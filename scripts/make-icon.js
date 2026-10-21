// Renders assets/icon.png and assets/icon.ico from SVG. Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5ac8fa"/><stop offset="1" stop-color="#0a64ff"/>
    </linearGradient>
    <linearGradient id="hi" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#bg)"/>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#hi)"/>
  <g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">
    <rect x="80" y="40" width="96" height="176" rx="24" stroke-width="13"/>
    <path d="M128 82v62M104 122l24 24 24-24" stroke-width="14"/>
    <path d="M110 186h36" stroke-width="12" opacity=".6"/>
  </g>
</svg>`;

// ICO container holding PNGs (supported since Vista).
function toIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(buf.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.buf)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, useContentSize: true });
  await win.loadURL('data:text/html,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent">${SVG.replace('<svg ', '<svg width="256" height="256" ')}</body></html>`));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  const out = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(out, { recursive: true });
  const base = img.resize({ width: 256, height: 256 });
  fs.writeFileSync(path.join(out, 'icon.png'), base.toPNG());
  const sizes = [16, 32, 48, 256].map((size) => ({ size, buf: base.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  fs.writeFileSync(path.join(out, 'icon.ico'), toIco(sizes));
  console.log('wrote', out);
  app.quit();
});
