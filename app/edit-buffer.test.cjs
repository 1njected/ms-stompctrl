/* The 0x28 edit-buffer codec, against a frame captured from a real MS-100BT
   on 2026-09-12 -- the reply to 0x50 then 0x29. */
const assert = require('assert');
global.window = global;
require('./backup.js');
const { validateEditBuffer } = global.PatchBackupCodec;

const CAPTURED =
 'f0 52 00 5e 28 48 01 00 00 50 7b 50 00 20 19 00 40 06 00 00 00 04 00 00 00 00 21 03 00 40 12 ' +
 '06 7c 01 16 00 00 00 10 00 00 00 00 00 00 05 00 41 00 00 46 08 48 00 00 32 00 00 00 00 00 00 ' +
 '00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01 00 00 00 00 ' +
 '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
 '00 00 00 00 00 40 0d 0f 45 00 6d 70 74 79 20 20 20 00 20 20 00 f7';
const bytes = CAPTURED.split(' ').map(x => parseInt(x, 16));

assert.equal(bytes.length, 146, 'the captured frame is 146 bytes');
const p = validateEditBuffer(bytes);
assert.equal(p.name, 'Empty', 'name decodes from offset 111');
assert.equal(p.rawHex.split(' ').length, 122, '140 packed bytes unpack to 122');

// The six effect slots decode with the same reader restore.js uses.
const raw = p.rawHex.split(' ').map(x => parseInt(x, 16));
const id = i => (((raw[i*18] | raw[i*18+1]<<8 | raw[i*18+2]<<16 | raw[i*18+3]<<24) >>> 1) & 0xfffffff)
  .toString(16).padStart(8, '0');
assert.equal(id(0), '08000040', 'slot 1 effect id');
assert.equal(id(1), '090001d0', 'slot 2 effect id');
assert.equal(id(2), '03000020', 'slot 3 effect id');

// Shape is enforced: the 08 slot dump must not pass as an edit buffer.
const slotDump = [240,82,0,94,8,0,0,0].concat(Array(147).fill(0), [247]);
assert.throws(() => validateEditBuffer(slotDump), /Invalid edit-buffer response/);
assert.throws(() => validateEditBuffer(bytes.slice(0, 145)), /Invalid edit-buffer response/);
const nonMidi = bytes.slice(); nonMidi[7] = 0x80;
assert.throws(() => validateEditBuffer(nonMidi), /Non-MIDI data/);

console.log('Edit buffer: real 0x28 frame decodes to "Empty", 122-byte body, 3 effect ids; bad shapes refused');

/* The packer. Before any 0x28 frame is transmitted the packer must reproduce
   the pedal's own wire bytes exactly; the live run gated on this too. */
const { buildEditBuffer, pack7, unpack7 } = global.PatchBackupCodec;
const wire = bytes.slice(5, -1);
assert.deepEqual(pack7(unpack7(wire)), wire, 'pack7 round-trips the captured frame byte for byte');
assert.deepEqual(buildEditBuffer(p.body), bytes, 'buildEditBuffer rebuilds the captured frame exactly');

// High-bit bytes must survive the packing, which is where a naive packer breaks.
const highs = Array.from({ length: 122 }, (_, i) => (i * 7 + 129) & 0xff);
assert.deepEqual(unpack7(pack7(highs)), highs, 'bytes with bit 7 set round-trip');

// The name change that proved 0x28 is a write.
const renamed = p.body.slice();
'RUNG1TEST '.split('').forEach((c, i) => { renamed[111 + i] = c.charCodeAt(0); });
const f = buildEditBuffer(renamed);
assert.equal(f.length, 146, 'a renamed body still builds a 146-byte frame');
assert.equal(global.PatchBackupCodec.validateEditBuffer(f).name, 'RUNG1TEST', 'rename survives the round trip');

assert.throws(() => buildEditBuffer(p.body.slice(0, 121)), /122 bytes/);
assert.throws(() => buildEditBuffer(p.body.map(() => 256)), /0-255/);
console.log('Packer: round-trips real wire bytes, high bits survive, rename rebuilds cleanly');

/* --- did a written patch take? ---------------------------------------------
   The pedal recomputes parameter fields on load, and which ones depends on the
   chain. A verify that demanded byte equality, with three offsets excused,
   reported a real write as failed: right name, right chain, four recalculated
   bytes. */
const { comparePatch } = global.PatchBackupCodec;
const base = p.body.slice();

// identical bodies
let c = comparePatch(base, base);
assert.equal(c.ok, true);
assert.equal(c.drift, 0);

// the pedal recalculating parameter bytes is not a failure, at any offset
const recalculated = base.slice();
[12, 13, 16, 40, 77, 103].forEach(o => { recalculated[o] = (recalculated[o] + 1) & 0xff; });
c = comparePatch(base, recalculated);
assert.equal(c.ok, true, 'recomputed parameter bytes do not fail a write');
assert.equal(c.drift, 6, 'but the drift is reported');
assert.equal(c.badSlot, -1);

// a wrong name is a failure, and says what it read
const wrongName = base.slice();
'XX'.split('').forEach((ch, i) => { wrongName[111 + i] = ch.charCodeAt(0); });
c = comparePatch(base, wrongName);
assert.equal(c.ok, false);
assert.equal(c.nameOk, false);
assert.equal(c.gotName.slice(0, 2), 'XX');

// a wrong effect in a slot is a failure, and names the slot
const swapped = base.slice();
swapped[2 * 18] ^= 0xff;
c = comparePatch(base, swapped);
assert.equal(c.ok, false);
assert.equal(c.badSlot, 2, 'the offending slot is identified');

// a flipped bypass bit is a real difference, not drift
const bypassed = base.slice();
bypassed[0] ^= 1;
c = comparePatch(base, bypassed);
assert.equal(c.ok, false, 'an effect switched off is not the patch that was sent');
assert.equal(c.badSlot, 0);

assert.throws(() => comparePatch(base.slice(0, 121), base), /122 bytes/);
console.log('Write verification: recomputed bytes pass with drift reported; wrong name, wrong effect and flipped bypass all fail and say which');
