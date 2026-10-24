// Renders the README media in docs/media from the app's real widget.html CSS + markup,
// over a synthetic wallpaper. Run: npm run media (ONLY=banner|states|taskbar|receive|gif for one).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { renderPage } = require('../src/dropserver');

const proj = path.join(__dirname, '..');
const out = path.join(proj, 'docs', 'media');
const widget = fs.readFileSync(path.join(proj, 'src', 'widget.html'), 'utf8');
const CSS = widget.match(/<style>([\s\S]*?)<\/style>/)[1];
const cardHtml = widget.match(/(<div class="card"[\s\S]*?)<script>\nconst card/)[1].trim();
const ICON = 'file:///' + path.join(proj, 'assets', 'icon.png').replace(/\\/g, '/');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-media-'));
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(out, { recursive: true });

// Synthetic wallpaper (never the user's real one).
const WP = `radial-gradient(42% 60% at 12% 18%, #7b5cff 0%, rgba(123,92,255,0) 70%),
  radial-gradient(40% 55% at 88% 22%, #ff4f9a 0%, rgba(255,79,154,0) 70%),
  radial-gradient(55% 70% at 70% 105%, #ffb03a 0%, rgba(255,176,58,0) 65%),
  radial-gradient(45% 55% at 38% 78%, #00b7ff 0%, rgba(0,183,255,0) 70%),
  linear-gradient(140deg, #0d1240 0%, #241056 55%, #3a0f3f 100%)`;

function card(state, title, sub) {
  return cardHtml
    .replace(/ id="\w+"/g, '')
    .replace('data-state="idle"', `data-state="${state}"`)
    .replace('>Send to Phone</div>', `>${title}</div>`)
    .replace('>Drop files or click</div>', `>${sub}</div>`);
}
const tile = (x, y, z, state, title, sub, cls = '') =>
  `<div class="tile ${cls}" style="left:${x / z}px;top:${y / z}px;zoom:${z}" data-z="${z}">${card(state, title, sub)}</div>`;
const capsule = (state, title, light) =>
  `<div class="cap bar ${light ? 'light' : ''}">${card(state, title, '')}</div>`;

const PAGE_CSS = `
  ${CSS}
  html, body { overflow: hidden; }
  body { margin: 0; position: relative; background: ${WP}; background-size: 100% 100%; font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; color: #fff; }
  .tile { position: absolute; width: 168px; height: 168px; }
  .tile .wall { background-image: ${WP}; }
  .cap { width: 150px; height: 48px; display: grid; place-items: center; flex: none; }
`;

// Align every tile's blurred wallpaper layer with the page background, like the app does.
const ALIGN = `<script>
function align() {
  const W = document.body.clientWidth, H = document.body.clientHeight;
  for (const t of document.querySelectorAll('.tile')) {
    const z = +t.dataset.z, r = t.getBoundingClientRect();
    const w = t.querySelector('.wall');
    Object.assign(w.style, { left: -(r.left + 16 * z) / z + 'px', top: -(r.top + 16 * z) / z + 'px',
      width: W / z + 'px', height: H / z + 'px', backgroundSize: W / z + 'px ' + H / z + 'px' });
  }
}
align();
</script>`;

