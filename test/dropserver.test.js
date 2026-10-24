// Run: node test/dropserver.test.js. Phone -> PC upload server, loopback only.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startDropServer, lanAddresses, isPrivateAddress } = require('../src/dropserver');

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
    onProgress: (p) => {
      progress.push(p);
      progressHook?.(p);
    },
    ...extra,
  });

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
      assert.match(r.body, /Files land in Downloads on your PC\./);
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
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, name: 'Holiday photo #1.jpg' });
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
