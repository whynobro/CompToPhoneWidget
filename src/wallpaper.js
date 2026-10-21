// Reads the current Windows wallpaper so the widget can blur it behind itself
// (real frosted glass with large corner radii, which Win11 acrylic can't do).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TRANSCODED = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');

// All values of one key from a single reg.exe spawn (each spawn blocks the main thread ~50 ms).
function regValues(key) {
  const vals = {};
  try {
    const out = execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true });
    for (const m of out.matchAll(/^\s+(\S+)\s+REG_\w+\s+(.*)$/gm)) vals[m[1]] = m[2].trim();
  } catch {}
  return vals;
}

// WallpaperStyle registry codes -> CSS-ish modes.
function styleFrom(style, tile) {
  if (tile === '1') return 'tile';
  return { 0: 'center', 2: 'stretch', 6: 'fit', 10: 'fill', 22: 'span' }[style] || 'fill';
}

function mimeOf(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return 'image/jpeg';
}

function readWallpaper() {
  const desk = regValues('HKCU\\Control Panel\\Desktop');
  const wpPath = desk.WallPaper || '';
  const mode = styleFrom(desk.WallpaperStyle, desk.TileWallpaper);
  const rgb = (regValues('HKCU\\Control Panel\\Colors').Background || '0 0 0').split(/\s+/).map(Number);
  const color = `rgb(${rgb.join(',')})`;

  // Empty WallPaper value means a solid-color desktop.
  if (!wpPath) return { url: null, mode, color, file: null };
  // TranscodedWallpaper is what Explorer actually renders; fall back to the registry path.
  for (const file of [TRANSCODED, wpPath]) {
    try {
      const buf = fs.readFileSync(file);
      if (buf.length < 64) continue;
      return { url: `data:${mimeOf(buf)};base64,${buf.toString('base64')}`, mode, color, file };
    } catch {}
  }
  return { url: null, mode, color, file: null };
}

// Calls cb (caller decides whether to re-read) when the wallpaper file changes (slideshow, Spotlight, manual change).
function watchWallpaper(cb) {
  let last = 0;
  const check = () => {
    try {
      const m = fs.statSync(TRANSCODED).mtimeMs;
      if (last && m !== last) cb();
      last = m;
    } catch {}
  };
  check();
  return setInterval(check, 20000);
}

module.exports = { readWallpaper, watchWallpaper };
