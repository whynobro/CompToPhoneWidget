// Run: npm test. Saving incoming files: names, collisions, partial uploads.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { safeName, uniquePath, saveStream } = require('../src/downloads');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-dl-'));
const files = () => fs.readdirSync(dir);

const tests = {
  async 'safeName: strips folders and characters Windows refuses'() {
    assert.strictEqual(safeName('..\\..\\Windows\\evil.txt'), 'evil.txt');
    assert.strictEqual(safeName('a/b/c.png'), 'c.png');
    assert.strictEqual(safeName('what?.jpg'), 'what_.jpg');
    assert.strictEqual(safeName('trailing. . '), 'trailing');
    assert.strictEqual(safeName('CON.txt'), '_CON.txt');
    assert.strictEqual(safeName(''), 'file');
    assert.strictEqual(safeName('...'), 'file');
    const long = safeName('x'.repeat(300) + '.mp4');
    assert.strictEqual(long.length, 180);
    assert.ok(long.endsWith('.mp4'));
  },

  async 'uniquePath: numbers duplicates instead of overwriting'() {
    fs.writeFileSync(path.join(dir, 'a.txt'), '');
    fs.writeFileSync(path.join(dir, 'a (1).txt'), '');
    assert.strictEqual(uniquePath(dir, 'a.txt'), path.join(dir, 'a (2).txt'));
    assert.strictEqual(uniquePath(dir, 'b.txt'), path.join(dir, 'b.txt'));
  },

  async 'saveStream: writes bytes under the final name and reports size'() {
    const data = Buffer.from('hello from the phone');
    let seen = 0;
    const r = await saveStream(dir, 'note.txt', Readable.from([data.subarray(0, 5), data.subarray(5)]), (n) => (seen = n));
    assert.strictEqual(r.name, 'note.txt');
    assert.strictEqual(r.size, data.length);
    assert.strictEqual(seen, data.length);
    assert.deepStrictEqual(fs.readFileSync(r.path), data);
    assert.ok(!files().some((f) => f.endsWith('.part')));
  },

  async 'saveStream: a broken upload leaves nothing behind'() {
    const before = files().length;
    const broken = new Readable({
      read() {
        this.push(Buffer.alloc(10));
        this.destroy(new Error('connection reset'));
      },
    });
    await assert.rejects(saveStream(dir, 'half.mov', broken), /connection reset/);
    assert.strictEqual(files().length, before);
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
