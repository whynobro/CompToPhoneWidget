// Phone -> PC: a tiny LAN HTTP server. The phone opens a page served from here and streams
// files straight into Downloads. Plain Node (no Electron) so it can be tested directly.
const http = require('http');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { saveStream } = require('./downloads');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_BAD = 20;
const MAX_TRACKED = 1000;
const PROGRESS_MS = 250;

// Adapters that never carry a phone's traffic (VMs, WSL, tethering stubs, capture drivers).
const VIRTUAL = /vethernet|wsl|hyper-v|virtualbox|vmware|loopback|bluetooth|npcap/i;

// The page is only ever meant for devices on the same network.
function ipv4Allowed(addr) {
  const p = addr.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return false;
  const [a, b] = p;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// Node usually reports ::ffff:1.2.3.4, but accept the hex form too.
function unmap(addr) {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (!hex) return addr;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

function normalizeAddress(addr) {
  return unmap(String(addr || '').replace(/%.*$/, '').toLowerCase());
}

function isPrivateAddress(raw) {
  const addr = normalizeAddress(raw);
  const kind = net.isIP(addr);
  if (kind === 4) return ipv4Allowed(addr);
  if (kind !== 6) return false;
  if (addr === '::1') return true;
  const first = parseInt(addr.split(':')[0] || '0', 16);
  return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00;
}

// Best address to put in the QR code comes first: home Wi-Fi ranges, then odd ones, then Tailscale.
function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      const p = a.address.split('.').map(Number);
      if (p[0] === 169 && p[1] === 254) continue;
      let rank = 3;
      if (p[0] === 192 && p[1] === 168) rank = 0;
      else if (p[0] === 10) rank = 1;
      else if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) rank = 2;
      if (/tailscale/i.test(name)) rank = 4;
      found.push({ address: a.address, rank });
    }
  }
  const seen = new Set();
  return found
    .sort((x, y) => x.rank - y.rank)
    .map((f) => f.address)
    .filter((ip) => !seen.has(ip) && seen.add(ip));
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";

