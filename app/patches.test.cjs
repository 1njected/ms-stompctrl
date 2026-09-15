/* The guard on what may be transmitted to patch memory.

   zoom-explorer records 0x5B in this same command space as a factory reset that
   wipes every user patch, and 0x01 as firmware update mode. A mistyped command
   byte here is not a failed experiment. The allowlist is the only thing between
   the two, so it is tested rather than trusted. */
const assert = require('node:assert/strict');
global.log = () => {};
require('./patches.js');
const { check, ALLOWED, DANGEROUS } = global.pedalPatches;

const frame = (cmd, ...rest) => [0xf0, 0x52, 0x00, 0x5e, cmd, ...rest, 0xf7];

// --- the three commands this module exists to send --------------------------
for (const cmd of [0x28, 0x29, 0x32]) {
  assert(ALLOWED.has(cmd), `0x${cmd.toString(16)} is permitted`);
  assert.deepEqual(check(frame(cmd, 0, 0, 0)), frame(cmd, 0, 0, 0), `0x${cmd.toString(16)} passes`);
}

// --- the ones that would cost the pedal -------------------------------------
assert.throws(() => check(frame(0x5b)), /factory reset/, '0x5B is refused by name');
assert.throws(() => check(frame(0x01)), /firmware/, '0x01 is refused by name');
for (const [cmd, why] of Object.entries(DANGEROUS))
  assert.throws(() => check(frame(Number(cmd))), new RegExp(why.split(':')[0]), `0x${cmd} is refused`);

// --- everything else is refused too, not merely the known-bad ----------------
let refused = 0;
for (let cmd = 0; cmd <= 0x7f; cmd++) {
  if (ALLOWED.has(cmd)) continue;
  assert.throws(() => check(frame(cmd)), /Refusing/, `0x${cmd.toString(16)} must not pass`);
  refused++;
}
assert.equal(refused, 0x80 - ALLOWED.size, 'every command outside the allowlist is refused');

// --- and frames that are not this pedal's SysEx at all ----------------------
assert.throws(() => check([0xf0, 0x52, 0x00, 0x58, 0x28, 0xf7]), /not a ZOOM MS-100BT/, 'another model is refused');
assert.throws(() => check([0xf0, 0x7e, 0x00, 0x06, 0x01, 0xf7]), /not a ZOOM MS-100BT/, 'a non-ZOOM frame is refused');
assert.throws(() => check([0xf0, 0x52, 0x00, 0x5e, 0x28, 0x00]), /not a ZOOM MS-100BT/, 'an unterminated frame is refused');
assert.throws(() => check([0x52, 0x00, 0x5e, 0x28, 0xf7]), /not a ZOOM MS-100BT/, 'a frame with no F0 is refused');

// The guard caught a real mistake while this was being written: rung 2 first
// sent the 0x08 slot dump back, which zoom-explorer records as receive-only.
assert.throws(() => check(frame(0x08, 0, 0, 0)), /Refusing command 0x8/,
              '0x08 is a reply, never something to transmit');
assert.equal(typeof global.pedalPatches.storeEditBufferToSlot, 'function');
assert.equal(typeof global.pedalPatches.rewriteEditBuffer, 'function');

console.log(`Patch write guard: 3 commands permitted, ${refused} refused including 0x5B factory reset and 0x01 firmware mode, and frames for other models or without SysEx framing rejected`);
