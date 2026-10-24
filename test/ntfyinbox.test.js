// Run: node test/ntfyinbox.test.js. Exercises the phone -> PC inbox without touching the network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startInbox } = require('../src/ntfyinbox');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-inbox-'));
let n = 0;
const tmpDir = () => {
  const d = path.join(root, `t${n++}`);
  fs.mkdirSync(d);
  return d;
};

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
}

// A subscribe response whose body the test feeds by hand.
function makeStream() {
  let ctrl;
  const body = new ReadableStream({ start(c) { ctrl = c; } });
  const safe = (fn) => { try { fn(); } catch {} };
  return {
    response: () => new Response(body, { status: 200 }),
    push: (obj) => safe(() => ctrl.enqueue(enc.encode(JSON.stringify(obj) + '\n'))),
    raw: (s) => safe(() => ctrl.enqueue(enc.encode(s))),
    close: () => safe(() => ctrl.close()),
  };
}

// Fake fetch: `/json` URLs take the next prepared subscribe response, anything else is a download.
function makeFetch({ streams = [], files = {} } = {}) {
  const calls = [];
  let sub = 0;
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (/\/json(\?|$)/.test(url)) {
      const s = streams[sub++];
      if (!s) return new Response('no stream', { status: 503 });
      return typeof s === 'function' ? s() : s.response();
    }
    const f = files[url];
    if (f === undefined) return new Response('nope', { status: 404 });
    if (typeof f === 'number') return new Response('err', { status: f });
    return new Response(f, { status: 200 });
  };
  fn.calls = calls;
  fn.subscribes = () => calls.filter((c) => /\/json(\?|$)/.test(c.url)).map((c) => c.url);
  fn.downloads = () => calls.filter((c) => !/\/json(\?|$)/.test(c.url)).map((c) => c.url);
  return fn;
}

// Collects every callback so tests can assert on them.
function harness(extra = {}) {
  const dir = tmpDir();
  const h = { dir, files: [], texts: [], cursors: [], statuses: [], errors: [] };
  h.opts = {
    server: 'https://ntfy.example/',
    topic: 'pc-test',
    dir: () => dir,
    onFile: (f) => h.files.push(f),
    onText: (t) => h.texts.push(t),
    onCursor: (id) => h.cursors.push(id),
    onStatus: (s, err) => { h.statuses.push(s); if (err) h.errors.push(err); },
    retryDelayMs: 5,
    reconnectDelayMs: 10,
    stallMs: 5000,
    ...extra,
  };
  h.start = (fetchImpl) => (h.inbox = startInbox({ ...h.opts, fetchImpl }));
  return h;
}

const msg = (id, rest = {}) => ({ id, time: 1, event: 'message', topic: 'pc-test', ...rest });
const future = () => Math.floor(Date.now() / 1000) + 3600;

