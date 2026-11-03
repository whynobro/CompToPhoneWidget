// Run: node test/dropserver.test.js. Phone -> PC upload server, loopback only.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startDropServer, lanAddresses, isPrivateAddress, resolveFolder } = require('../src/dropserver');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-drop-'));
const TOKEN = 'k7m2x9qa';
let cur = root;
let n = 0;
const fresh = () => {
  cur = path.join(root, `t${n++}`);
  fs.mkdirSync(cur);
  return cur;
};

const received = [];
const texts = [];
const progress = [];
let srv;
let progressHook = null;

const request = (port, { method = 'GET', url = '/', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });

const upload = (name, body, port = srv.port) =>
  request(port, {
    method: 'POST',
    url: `/${TOKEN}/upload`,
    headers: { 'X-Filename': encodeURIComponent(name), 'Content-Length': Buffer.byteLength(body) },
    body,
  });

const waitFor = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
};

const startServer = (extra = {}) =>
  startDropServer({
    port: 0,
    token: TOKEN,
    dir: () => cur,
    pcName: 'MICHAEL-PC',
    onReceived: (f) => received.push(f),
    onText: (t) => texts.push(t),
    onProgress: (p) => {
      progress.push(p);
      progressHook?.(p);
    },
    ...extra,
  });

// Drop-page destinations: a Downloads-like root, a OneDrive-like root, and a folder outside both.
const layout = () => {
  const base = fresh();
  const mk = (...p) => fs.mkdirSync(path.join(base, ...p), { recursive: true });
  mk('dl');
  mk('od', 'ME 211', 'Labs');
  mk('od', 'ME 2', 'x');
  mk('od', 'me 10');
  mk('od', 'Alpha');
  mk('od', '.hidden');
  mk('od', '~$lock');
  mk('outside', 'sub');
  fs.writeFileSync(path.join(base, 'od', 'notes.txt'), 'file');
  const roots = [
    { id: 'downloads', name: 'Downloads', path: path.join(base, 'dl') },
    { id: 'onedrive', name: 'OneDrive', path: path.join(base, 'od') },
    { id: 'ghost', name: 'Ghost', path: path.join(base, 'missing-root') },
  ];
  return { base, roots, dl: roots[0].path, od: roots[1].path, outside: path.join(base, 'outside') };
};

const tryJunction = (target, link) => {
  try {
    fs.symlinkSync(target, link, 'junction');
    return true;
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'UNKNOWN') return false;
    throw e;
  }
};

const folders = (port, query = '') => request(port, { url: `/${TOKEN}/folders${query}` });
const uploadTo = (port, { root, rel, name = 'a.txt', body = 'hello' } = {}) => {
  const headers = { 'X-Filename': encodeURIComponent(name), 'Content-Length': Buffer.byteLength(body) };
  if (root !== undefined) headers['X-Root'] = root;
  if (rel !== undefined) headers['X-Path'] = rel;
  return request(port, { method: 'POST', url: `/${TOKEN}/upload`, headers, body });
};
const snapshot = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      out.push(f);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(f);
    }
  };
  walk(dir);
  return out.sort();
};

