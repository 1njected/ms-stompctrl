/* The patch editor codec, against the 50 real patches in a hardware backup. */
const assert = require('node:assert/strict'), fs = require('node:fs');
global.window = global;
require('./patch-editor.js');
const E = global.PatchEditor;

// Hardware-captured fixture, not redistributable: it holds the author's own
// pedal contents or ZOOM binary data. Skip cleanly when it is absent, the way
// iap-signature.test.cjs already does, so a published checkout runs green.
const FIXTURE = __dirname + '/../backups/ms100bt-patches-20260908.json';
if (!fs.existsSync(FIXTURE)) { console.log('Captured 50-patch backup absent; patch codec round-trip skipped'); process.exit(0); }
const backup = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const body = p => {
  const b = p.sysexHex.split(' ').map(x => parseInt(x, 16)), packed = b.slice(10, -6), raw = [];
  for (let i = 0; i < packed.length; i += 8)
    for (let j = 0; j < 7 && i + j + 1 < packed.length; j++)
      raw.push(packed[i + j + 1] | (((packed[i] >> (6 - j)) & 1) << 7));
  return raw;
};

// --- every real patch round-trips byte for byte -----------------------------
let bypassed = 0, used = new Set();
for (const p of backup.patches) {
  const raw = body(p);
  const dec = E.decode(raw);
  assert.deepEqual(E.encode(dec), raw, `${p.name} round-trips unchanged`);
  assert.equal(dec.name, p.name.trimEnd(), `${p.name} name decodes`);
  assert.equal(dec.slots.length, 6);
  for (const s of dec.slots) {
    assert.match(s.effectId, /^[0-9a-f]{8}$/);
    assert.equal(s.params.length, 14);
    if (!s.empty) { used.add(s.effectId); if (!s.enabled) bypassed++; }
  }
}
assert(used.size > 20, 'the backup uses a real spread of effects');
assert(bypassed > 0, 'at least one factory slot ships bypassed — the flag is real');

// --- the edits ---------------------------------------------------------------
const p0 = E.decode(body(backup.patches[0]));
const firstUsed = p0.slots.findIndex(s => !s.empty);

const renamed = E.rename(p0, 'MY PATCH');
assert.equal(E.decode(E.encode(renamed)).name, 'MY PATCH');
// over-long and non-ASCII names are clamped, not rejected into a corrupt body
const odd = E.decode(E.encode(E.rename(p0, 'ABCDEFGHIJKLMNOP')));
assert.equal(odd.name.length, 10, 'names are clamped to 10 characters');
assert.equal(E.decode(E.encode(E.rename(p0, 'café☺'))).name, 'caf');
assert.equal(E.encode(E.rename(p0, '')).length, 122, 'an empty name still encodes');

// bypass flips only bit 0 of that slot, nothing else in the body
const off = E.setEnabled(p0, firstUsed, false);
const a = E.encode(p0), b = E.encode(off);
const diff = a.map((v, i) => [i, v, b[i]]).filter(([, v, w]) => v !== w);
assert.equal(diff.length, 1, 'bypass changes exactly one byte');
assert.equal(diff[0][0], firstUsed * 18, 'and it is the slot header byte');
assert.equal(diff[0][1] ^ diff[0][2], 1, 'and only bit 0 of it');
assert.equal(E.decode(b).slots[firstUsed].effectId, p0.slots[firstUsed].effectId,
             'the effect id survives a bypass');
assert.equal(E.toggle(off, firstUsed).slots[firstUsed].enabled, true, 'toggle restores it');

// clear empties a slot; an empty slot cannot be switched on
const cleared = E.clear(p0, firstUsed);
assert.equal(cleared.slots[firstUsed].empty, true);
assert.equal(E.decode(E.encode(cleared)).slots[firstUsed].effectId, '00000000');
assert.throws(() => E.setEnabled(cleared, firstUsed, true), /empty slot/);

// reorder carries each effect's parameters with it
const two = p0.slots.filter(s => !s.empty).length >= 2;
if (two) {
  const moved = E.move(p0, 0, 1);
  assert.deepEqual(moved.slots[1].params, p0.slots[0].params, 'parameters travel with the slot');
  assert.equal(moved.slots[1].effectId, p0.slots[0].effectId);
  assert.equal(E.encode(moved).length, 122);
}

// setEffect refuses to invent parameters
assert.throws(() => E.setEffect(p0, 0, '09000020'), /cannot invent them/);
assert.throws(() => E.setEffect(p0, 0, '09000020', [1, 2, 3]), /14 parameter bytes/);
const swapped = E.setEffect(p0, 0, '09000020', new Array(14).fill(0));
assert.equal(E.decode(E.encode(swapped)).slots[0].effectId, '09000020');
assert.equal(swapped.slots[0].enabled, true);

