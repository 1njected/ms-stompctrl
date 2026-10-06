/* The slot parameter layout, and the defaults built on top of it.

   Two halves. The structural half needs nothing: it checks the bit table is a
   partition -- no bit used twice, none outside the slot's own bytes -- and that
   read/write are inverses over the whole value range. The hardware half needs
   the captured backup and skips without it, the way patch-editor.test.cjs does;
   it is the check that the table is the RIGHT one, by decoding 786 real
   parameters and holding them against the ranges their .ZDL states. */
const assert = require('node:assert/strict'), fs = require('node:fs');
global.window = global;
require('./patch-editor.js');
require('./patch-params.js');
const P = global.PatchParams, E = global.PatchEditor;

// --- the table is a partition of real slot bits -----------------------------
const seen = new Map();
P.LAYOUT.forEach((bits, p) => {
  assert.equal(bits.length % 2, 0, `p${p}: bit list must be [byte,bit] pairs`);
  for (let i = 0; i < bits.length; i += 2) {
    const byte = bits[i], bit = bits[i + 1], key = `${byte}.${bit}`;
    // Byte 3 is the id word's top byte, and only its top three bits are ours:
    // the rest is the effect id. Bytes 4-17 are the parameter bytes.
    assert.ok(byte === 3 ? bit >= 5 && bit <= 7 : byte >= 4 && byte <= 17,
      `p${p} b${i / 2} lands on byte ${byte} bit ${bit}, outside the slot's parameter bits`);
    assert.ok(!seen.has(key), `byte ${byte} bit ${bit} is claimed by p${seen.get(key)} and p${p}`);
    seen.set(key, p);
  }
});
assert.equal(P.LAYOUT.length, P.PARAMS);
assert.deepEqual(P.WIDTH, [12, 11, 11, 8, 8, 8, 8, 9, 8]);
// The cabinet byte is not a packed field, so no parameter may claim a bit of it.
for (let bit = 0; bit < 8; bit++)
  assert.ok(!seen.has(`${P.CAB_AT}.${bit}`), `the cabinet byte ${P.CAB_AT} must stay unpacked`);

// --- read and write are inverses --------------------------------------------
const slotOf = ({ flags, params }) => ({ flags, params });
for (let p = 0; p < P.PARAMS; p++) {
  const top = (1 << P.WIDTH[p]) - 1;
  for (const v of [0, 1, 2, top - 1, top, Math.floor(top / 3)]) {
    const values = new Array(P.PARAMS).fill(0); values[p] = v;
    const back = P.read(slotOf(P.write(values)));
    assert.deepEqual(back, values, `p${p}=${v} did not survive a round trip`);
  }
}
// Every parameter at once, so a field that borrowed a neighbour's bit shows up.
const full = P.WIDTH.map(w => (1 << w) - 1);
assert.deepEqual(P.read(slotOf(P.write(full))), full);
// A value past its field is clamped, not wrapped: silently writing 0 for 4096
// would be a plausible-looking delay time rather than the longest one.
assert.deepEqual(P.read(slotOf(P.write([9999]))).slice(0, 1), [(1 << P.WIDTH[0]) - 1]);

// --- defaults, and the cabinet byte -----------------------------------------
const seed = P.defaults([{ name: 'Time', max: 2014, def: 499 }, { name: 'F.B', max: 100, def: 50 }]);
assert.equal(seed.params.length, 14);
assert.deepEqual(P.read(slotOf(seed)).slice(0, 2), [499, 50]);
// p0's low three bits live in the id word, so a default over 7 must set them.
assert.ok(seed.flags > 0, '499 needs bits below 8, which live in the id word');
/* CAB is the one descriptor entry whose fields are not a range and a default:
   max reads 0 and "default" reads a pointer. It still consumes a parameter
   index, so its field is written zero rather than skipped -- otherwise every
   knob after it shifts down one -- and the cabinet byte stays 0, which is
   cabinet off, the state half the amp slots in the backup are already in. */
{
  const amp = [{ name: 'Gain', max: 100, def: 50 }, { name: 'CAB', max: 0, def: 67109072 },
               { name: 'OUT', max: 4, def: 1 }];
  const s = P.defaults(amp);
  const v = P.read(slotOf(s));
  assert.equal(v[0], 50, 'the knob before CAB is where it belongs');
  assert.equal(v[1], 0, "CAB's pointer-valued default is not packed");
  assert.equal(v[2], 1, 'and the knob after CAB has not shifted down');
  assert.equal(s.params[P.CAB_AT - 4], 0, 'the cabinet byte is off');
  assert.equal(P.isCab({ name: 'cab' }), true);
  assert.equal(P.isCab({ name: 'Bass' }), false);
}

// --- setEffect carries the flags, because they are parameter bits -----------
{
  const body = new Array(122).fill(0);
  for (let i = 0; i < 6; i++) body[i * 18] = 1;            // six empty slots
  const patch = E.decode(body);
  const next = E.setEffect(patch, 0, '08000020', seed.params, seed.flags);
  assert.deepEqual(P.read(next.slots[0]).slice(0, 2), [499, 50],
    'setEffect dropped the flags, so parameter 0 came back wrong');
  // Without them, p0 loses its low three bits -- the bug this guards.
  const lossy = E.setEffect(patch, 0, '08000020', seed.params);
  assert.notDeepEqual(P.read(lossy.slots[0]).slice(0, 1), [499]);
}

// --- against the real pedal -------------------------------------------------
// Hardware-captured fixture, not redistributable: it holds the author's own
// pedal contents. Skip cleanly when absent so a published checkout runs green.
const FIXTURE = __dirname + '/../backups/ms100bt-patches-20260908.json';
const INDEX = __dirname + '/effect-params.json';
if (!fs.existsSync(FIXTURE) || !fs.existsSync(INDEX)) {
  console.log('patch-params: structure and defaults OK; real-patch decode skipped (fixture or index absent)');
  process.exit(0);
}
const table = JSON.parse(fs.readFileSync(INDEX, 'utf8')).params;
let total = 0, inRange = 0, atDefault = 0, exact = 0, slots = 0;
for (const p of JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).patches) {
  for (const s of E.decode(p.rawHex.split(' ').map(x => parseInt(x, 16))).slots) {
    if (s.empty) continue;
    const knobs = table[s.effectId];
    if (!knobs) continue;
    slots++;
    const values = P.read(s);
    knobs.forEach((k, i) => {
      total++;
      // CAB is the documented exception: its value is the cabinet byte, not a
      // packed field, so the field at its index holds a neighbour's bits.
      if (/^cab$/i.test(k.name)) return;
      if (values[i] <= k.max) inRange++;
      else assert.fail(`${p.name}: ${s.effectId} ${k.name} decoded ${values[i]}, max ${k.max}`);
      if (values[i] === k.def) atDefault++;
    });
    // Writing the values back must reproduce the slot byte for byte, save the
    // cabinet byte this module deliberately does not own.
    const back = P.write(values);
    const same = back.flags === s.flags &&
      back.params.every((v, k) => k === P.CAB_AT - 4 || v === s.params[k]);
    if (same) exact++;
    else assert.fail(`${p.name}: ${s.effectId} did not round-trip`);
  }
}
assert.equal(exact, slots, 'every real slot must round-trip');
assert.ok(atDefault / total > 0.3,
  `only ${atDefault}/${total} parameters sit on their .ZDL default; the layout is probably wrong`);
console.log(`patch-params: ${slots} real slots round-trip, ${inRange}/${total} parameters in range, `
  + `${atDefault} exactly at their .ZDL default`);
