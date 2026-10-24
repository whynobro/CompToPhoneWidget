// Phone -> PC inbox: subscribes to a private ntfy topic and saves shared files into Downloads.
// Plain Node (no Electron) so it can be tested directly. Nothing in here may throw into the
// caller: every failure is reported through onStatus and the loop keeps going.
const { Readable } = require('stream');
const { saveStream } = require('./downloads');

const SEEN_LIMIT = 500;
const MAX_ATTEMPTS = 3;
const MAX_RECONNECT_MS = 60000;

function startInbox(opts) {
  const {
    server = 'https://ntfy.sh',
    topic,
    dir,
    onFile,
    onText,
    onCursor,
    onStatus,
    fetchImpl = fetch,
    retryDelayMs = 2000, // base backoff between download attempts
    reconnectDelayMs = 2000, // base backoff between subscribe attempts, doubles up to 60 s
    stallMs = 90000, // keepalives come every ~45 s, so silence this long means a dead socket
  } = opts;
  const getDir = typeof dir === 'function' ? dir : () => dir;
  const base = String(server).replace(/\/+$/, '');
  let serverHost = '';
  try {
    serverHost = new URL(base).host;
  } catch {}

  let cursor = opts.since || '';
  let stopped = false;
  let conn = null; // AbortController of the current subscribe request
  let lastState = null;
  let queue = Promise.resolve();
  const stopCtl = new AbortController(); // aborts in-flight downloads
  const seen = new Set();
  const sleepers = new Set();

  // Callbacks are the caller's code: never let them throw into the loop, never fire after stop().
  function emit(fn, ...args) {
    if (stopped || typeof fn !== 'function') return;
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {}
  }

  function setState(state) {
    if (state === lastState) return;
    lastState = state;
    emit(onStatus, state);
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      if (stopped) return resolve();
      const s = { resolve };
      s.timer = setTimeout(() => {
        sleepers.delete(s);
        resolve();
      }, ms);
      sleepers.add(s);
    });
  }

  function remember(id) {
    seen.add(id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
  }

  async function download(msg, a) {
    let url;
    try {
      url = new URL(a.url);
    } catch {}
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new Error('Attachment has no usable link.');
    // Shared files are uploaded to the ntfy server itself. An external Attach: URL would let
    // anyone who knows the topic make this PC fetch arbitrary (even LAN) addresses.
    if (url.host !== serverHost) throw new Error(`${a.name || 'File'} is hosted outside ${serverHost}, skipped.`);
    if (a.expires && a.expires * 1000 < Date.now()) throw new Error(`${a.name || 'File'} expired on the server before it was downloaded.`);

    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !stopped; attempt++) {
      let permanent = false;
      try {
        const res = await fetchImpl(url.href, { signal: stopCtl.signal });
        if (!res.ok) {
          permanent = res.status === 404 || res.status === 410; // gone from the server, retrying will not help
          try { await res.body?.cancel(); } catch {}
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.body) throw new Error('empty response');
        const saved = await saveStream(getDir(), a.name || 'file', Readable.fromWeb(res.body));
        emit(onFile, { path: saved.path, name: saved.name, size: saved.size, messageId: msg.id });
        return;
      } catch (err) {
        lastErr = err;
        if (stopped || permanent) break;
        if (attempt < MAX_ATTEMPTS) await sleep(retryDelayMs * attempt);
      }
    }
    if (stopped) return;
    throw new Error(`Could not download ${a.name || 'file'}: ${lastErr ? lastErr.message : 'failed'}`);
  }

  async function handle(msg) {
    if (stopped || seen.has(msg.id)) return;
    remember(msg.id);
    try {
      if (msg.attachment && typeof msg.attachment === 'object') {
        // Any text on a file message is only its caption, so no onText for it.
        await download(msg, msg.attachment);
      } else if (typeof msg.message === 'string' && msg.message.trim()) {
        emit(onText, { title: msg.title || '', message: msg.message, click: msg.click || '', messageId: msg.id });
      }
    } catch (err) {
      emit(onStatus, 'error', err);
    }
    cursor = msg.id;
    emit(onCursor, msg.id);
  }

  function handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    if (!obj || obj.event !== 'message' || typeof obj.id !== 'string' || !obj.id) return;
    // Strictly one at a time, so files land in order and the cursor never skips ahead.
    queue = queue.then(() => handle(obj)).catch(() => {});
  }

  // One subscribe session. Resolves true if the server accepted the request, false otherwise.
  async function connectOnce() {
    const ctl = new AbortController();
    conn = ctl;
    let stall = null;
    let reader = null;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => ctl.abort(), stallMs);
    };
    try {
      arm();
      const url = `${base}/${encodeURIComponent(topic)}/json` + (cursor ? `?since=${encodeURIComponent(cursor)}` : '');
      const res = await fetchImpl(url, { signal: ctl.signal });
      if (!res.ok) {
        try { await res.body?.cancel(); } catch {}
        return false;
      }
      if (stopped) return true;
      setState('connected');
      if (!res.body) return true;
      reader = res.body.getReader();
      // A fetch stand-in may ignore the signal, so make abort end the read ourselves.
      ctl.signal.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true });
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // partial tail waits for the next chunk
        for (const line of lines) handleLine(line);
      }
      handleLine(buf + decoder.decode());
      return true;
    } finally {
      clearTimeout(stall);
      if (conn === ctl) conn = null;
      try { await reader?.cancel(); } catch {}
    }
  }

  async function run() {
    let delay = reconnectDelayMs;
    while (!stopped) {
      try {
        const ok = await connectOnce();
        if (ok) delay = reconnectDelayMs;
      } catch {}
      if (stopped) return;
      setState('disconnected');
      // Let queued downloads finish first so the reconnect cursor is current.
      await queue;
      await sleep(delay);
      delay = Math.min(delay * 2, Math.max(MAX_RECONNECT_MS, reconnectDelayMs));
    }
  }

  run().catch(() => {});

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      stopCtl.abort();
      try { conn?.abort(); } catch {}
      for (const s of sleepers) {
        clearTimeout(s.timer);
        s.resolve();
      }
      sleepers.clear();
    },
  };
}

module.exports = { startInbox };
