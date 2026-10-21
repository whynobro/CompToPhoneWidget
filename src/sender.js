// Delivery backends. Plain Node (no Electron) so it can be tested directly.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Gmail caps a whole message at 25 MB *after* base64 (+33%), so ~18 MB of raw files.
const EMAIL_BATCH_LIMIT = 18 * 1024 * 1024;
// ntfy.sh public server attachment cap.
const NTFY_FILE_LIMIT = 15 * 1024 * 1024;

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

function statFiles(filePaths) {
  return filePaths.map((p) => {
    const st = fs.statSync(p);
    if (!st.isFile()) throw new Error(`${path.basename(p)} is a folder. Zip it first.`);
    return { path: p, name: path.basename(p), size: st.size };
  });
}

// Group files into emails that each stay under the Gmail limit.
function batchForEmail(files) {
  const tooBig = files.filter((f) => f.size > EMAIL_BATCH_LIMIT);
  if (tooBig.length) {
    throw new Error(`${tooBig[0].name} is ${mb(tooBig[0].size)}. Email max is ${mb(EMAIL_BATCH_LIMIT)}.`);
  }
  const batches = [];
  let cur = [];
  let curSize = 0;
  for (const f of files) {
    if (cur.length && curSize + f.size > EMAIL_BATCH_LIMIT) {
      batches.push(cur);
      cur = [];
      curSize = 0;
    }
    cur.push(f);
    curSize += f.size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// nodemailer costs ~1 s to load on a cold login boot; only pay it when an email goes out.
function makeGmailTransport(email) {
  return require('nodemailer').createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: email.user, pass: email.pass.replace(/\s+/g, '') },
  });
}

// `links` are files already uploaded to Drive; they ride along in the first email as links.
async function sendEmail(files, email, transport, links = []) {
  if (!email.user || !email.pass) throw new Error('Set your Gmail address and app password in Settings.');
  const t = transport || makeGmailTransport(email);
  const batches = files.length ? batchForEmail(files) : [[]];
  for (const [i, batch] of batches.entries()) {
    const linked = i === 0 ? links : [];
    const names = [...batch, ...linked].map((f) => f.name);
    const part = batches.length > 1 ? ` (${i + 1}/${batches.length})` : '';
    const lines = [
      ...batch.map((f) => `• ${f.name} (${mb(f.size)})`),
      ...linked.map((f) => `• ${f.name} (${mb(f.size)}, in Google Drive > ${f.folder}):\n  ${f.url}`),
    ];
    await t.sendMail({
      from: `Send to Phone <${email.user}>`,
      to: email.to || email.user,
      subject: (names.length === 1 ? names[0] : `${names.length} files: ${names.join(', ')}`).slice(0, 180) + part,
      text: `Sent from your PC:\n\n${lines.join('\n')}\n`,
      attachments: batch.map((f) => ({ filename: f.name, path: f.path })),
    });
  }
  return { count: files.length + links.length, messages: batches.length };
}

// Google Drive via rclone (remote created with scope=drive.file, so it only sees its own uploads).
function runRclone(bin, args, onStats) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      err += d;
      if (!onStats) return;
      for (const line of String(d).split('\n')) {
        try {
          const j = JSON.parse(line);
          if (j.stats) onStats(j.stats);
        } catch {}
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve(out);
      const msg = err.split('\n').map((l) => { try { return JSON.parse(l).msg; } catch { return l; } })
        .filter((l) => l && /error|fail|couldn't|invalid/i.test(l)).pop();
      reject(new Error(`Drive upload failed: ${(msg || `rclone exit ${code}`).trim()}`));
    });
  });
}

async function sendDrive(files, drive, deps = {}) {
  if (!drive.rclone || !drive.remote) throw new Error('Connect Google Drive in Settings.');
  const run = deps.rclone || runRclone;
  const folder = drive.folder || 'From PC';
  const dest = `${drive.remote}:${folder}`;
  const total = files.reduce((s, f) => s + f.size, 0) || 1;
  let before = 0;
  const links = [];
  for (const f of files) {
    await run(drive.rclone, ['copy', f.path, dest, '--use-json-log', '--stats', '1s', '--stats-log-level', 'NOTICE'], (s) =>
      deps.onProgress?.(Math.min(1, (before + (s.bytes || 0)) / total)));
    before += f.size;
    const meta = JSON.parse(await run(drive.rclone, ['lsjson', `${dest}/${f.name}`, '--stat']));
    links.push({ name: f.name, size: f.size, folder, url: `https://drive.google.com/file/d/${meta.ID}/view` });
  }
  return links;
}

