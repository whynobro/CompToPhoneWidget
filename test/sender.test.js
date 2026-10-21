// Run: npm test. Exercises the send backends without touching the network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodemailer = require('nodemailer');
const sender = require('../src/sender');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-'));
const mk = (name, bytes) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
};
const MB = 1024 * 1024;

const tests = {
  async 'email: one message with attachment, defaults to self'() {
    const t = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const sent = [];
    const orig = t.sendMail.bind(t);
    t.sendMail = async (m) => { sent.push(m); return orig(m); };
    const file = mk('photo.jpg', 1000);
    const r = await sender.send([file], { method: 'email', email: { user: 'me@gmail.com', pass: 'abcd efgh' } }, { transport: t });
    assert.deepStrictEqual(r, { count: 1, via: ['Gmail'] });
    assert.strictEqual(sent[0].to, 'me@gmail.com');
    assert.strictEqual(sent[0].subject, 'photo.jpg');
    const raw = (await orig(sent[0])).message.toString();
    assert.match(raw, /filename=photo\.jpg/);
  },

  async 'email: splits batches under the Gmail limit'() {
    const files = [10, 10, 5].map((n, i) => ({ name: `f${i}`, size: n * MB }));
    const b = sender.batchForEmail(files);
    assert.deepStrictEqual(b.map((x) => x.map((f) => f.name)), [['f0'], ['f1', 'f2']]);
  },

  async 'email: rejects a single oversize file'() {
    const big = mk('big.mov', sender.EMAIL_BATCH_LIMIT + 1);
    await assert.rejects(sender.send([big], { method: 'email', email: { user: 'a', pass: 'b' } }, { transport: {} }), /Email max/);
  },

  async 'email: missing credentials gives setup hint'() {
    await assert.rejects(sender.send([mk('a.txt', 3)], { method: 'email', email: {} }), /Settings/);
  },

  async 'rejects folders'() {
    await assert.rejects(sender.send([dir], { method: 'email', email: { user: 'a', pass: 'b' } }), /folder/);
  },

  async 'ntfy: PUTs each file with Filename header'() {
    const calls = [];
    const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
    const r = await sender.send([mk('a b.pdf', 10), mk('c.png', 20)], { method: 'ntfy', ntfy: { topic: 'phone-x', server: 'https://ntfy.sh/' } }, { fetch: fakeFetch });
    assert.strictEqual(r.count, 2);
    assert.strictEqual(calls[0].url, 'https://ntfy.sh/phone-x');
    assert.strictEqual(calls[0].opts.method, 'PUT');
    assert.strictEqual(calls[0].opts.headers.Filename, 'a b.pdf');
    assert.strictEqual(calls[1].opts.body.length, 20);
  },

  async 'auto: small files go to Gmail only, Drive untouched'() {
    const mails = [];
    const t = { sendMail: async (m) => mails.push(m) };
    const rclone = async () => { throw new Error('should not upload'); };
    const r = await sender.send([mk('small.pdf', 1000)], { method: 'auto', email: { user: 'a', pass: 'b' }, drive: { rclone: 'x', remote: 'r' } }, { transport: t, rclone });
    assert.deepStrictEqual(r.via, ['Gmail']);
    assert.strictEqual(mails[0].attachments.length, 1);
  },

  async 'auto: big file goes to Drive and is linked in one email with the small one'() {
    const mails = [];
    const calls = [];
    const t = { sendMail: async (m) => mails.push(m) };
    const rclone = async (bin, args, onStats) => {
      calls.push(args[0]);
      if (args[0] === 'copy') { onStats({ bytes: 5 }); return ''; }
      return JSON.stringify({ ID: 'FILEID123' });
    };
    const progress = [];
    const big = mk('video.mp4', sender.EMAIL_BATCH_LIMIT + 10);
    const r = await sender.send([mk('note.txt', 10), big], { method: 'auto', email: { user: 'a', pass: 'b' }, drive: { rclone: 'x', remote: 'r', folder: 'From PC' } }, { transport: t, rclone, onProgress: (p) => progress.push(p) });
    assert.deepStrictEqual(r.via, ['Gmail', 'Drive']);
    assert.deepStrictEqual(calls, ['copy', 'lsjson']);
    assert.strictEqual(mails.length, 1);
    assert.deepStrictEqual(mails[0].attachments.map((a) => a.filename), ['note.txt']);
    assert.match(mails[0].text, /video\.mp4.*Google Drive > From PC[\s\S]*drive\.google\.com\/file\/d\/FILEID123\/view/);
    assert.ok(progress.length > 0);
  },

  async 'auto: only big files sends a link-only email'() {
    const mails = [];
    const t = { sendMail: async (m) => mails.push(m) };
    const rclone = async (bin, args) => (args[0] === 'lsjson' ? JSON.stringify({ ID: 'X' }) : '');
    await sender.send([mk('big.mov', sender.EMAIL_BATCH_LIMIT + 1)], { method: 'auto', email: { user: 'a', pass: 'b' }, drive: { rclone: 'x', remote: 'r' } }, { transport: t, rclone });
    assert.strictEqual(mails.length, 1);
    assert.strictEqual(mails[0].attachments.length, 0);
    assert.strictEqual(mails[0].subject, 'big.mov');
  },

  async 'auto: big file without Drive explains how to fix'() {
    await assert.rejects(sender.send([mk('huge.mov', sender.EMAIL_BATCH_LIMIT + 1)], { method: 'auto', email: { user: 'a', pass: 'b' } }), /Connect Google Drive/);
  },

  async 'drive: uploads everything to Drive only'() {
    const rclone = async (bin, args) => (args[0] === 'lsjson' ? JSON.stringify({ ID: 'Y' }) : '');
    const r = await sender.send([mk('a.png', 5)], { method: 'drive', drive: { rclone: 'x', remote: 'r' } }, { rclone, transport: { sendMail: () => { throw new Error('no email'); } } });
    assert.deepStrictEqual(r.via, ['Drive']);
  },

  async 'drive: rclone failure surfaces readable error'() {
    // Real child process standing in for rclone: JSON log line on stderr, exit 1.
    const script = `console.error(JSON.stringify({ level: 'error', msg: 'Failed to copy: invalid_grant token expired' })); process.exit(1)`;
    await assert.rejects(sender.runRclone(process.execPath, ['-e', script]), /Drive upload failed: Failed to copy: invalid_grant/);
  },

  async 'note: bare link becomes a tappable link notification'() {
    let call;
    const fakeFetch = async (url, opts) => { call = { url, body: JSON.parse(opts.body) }; return { ok: true }; };
    const r = await sender.sendNote('  https://example.com/a?b=ü  ', { topic: 't', server: 'https://ntfy.sh/' }, fakeFetch);
    assert.deepStrictEqual(r, { link: true });
    assert.strictEqual(call.url, 'https://ntfy.sh');
    assert.strictEqual(call.body.topic, 't');
    assert.strictEqual(call.body.title, 'Link from your PC');
    assert.strictEqual(call.body.click, 'https://example.com/a?b=ü');
    assert.strictEqual(call.body.actions[0].url, 'https://example.com/a?b=ü');
  },

  async 'note: text with a link is a note that still opens the link'() {
    let body;
    const fakeFetch = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true }; };
    await sender.sendNote('read this later https://x.io/p', { topic: 't' }, fakeFetch);
    assert.strictEqual(body.title, 'Note from your PC');
    assert.strictEqual(body.message, 'read this later https://x.io/p');
    assert.strictEqual(body.click, 'https://x.io/p');
  },

  async 'note: plain text has no click action; empty is rejected'() {
    let body;
    const fakeFetch = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true }; };
    await sender.sendNote('gate code 4417', { topic: 't' }, fakeFetch);
    assert.strictEqual(body.click, undefined);
    assert.strictEqual(body.actions, undefined);
    await assert.rejects(sender.sendNote('   ', { topic: 't' }, fakeFetch), /Nothing to send/);
  },

  async 'ntfy: surfaces server errors'() {
    const fakeFetch = async () => ({ ok: false, status: 413, text: async () => 'too large' });
    await assert.rejects(sender.send([mk('x', 5)], { method: 'ntfy', ntfy: { topic: 't' } }, { fetch: fakeFetch }), /413 too large/);
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
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
  process.exit(failed ? 1 : 0);
})();
