// Phone -> PC: a tiny LAN HTTP server. The phone opens a page served from here and streams
// files straight into Downloads or a folder it picks, or sends a quick message (a link or a note).
// Plain Node (no Electron) so it can be tested directly.
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { saveStream, safeName } = require('./downloads');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_BAD = 20;
const MAX_TRACKED = 1000;
const PROGRESS_MS = 250;
const MAX_FOLDERS = 1000;
const MAX_TEXT = 100 * 1024; // bytes of UTF-8 a message may carry

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

const WIN = process.platform === 'win32';
const fold = (p) => (WIN ? p.toLowerCase() : p);
const within = (base, p) => {
  const b = fold(base);
  const q = fold(p);
  return q === b || q.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};
const folderError = (status, message) => Object.assign(new Error(message), { status });
const isDir = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};

// A folder the phone asked for (root id + "a/b/c"), proven to sit inside that root even through
// junctions. Throws an error with .status (400 bad input, 404 gone). Never creates folders, except
// that the default root with no path is left to saveStream, as before.
function resolveFolder(roots, rootId, rel) {
  const root = rootId ? roots.find((r) => r.id === rootId) : roots[0];
  if (!root) throw folderError(400, 'Unknown destination.');
  const text = String(rel || '');
  const bad = () => folderError(400, 'That folder name is not allowed.');
  if (text.startsWith('/')) throw bad();
  const segs = text.split('/').filter(Boolean);
  for (const s of segs) if (s === '.' || s === '..' || s !== safeName(s)) throw bad();
  const base = path.resolve(root.path);
  const dir = path.resolve(base, ...segs);
  if (!within(base, dir)) throw bad();
  if (!segs.length && root === roots[0]) return { root, dir, rel: '' };
  let realBase;
  let realDir;
  try {
    realBase = fs.realpathSync(base);
    realDir = fs.realpathSync(dir);
  } catch {
    throw folderError(404, 'That folder no longer exists on the PC.');
  }
  if (!within(realBase, realDir)) throw bad();
  if (!isDir(realDir)) throw folderError(404, 'That folder no longer exists on the PC.');
  return { root, dir, rel: segs.join('/') };
}