// --- malformed input ---------------------------------------------------------
assert.throws(() => E.decode(new Array(121).fill(0)), /122 bytes/);
assert.throws(() => E.decode(body(backup.patches[0]).map(() => 300)), /0-255/);
assert.throws(() => E.encode({ ...p0, slots: p0.slots.slice(0, 5) }), /exactly 6 slots/);
assert.throws(() => E.encode({ ...p0, tail: [] }), /Tail length/);

console.log(`Patch editor: all ${backup.patches.length} real patches round-trip byte for byte; ` +
            `${used.size} effects seen, ${bypassed} factory slots ship bypassed; ` +
            `rename clamps, bypass touches one bit, reorder carries parameters, setEffect refuses to guess`);

// --- where a swap's parameters come from ------------------------------------
const sources = E.paramSources(backup.patches.map(p => ({ ...p, rawHex: body(p).map(v => v.toString(16).padStart(2,'0')).join(' ') })));
assert.equal(sources.size, used.size, 'one source per distinct effect the patches use');
for (const [id, src] of sources) {
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(src.params.length, 14, `${id} carries a full parameter block`);
  assert(src.fromPatch >= 1 && src.fromPatch <= 50, `${id} names the patch it came from`);
}
assert(!sources.has('00000000'), 'empty slots are not offered as a source');

// A block harvested from a real patch must rebuild that slot exactly.
const donorId = [...sources.keys()][0], donor = sources.get(donorId);
const host = E.decode(body(backup.patches[0]));
const withDonor = E.setEffect(host, 5, donorId, donor.params);
const round = E.decode(E.encode(withDonor));
assert.equal(round.slots[5].effectId, donorId, 'the swapped id survives an encode');
assert.deepEqual(round.slots[5].params, donor.params, 'and so do its parameters');
assert.equal(round.slots[5].enabled, true, 'a swapped-in effect starts switched on');
// Nothing outside that slot moved.
const a2 = E.encode(host), b2 = E.encode(withDonor);
const touched = a2.map((v, i) => i).filter(i => a2[i] !== b2[i]);
assert(touched.every(i => i >= 5 * 18 && i < 6 * 18), 'a swap touches only its own slot');

// Empty sources are handled, not crashed on.
assert.equal(E.paramSources([]).size, 0);
assert.equal(E.paramSources([{ rawHex: 'zz' }]).size, 0);
assert.equal(E.paramSources(null).size, 0);

console.log(`Parameter sources: ${sources.size} effects harvested from real patches, each with 14 bytes and a named donor; a swap rebuilds exactly and touches only its own slot`);

// --- what an effect is, from its id alone ------------------------------------
assert.equal(E.describe('08000040').family, 'Delay');
assert.equal(E.describe('09000020').family, 'Reverb');
assert.equal(E.describe('01000008').family, 'Dynamics');
assert.equal(E.describe('03000020').family, 'Drive');
assert.equal(E.describe('06000030').family, 'Modulation');
assert.equal(E.describe('00000000').empty, true);
// byte 2 marks the instrument family, and only then
assert.equal(E.describe('01400010').family, 'Bass drive');
assert.equal(E.describe('01400010').bass, true);
assert.equal(E.describe('01600050').family, 'Bass preamp');
assert.equal(E.describe('05100010').family, 'Bass/acoustic amp');
assert.equal(E.describe('01000008').bass, false, 'a guitar effect is not flagged');
// An unknown sub-byte still falls back to the category rather than going blank.
assert.equal(E.describe('08990000').family, 'Delay');

// Every effect the real patches use must land in a named family, or the slot
// rows go back to showing bare hex.
const unnamed = [...sources.keys()].filter(id => !E.describe(id).family);
assert.deepEqual(unnamed, [], `these ids have no family: ${unnamed.join(', ')}`);
const fams = new Set([...sources.keys()].map(id => E.describe(id).family));
assert(fams.size >= 6, `only ${fams.size} families across ${sources.size} effects`);

console.log(`Families: all ${sources.size} effects used by real patches resolve to a family; ${fams.size} distinct — ${[...fams].sort().join(', ')}`);

// Short forms exist for every family and stay short enough for a chain badge.
for (const family of Object.values(E.FAMILIES)) {
  const id = Object.entries(E.FAMILIES).find(([, v]) => v === family)[0];
  const [cat, sub] = id.split(':');
  const d = E.describe(cat + sub + '0010');
  assert.equal(d.family, family);
  assert(d.short && d.short.length <= 9, `${family} -> ${d.short} is too long for a badge`);
  assert.match(d.short, /^[A-Z]/, `${family} -> ${d.short} should read as a label`);
}
assert.equal(E.describe('01400010').short, 'Bass OD');
assert.equal(E.describe('05100010').short, 'Bass amp');
assert.equal(E.describe('02000010').short, 'EQ');
console.log('Short family labels: every family has one, all <= 9 characters');
