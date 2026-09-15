/* Validates the effect-list codec against the real before/after pair extracted
   from the native install capture (runtime/flst/). */
const assert = require('node:assert/strict'), fs = require('node:fs');
require('./flst.js');
const F = global.FlstCodec;

const dir = __dirname + '/../runtime/flst/';
// Hardware-captured fixture, not redistributable: it holds the author's own
// pedal contents or ZOOM binary data. Skip cleanly when it is absent, the way
// iap-signature.test.cjs already does, so a published checkout runs green.
if (!fs.existsSync(dir + 'FLST_SEQ.before.bin')) { console.log('Captured effect-list binaries absent; FLST codec checks skipped'); process.exit(0); }
const before = new Uint8Array(fs.readFileSync(dir + 'FLST_SEQ.before.bin'));
const after = new Uint8Array(fs.readFileSync(dir + 'FLST_SEQ.after.bin'));

assert.equal(before.length, 4108);
assert.equal(after.length, 4108);
assert.equal(F.SIZE, 4108);
assert.equal(F.RECORD * F.TOTAL, 4108);

// --- structure -------------------------------------------------------------
const cats = F.categories(before);
assert.equal(cats.length, 32, '32 category blocks');
assert.deepEqual(cats.map(c => c.id), [...Array(32).keys()], 'ids 0..31 in order');
assert.equal(F.entries(before).length, 102);
assert.equal(F.entries(after).length, 103);
assert.deepEqual(cats.find(c => c.id === 1).files.slice(0, 3), ['COMP.ZDL', 'RACKCOMP.ZDL', 'M_COMP.ZDL']);
assert.equal(cats.find(c => c.id === 5).files.length, 0, 'category 5 empty before the install');

// --- the native change is reproduced byte for byte --------------------------
const made = F.insert(before, '_AG_AMP.ZDL', 5);
assert.equal(made.changed, true);
assert.equal(made.category, 5);
assert.deepEqual(Array.from(made.bytes), Array.from(after),
  'insert() must reproduce the captured native result exactly');

// --- category derivation ----------------------------------------------------
// The category is the high byte of the effect ID at ZDL offset 0x40. A minimal
// synthetic header proves the rule without needing a ZOOM binary, so this runs
// in a checkout that ships none -- which a published copy does not.
const stubZdl = id => {
  const b = new Uint8Array(0x80), put = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  put(4, 'SIZE'); put(0x14, 'INFO'); put(0x44, '1.00\0');
  new DataView(b.buffer).setUint32(0x40, id, true);
  return b;
};
for (const [id, category] of [[0x05100070, 5], [0x01000008, 1], [0x1f000000, 31], [0x00000001, 0]]) {
  const c = F.categoryOf(stubZdl(id));
  assert.equal(c.effectId >>> 0, id >>> 0, `effect ID 0x${id.toString(16)}`);
  assert.equal(c.category, category, `category of 0x${id.toString(16)}`);
}
assert.throws(() => F.categoryOf(new Uint8Array(0x40)), /too short/);

// Against the real binaries, every listed effect must agree with its own ID.
// Skipped where bundle-assets is absent: those are ZOOM's files and are not
// part of the published app.
const assets = __dirname + '/bundle-assets';
let checked = 0;
if (fs.existsSync(assets)) {
  const files = fs.readdirSync(assets).filter(f => f.endsWith('.ZDL'));
  const byName = new Map(files.map(f => [f.split('-').pop().toUpperCase(), f]));
  for (const cat of F.categories(after))
    for (const name of cat.files) {
      const file = byName.get(name.toUpperCase());
      if (!file) continue;
      const bin = new Uint8Array(fs.readFileSync(assets + '/' + file));
      assert.equal(F.categoryOf(bin).category, cat.id, `${name} category`);
      checked++;
    }
  assert(checked > 90, `expected to verify most entries, checked ${checked}`);
}

// --- idempotence and guards -------------------------------------------------
assert.equal(F.insert(after, '_AG_AMP.ZDL', 5).changed, false, 'already-listed insert is a no-op');
assert.equal(F.insert(after, '_ag_amp.zdl', 5).changed, false, 'match is case-insensitive');
assert.throws(() => F.insert(before, 'X.ZDL', 99), /no category 99/);
assert.throws(() => F.insert(before.slice(0, 100), 'X.ZDL', 5), /Unexpected effect list size/);
assert.throws(() => F.insert(before, 'THIS_NAME_IS_WAY_TOO_LONG.ZDL', 5), /too long/);

// A full list must be refused rather than silently dropping a real entry.
const full = F.toRecords(before);
for (let i = 0; i < F.TOTAL; i++) if (F.isFree(full[i])) full[i] = F.record('FILLER.ZDL');
assert.throws(() => F.insert(F.serialize(full), 'X.ZDL', 5), /full/);

// Inserting keeps every previously listed effect.
const kept = F.entries(made.bytes);
for (const name of F.entries(before)) assert(kept.includes(name), `${name} must survive insertion`);

// --- removal is the exact inverse of insertion ------------------------------
// The native after-image differs from before by exactly one inserted record, so
// removing that record must reproduce the before-image byte for byte.  This is
// the property the delete path depends on: nothing else in the file may move.
const undone = F.remove(after, '_AG_AMP.ZDL');
assert.equal(undone.changed, true, 'the listed effect is found');
assert.deepEqual(Array.from(undone.bytes), Array.from(before), 'remove undoes the native insert exactly');

// Round trip in the other direction, for an arbitrary category.
const roundTrip = F.remove(F.insert(before, 'TESTFX.ZDL', 7).bytes, 'TESTFX.ZDL');
assert.deepEqual(Array.from(roundTrip.bytes), Array.from(before), 'insert then remove is a no-op');

assert.equal(F.remove(before, '_AG_AMP.ZDL').changed, false, 'removing an unlisted effect changes nothing');
assert.equal(F.remove(after, '_ag_amp.zdl').changed, true, 'removal matches case-insensitively');
assert.equal(F.remove(before, 'NOSUCH.ZDL').reason, 'not listed');
assert.throws(() => F.remove(before.slice(0, 100), 'X.ZDL'), /Unexpected effect list size/);

// Size, record count and category structure are preserved.
assert.equal(undone.bytes.length, F.SIZE);
assert.equal(F.toRecords(undone.bytes).length, F.TOTAL);
assert.deepEqual(F.categories(undone.bytes).map(c => c.id), [...Array(32).keys()], 'markers keep their order');
assert.equal(F.entries(undone.bytes).length, 102);

// Category markers must never be mistaken for entries.
for (const marker of ['>>>', '<<<']) assert.equal(F.remove(before, marker).changed, false, `${marker} is not removable`);

// Every other effect survives a removal.
const survivors = F.entries(F.remove(before, 'COMP.ZDL').bytes);
assert(!survivors.includes('COMP.ZDL'), 'the named effect is gone');
for (const name of F.entries(before)) if (name !== 'COMP.ZDL')
  assert(survivors.includes(name), `${name} must survive removal`);
assert.equal(survivors.length, 101);

console.log(`Effect list codec: reproduces the captured native install byte-for-byte, ${checked ? checked + ' category derivations against real binaries' : 'category rule on synthetic headers'}, guards for duplicates/full/oversize, removal inverts insertion exactly`);