const page = (w, h, body, extraCss = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
  ${PAGE_CSS}
  body { width: ${w}px; height: ${h}px; }
  ${extraCss}
</style></head><body>${body}${ALIGN}</body></html>`;

// ---------- banner (1280x640, also the social preview) ----------
const PHONE_CSS = `
  .copy { position: absolute; left: 84px; top: 128px; width: 560px; }
  .pill { display: inline-flex; gap: 8px; align-items: center; padding: 7px 14px; border-radius: 999px; font-size: 15px; font-weight: 600;
    background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.22); backdrop-filter: blur(12px); letter-spacing: .01em; }
  .pill i { width: 8px; height: 8px; border-radius: 50%; background: #30d158; box-shadow: 0 0 10px #30d158; }
  h1 { font-size: 92px; line-height: .98; margin: 22px 0 18px; font-weight: 750; letter-spacing: -.035em;
    background: linear-gradient(180deg, #fff 30%, rgba(255,255,255,.72)); -webkit-background-clip: text; color: transparent; }
  .tag { font-size: 29px; line-height: 1.3; font-weight: 500; color: rgba(255,255,255,.86); letter-spacing: -.01em; }
  .chips { display: flex; gap: 10px; margin-top: 30px; }
  .chip { padding: 9px 15px; border-radius: 12px; font-size: 16px; font-weight: 600; background: rgba(0,0,0,.22); border: 1px solid rgba(255,255,255,.14); }
  .chip b { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 8px; vertical-align: 1px; }
  .fine { margin-top: 22px; font-size: 16px; color: rgba(255,255,255,.62); font-weight: 500; }
  .file { position: absolute; left: 640px; top: 168px; display: flex; gap: 10px; align-items: center; padding: 10px 14px 10px 10px; border-radius: 14px;
    background: rgba(255,255,255,.9); color: #1d1d1f; font-size: 15px; font-weight: 600; box-shadow: 0 18px 40px -12px rgba(0,0,0,.5); transform: rotate(-6deg); z-index: 5; }
  .file .doc { width: 30px; height: 36px; border-radius: 6px; background: linear-gradient(160deg, #ff8a3d, #ff3d6e); position: relative; }
  .file .doc::after { content: "MP4"; position: absolute; bottom: 4px; left: 0; right: 0; text-align: center; font-size: 8px; color: #fff; font-weight: 800; }
  .file small { display: block; color: #6e6e73; font-weight: 500; font-size: 12px; }
  .cursor { position: absolute; left: 792px; top: 214px; z-index: 6; filter: drop-shadow(0 2px 3px rgba(0,0,0,.4)); }
  .arc { position: absolute; left: 0; top: 0; z-index: 1; }
  .phone { position: absolute; left: 1004px; top: 96px; width: 238px; height: 500px; border-radius: 44px; background: #0b0b0f; padding: 10px; box-sizing: border-box;
    box-shadow: 0 0 0 2px rgba(255,255,255,.18), 0 40px 80px -20px rgba(0,0,0,.7); transform: rotate(4deg); z-index: 2; }
  .screen { width: 100%; height: 100%; border-radius: 35px; overflow: hidden; position: relative;
    background: radial-gradient(80% 60% at 20% 10%, #5b6cff, transparent 70%), radial-gradient(70% 60% at 90% 90%, #ff5fa2, transparent 70%), #1a1446; }
  .island { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); width: 76px; height: 22px; border-radius: 12px; background: #000; }
  .clock { position: absolute; top: 58px; width: 100%; text-align: center; font-size: 58px; font-weight: 600; letter-spacing: -.02em; color: rgba(255,255,255,.92); }
  .date { position: absolute; top: 44px; width: 100%; text-align: center; font-size: 13px; font-weight: 600; color: rgba(255,255,255,.8); }
  .note { position: absolute; left: 10px; right: 10px; padding: 10px 11px; border-radius: 18px; display: flex; gap: 9px; color: #fff;
    background: rgba(255,255,255,.2); backdrop-filter: blur(20px) saturate(1.6); border: 1px solid rgba(255,255,255,.18); }
  .note img, .note .ni { width: 30px; height: 30px; border-radius: 8px; flex: none; }
  .note .ni { display: grid; place-items: center; font-size: 15px; font-weight: 800; }
  .note h4 { margin: 0; font-size: 12.5px; font-weight: 700; display: flex; justify-content: space-between; }
  .note h4 span { font-weight: 500; opacity: .7; font-size: 11px; }
  .note p { margin: 2px 0 0; font-size: 11.5px; line-height: 1.3; opacity: .9; }
`;
const banner = page(1280, 640, `
  <div class="copy">
    <div class="pill"><i></i>Windows 11 · free &amp; open source</div>
    <h1>Send to<br>Phone</h1>
    <div class="tag">Taskbar to phone in one drop.<br>Phone to PC in one tap.</div>
    <div class="chips">
      <div class="chip"><b style="background:#ea4335"></b>Gmail</div>
      <div class="chip"><b style="background:#34a853"></b>Google Drive</div>
      <div class="chip"><b style="background:#57a7ff"></b>ntfy push</div>
      <div class="chip"><b style="background:#ffd60a"></b>Wi-Fi QR</div>
    </div>
    <div class="fine">No Bluetooth. No Phone Link. No cables.</div>
  </div>
  <svg class="arc" width="1280" height="640"><path d="M948 352 C 965 318, 975 300, 1010 300" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="3" stroke-dasharray="2 10" stroke-linecap="round"/>
    <path d="M998 290 l14 10 -15 8" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
  ${tile(668, 214, 1.55, 'over', 'Release to send', 'Goes to your phone')}
  <div class="file"><div class="doc"></div><div>vacation.mp4<small>48.2 MB</small></div></div>
  <svg class="cursor" width="26" height="32" viewBox="0 0 26 32"><path d="M2 2v24l6.5-6 4.5 10 4.5-2-4.5-10H22z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>
  <div class="phone"><div class="screen">
    <div class="island"></div>
    <div class="date">Wednesday, October 21</div>
    <div class="clock">9:41</div>
    <div class="note" style="top:178px"><img src="${ICON}"><div><h4>Send to Phone <span>now</span></h4><p>vacation.mp4 (48.2 MB)<br>Uploaded to Drive, link in Gmail</p></div></div>
    <div class="note" style="top:276px"><div class="ni" style="background:#57a7ff">n</div><div><h4>ntfy <span>2m ago</span></h4><p>github.com/whynobro</p></div></div>
    <div class="note" style="top:350px"><div class="ni" style="background:#ea4335">M</div><div><h4>Gmail <span>5m ago</span></h4><p>3 files: receipt.pdf, notes.txt, map.png</p></div></div>
  </div></div>
`, PHONE_CSS);

// ---------- states strip ----------
const STATES = [
  ['idle', 'Send to Phone', 'Drop files or click', 'Idle'],
  ['over', 'Release to send', 'Goes to your phone', 'Drag over'],
  ['sending', 'Sending…', 'Uploading 42%', 'Sending'],
  ['done', 'Sent', 'via Gmail', 'Delivered'],
  ['error', "Didn't send", 'Finish setup first.', 'Error'],
];
const statesPage = page(1240, 300, STATES.map(([s, t, sub, label], i) => `
  ${tile(52 + i * 232, 40, 1, s, t, sub)}
  <div class="lbl" style="left:${52 + i * 232}px">${label}</div>`).join(''), `
  .lbl { position: absolute; top: 222px; width: 168px; text-align: center; font-size: 15px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: rgba(255,255,255,.78); }
  .card[data-state="error"] { animation: none; }`);

// ---------- taskbar ----------
const TB_CSS = `
  .tb { position: absolute; left: 40px; right: 40px; height: 48px; border-radius: 14px; display: flex; align-items: center; padding: 0 12px; gap: 6px;
    backdrop-filter: blur(30px) saturate(1.5); box-shadow: 0 10px 30px -10px rgba(0,0,0,.5); }
  .dark { background: rgba(28,28,32,.82); border: 1px solid rgba(255,255,255,.08); }
  .lite { background: rgba(243,243,243,.86); border: 1px solid rgba(0,0,0,.06); color: #1d1d1f; }
  .wx { display: flex; gap: 8px; align-items: center; font-size: 13px; font-weight: 600; width: 92px; }
  .wx i { width: 22px; height: 16px; border-radius: 8px; background: linear-gradient(#e8eef8, #9fb2cf); display: block; }
  .ico { width: 40px; height: 40px; border-radius: 6px; display: grid; place-items: center; flex: none; }
  .ico span { width: 22px; height: 22px; border-radius: 5px; display: block; }
  .tray { margin-left: auto; font-size: 12px; text-align: right; line-height: 1.35; font-weight: 500; opacity: .9; }
  .tag2 { position: absolute; right: 56px; font-size: 13px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: rgba(255,255,255,.75); }`;
const icons = (light) => {
  const c = light ? ['#0067c0', '#c42b1c', '#e3a21a', '#2d7d9a'] : ['#4cc2ff', '#ff6b5e', '#ffc83d', '#6ad1b0'];
  return `<div class="ico"><span style="background:linear-gradient(135deg,${c[0]},${c[0]}aa);border-radius:4px"></span></div>` +
    c.slice(1).map((x) => `<div class="ico"><span style="background:${x};opacity:.9"></span></div>`).join('');
};
const bar = (top, light, state, title, label) => `
  <div class="tb ${light ? 'lite' : 'dark'}" style="top:${top}px">
    <div class="wx"><i></i>65°</div>
    ${capsule(state, title, light)}
    ${icons(light)}
    <div class="tray">9:41 AM<br>10/21/2026</div>
  </div>`;
const taskbarPage = page(1000, 300, bar(28, false, 'idle', 'Send to Phone') + bar(124, false, 'sending', 'Sending 42%') + bar(220, true, 'done', 'Sent'), TB_CSS);

// ---------- receive (phone -> PC) ----------
// The phone shows the real drop page from dropserver.js, frozen mid-batch (its script stripped).
const ROWS = [
  ['IMG_2041.HEIC', '3.1 MB · Sent', 'done', 100],
  ['lecture-scan.pdf', '840 KB · Sent', 'done', 100],
  ['clip.mov', '212.4 MB · 64%', 'sending', 64],
];
const CHECK = '<svg viewBox="0 0 26 26"><circle cx="13" cy="13" r="13" fill="#30d158"/><path d="M7.5 13.5l3.7 3.7 7.3-7.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const dropPage = renderPage('My PC')
  .replace(/<script>[\s\S]*<\/script>/, '')
  .replace('</style>', ':root { --bg: #000; --card: #1c1c1e; --text: #fff; --sub: #98989f; --track: rgba(120,120,128,.32); } body { padding-top: 54px; }</style>')
  .replace('<p id="summary" role="status" aria-live="polite"></p>', '<p id="summary">Sending 3 of 3…</p>')
  .replace('<ul id="list"></ul>', '<ul id="list">' + ROWS.map(([n, m, st, pct]) =>
    `<li class="row ${st}"><div class="name">${n}</div><div class="state">${st === 'done' ? CHECK : ''}</div><div class="meta">${m}</div><div class="bar"><i style="width:${pct}%"></i></div></li>`).join('') + '</ul>');
const RX_CSS = `
  .rphone { position: absolute; left: 96px; top: 34px; width: 286px; height: 572px; border-radius: 46px; background: #0b0b0f; padding: 10px; box-sizing: border-box;
    box-shadow: 0 0 0 2px rgba(255,255,255,.18), 0 40px 80px -20px rgba(0,0,0,.7); transform: rotate(-3deg); }
  .rscreen { width: 100%; height: 100%; border-radius: 37px; overflow: hidden; position: relative; background: #000; }
  .rscreen iframe { border: 0; width: 390px; height: 753px; transform: scale(.682); transform-origin: 0 0; }
  .island { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); width: 80px; height: 23px; border-radius: 12px; background: #000; z-index: 2; }
  .rcopy { position: absolute; left: 500px; top: 70px; width: 680px; }
  .rcopy h2 { font-size: 64px; line-height: 1; margin: 0 0 16px; font-weight: 750; letter-spacing: -.035em; }
  .rcopy p { font-size: 25px; line-height: 1.35; margin: 0; color: rgba(255,255,255,.86); font-weight: 500; }
  .rchips { display: flex; gap: 10px; margin-top: 24px; }
  .rchips div { padding: 9px 15px; border-radius: 12px; font-size: 16px; font-weight: 600; background: rgba(0,0,0,.22); border: 1px solid rgba(255,255,255,.14); }
  .toast { position: absolute; left: 740px; top: 392px; width: 392px; border-radius: 10px; padding: 14px 16px 16px; box-sizing: border-box;
    background: rgba(32,32,36,.9); border: 1px solid rgba(255,255,255,.1); box-shadow: 0 24px 50px -16px rgba(0,0,0,.6); font-size: 14px; }
  .toast .app { display: flex; gap: 8px; align-items: center; font-size: 12px; color: rgba(255,255,255,.75); margin-bottom: 10px; }
  .toast .app img { width: 16px; height: 16px; }
  .toast b { display: block; font-size: 15px; margin-bottom: 3px; }
  .toast span { color: rgba(255,255,255,.75); }
  .rarc { position: absolute; left: 0; top: 0; }`;
const receivePage = page(1240, 620, `
  <div class="rphone"><div class="rscreen"><div class="island"></div><iframe srcdoc="${dropPage.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe></div></div>
  <div class="rcopy">
    <h2>And back again</h2>
    <p>Scan the QR code on your PC, pick photos or files.<br>They land in your Downloads folder.</p>
    <div class="rchips"><div>Same Wi-Fi: any size, no app</div><div>ntfy: from anywhere</div></div>
  </div>
  <svg class="rarc" width="1240" height="620"><path d="M404 470 C 450 520, 470 470, 486 446" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="3" stroke-dasharray="2 10" stroke-linecap="round"/>
    <path d="M476 446 l12 -2 1 13" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
  ${tile(486, 356, 1.15, 'done', 'Received', 'lecture-scan.pdf')}
  <div class="toast"><div class="app"><img src="${ICON}">Send to Phone</div><b>2 files from your phone</b><span>IMG_2041.HEIC, lecture-scan.pdf</span></div>
`, RX_CSS);

// ---------- render ----------
async function open(html, name, w, h, zoom = 2) {
  const file = path.join(TMP, name + '.html');
  fs.writeFileSync(file, html);
  const win = new BrowserWindow({ width: w * zoom, height: h * zoom, show: false, useContentSize: true, frame: false, enableLargerThanScreen: true,
    webPreferences: { offscreen: true, zoomFactor: zoom } });
  win.setContentSize(w * zoom, h * zoom);
  win.webContents.setFrameRate(60);
  await win.loadFile(file);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(r => setTimeout(r, 400)))');
  await win.webContents.executeJavaScript('align(); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  return win;
}

async function shot(html, name, w, h, fmt = 'png') {
  const win = await open(html, name, w, h);
  // Freeze one-shot animations at their end state.
  await win.webContents.executeJavaScript(`document.getAnimations().forEach(a => { if (a.effect.getComputedTiming().iterations !== Infinity) a.finish(); else { a.pause(); a.currentTime = 300; } }); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  await new Promise((r) => setTimeout(r, 200));
  const img = await win.webContents.capturePage();
  const buf = fmt === 'jpg' ? img.toJPEG(90) : img.toPNG();
  fs.writeFileSync(path.join(out, `${name}.${fmt}`), buf);
  console.log(name, img.getSize(), (buf.length / 1024).toFixed(0) + ' KB');
  win.destroy();
}

// Demo GIF: idle -> file dragged over -> sending with % -> check drawn -> idle.
async function gif() {
  const W = 420, H = 280, Z = 1.5, FPS = 20;
  const html = page(W, H, `${tile(126, 56, 1, 'idle', 'Send to Phone', 'Drop files or click')}
    <div class="file" id="f"><div class="doc"></div><div>vacation.mp4<small>48.2 MB</small></div></div>
    <svg class="cursor" id="c" width="22" height="28" viewBox="0 0 26 32"><path d="M2 2v24l6.5-6 4.5 10 4.5-2-4.5-10H22z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>
    <script>
      const cardEl = document.querySelector('.card'), t = cardEl.querySelector('.title'), s = cardEl.querySelector('.sub');
      const f = document.getElementById('f'), c = document.getElementById('c');
      function set(st, a, b) { cardEl.dataset.state = st; t.textContent = a; s.textContent = b; }
      function place(x, y, o) { f.style.transform = 'translate(' + x + 'px,' + y + 'px) rotate(-6deg)'; c.style.transform = 'translate(' + (x + 70) + 'px,' + (y + 34) + 'px)'; f.style.opacity = c.style.opacity = o; }
      function step(dt) { document.getAnimations().forEach(a => { a.pause(); a.currentTime = (a.currentTime || 0) + dt; }); }
    </script>`, PHONE_CSS + `.file { left: 0; top: 0; transform: none; transition: none; } .cursor { left: 0; top: 0; }`);
  const win = await open(html, 'demo', W, H, Z);
  const js = (code) => win.webContents.executeJavaScript(code);
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  const frames = [];
  const total = 6.4, dt = 1000 / FPS;
  let state = '';
  for (let i = 0; i < total * FPS; i++) {
    const T = i / FPS;
    let code = '';
    const go = (st, a, b) => { if (state !== st + a + b) { state = st + a + b; code += `set(${JSON.stringify(st)}, ${JSON.stringify(a)}, ${JSON.stringify(b)});`; } };
    if (T < 0.6) { go('idle', 'Send to Phone', 'Drop files or click'); code += 'place(-180, 20, 1);'; }
    else if (T < 1.6) {
      const k = ease((T - 0.6) / 1.0);
      code += `place(${-180 + k * 330}, ${20 + k * 70}, 1);`;
      if (T > 1.15) go('over', 'Release to send', 'Goes to your phone'); else go('idle', 'Send to Phone', 'Drop files or click');
    } else if (T < 3.4) {
      code += 'place(150, 90, 0);';
      const pct = Math.min(100, Math.round(((T - 1.6) / 1.6) * 100));
      go('sending', 'Sending…', T < 1.8 ? 'vacation.mp4' : `Uploading ${pct}%`);
    } else if (T < 5.6) go('done', 'Sent', 'via Drive + Gmail');
    else go('idle', 'Send to Phone', 'Drop files or click');
    await js(code + `step(${dt}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    const img = await win.webContents.capturePage();
    frames.push(img.resize({ width: Math.round(W * Z), quality: 'best' }));
  }
  win.destroy();
  const { width, height } = frames[0].getSize();
  const rgba = frames.map((im) => {
    const b = im.toBitmap(); // BGRA
    for (let i = 0; i < b.length; i += 4) { const x = b[i]; b[i] = b[i + 2]; b[i + 2] = x; b[i + 3] = 255; }
    return new Uint8Array(b.buffer, b.byteOffset, b.length);
  });
  // One shared palette from sampled frames avoids flicker between frames.
  const sample = new Uint8Array(rgba.length > 8 ? rgba[0].length * 8 : rgba[0].length * rgba.length);
  const pick = [0, 20, 26, 34, 50, 60, 80, 100].filter((i) => i < rgba.length);
  pick.forEach((i, k) => sample.set(rgba[i], k * rgba[0].length));
  // 255 colors + index 255 reserved as "unchanged since last frame" (transparent).
  const palette = quantize(sample.subarray(0, pick.length * rgba[0].length), 255);
  while (palette.length < 255) palette.push([0, 0, 0]);
  palette.push([0, 0, 0]);
  const enc = GIFEncoder();
  let prev = null;
  // Ordered dither hides gradient banding; the fixed pattern keeps static pixels identical across frames.
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const dither = (px) => {
    const d = new Uint8Array(px.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, n = (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.47) * 28;
      d[o] = Math.max(0, Math.min(255, px[o] + n)); d[o + 1] = Math.max(0, Math.min(255, px[o + 1] + n));
      d[o + 2] = Math.max(0, Math.min(255, px[o + 2] + n)); d[o + 3] = 255;
    }
    return d;
  };
  rgba.forEach((px, i) => {
    const idx = applyPalette(dither(px), palette.slice(0, 255));
    const outIdx = idx.slice();
    if (prev) for (let k = 0; k < idx.length; k++) if (idx[k] === prev[k]) outIdx[k] = 255;
    prev = idx;
    enc.writeFrame(outIdx, width, height, { palette: i === 0 ? palette : undefined, delay: dt, repeat: 0, transparent: i > 0, transparentIndex: 255, dispose: 1 });
  });
  enc.finish();
  const buf = Buffer.from(enc.bytes());
  fs.writeFileSync(path.join(out, 'demo.gif'), buf);
  console.log('demo.gif', { width, height }, frames.length + ' frames', (buf.length / 1024).toFixed(0) + ' KB');
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // each shot closes its window; keep going
app.whenReady().then(async () => {
  try {
    const only = process.env.ONLY;
    if (!only || only === 'banner') await shot(banner, 'banner', 1280, 640, 'jpg');
    if (!only || only === 'states') await shot(statesPage, 'states', 1240, 300);
    if (!only || only === 'taskbar') await shot(taskbarPage, 'taskbar', 1000, 300);
    if (!only || only === 'receive') await shot(receivePage, 'receive', 1240, 620, 'jpg');
    if (!only || only === 'gif') await gif();
  } catch (e) {
    console.error(e);
  }
  app.quit();
});