async function sendNtfy(files, ntfy, fetchImpl = fetch) {
  if (!ntfy.topic) throw new Error('Set an ntfy topic in Settings.');
  const tooBig = files.find((f) => f.size > NTFY_FILE_LIMIT);
  if (tooBig) throw new Error(`${tooBig.name} is ${mb(tooBig.size)}. ntfy max is ${mb(NTFY_FILE_LIMIT)}.`);
  const base = (ntfy.server || 'https://ntfy.sh').replace(/\/+$/, '');
  for (const f of files) {
    const res = await fetchImpl(`${base}/${encodeURIComponent(ntfy.topic)}`, {
      method: 'PUT',
      headers: { Filename: f.name, Title: 'From your PC', Tags: 'paperclip' },
      body: fs.readFileSync(f.path),
    });
    if (!res.ok) throw new Error(`ntfy rejected ${f.name}: HTTP ${res.status} ${await res.text()}`);
  }
  return { count: files.length, messages: files.length };
}

// method:
//   'auto'  - files that fit go to Gmail as attachments; bigger ones go to Drive and are
//             linked in that same email, so each file lands in exactly one place.
//   'email' | 'drive' | 'ntfy' - everything to that one channel.
// Result `via` lists the channels used.
async function send(filePaths, config, deps = {}) {
  if (!filePaths.length) throw new Error('No files.');
  const files = statFiles(filePaths);
  const email = config.email || {};
  const drive = config.drive || {};
  const method = config.method === 'both' ? 'auto' : config.method;

  if (method === 'ntfy') {
    await sendNtfy(files, config.ntfy || {}, deps.fetch);
    return { count: files.length, via: ['ntfy'] };
  }
  if (method === 'drive') {
    await sendDrive(files, drive, deps);
    return { count: files.length, via: ['Drive'] };
  }
  if (method === 'email') {
    await sendEmail(files, email, deps.transport);
    return { count: files.length, via: ['Gmail'] };
  }

  const small = files.filter((f) => f.size <= EMAIL_BATCH_LIMIT);
  const big = files.filter((f) => f.size > EMAIL_BATCH_LIMIT);
  if (big.length && !(drive.rclone && drive.remote)) {
    throw new Error(`${big[0].name} is ${mb(big[0].size)}, too big for email. Connect Google Drive in Settings.`);
  }
  if (!email.user || !email.pass) throw new Error('Set your Gmail address and app password in Settings.');
  const links = big.length ? await sendDrive(big, drive, deps) : [];
  await sendEmail(small, email, deps.transport, links);
  return { count: files.length, via: big.length ? ['Gmail', 'Drive'] : ['Gmail'] };
}

async function verifyEmail(email) {
  if (!email.user || !email.pass) throw new Error('Enter Gmail address and app password.');
  await makeGmailTransport(email).verify();
}

// Text notes and links always go through ntfy: instant, and tapping a link opens it.
// JSON publish (not headers) so non-ASCII text and URLs survive.
async function sendNote(text, ntfy, fetchImpl = fetch) {
  const message = String(text || '').trim();
  if (!message) throw new Error('Nothing to send.');
  if (!ntfy.topic) throw new Error('Set an ntfy topic in Settings.');
  const url = (message.match(/https?:\/\/[^\s<>"]+/i) || [])[0];
  const onlyLink = url === message;
  const body = {
    topic: ntfy.topic,
    title: onlyLink ? 'Link from your PC' : 'Note from your PC',
    message,
    tags: [onlyLink ? 'link' : 'memo'],
  };
  if (url) {
    body.click = url;
    body.actions = [{ action: 'view', label: 'Open link', url, clear: true }];
  }
  const base = (ntfy.server || 'https://ntfy.sh').replace(/\/+$/, '');
  const res = await fetchImpl(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`ntfy rejected the note: HTTP ${res.status} ${await res.text()}`);
  return { link: !!url };
}

async function verifyDrive(drive) {
  if (!drive.rclone) throw new Error('rclone not found. Install it: winget install Rclone.Rclone');
  const out = await runRclone(drive.rclone, ['listremotes']);
  if (!out.split(/\r?\n/).includes(`${drive.remote}:`)) throw new Error('Google Drive not connected yet.');
  await runRclone(drive.rclone, ['lsjson', `${drive.remote}:`, '--max-depth', '1', '--dirs-only']);
}

module.exports = { send, sendNote, sendDrive, runRclone, verifyEmail, verifyDrive, batchForEmail, EMAIL_BATCH_LIMIT, NTFY_FILE_LIMIT };
