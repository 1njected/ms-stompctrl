const assert = require('node:assert/strict');
const test = require('node:test');

global.IAPCodec = { Parser: function () { this.feed = () => {}; } };
global.onStompFrame = () => () => {};
global.pedalLock = { run: (_label, fn) => fn() };
global.stompTransfer = fn => fn();
global.iapHost = {
  session: 1,
  nextTransaction: 1,
  frame: data => data,
};
require('./install.js');

test('install logs through the shared logger and cleans up without masking transport errors', async () => {
  const events = [], writes = [];
  const failure = new Error('Test transport disconnected');
  global.log = (kind, value) => events.push({ kind, value });
  global.stompWrite = async frame => { writes.push(frame); throw failure; };
  const data = new Uint8Array(76);
  data.set(new TextEncoder().encode('SIZE'), 4);

  await assert.rejects(
    global.pedalInstaller.install({ filename: 'TEST.ZDL', data }),
    error => error === failure,
  );
  assert(events.some(e => e.kind === 'install_tx'));
  assert(events.some(e => e.kind === 'install_abort' && e.value.includes(failure.message)));
  for (const step of ['close file', 'flush', 'delete partial TEST.ZDL', 'enumerate',
                      'leave file mode', 'unmute', 'release']) {
    assert(events.some(e => e.kind === 'abort_warn' && e.value.step === step), step);
  }
  assert.deepEqual(writes.at(-1), [240, 82, 0, 94, 0x60, 7, 247]);
  assert.equal(global.pedalCodec.fragmentAcks.size, 0);
});
