// Saving files that arrive from the phone. Plain Node so it can be tested directly.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

// A phone-supplied name, reduced to something Windows can store in one folder.
function safeName(name) {
  let n = String(name || '').split(/[\\/]/).pop();
  n = n.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  if (!n) n = 'file';
  if (RESERVED.test(n)) n = '_' + n;
  return n;
}

// photo.jpg, then "photo (1).jpg", "photo (2).jpg"... never overwrites.
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const p = path.join(dir, i ? `${stem} (${i})${ext}` : name);
    if (!fs.existsSync(p)) return p;
  }
}

// Tag files as downloaded (Internet zone) so SmartScreen and Office still vet anything
// that came off the phone or a public ntfy server, same as a browser download.
function markOfTheWeb(file) {
  if (process.platform !== 'win32') return;
  try {
    fs.writeFileSync(file + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n');
  } catch {}
}

// Streams into a hidden temp file, then renames into place, so a half-received file never
// shows up in Downloads under its real name. Resolves { path, name, size }.
async function saveStream(dir, name, readable, onBytes) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.stp-${crypto.randomBytes(6).toString('hex')}.part`);
  let size = 0;
  readable.on('data', (chunk) => {
    size += chunk.length;
    onBytes?.(size);
  });
  try {
    await pipeline(readable, fs.createWriteStream(tmp));
    const final = uniquePath(dir, safeName(name));
    fs.renameSync(tmp, final);
    markOfTheWeb(final);
    return { path: final, name: path.basename(final), size };
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

module.exports = { safeName, uniquePath, saveStream };