// String.raw keeps the regex backslashes in the client script intact.
const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<title>Send to __PC__</title>
<style>
:root {
  --bg: #f2f2f7; --card: #ffffff; --text: #1c1c1e; --sub: #6c6c70; --track: rgba(120, 120, 128, 0.16);
  --blue: #0a84ff; --green: #30d158; --red: #ff453a;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #000000; --card: #1c1c1e; --text: #ffffff; --sub: #98989f; --track: rgba(120, 120, 128, 0.32); }
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html { color-scheme: light dark; -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh; overflow-x: hidden;
  background: var(--bg); color: var(--text);
  font: 16px/1.4 -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  padding: max(28px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(28px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
}
main { max-width: 520px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 28px; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; overflow-wrap: anywhere; }
.sub { margin: 0 0 22px; color: var(--sub); font-size: 16px; }
.pick {
  position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  min-height: 176px; padding: 24px 16px; border-radius: 20px; cursor: pointer; text-align: center;
  color: #fff; background: linear-gradient(160deg, #3b9bff, var(--blue) 55%, #0a6fe0);
  box-shadow: 0 10px 28px rgba(10, 132, 255, 0.28);
  transition: transform 0.12s ease, box-shadow 0.12s ease; user-select: none; -webkit-user-select: none;
}
.pick:active { transform: scale(0.98); box-shadow: 0 4px 14px rgba(10, 132, 255, 0.3); }
.pick:focus-within { outline: 3px solid rgba(10, 132, 255, 0.5); outline-offset: 3px; }
.pick.over { transform: scale(1.01); outline: 3px dashed #fff; outline-offset: -10px; }
.pick svg { width: 46px; height: 46px; }
.pick .big { font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.pick .hint { font-size: 14px; opacity: 0.85; }
@media (hover: none) { .pick .hint { display: none; } }
.pick input { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; clip: rect(0 0 0 0); }
#summary { margin: 22px 2px 10px; font-size: 15px; font-weight: 600; min-height: 0; }
#summary:empty { display: none; }
#summary.ok { color: var(--green); }
#summary.bad { color: var(--red); }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; align-items: center;
  padding: 13px 14px; border-radius: 14px; background: var(--card);
}
.name { grid-column: 1; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { grid-column: 1; font-size: 13px; color: var(--sub); overflow-wrap: anywhere; }
.row.error .meta { color: var(--red); }
.state { grid-column: 2; grid-row: 1 / span 2; display: flex; align-items: center; min-width: 26px; justify-content: flex-end; }
.state svg { width: 26px; height: 26px; }
.bar { grid-column: 1 / -1; height: 6px; margin-top: 9px; border-radius: 3px; background: var(--track); overflow: hidden; }
.bar i { display: block; height: 100%; width: 0; border-radius: 3px; background: var(--blue); transition: width 0.15s linear; }
.row.done .bar i { background: var(--green); width: 100%; }
.row.error .bar i { background: var(--red); }
button.retry {
  appearance: none; border: 0; border-radius: 999px; padding: 8px 16px; font: inherit; font-size: 14px; font-weight: 600;
  color: var(--blue); background: rgba(10, 132, 255, 0.14); cursor: pointer;
}
button.retry:active { opacity: 0.6; }
.tip { margin: 28px 8px 0; text-align: center; font-size: 13px; color: var(--sub); }
@media (prefers-reduced-motion: reduce) { .pick, .bar i { transition: none; } }
</style>
</head>
<body data-pc="__PC__">
<main>
  <h1>Send to __PC__</h1>
  <p class="sub">Files land in Downloads on your PC.</p>
  <label class="pick" id="drop">
    <input type="file" id="file" multiple>
    <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M24 33V9M14 19l10-10 10 10"/><path d="M8 29v7a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4v-7"/></svg>
    <span class="big">Choose photos or files</span>
    <span class="hint">or drop them here</span>
  </label>
  <p id="summary" role="status" aria-live="polite"></p>
  <ul id="list"></ul>
  <p class="tip">Tip: Add this page to your Home Screen for one tap next time.</p>
</main>
<script>
(function () {
  var pc = document.body.getAttribute('data-pc');
  var input = document.getElementById('file');
  var drop = document.getElementById('drop');
  var list = document.getElementById('list');
  var summary = document.getElementById('summary');
  var base = location.pathname.replace(/\/$/, '') + '/upload';
  var items = [];
  var running = false;
  var CHECK = '<svg viewBox="0 0 26 26" aria-label="Sent"><circle cx="13" cy="13" r="13" fill="#30d158"/><path d="M7.5 13.5l3.7 3.7 7.3-7.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function fmt(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function build(it) {
    it.row = el('li', 'row');
    it.nameEl = el('div', 'name', it.file.name || 'file');
    it.metaEl = el('div', 'meta');
    it.stateEl = el('div', 'state');
    var bar = el('div', 'bar');
    it.fill = el('i');
    bar.appendChild(it.fill);
    it.row.appendChild(it.nameEl);
    it.row.appendChild(it.stateEl);
    it.row.appendChild(it.metaEl);
    it.row.appendChild(bar);
    list.appendChild(it.row);
  }

  function paint(it, frac, msg) {
    var size = fmt(it.file.size);
    it.row.className = 'row ' + it.state;
    it.stateEl.textContent = '';
    if (it.state === 'queued') it.metaEl.textContent = size + ' · Waiting';
    if (it.state === 'sending') {
      it.metaEl.textContent = size + ' · ' + Math.round((frac || 0) * 100) + '%';
      it.fill.style.width = Math.round((frac || 0) * 100) + '%';
    }
    if (it.state === 'queued') it.fill.style.width = '0';
    if (it.state === 'done') {
      it.metaEl.textContent = size + ' · Sent';
      it.stateEl.innerHTML = CHECK;
    }
    if (it.state === 'error') {
      it.metaEl.textContent = msg || 'Failed';
      var b = el('button', 'retry', 'Retry');
      b.type = 'button';
      b.onclick = function () { it.state = 'queued'; paint(it); summarize(); pump(); };
      it.stateEl.appendChild(b);
    }
  }

  function summarize() {
    var done = 0, bad = 0, left = 0;
    items.forEach(function (it) {
      if (it.state === 'done') done++;
      else if (it.state === 'error') bad++;
      else left++;
    });
    var text = '';
    if (left) text = 'Sending ' + (done + bad + 1) + ' of ' + items.length + '…';
    else if (items.length) text = done + ' sent to ' + pc + (bad ? ', ' + bad + ' failed' : '');
    summary.textContent = text;
    summary.className = left ? '' : (bad ? 'bad' : (done ? 'ok' : ''));
  }

  function finish(it, state, msg) {
    if (it.state !== 'sending') return;
    it.state = state;
    running = false;
    paint(it, 1, msg);
    summarize();
    pump();
  }

  function upload(it) {
    it.state = 'sending';
    running = true;
    paint(it, 0);
    summarize();
    var x = new XMLHttpRequest();
    x.open('POST', base);
    x.setRequestHeader('X-Filename', encodeURIComponent(it.file.name || 'file'));
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = function (e) {
      if (e.lengthComputable && it.state === 'sending') paint(it, e.loaded / e.total);
    };
    x.onload = function () {
      var r = null;
      try { r = JSON.parse(x.responseText); } catch (e) {}
      if (x.status === 200 && r && r.ok) finish(it, 'done');
      else finish(it, 'error', (r && r.message) || 'Failed (HTTP ' + x.status + ')');
    };
    x.onerror = function () { finish(it, 'error', 'Connection lost'); };
    x.ontimeout = x.onerror;
    x.onabort = x.onerror;
    x.send(it.file);
  }

  function pump() {
    if (running) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].state === 'queued') return upload(items[i]);
    }
  }

  function add(files) {
    for (var i = 0; i < files.length; i++) {
      var it = { file: files[i], state: 'queued' };
      build(it);
      paint(it);
      items.push(it);
    }
    summarize();
    pump();
  }

  input.addEventListener('change', function () {
    var picked = Array.prototype.slice.call(input.files || []);
    input.value = '';
    if (picked.length) add(picked);
  });

  ['dragenter', 'dragover'].forEach(function (t) {
    window.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    window.addEventListener(t, function (e) {
      e.preventDefault();
      if (t === 'drop' || e.target === document.documentElement || !e.relatedTarget) drop.classList.remove('over');
    });
  });
  window.addEventListener('drop', function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) add(Array.prototype.slice.call(files));
  });

  window.addEventListener('beforeunload', function (e) {
    var busy = items.some(function (it) { return it.state === 'sending' || it.state === 'queued'; });
    if (!busy) return;
    e.preventDefault();
    e.returnValue = '';
  });
})();
</script>
</body>
</html>
`;

function renderPage(pcName) {
  return PAGE.replace(/__PC__/g, () => escapeHtml(pcName));
}

function friendlyError(err) {
  if (err && err.code === 'ENOSPC') return 'The PC is out of disk space.';
  if (err && (err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE')) return 'Upload was interrupted.';
  return 'Could not save the file on the PC.';
}

async function listen(server, port) {
  const attempt = (p) => new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(p, '0.0.0.0', () => {
      server.off('error', onError);
      resolve();
    });
  });
  try {
    await attempt(port);
  } catch (err) {
    if (err.code !== 'EADDRINUSE' || !port) throw err;
    await attempt(0);
  }
}

async function startDropServer({ port = 47800, token, dir, pcName = 'your PC', onReceived, onProgress } = {}) {
  if (!token) throw new Error('A token is required.');
  const tokenBuf = Buffer.from(String(token));
  const page = renderPage(pcName);
  const getDir = typeof dir === 'function' ? dir : () => dir;
  const bad = new Map(); // ip -> { count, start }, oldest window first
  const sockets = new Set();

  // Compares the first path segment without leaking how much of the token matched.
  const tokenMatches = (seg) => {
    const given = Buffer.from(seg);
    return given.length === tokenBuf.length && crypto.timingSafeEqual(given, tokenBuf);
  };

  const isLimited = (ip, now) => {
    const e = bad.get(ip);
    if (!e) return false;
    if (now - e.start > WINDOW_MS) {
      bad.delete(ip);
      return false;
    }
    return e.count >= MAX_BAD;
  };

  const recordBad = (ip, now) => {
    if (bad.size >= MAX_TRACKED) {
      for (const [k, e] of bad) if (now - e.start > WINDOW_MS) bad.delete(k);
      if (bad.size >= MAX_TRACKED) bad.delete(bad.keys().next().value);
    }
    let e = bad.get(ip);
    if (!e || now - e.start > WINDOW_MS) {
      bad.delete(ip);
      e = { count: 0, start: now };
      bad.set(ip, e);
    }
    e.count++;
  };

  const reply = (res, status, type, body) => {
    if (res.headersSent || res.destroyed) return;
    res.statusCode = status;
    res.setHeader('Content-Type', type);
    res.end(body);
  };
  const text = (res, status, body) => reply(res, status, 'text/plain; charset=utf-8', body);
  const json = (res, status, obj) => reply(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));

  async function receive(req, res) {
    let name = 'file';
    try {
      name = decodeURIComponent(req.headers['x-filename'] || '') || 'file';
    } catch {}
    const total = parseInt(req.headers['content-length'], 10) || 0;
    let last = 0;
    try {
      const saved = await saveStream(getDir(), name, req, (received) => {
        if (!onProgress) return;
        const now = Date.now();
        if (now - last < PROGRESS_MS) return;
        last = now;
        try { onProgress({ name, received, total }); } catch {}
      });
      try { onReceived?.(saved); } catch {}
      json(res, 200, { ok: true, name: saved.name });
    } catch (err) {
      json(res, 500, { ok: false, message: friendlyError(err) });
    }
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const remote = req.socket.remoteAddress;
    if (!isPrivateAddress(remote)) return text(res, 403, 'Forbidden');

    const ip = normalizeAddress(remote);
    const now = Date.now();
    if (isLimited(ip, now)) return text(res, 429, 'Too many requests');

    const pathname = (req.url || '').split('?')[0];
    const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!m || !tokenMatches(m[1])) {
      // Browsers ask for this on their own; it is not a guess at the token.
      if (pathname !== '/favicon.ico') recordBad(ip, now);
      return text(res, 404, 'Not found');
    }

    const rest = m[2] || '';
    if ((req.method === 'GET' || req.method === 'HEAD') && (rest === '' || rest === '/')) {
      res.setHeader('Content-Security-Policy', PAGE_CSP);
      return reply(res, 200, 'text/html; charset=utf-8', req.method === 'HEAD' ? undefined : page);
    }
    if (req.method === 'POST' && rest === '/upload') return void receive(req, res);
    text(res, 404, 'Not found');
  });

  // The default 5 minute request timeout would cut off big videos on a slow Wi-Fi link.
  server.requestTimeout = 0;
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  await listen(server, port);

  return {
    port: server.address().port,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      });
    },
  };
}

module.exports = { startDropServer, lanAddresses, isPrivateAddress };