const tests = {
  async 'subscribe URL: no since by default, trailing slash trimmed'() {
    const s = makeStream();
    const f = makeFetch({ streams: [s] });
    const h = harness();
    h.start(f);
    await waitFor(() => f.calls.length >= 1);
    h.inbox.stop();
    assert.strictEqual(f.calls[0].url, 'https://ntfy.example/pc-test/json');
  },

  async 'subscribe URL: since cursor and topic are encoded'() {
    const s = makeStream();
    const f = makeFetch({ streams: [s] });
    const h = harness({ topic: 'a b', since: 'msg 1' });
    h.start(f);
    await waitFor(() => f.calls.length >= 1);
    h.inbox.stop();
    assert.strictEqual(f.calls[0].url, 'https://ntfy.example/a%20b/json?since=msg%201');
  },

  async 'attachment: saves exact bytes under its name, then onFile and onCursor'() {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13, 255]);
    const s = makeStream();
    const f = makeFetch({ streams: [s], files: { 'https://ntfy.example/file/abc.bin': bytes } });
    const h = harness();
    h.start(f);
    s.push(msg('m1', { message: 'caption here', attachment: { name: 'My Photo.bin', url: 'https://ntfy.example/file/abc.bin', size: bytes.length } }));
    await waitFor(() => h.cursors.length === 1);
    h.inbox.stop();
    assert.strictEqual(h.files.length, 1);
    assert.strictEqual(h.files[0].name, 'My Photo.bin');
    assert.strictEqual(h.files[0].size, bytes.length);
    assert.strictEqual(h.files[0].messageId, 'm1');
    assert.ok(h.files[0].path.startsWith(h.dir));
    assert.ok(fs.readFileSync(h.files[0].path).equals(bytes));
    assert.deepStrictEqual(h.cursors, ['m1']);
    assert.strictEqual(h.texts.length, 0, 'caption must not also fire onText');
  },

  async 'attachment: missing name falls back to "file"'() {
    const s = makeStream();
    const f = makeFetch({ streams: [s], files: { 'https://ntfy.example/file/x': Buffer.from('hi') } });
    const h = harness();
    h.start(f);
    s.push(msg('m1', { attachment: { url: 'https://ntfy.example/file/x' } }));
    await waitFor(() => h.files.length === 1);
    h.inbox.stop();
    assert.strictEqual(h.files[0].name, 'file');
  },

  async 'text message: onText with title, message and click'() {
    const s = makeStream();
    const f = makeFetch({ streams: [s] });
    const h = harness();
    h.start(f);
    s.push(msg('m1', { title: 'Link', message: 'read this', click: 'https://example.com/p' }));
    await waitFor(() => h.cursors.length === 1);
    h.inbox.stop();
    assert.deepStrictEqual(h.texts, [{ title: 'Link', message: 'read this', click: 'https://example.com/p', messageId: 'm1' }]);
    assert.strictEqual(h.files.length, 0);
  },

  async 'open, keepalive, blank and garbage lines are ignored; split chunks are joined'() {
    const s = makeStream();
    const f = makeFetch({ streams: [s] });
    const h = harness();
    h.start(f);
    s.push({ id: 'o1', event: 'open', topic: 'pc-test' });
    s.push({ id: 'k1', event: 'keepalive', topic: 'pc-test' });
    s.push({ id: 'p1', event: 'poll_request', topic: 'pc-test' });
    s.raw('\n   \nnot json at all\n{"broken":\n');
    const line = JSON.stringify(msg('m1', { message: 'split across chunks' })) + '\n';
    s.raw(line.slice(0, 20));
    await sleep(20);
    assert.strictEqual(h.texts.length, 0);
    s.raw(line.slice(20));
    await waitFor(() => h.cursors.length === 1);
    h.inbox.stop();
    assert.deepStrictEqual(h.cursors, ['m1']);
    assert.strictEqual(h.texts.length, 1);
    assert.strictEqual(h.texts[0].message, 'split across chunks');
    assert.ok(!h.statuses.includes('error'));
  },

  async 'duplicate message id is processed once'() {
    const s = makeStream();
    const f = makeFetch({ streams: [s], files: { 'https://ntfy.example/file/d': Buffer.from('dup') } });
    const h = harness();
    h.start(f);
    s.push(msg('m1', { attachment: { name: 'd.txt', url: 'https://ntfy.example/file/d' } }));
    s.push(msg('m1', { attachment: { name: 'd.txt', url: 'https://ntfy.example/file/d' } }));
    s.push(msg('m2', { message: 'after' }));
    await waitFor(() => h.cursors.length === 2);
    h.inbox.stop();
    assert.strictEqual(h.files.length, 1);
    assert.strictEqual(f.downloads().length, 1);
    assert.deepStrictEqual(h.cursors, ['m1', 'm2']);
  },

  async 'expired attachment is skipped, reported, and the cursor still advances'() {
    const s = makeStream();
    const f = makeFetch({ streams: [s] });
    const h = harness();
    h.start(f);
    s.push(msg('m1', { attachment: { name: 'old.jpg', url: 'https://ntfy.example/file/old', expires: Math.floor(Date.now() / 1000) - 60 } }));
    await waitFor(() => h.cursors.length === 1);
    h.inbox.stop();
    assert.strictEqual(f.downloads().length, 0);
    assert.strictEqual(h.files.length, 0);
    assert.ok(h.statuses.includes('error'));
    assert.match(h.errors[0].message, /expired/);
    assert.deepStrictEqual(h.cursors, ['m1']);
  },

  async 'non-http attachment url is skipped and the cursor advances'() {
    const s = makeStream();
    const f = makeFetch({ streams: [s] });
    const h = harness();
    h.start(f);
    s.push(msg('m1', { attachment: { name: 'x', url: 'file:///C:/Windows/win.ini' } }));
    s.push(msg('m2', { attachment: { name: 'y', url: 'javascript:alert(1)' } }));
    await waitFor(() => h.cursors.length === 2);
    h.inbox.stop();
    assert.strictEqual(f.downloads().length, 0);
    assert.strictEqual(h.errors.length, 2);
  },

  async 'attachment hosted off the ntfy server is never fetched'() {
    const s = makeStream();
    const f = makeFetch({ streams: [s] });
    const h = harness();
    h.start(f);
    s.push(msg('m1', { attachment: { name: 'x', url: 'http://127.0.0.1:8080/admin' } }));
    s.push(msg('m2', { attachment: { name: 'y', url: 'https://evil.example/file/y' } }));
    await waitFor(() => h.cursors.length === 2);
    h.inbox.stop();
    assert.strictEqual(f.downloads().length, 0);
    assert.match(h.errors[0].message, /outside ntfy\.example/);
  },

  async 'failed download is retried 3 times, given up, and later messages still work'() {
    const s = makeStream();
    const f = makeFetch({ streams: [s], files: { 'https://ntfy.example/file/bad': 500 } });
    const h = harness();
    h.start(f);
    s.push(msg('m1', { attachment: { name: 'bad.bin', url: 'https://ntfy.example/file/bad' } }));
    s.push(msg('m2', { message: 'still alive' }));
    await waitFor(() => h.cursors.length === 2);
    h.inbox.stop();
    assert.strictEqual(f.downloads().length, 3);
    assert.strictEqual(h.files.length, 0);
    assert.match(h.errors[0].message, /bad\.bin.*HTTP 500/);
    assert.deepStrictEqual(h.cursors, ['m1', 'm2']);
    assert.strictEqual(h.texts[0].message, 'still alive');
    assert.deepStrictEqual(fs.readdirSync(h.dir), [], 'no stray temp files');
  },

  async 'download that fails once succeeds on retry'() {
    const s = makeStream();
    const f = makeFetch({ streams: [s] });
    let tries = 0;
    const h = harness();
    h.start(async (url, opts) => {
      if (!url.endsWith('/file/flaky')) return f(url, opts);
      return tries++ === 0 ? new Response('x', { status: 502 }) : new Response('fine', { status: 200 });
    });
    s.push(msg('m1', { attachment: { name: 'f.txt', url: 'https://ntfy.example/file/flaky' } }));
    await waitFor(() => h.cursors.length === 1);
    h.inbox.stop();
    assert.strictEqual(tries, 2);
    assert.strictEqual(h.files.length, 1);
    assert.strictEqual(fs.readFileSync(h.files[0].path, 'utf8'), 'fine');
    assert.strictEqual(h.errors.length, 0);
  },

  async 'reconnect after the stream closes uses the latest cursor'() {
    const s1 = makeStream();
    const s2 = makeStream();
    const f = makeFetch({ streams: [s1, s2] });
    const h = harness();
    h.start(f);
    s1.push(msg('m1', { message: 'one' }));
    s1.push(msg('m2', { message: 'two' }));
    s1.close();
    await waitFor(() => f.subscribes().length === 2);
    assert.deepStrictEqual(f.subscribes(), ['https://ntfy.example/pc-test/json', 'https://ntfy.example/pc-test/json?since=m2']);
    s2.push(msg('m3', { message: 'three' }));
    await waitFor(() => h.cursors.length === 3);
    h.inbox.stop();
    assert.deepStrictEqual(h.texts.map((t) => t.message), ['one', 'two', 'three']);
    assert.deepStrictEqual(h.statuses, ['connected', 'disconnected', 'connected']);
  },

  async 'subscribe errors back off and retry until the server accepts'() {
    const s = makeStream();
    const f = makeFetch({ streams: [() => new Response('slow down', { status: 429 }), () => { throw new Error('ECONNRESET'); }, s] });
    const h = harness();
    h.start(f);
    await waitFor(() => f.subscribes().length === 3);
    s.push(msg('m1', { message: 'made it' }));
    await waitFor(() => h.texts.length === 1);
    h.inbox.stop();
    assert.deepStrictEqual(h.statuses, ['disconnected', 'connected']);
  },

  async 'stall watchdog aborts a silent stream and reconnects'() {
    const dead = makeStream(); // never sends a byte, so the watchdog must act
    const s2 = makeStream();
    const f = makeFetch({ streams: [dead, s2] });
    const h = harness({ stallMs: 60 });
    h.start(f);
    await waitFor(() => f.subscribes().length === 2);
    assert.strictEqual(f.calls[0].opts.signal.aborted, true);
    s2.push(msg('m1', { message: 'back' }));
    await waitFor(() => h.texts.length === 1);
    h.inbox.stop();
  },

  async 'stop() ends callbacks and fetches, with no stray rejections'() {
    const rejections = [];
    const onRej = (e) => rejections.push(e);
    process.on('unhandledRejection', onRej);
    const s = makeStream();
    const f = makeFetch({ streams: [s], files: { 'https://ntfy.example/file/z': Buffer.from('z') } });
    const h = harness();
    h.start(f);
    await waitFor(() => h.statuses.includes('connected'));
    h.inbox.stop();
    h.inbox.stop(); // idempotent
    const before = f.calls.length;
    const statusesAtStop = h.statuses.length;
    s.push(msg('m1', { message: 'too late' }));
    s.push(msg('m2', { attachment: { name: 'z', url: 'https://ntfy.example/file/z' } }));
    s.close();
    await sleep(120); // several reconnectDelayMs
    process.off('unhandledRejection', onRej);
    assert.strictEqual(h.texts.length, 0);
    assert.strictEqual(h.files.length, 0);
    assert.strictEqual(h.cursors.length, 0);
    assert.strictEqual(h.statuses.length, statusesAtStop);
    assert.strictEqual(f.calls.length, before);
    assert.deepStrictEqual(rejections, []);
  },

  async 'stop() during a download cancels it and leaves no file or callback'() {
    let release;
    const gate = new Promise((r) => { release = r; });
    const slowBody = new ReadableStream({
      async start(c) {
        c.enqueue(enc.encode('part'));
        await gate;
        try { c.enqueue(enc.encode('rest')); c.close(); } catch {}
      },
    });
    const s = makeStream();
    const f = makeFetch({ streams: [s], files: {} });
    const h = harness();
    h.start(async (url, opts) => (url.endsWith('/file/slow') ? new Response(slowBody, { status: 200 }) : f(url, opts)));
    s.push(msg('m1', { attachment: { name: 'slow.bin', url: 'https://ntfy.example/file/slow' } }));
    await sleep(50);
    h.inbox.stop();
    release();
    await sleep(50);
    assert.strictEqual(h.files.length, 0);
    assert.strictEqual(h.cursors.length, 0);
  },

  async 'a throwing callback does not break the loop'() {
    const s = makeStream();
    const f = makeFetch({ streams: [s] });
    const h = harness({ onText: () => { throw new Error('boom'); }, onCursor: async () => { throw new Error('async boom'); } });
    const rejections = [];
    const onRej = (e) => rejections.push(e);
    process.on('unhandledRejection', onRej);
    h.start(f);
    s.push(msg('m1', { message: 'one' }));
    s.push(msg('m2', { message: 'two' }));
    await sleep(60);
    process.off('unhandledRejection', onRej);
    h.inbox.stop();
    assert.deepStrictEqual(rejections, []);
  },
};

(async () => {
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
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
  process.exit(failed ? 1 : 0);
})();