// Immediate subfolders worth offering: no hidden, no Office lock files, no links, nothing safeName would change.
async function listFolders(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !e.name.startsWith('~$') && e.name === safeName(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
    .slice(0, MAX_FOLDERS);
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
h1 { margin: 0 0 14px; font-size: 28px; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; overflow-wrap: anywhere; }
.dest { display: flex; align-items: center; gap: 12px; margin: 0 0 22px; padding: 10px 12px 10px 14px; border-radius: 14px; background: var(--card); }
.dest .txt { flex: 1; min-width: 0; }
.dest .k { display: block; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--sub); }
.dest .v { display: block; font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
button.chg {
  appearance: none; border: 0; border-radius: 999px; padding: 0 18px; min-height: 44px; font: inherit; font-size: 15px; font-weight: 600;
  color: var(--blue); background: rgba(10, 132, 255, 0.14); cursor: pointer; flex: none;
}
button.chg:active { opacity: 0.6; }
[hidden] { display: none !important; }
.sheet { position: fixed; inset: 0; z-index: 10; display: flex; align-items: flex-end; justify-content: center; background: rgba(0, 0, 0, 0.45); }
.panel {
  display: flex; flex-direction: column; width: 100%; max-width: 520px; max-height: 88vh; max-height: 88dvh;
  background: var(--bg); border-radius: 20px 20px 0 0; overflow: hidden;
}
.phead { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 6px 8px; }
.phead h2 { margin: 0; font-size: 17px; font-weight: 600; text-align: center; }
button.link {
  appearance: none; border: 0; background: none; min-height: 44px; padding: 0 10px; font: inherit; font-size: 16px; color: var(--blue); cursor: pointer; justify-self: start;
}
button.link:active { opacity: 0.6; }
.where { margin: 0 16px 8px; font-size: 13px; color: var(--sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pbody { flex: 1; min-height: 120px; overflow-y: auto; padding: 0 16px 8px; -webkit-overflow-scrolling: touch; }
.prows { border-radius: 14px; background: var(--card); overflow: hidden; }
.prows:empty { display: none; }
button.prow {
  appearance: none; border: 0; border-top: 0.5px solid var(--track); display: flex; align-items: center; gap: 10px; width: 100%; min-height: 48px; padding: 8px 14px;
  background: none; color: var(--text); font: inherit; font-size: 16px; text-align: left; cursor: pointer;
}
button.prow:first-child { border-top: 0; }
button.prow:active { background: var(--track); }
button.prow .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.prow svg { width: 10px; height: 16px; flex: none; color: var(--sub); }
button.prow.up { color: var(--blue); }
button.prow.up svg { color: var(--blue); }
.pmsg { padding: 18px 4px; text-align: center; font-size: 15px; color: var(--sub); }
.perr { margin: 8px 4px 0; font-size: 14px; font-weight: 600; color: var(--red); }
.pfoot { padding: 8px 16px max(16px, env(safe-area-inset-bottom)); }
button.save {
  appearance: none; border: 0; width: 100%; min-height: 50px; border-radius: 14px; font: inherit; font-size: 17px; font-weight: 600;
  color: #fff; background: var(--blue); cursor: pointer;
}
button.save:active { opacity: 0.8; }
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
.msg { margin: 22px 0 0; padding: 14px; border-radius: 20px; background: var(--card); }
.msg label { display: block; margin: 0 2px 8px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--sub); }
.msg textarea {
  display: block; width: 100%; min-height: 84px; max-height: 40vh; resize: vertical; margin: 0; padding: 10px 12px; border: 0; border-radius: 12px;
  background: var(--track); color: var(--text); font: inherit; font-size: 16px; line-height: 1.35; overflow-wrap: anywhere;
}
.msg textarea:focus { outline: 2px solid var(--blue); outline-offset: 0; }
.msg .go { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
.msg .go p { flex: 1; min-width: 0; margin: 0 2px; font-size: 14px; font-weight: 600; color: var(--sub); overflow-wrap: anywhere; }
.msg .go p.ok { color: var(--green); }
.msg .go p.bad { color: var(--red); }
button.send {
  appearance: none; border: 0; flex: none; min-width: 96px; min-height: 44px; padding: 0 20px; border-radius: 999px; font: inherit; font-size: 16px; font-weight: 600;
  color: #fff; background: var(--blue); cursor: pointer;
}
button.send:active { opacity: 0.8; }
button.send:disabled { opacity: 0.4; cursor: default; }
.tip { margin: 28px 8px 0; text-align: center; font-size: 13px; color: var(--sub); }
@media (prefers-reduced-motion: reduce) { .pick, .bar i { transition: none; } }
</style>
</head>
<body data-pc="__PC__">
<main>
  <h1>Send to __PC__</h1>
  <div class="dest">
    <div class="txt"><span class="k">Save to</span><span class="v" id="destName">Downloads</span></div>
    <button type="button" class="chg" id="change">Change</button>
  </div>
  <label class="pick" id="drop">
    <input type="file" id="file" multiple>
    <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M24 33V9M14 19l10-10 10 10"/><path d="M8 29v7a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4v-7"/></svg>
    <span class="big">Choose photos or files</span>
    <span class="hint">or drop them here</span>
  </label>
  <p id="summary" role="status" aria-live="polite"></p>
  <ul id="list"></ul>
  <form class="msg" id="msgForm" autocomplete="off">
    <label for="msg">Or send a message</label>
    <textarea id="msg" rows="3" placeholder="Paste a link or type a note" enterkeyhint="send"></textarea>
    <div class="go">
      <p id="msgStatus" role="status" aria-live="polite"></p>
      <button type="submit" class="send" id="msgSend" disabled>Send</button>
    </div>
  </form>
  <p class="tip">Tip: Add this page to your Home Screen for one tap next time.</p>
</main>
<div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" hidden>
  <div class="panel">
    <div class="phead">
      <button type="button" class="link" id="cancel">Cancel</button>
      <h2 id="sheetTitle">Save to</h2>
      <span></span>
    </div>
    <p class="where" id="where"></p>
    <div class="pbody">
      <div class="prows" id="prows"></div>
      <p class="pmsg" id="pmsg" hidden></p>
      <p class="perr" id="perr" role="alert" hidden></p>
    </div>
    <div class="pfoot"><button type="button" class="save" id="saveHere" hidden>Save here</button></div>
  </div>
</div>
<script>
(function () {
  var pc = document.body.getAttribute('data-pc');
  var input = document.getElementById('file');
  var drop = document.getElementById('drop');
  var list = document.getElementById('list');
  var summary = document.getElementById('summary');
  var root = location.pathname.replace(/\/$/, '');
  var base = root + '/upload';
  var destName = document.getElementById('destName');
  var sheet = document.getElementById('sheet');
  var prows = document.getElementById('prows');
  var pmsg = document.getElementById('pmsg');
  var perr = document.getElementById('perr');
  var where = document.getElementById('where');
  var saveHere = document.getElementById('saveHere');
  var KEY = 'stp-dest';
  var dest = { root: '', rootName: 'Downloads', path: '' };
  var picked = false;
  var nav = null;
  var navSeq = 0;
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
      it.metaEl.textContent = size + ' · Sent to ' + short(it.dest);
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

  function short(d) {
    if (!d.path) return d.rootName;
    var p = d.path.split('/');
    return p[p.length - 1];
  }

  // One shared folder is named; a mixed batch falls back to the PC name.
  function sentTo() {
    var seen = {}, names = [];
    items.forEach(function (it) {
      if (it.state !== 'done') return;
      var k = it.dest.root + '|' + it.dest.path;
      if (!seen[k]) { seen[k] = 1; names.push(short(it.dest)); }
    });
    return names.length === 1 ? names[0] : pc;
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
    else if (items.length) text = done + ' sent to ' + sentTo() + (bad ? ', ' + bad + ' failed' : '');
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
    if (it.dest.root) x.setRequestHeader('X-Root', it.dest.root);
    if (it.dest.path) x.setRequestHeader('X-Path', encodeURIComponent(it.dest.path));
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
      var it = { file: files[i], state: 'queued', dest: { root: dest.root, rootName: dest.rootName, path: dest.path } };
      build(it);
      paint(it);
      items.push(it);
    }
    summarize();
    pump();
  }

  function label(rootName, path) {
    var parts = [rootName].concat(path ? path.split('/') : []);
    if (parts.length > 3) parts = [parts[0], '…', parts[parts.length - 2], parts[parts.length - 1]];
    return parts.join(' › ');
  }

  function paintDest() {
    destName.textContent = label(dest.rootName, dest.path);
    destName.title = [dest.rootName].concat(dest.path ? dest.path.split('/') : []).join(' › ');
  }

  function store(v) {
    try {
      if (v) localStorage.setItem(KEY, JSON.stringify({ root: v.root, path: v.path }));
      else localStorage.removeItem(KEY);
    } catch (e) {}
  }

  function recall() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (v && typeof v.root === 'string' && v.root && typeof v.path === 'string') return v;
    } catch (e) {}
    return null;
  }

  function query(rootId, path, cb) {
    var x = new XMLHttpRequest();
    var q = rootId ? '?root=' + encodeURIComponent(rootId) + '&path=' + encodeURIComponent(path || '') : '';
    x.open('GET', root + '/folders' + q);
    x.onload = function () {
      var r = null;
      try { r = JSON.parse(x.responseText); } catch (e) {}
      if (x.status === 200 && r) cb(null, r);
      else cb((r && r.message) || 'Could not load folders (HTTP ' + x.status + ')');
    };
    x.onerror = function () { cb('Connection lost'); };
    x.ontimeout = x.onerror;
    x.send();
  }

  function chevron(flip) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 10 16');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', flip ? 'M8 1L2 8l6 7' : 'M2 1l6 7-6 7');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p);
    return s;
  }

  function rowBtn(text, cls, flip, onTap) {
    var b = el('button', 'prow' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    if (flip) b.appendChild(chevron(true));
    b.appendChild(el('span', 'nm', text));
    if (!flip) b.appendChild(chevron(false));
    b.onclick = onTap;
    return b;
  }

  function showMsg(text) {
    pmsg.textContent = text || '';
    pmsg.hidden = !text;
  }

  function showErr(text) {
    perr.textContent = text || '';
    perr.hidden = !text;
  }

  function render() {
    prows.textContent = '';
    showMsg('');
    if (!nav.root) {
      where.textContent = 'Choose a location';
      saveHere.hidden = true;
      nav.roots.forEach(function (r) {
        prows.appendChild(rowBtn(r.name, '', false, function () { browse(r.id, ''); }));
      });
      if (!nav.roots.length) showMsg('No folders available.');
      return;
    }
    saveHere.hidden = false;
    where.textContent = label(nav.rootName, nav.path);
    var segs = nav.path ? nav.path.split('/') : [];
    var parentName = segs.length > 1 ? segs[segs.length - 2] : (segs.length ? nav.rootName : 'All locations');
    prows.appendChild(rowBtn(parentName, 'up', true, function () {
      if (!segs.length) return browseRoots();
      browse(nav.root, segs.slice(0, -1).join('/'));
    }));
    nav.folders.forEach(function (name) {
      prows.appendChild(rowBtn(name, '', false, function () { browse(nav.root, segs.concat(name).join('/')); }));
    });
    if (!nav.folders.length) showMsg('No folders in here.');
  }

  function loading() {
    showErr('');
    showMsg('Loading…');
  }

  function browseRoots() {
    var seq = ++navSeq;
    loading();
    query('', '', function (err, r) {
      if (seq !== navSeq) return;
      if (err) { showMsg(''); showErr(err); return; }
      nav = { root: '', roots: r.roots || [] };
      render();
    });
  }

  function browse(rootId, path, fallbackToTop) {
    var seq = ++navSeq;
    loading();
    query(rootId, path, function (err, r) {
      if (seq !== navSeq) return;
      if (err) {
        if (fallbackToTop) return browseRoots();
        showMsg('');
        showErr(err);
        if (nav) render();
        return;
      }
      nav = { root: r.root, rootName: r.rootName, path: r.path || '', folders: r.folders || [] };
      render();
    });
  }

  function openSheet() {
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    nav = null;
    prows.textContent = '';
    saveHere.hidden = true;
    where.textContent = '';
    if (dest.root) browse(dest.root, dest.path, true);
    else browseRoots();
  }

  function closeSheet() {
    navSeq++;
    sheet.hidden = true;
    document.body.style.overflow = '';
    document.getElementById('change').focus();
  }

  document.getElementById('change').addEventListener('click', openSheet);
  document.getElementById('cancel').addEventListener('click', closeSheet);
  sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });
  saveHere.addEventListener('click', function () {
    if (!nav || !nav.root) return;
    dest = { root: nav.root, rootName: nav.rootName, path: nav.path };
    picked = true;
    store(dest);
    paintDest();
    closeSheet();
  });

  // Reuse the last pick only if the PC still has that folder; otherwise quietly use the default.
  function initDest() {
    function useDefault() {
      query('', '', function (err, r) {
        if (err || !r.roots || !r.roots.length || picked) return;
        dest = { root: '', rootName: r.roots[0].name, path: '' };
        paintDest();
      });
    }
    var saved = recall();
    if (!saved) return useDefault();
    query(saved.root, saved.path, function (err, r) {
      if (err || !r.root) {
        store(null);
        return useDefault();
      }
      if (picked) return;
      dest = { root: r.root, rootName: r.rootName, path: r.path || '' };
      paintDest();
    });
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

  // Quick message: a link opens from the PC's toast, anything else lands on the PC clipboard.
  var msgForm = document.getElementById('msgForm');
  var msg = document.getElementById('msg');
  var msgSend = document.getElementById('msgSend');
  var msgStatus = document.getElementById('msgStatus');
  var msgBusy = false;

  function msgState(text, cls) {
    msgStatus.textContent = text || '';
    msgStatus.className = cls || '';
  }

  function msgReady() {
    msgSend.disabled = msgBusy || !msg.value.trim();
  }

  function sendMsg() {
    var text = msg.value.trim();
    if (!text || msgBusy) return;
    msgBusy = true;
    msgReady();
    msgState('Sending…');
    var link = /^https?:\/\/\S+$/i.test(text);
    var x = new XMLHttpRequest();
    x.open('POST', root + '/text');
    x.setRequestHeader('Content-Type', 'text/plain; charset=utf-8');
    x.onload = function () {
      var r = null;
      try { r = JSON.parse(x.responseText); } catch (e) {}
      msgBusy = false;
      if (x.status === 200 && r && r.ok) {
        if (msg.value.trim() === text) msg.value = '';
        msgState(link ? 'Link sent. Click the toast on ' + pc + ' to open it.' : 'Copied to the clipboard on ' + pc + '.', 'ok');
      } else {
        msgState((r && r.message) || 'Failed (HTTP ' + x.status + ')', 'bad');
      }
      msgReady();
    };
    x.onerror = function () {
      msgBusy = false;
      msgState('Connection lost', 'bad');
      msgReady();
    };
    x.ontimeout = x.onerror;
    x.onabort = x.onerror;
    x.send(text);
  }

  msgForm.addEventListener('submit', function (e) { e.preventDefault(); sendMsg(); });
  msg.addEventListener('input', function () { msgReady(); if (msgStatus.className !== '') msgState(''); });
  // Enter adds a line on a phone keyboard; Ctrl/Cmd+Enter sends from a real keyboard.
  msg.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMsg(); }
  });

  initDest();

  window.addEventListener('beforeunload', function (e) {
    var busy = msgBusy || items.some(function (it) { return it.state === 'sending' || it.state === 'queued'; });
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

async function startDropServer({ port = 47800, token, dir, roots, pcName = 'your PC', onReceived, onProgress, onText } = {}) {
  if (!token) throw new Error('A token is required.');
  const tokenBuf = Buffer.from(String(token));
  const page = renderPage(pcName);
  const getDir = typeof dir === 'function' ? dir : () => dir;
  // Looked up per request so the list follows OneDrive being set up or removed.
  const getRoots = typeof roots === 'function' ? roots
    : Array.isArray(roots) ? () => roots
    : () => [{ id: 'downloads', name: 'Downloads', path: getDir() }];
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

  // Answer first, then drain, so the phone sees the JSON instead of a reset connection.
  const fail = (req, res, err) => {
    const known = err && err.status;
    json(res, known || 500, { ok: false, message: known ? err.message : friendlyError(err) });
    req.resume();
  };

  const decodeRel = (v) => {
    try {
      return decodeURIComponent(v || '');
    } catch {
      throw folderError(400, 'That folder name is not allowed.');
    }
  };

  async function receive(req, res) {
    let name = 'file';
    try {
      name = decodeURIComponent(req.headers['x-filename'] || '') || 'file';
    } catch {}
    const total = parseInt(req.headers['content-length'], 10) || 0;
    let last = 0;
    try {
      const target = resolveFolder(getRoots(), String(req.headers['x-root'] || ''), decodeRel(req.headers['x-path']));
      const saved = await saveStream(target.dir, name, req, (received) => {
        if (!onProgress) return;
        const now = Date.now();
        if (now - last < PROGRESS_MS) return;
        last = now;
        try { onProgress({ name, received, total }); } catch {}
      });
      try { onReceived?.(saved); } catch {}
      json(res, 200, { ok: true, name: saved.name, folder: target.root.name + (target.rel ? '/' + target.rel : '') });
    } catch (err) {
      fail(req, res, err);
    }
  }

  // A quick message from the page. Collected whole (it is small), never written to disk.
  function receiveText(req, res) {
    const declared = parseInt(req.headers['content-length'], 10);
    if (declared > MAX_TEXT) return fail(req, res, folderError(413, 'That message is too long.'));
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_TEXT) {
        over = true;
        chunks.length = 0;
        return fail(req, res, folderError(413, 'That message is too long.'));
      }
      chunks.push(c);
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (over) return;
      const message = Buffer.concat(chunks).toString('utf8').replace(/\r\n?/g, '\n').trim();
      if (!message) return json(res, 400, { ok: false, message: 'The message is empty.' });
      try {
        onText?.({ message });
      } catch {
        return json(res, 500, { ok: false, message: 'Could not deliver the message on the PC.' });
      }
      json(res, 200, { ok: true });
    });
  }

  // Lists what the phone may pick from. Only ids and display names go out, never PC paths.
  async function folders(req, res, query) {
    try {
      const list = getRoots();
      const id = query.get('root');
      if (!id) return json(res, 200, { roots: list.filter((r) => isDir(r.path)).map((r) => ({ id: r.id, name: r.name })) });
      const target = resolveFolder(list, id, query.get('path'));
      let names;
      try {
        names = await listFolders(target.dir);
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw folderError(404, 'That folder no longer exists on the PC.');
        throw folderError(500, 'Could not read that folder.');
      }
      json(res, 200, { root: target.root.id, rootName: target.root.name, path: target.rel, folders: names });
    } catch (err) {
      const known = err && err.status;
      json(res, known || 500, { ok: false, message: known ? err.message : 'Could not read that folder.' });
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

    const [pathname, queryString = ''] = (req.url || '').split('?');
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
    if (req.method === 'POST' && rest === '/text') return void receiveText(req, res);
    if (req.method === 'GET' && rest === '/folders') return void folders(req, res, new URLSearchParams(queryString));
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

module.exports = { startDropServer, lanAddresses, isPrivateAddress, renderPage, resolveFolder };