const tests = {
  async 'page: served at /token and /token/ with CSP and security headers'() {
    for (const url of [`/${TOKEN}`, `/${TOKEN}/`]) {
      const r = await request(srv.port, { url });
      assert.strictEqual(r.status, 200);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.strictEqual(
        r.headers['content-security-policy'],
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
      );
      assert.strictEqual(r.headers['referrer-policy'], 'no-referrer');
      assert.strictEqual(r.headers['cache-control'], 'no-store');
      assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
      assert.match(r.body, /Send to MICHAEL-PC/);
      assert.match(r.body, /Save to/);
      assert.match(r.body, /id="change"/);
      assert.match(r.body, /Choose photos or files/);
      assert.ok(!/<input[^>]*accept=/.test(r.body), 'file input must not have accept');
    }
  },

  async 'page: pcName is HTML-escaped and no em dashes anywhere'() {
    const s = await startServer({ pcName: '<script>alert(1)</script>&"' });
    try {
      const r = await request(s.port, { url: `/${TOKEN}` });
      assert.ok(!r.body.includes('<script>alert(1)'));
      assert.match(r.body, /Send to &lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;&quot;/);
    } finally {
      await s.close();
    }
    const page = (await request(srv.port, { url: `/${TOKEN}` })).body;
    assert.ok(!page.includes('\u2014'));
    for (const f of ['../src/dropserver.js', 'dropserver.test.js']) {
      assert.ok(!fs.readFileSync(path.join(__dirname, f), 'utf8').includes('\u2014'), f);
    }
  },

  async 'wrong token and unknown paths: 404 text/plain that never reveals the token'() {
    for (const url of ['/nope', '/', `/${TOKEN}x`, `/${TOKEN.slice(1)}`, `/${TOKEN}/other`, '/favicon.ico']) {
      const r = await request(srv.port, { url });
      assert.strictEqual(r.status, 404, url);
      assert.match(r.headers['content-type'], /text\/plain/);
      assert.strictEqual(r.body, 'Not found');
      assert.ok(!r.body.includes(TOKEN));
      assert.strictEqual(r.headers['referrer-policy'], 'no-referrer');
    }
    const post = await request(srv.port, { method: 'POST', url: '/wrong/upload', body: 'x' });
    assert.strictEqual(post.status, 404);
  },

  async 'upload: saves exact bytes under the right name and fires onReceived'() {
    const dir = fresh();
    const bytes = Buffer.alloc(300000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
    received.length = 0;
    const r = await upload('Holiday photo #1.jpg', bytes);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, name: 'Holiday photo #1.jpg', folder: 'Downloads' });
    assert.ok(fs.readFileSync(path.join(dir, 'Holiday photo #1.jpg')).equals(bytes));
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].name, 'Holiday photo #1.jpg');
    assert.strictEqual(received[0].size, bytes.length);
    assert.strictEqual(received[0].path, path.join(dir, 'Holiday photo #1.jpg'));
    assert.deepStrictEqual(fs.readdirSync(dir), ['Holiday photo #1.jpg']);
  },

  async 'upload: unicode names survive, bad encoding falls back to "file"'() {
    const dir = fresh();
    assert.strictEqual(JSON.parse((await upload('r\u00e9sum\u00e9 \u65e5\u672c.txt', 'a')).body).name, 'r\u00e9sum\u00e9 \u65e5\u672c.txt');
    const r = await request(srv.port, { method: 'POST', url: `/${TOKEN}/upload`, headers: { 'X-Filename': '%E0%A4%A' }, body: 'b' });
    assert.strictEqual(JSON.parse(r.body).name, 'file');
    const none = await request(srv.port, { method: 'POST', url: `/${TOKEN}/upload`, body: 'c' });
    assert.strictEqual(JSON.parse(none.body).name, 'file (1)');
    assert.strictEqual(fs.readdirSync(dir).length, 3);
  },

  async 'upload: duplicate name becomes "name (1).ext"'() {
    const dir = fresh();
    const a = JSON.parse((await upload('dup.txt', 'one')).body);
    const b = JSON.parse((await upload('dup.txt', 'two')).body);
    const c = JSON.parse((await upload('dup.txt', 'three')).body);
    assert.deepStrictEqual([a.name, b.name, c.name], ['dup.txt', 'dup (1).txt', 'dup (2).txt']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'dup.txt'), 'utf8'), 'one');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'dup (1).txt'), 'utf8'), 'two');
  },

  async 'upload: traversal name lands inside dir'() {
    const dir = fresh();
    const r = await upload('..\\..\\evil.txt', 'x');
    assert.strictEqual(JSON.parse(r.body).name, 'evil.txt');
    assert.deepStrictEqual(fs.readdirSync(dir), ['evil.txt']);
    assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.txt')));
    assert.ok(!fs.existsSync(path.join(dir, '..', '..', 'evil.txt')));
    const r2 = await upload('../../up.txt', 'y');
    assert.strictEqual(JSON.parse(r2.body).name, 'up.txt');
    assert.ok(!fs.existsSync(path.join(dir, '..', 'up.txt')));
  },

  async 'upload: onProgress reports received and total'() {
    fresh();
    progress.length = 0;
    await upload('p.bin', Buffer.alloc(50000));
    assert.ok(progress.length >= 1);
    assert.strictEqual(progress[0].name, 'p.bin');
    assert.strictEqual(progress[0].total, 50000);
    assert.ok(progress[0].received > 0 && progress[0].received <= 50000);
  },

  async 'upload: dir() failure gives 500 JSON and the server keeps working'() {
    const s = await startServer({
      dir: () => {
        throw new Error('C:\\secret\\place exploded');
      },
    });
    try {
      const r = await upload('a.txt', 'x', s.port);
      assert.strictEqual(r.status, 500);
      const j = JSON.parse(r.body);
      assert.strictEqual(j.ok, false);
      assert.ok(j.message && !j.message.includes('secret'));
      assert.strictEqual((await request(s.port, { url: `/${TOKEN}` })).status, 200);
    } finally {
      await s.close();
    }
  },

  async 'upload: client abort mid-upload leaves no files and server survives'() {
    const dir = fresh();
    received.length = 0;
    const gotBytes = new Promise((resolve) => { progressHook = resolve; });
    const req = http.request({
      host: '127.0.0.1',
      port: srv.port,
      method: 'POST',
      path: `/${TOKEN}/upload`,
      agent: false,
      headers: { 'X-Filename': 'big.bin', 'Content-Length': 5000000 },
    });
    req.on('error', () => {});
    req.write(Buffer.alloc(20000));
    await gotBytes;
    progressHook = null;
    assert.ok(await waitFor(() => fs.readdirSync(dir).some((f) => f.endsWith('.part'))), 'temp file should exist mid-upload');
    req.destroy();
    assert.ok(await waitFor(() => fs.readdirSync(dir).length === 0), `leftover files: ${fs.readdirSync(dir)}`);
    assert.strictEqual(received.length, 0);
    assert.strictEqual((await request(srv.port, { url: `/${TOKEN}` })).status, 200);
    assert.strictEqual(JSON.parse((await upload('after.txt', 'ok')).body).ok, true);
    assert.deepStrictEqual(fs.readdirSync(dir), ['after.txt']);
  },

  async 'folders: no root lists ids and names only, skipping roots that are missing'() {
    const L = layout();
    const s = await startServer({ roots: L.roots });
    try {
      const r = await folders(s.port);
      assert.strictEqual(r.status, 200);
      assert.match(r.headers['content-type'], /application\/json/);
      assert.deepStrictEqual(JSON.parse(r.body), { roots: [{ id: 'downloads', name: 'Downloads' }, { id: 'onedrive', name: 'OneDrive' }] });
      assert.ok(!r.body.includes(L.base) && !r.body.includes('stp-drop-'), 'no absolute paths');
      const q = await folders(s.port, '?root=onedrive');
      assert.ok(!q.body.includes(L.base) && !q.body.includes('stp-drop-'), 'no absolute paths');
    } finally {
      await s.close();
    }
  },

  async 'folders: roots may be a function evaluated per request'() {
    const L = layout();
    let list = [L.roots[0]];
    const s = await startServer({ roots: () => list });
    try {
      assert.deepStrictEqual(JSON.parse((await folders(s.port)).body).roots.map((x) => x.id), ['downloads']);
      list = L.roots;
      assert.deepStrictEqual(JSON.parse((await folders(s.port)).body).roots.map((x) => x.id), ['downloads', 'onedrive']);
    } finally {
      await s.close();
    }
  },

  async 'folders: lists sorted subfolders, no dot folders, files, lock files or junctions'() {
    const L = layout();
    const linked = tryJunction(L.outside, path.join(L.od, 'Sneaky'));
    const s = await startServer({ roots: L.roots });
    try {
      const r = await folders(s.port, '?root=onedrive');
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.body);
      assert.strictEqual(j.root, 'onedrive');
      assert.strictEqual(j.rootName, 'OneDrive');
      assert.strictEqual(j.path, '');
      assert.deepStrictEqual(j.folders, ['Alpha', 'ME 2', 'me 10', 'ME 211']);
      if (!linked) console.log('     (junction creation not permitted here, skipped that assertion)');
      const sub = JSON.parse((await folders(s.port, `?root=onedrive&path=${encodeURIComponent('ME 211')}`)).body);
      assert.strictEqual(sub.path, 'ME 211');
      assert.deepStrictEqual(sub.folders, ['Labs']);
      const nested = JSON.parse((await folders(s.port, `?root=onedrive&path=${encodeURIComponent('ME 211//Labs/')}`)).body);
      assert.strictEqual(nested.path, 'ME 211/Labs');
      assert.deepStrictEqual(nested.folders, []);
    } finally {
      await s.close();
    }
  },

  async 'folders: capped at 1000 entries'() {
    const L = layout();
    for (let i = 0; i < 1005; i++) fs.mkdirSync(path.join(L.dl, `d${String(i).padStart(4, '0')}`));
    const s = await startServer({ roots: L.roots });
    try {
      const j = JSON.parse((await folders(s.port, '?root=downloads')).body);
      assert.strictEqual(j.folders.length, 1000);
      assert.strictEqual(j.folders[0], 'd0000');
    } finally {
      await s.close();
    }
  },

  async 'folders: bad root 400, bad path 400, missing folder 404, all JSON'() {
    const L = layout();
    const s = await startServer({ roots: L.roots });
    try {
      for (const [q, status] of [
        ['?root=nope', 400],
        ['?root=onedrive&path=..', 400],
        ['?root=onedrive&path=ME%20211/..%2f..', 400],
        [`?root=onedrive&path=${encodeURIComponent('C:\\Windows')}`, 400],
        ['?root=onedrive&path=Nothing', 404],
        ['?root=ghost', 404],
      ]) {
        const r = await folders(s.port, q);
        assert.strictEqual(r.status, status, q);
        const j = JSON.parse(r.body);
        assert.strictEqual(j.ok, false, q);
        assert.ok(j.message && !j.message.includes(L.base), q);
      }
    } finally {
      await s.close();
    }
  },

  async 'folders: token is still required (404 text, counted as a bad guess)'() {
    const L = layout();
    const s = await startServer({ roots: L.roots });
    try {
      for (const url of ['/folders', '/folders?root=onedrive', `/${TOKEN}x/folders`, '/wrong/folders?root=onedrive']) {
        const r = await request(s.port, { url });
        assert.strictEqual(r.status, 404, url);
        assert.match(r.headers['content-type'], /text\/plain/);
        assert.strictEqual(r.body, 'Not found');
      }
      assert.strictEqual((await request(s.port, { method: 'POST', url: `/${TOKEN}/folders` })).status, 404);
    } finally {
      await s.close();
    }
  },

  async 'upload: X-Root and X-Path land in a nested existing folder'() {
    const L = layout();
    received.length = 0;
    const s = await startServer({ roots: L.roots });
    try {
      const rel = 'ME 211/Labs';
      const r = await uploadTo(s.port, { root: 'onedrive', rel: encodeURIComponent(rel), name: 'lab1.txt', body: 'data' });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(JSON.parse(r.body), { ok: true, name: 'lab1.txt', folder: 'OneDrive/ME 211/Labs' });
      assert.strictEqual(fs.readFileSync(path.join(L.od, 'ME 211', 'Labs', 'lab1.txt'), 'utf8'), 'data');
      assert.strictEqual(received[0].path, path.join(L.od, 'ME 211', 'Labs', 'lab1.txt'));
      assert.deepStrictEqual(fs.readdirSync(path.join(L.od, 'ME 211', 'Labs')), ['lab1.txt']);
      assert.deepStrictEqual(fs.readdirSync(L.dl), []);
      const top = await uploadTo(s.port, { root: 'onedrive', name: 'top.txt' });
      assert.deepStrictEqual(JSON.parse(top.body), { ok: true, name: 'top.txt', folder: 'OneDrive' });
      assert.ok(fs.existsSync(path.join(L.od, 'top.txt')));
    } finally {
      await s.close();
    }
  },

  async 'upload: no headers goes to the first root, the default'() {
    const L = layout();
    const s = await startServer({ roots: L.roots });
    try {
      const r = await uploadTo(s.port, { name: 'plain.txt' });
      assert.deepStrictEqual(JSON.parse(r.body), { ok: true, name: 'plain.txt', folder: 'Downloads' });
      assert.deepStrictEqual(fs.readdirSync(L.dl), ['plain.txt']);
      const blank = await uploadTo(s.port, { root: '', rel: '', name: 'blank.txt' });
      assert.strictEqual(JSON.parse(blank.body).folder, 'Downloads');
      assert.deepStrictEqual(fs.readdirSync(L.dl).sort(), ['blank.txt', 'plain.txt']);
    } finally {
      await s.close();
    }
  },

  async 'upload: default root is still created on demand when it has no path'() {
    const base = fresh();
    const dl = path.join(base, 'not', 'yet');
    const s = await startServer({ roots: [{ id: 'downloads', name: 'Downloads', path: dl }] });
    try {
      assert.strictEqual(JSON.parse((await uploadTo(s.port, { name: 'x.txt' })).body).ok, true);
      assert.deepStrictEqual(fs.readdirSync(dl), ['x.txt']);
    } finally {
      await s.close();
    }
  },

  async 'upload: traversal in X-Path is rejected with 400 and nothing is written anywhere'() {
    const L = layout();
    const before = snapshot(L.base);
    const s = await startServer({ roots: L.roots });
    try {
      const bad = [
        encodeURIComponent('..'),
        encodeURIComponent('a/../..'),
        encodeURIComponent('ME 211/../../outside'),
        encodeURIComponent('C:\\Windows'),
        encodeURIComponent('C:/Windows'),
        encodeURIComponent('\\\\server\\share'),
        encodeURIComponent('ME 211\\Labs'),
        encodeURIComponent('/outside'),
        encodeURIComponent('.'),
        encodeURIComponent('ME 211/./Labs'),
        encodeURIComponent('bad:name'),
        '%2e%2e',
        '%2E%2E%2Foutside',
        '%00',
        '%E0%A4%A',
      ];
      for (const rel of bad) {
        for (const root of ['onedrive', 'downloads']) {
          const r = await uploadTo(s.port, { root, rel, name: 'evil.txt' });
          assert.strictEqual(r.status, 400, `${root} ${rel}`);
          const j = JSON.parse(r.body);
          assert.strictEqual(j.ok, false);
          assert.ok(!j.message.includes(L.base));
        }
      }
      assert.deepStrictEqual(snapshot(L.base), before);
      assert.strictEqual((await uploadTo(s.port, { root: 'onedrive', name: 'fine.txt' })).status, 200);
    } finally {
      await s.close();
    }
  },

  async 'upload: a junction pointing outside the root cannot be used to escape'() {
    const L = layout();
    if (!tryJunction(L.outside, path.join(L.od, 'Escape'))) {
      console.log('     (junction creation not permitted here, skipped)');
      return;
    }
    const before = snapshot(L.outside);
    const s = await startServer({ roots: L.roots });
    try {
      for (const rel of ['Escape', 'Escape/sub']) {
        const r = await uploadTo(s.port, { root: 'onedrive', rel: encodeURIComponent(rel), name: 'evil.txt' });
        assert.strictEqual(r.status, 400, rel);
        assert.strictEqual(JSON.parse(r.body).ok, false);
        const f = await folders(s.port, `?root=onedrive&path=${encodeURIComponent(rel)}`);
        assert.strictEqual(f.status, 400, rel);
      }
      assert.deepStrictEqual(snapshot(L.outside), before);
      assert.ok(!fs.existsSync(path.join(L.outside, 'evil.txt')));
    } finally {
      await s.close();
    }
  },

  async 'upload: a root that is itself a junction still works for folders inside it'() {
    const L = layout();
    const link = path.join(L.base, 'od-link');
    if (!tryJunction(L.od, link)) {
      console.log('     (junction creation not permitted here, skipped)');
      return;
    }
    const s = await startServer({ roots: [{ id: 'onedrive', name: 'OneDrive', path: link }] });
    try {
      const r = await uploadTo(s.port, { root: 'onedrive', rel: encodeURIComponent('ME 211/Labs'), name: 'ok.txt' });
      assert.strictEqual(r.status, 200);
      assert.ok(fs.existsSync(path.join(L.od, 'ME 211', 'Labs', 'ok.txt')));
    } finally {
      await s.close();
    }
  },

  async 'upload: unknown root is 400, missing folder is 404 and is never created'() {
    const L = layout();
    const before = snapshot(L.base);
    const s = await startServer({ roots: L.roots });
    try {
      const unknown = await uploadTo(s.port, { root: 'nope', name: 'u.txt' });
      assert.strictEqual(unknown.status, 400);
      assert.strictEqual(JSON.parse(unknown.body).ok, false);
      for (const [root, rel] of [['onedrive', 'Gone'], ['onedrive', 'ME 211/Gone/Deeper'], ['downloads', 'Gone'], ['ghost', '']]) {
        const r = await uploadTo(s.port, { root, rel: encodeURIComponent(rel), name: 'm.txt' });
        assert.strictEqual(r.status, 404, `${root}/${rel}`);
        const j = JSON.parse(r.body);
        assert.strictEqual(j.ok, false);
        assert.strictEqual(j.message, 'That folder no longer exists on the PC.');
      }
      assert.deepStrictEqual(snapshot(L.base), before);
      assert.ok(!fs.existsSync(L.roots[2].path));
    } finally {
      await s.close();
    }
  },

  async 'upload: a file where a folder is expected is 404, and a large rejected body still gets a JSON reply'() {
    const L = layout();
    const s = await startServer({ roots: L.roots });
    try {
      const r = await uploadTo(s.port, { root: 'onedrive', rel: encodeURIComponent('notes.txt'), name: 'x.txt' });
      assert.strictEqual(r.status, 404);
      // Browsers keep the connection alive, so the early reply must survive a body still in flight.
      const agent = new http.Agent({ keepAlive: true });
      const body = Buffer.alloc(3000000);
      const big = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port: s.port, method: 'POST', path: `/${TOKEN}/upload`, agent,
          headers: { 'X-Filename': 'big.bin', 'X-Root': 'onedrive', 'X-Path': 'Gone', 'Content-Length': body.length },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end(body);
      });
      agent.destroy();
      assert.strictEqual(big.status, 404);
      assert.strictEqual(JSON.parse(big.body).ok, false);
      assert.strictEqual(snapshot(L.od).filter((f) => f.endsWith('.part') || f.endsWith('big.bin')).length, 0);
    } finally {
      await s.close();
    }
  },

  async 'resolveFolder: accepts normal nested names, rejects the rest'() {
    const L = layout();
    const ok = resolveFolder(L.roots, 'onedrive', 'ME 211/Labs');
    assert.strictEqual(ok.rel, 'ME 211/Labs');
    assert.strictEqual(ok.dir, path.join(L.od, 'ME 211', 'Labs'));
    assert.strictEqual(resolveFolder(L.roots, '', '').root.id, 'downloads');
    assert.strictEqual(resolveFolder(L.roots, 'onedrive', 'ME 211//Labs/').rel, 'ME 211/Labs');
    for (const rel of ['..', '../x', 'a/..', '.', 'C:', 'a\\b', '/abs', 'a/b:c', 'a/b?', 'con', 'trail.', 'a\u0001b']) {
      assert.throws(() => resolveFolder(L.roots, 'onedrive', rel), (e) => e.status === 400, JSON.stringify(rel));
    }
    assert.throws(() => resolveFolder(L.roots, 'x', ''), (e) => e.status === 400);
    assert.throws(() => resolveFolder([], '', ''), (e) => e.status === 400);
    assert.throws(() => resolveFolder(L.roots, 'onedrive', 'Nope'), (e) => e.status === 404);
  },

  async 'page: has the Save to picker, builds DOM with textContent, and its script parses'() {
    const { renderPage } = require('../src/dropserver');
    const html = renderPage('PC');
    assert.match(html, /id="destName"/);
    assert.match(html, /id="sheet"/);
    assert.match(html, /X-Root/);
    assert.match(html, /localStorage/);
    assert.match(html, /id="msgForm"/);
    assert.match(html, /root \+ '\/text'/);
    const script = html.split('<script>')[1].split('</script>')[0];
    new Function(script);
    const uses = script.match(/innerHTML/g) || [];
    assert.strictEqual(uses.length, 1, 'only the constant check mark may use innerHTML');
  },

  async 'text: a message reaches onText trimmed, with Windows line breaks folded'() {
    texts.length = 0;
    const body = '  https://example.com/a?b=1  ';
    const r = await request(srv.port, { method: 'POST', url: `/${TOKEN}/text`, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true });
    assert.deepStrictEqual(texts, [{ message: 'https://example.com/a?b=1' }]);
    const note = 'café \u{1F600}\r\nline two';
    assert.strictEqual((await request(srv.port, { method: 'POST', url: `/${TOKEN}/text`, body: note })).status, 200);
    assert.strictEqual(texts[1].message, 'café \u{1F600}\nline two');
  },

  async 'text: empty, oversized, wrong token and GET are refused without calling onText'() {
    texts.length = 0;
    const post = (body, url = `/${TOKEN}/text`) => request(srv.port, { method: 'POST', url, body });
    const empty = await post('   \n ');
    assert.strictEqual(empty.status, 400);
    assert.strictEqual(JSON.parse(empty.body).ok, false);
    const big = await post('x'.repeat(100 * 1024 + 1));
    assert.strictEqual(big.status, 413);
    assert.match(JSON.parse(big.body).message, /too long/);
    assert.strictEqual((await post('x'.repeat(100 * 1024))).status, 200);
    // Chunked, so the size is only known while reading.
    const chunked = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: `/${TOKEN}/text`, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      for (let i = 0; i < 30; i++) req.write('y'.repeat(4096));
      req.end();
    });
    assert.strictEqual(chunked, 413);
    assert.strictEqual((await post('hi', '/wrongtoken/text')).status, 404);
    assert.strictEqual((await request(srv.port, { url: `/${TOKEN}/text` })).status, 404);
    assert.strictEqual(texts.length, 1);
    assert.strictEqual(texts[0].message.length, 100 * 1024);
  },

  async 'text: a throwing onText answers 500 and the server keeps working'() {
    const s = await startServer({ onText: () => { throw new Error('boom'); } });
    try {
      const r = await request(s.port, { method: 'POST', url: `/${TOKEN}/text`, body: 'hello' });
      assert.strictEqual(r.status, 500);
      assert.strictEqual(JSON.parse(r.body).ok, false);
      assert.strictEqual((await request(s.port, { url: `/${TOKEN}` })).status, 200);
    } finally {
      await s.close();
    }
  },

  async 'rate limit: 429 for everything after 20 bad requests, even the right token'() {
    const s = await startServer();
    try {
      for (let i = 0; i < 20; i++) {
        assert.strictEqual((await request(s.port, { url: `/guess${i}` })).status, 404, `request ${i}`);
      }
      for (const url of ['/another', `/${TOKEN}`]) {
        const r = await request(s.port, { url });
        assert.strictEqual(r.status, 429, url);
        assert.strictEqual(r.headers['cache-control'], 'no-store');
      }
      assert.strictEqual((await upload('x.txt', 'x', s.port)).status, 429);
    } finally {
      await s.close();
    }
  },

  async 'rate limit: good requests and favicon do not count toward the limit'() {
    const s = await startServer();
    try {
      for (let i = 0; i < 30; i++) {
        assert.strictEqual((await request(s.port, { url: `/${TOKEN}` })).status, 200);
        await request(s.port, { url: '/favicon.ico' });
      }
      assert.strictEqual((await request(s.port, { url: `/${TOKEN}` })).status, 200);
    } finally {
      await s.close();
    }
  },

  async 'address filter: private ranges allowed, public rejected'() {
    const ok = [
      '127.0.0.1', '127.9.9.9', '::1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.20',
      '169.254.10.10', '100.64.0.1', '100.127.255.255', 'fe80::1', 'fe80::abcd%eth0', 'febf::1', 'fc00::1',
      'fd12:3456::1', '::ffff:192.168.1.5', '::ffff:10.1.2.3', '::ffff:127.0.0.1', '::ffff:c0a8:0105',
    ];
    const no = [
      '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.63.255.255', '100.128.0.1', '11.0.0.1',
      '2001:4860:4860::8888', 'fec0::1', 'fe00::1', 'fb00::1', '::ffff:8.8.8.8', '::ffff:0808:0808', '::', '', 'garbage',
    ];
    for (const a of ok) assert.ok(isPrivateAddress(a), `should allow ${a}`);
    for (const a of no) assert.ok(!isPrivateAddress(a), `should reject ${a}`);
  },

  async 'close(): destroys open sockets and stops listening'() {
    const s = await startServer();
    const stalled = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: `/${TOKEN}/upload`, agent: false, headers: { 'Content-Length': 100 } });
    let closed = false;
    stalled.on('error', () => { closed = true; });
    stalled.write('abc');
    await new Promise((r) => setTimeout(r, 100));
    await Promise.race([s.close(), new Promise((_, rej) => setTimeout(() => rej(new Error('close() hung')), 3000))]);
    assert.ok(await waitFor(() => closed));
    await assert.rejects(request(s.port, { url: `/${TOKEN}` }), /ECONNREFUSED/);
  },

  async 'port: falls back to a random port when the preferred one is taken'() {
    const blocker = http.createServer();
    await new Promise((r) => blocker.listen(0, '0.0.0.0', r));
    const busy = blocker.address().port;
    const s = await startServer({ port: busy });
    try {
      assert.notStrictEqual(s.port, busy);
      assert.strictEqual((await request(s.port, { url: `/${TOKEN}` })).status, 200);
    } finally {
      await s.close();
      await new Promise((r) => blocker.close(r));
    }
  },

  async 'lanAddresses: array of non-link-local IPv4 strings'() {
    const a = lanAddresses();
    assert.ok(Array.isArray(a));
    for (const ip of a) {
      assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/);
      assert.ok(!ip.startsWith('169.254.') && !ip.startsWith('127.'));
    }
    assert.strictEqual(new Set(a).size, a.length);
  },
};

(async () => {
  srv = await startServer();
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log('ok  ', name);
    } catch (e) {
      failed++;
      console.log('FAIL', name, '\n     ', e.message);
    }
  }
  await srv.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
  process.exit(failed ? 1 : 0);
})();
