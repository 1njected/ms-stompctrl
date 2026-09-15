/* The on-the-wire encode chain for a 60 23 write chunk, checked against the 36
   whole write frames in the native iPad capture.

   This exists because the unsigned shift in enc() was fixed once, on branch
   session-20260909-protocol-work, and silently lost when main was restored to
   b0fc67b -- the code still ran, and the pedal reports a rejected chunk with a
   status word the installer discarded, so nothing failed loudly for two days. */
const assert = require('node:assert/strict'), fs = require('node:fs');

// install.js builds two IAPCodec.Parser instances and wraps globalThis.log at
// load; neither matters here, so stub just enough for it to evaluate.
global.IAPCodec = { Parser: function () { this.feed = () => {}; }, frame: () => [] };
global.log = () => {};
require('./install.js');
const { enc, pack, unpack, crc } = global.pedalCodec;

// --- the regression itself --------------------------------------------------
assert.deepEqual(enc(0x80000000), [0, 0, 0, 0, 8], 'bit 31 must not sign-extend');
assert.deepEqual(enc(0xedb88320), [32, 6, 98, 109, 14]);
assert.deepEqual(enc(0xffffffff), [127, 127, 127, 127, 15], 'the largest CRC is 15 in the top group');
assert.deepEqual(enc(0), [0, 0, 0, 0, 0]);
assert.deepEqual(enc(0x7fffffff), [127, 127, 127, 127, 7], 'below bit 31 both shifts agree');
for (const n of [0, 1, 0x7fffffff, 0x80000000, 0xdc99e6dc, 0xffffffff]) {
  const g = enc(n);
  assert.equal(g.length, 5);
  for (const v of g) assert(v >= 0 && v <= 127, `group ${v} is not 7-bit for 0x${n.toString(16)}`);
  assert.equal(g.reduce((a, v, i) => a + v * 2 ** (7 * i), 0), n, 'decodes back to the same value');
}

// --- pack/unpack round trip -------------------------------------------------
for (const len of [0, 1, 6, 7, 8, 13, 14, 4096]) {
  const data = Array.from({ length: len }, (_, i) => (i * 37 + 211) & 255);
  assert.deepEqual(unpack(pack(data)).slice(0, len), data, `round trip at ${len} bytes`);
  for (const v of pack(data)) assert(v <= 127, 'packed bytes must be 7-bit');
}

// --- against the wire -------------------------------------------------------
// Frame layout: F0 52 00 5E 60 23 | 5 zero bytes | length:5 | packed | crc:5 | F7
const dec5 = g => g.reduce((a, v, i) => a + v * 2 ** (7 * i), 0);
const frames = [];
// Hardware-captured fixture, not redistributable: it holds the author's own
// pedal contents or ZOOM binary data. Skip cleanly when it is absent, the way
// iap-signature.test.cjs already does, so a published checkout runs green.
const CAPTURE = __dirname + '/../runtime/capture-20260908-native.jsonl';
if (!fs.existsSync(CAPTURE)) { console.log('Native install capture absent; install codec checks skipped'); process.exit(0); }
for (const line of fs.readFileSync(CAPTURE, 'utf8').split('\n')) {
  let rec; try { rec = JSON.parse(line); } catch { continue; }
  if (!rec || !rec.hex) continue;                      // packet bytes are a top-level key
  const b = Buffer.from(rec.hex.replace(/ /g, ''), 'hex');
  for (let i = 0; (i = b.indexOf(Buffer.from('f052005e6023', 'hex'), i)) >= 0; i++) {
    const end = b.indexOf(0xf7, i);
    if (end > 0 && end - i >= 100) frames.push(b.subarray(i, end + 1));
  }
}
assert.equal(frames.length, 36, 'the native capture holds 36 whole write chunks');

let signExtended = 0;
for (const f of frames) {
  const declared = dec5(Array.from(f.subarray(11, 16)));
  const raw = unpack(Array.from(f.subarray(16, -6))).slice(0, declared);
  assert.equal(raw.length, declared, 'unpacked length matches the declared length');
  const computed = crc(raw);
  assert.deepEqual(enc(computed), Array.from(f.subarray(-6, -1)),
    `chunk CRC must reproduce the captured bytes (0x${computed.toString(16)})`);
  if (computed >= 0x80000000) signExtended++;
}
assert(signExtended >= 15, `expected the corpus to exercise bit 31; only ${signExtended} chunks do`);

console.log(`Write encode chain: ${frames.length}/${frames.length} native chunks reproduced byte for byte, ${signExtended} of them with bit 31 set (the group ">>" corrupted)`);
