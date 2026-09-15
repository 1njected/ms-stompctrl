/* Reading and planning a sound package.

   The package is what bundle.js writes: patches.json, effects/*.ZDL and a
   manifest. Everything here is offline -- reading, comparing against the pedal's
   directory, and deciding what would be installed -- so it can be tested for
   real without hardware. Installing is the part that needs a pedal. */
const assert = require('node:assert/strict'), fs = require('node:fs');

global.indexedDB = {};
global.localStorage = { getItem: () => null, setItem() {} };
require('./bundle.js');            // BackupBundle.zip writes the package
require('./effect-store.js');      // zipEntries and effectName read it back
require('./restore.js');

// Hardware-captured fixture, not redistributable: it holds the author's own
// pedal contents or ZOOM binary data. Skip cleanly when it is absent, the way
// iap-signature.test.cjs already does, so a published checkout runs green.
const FIXTURE = __dirname + '/../backups/ms100bt-patches-20260908.json';
if (!fs.existsSync(FIXTURE)) { console.log('Captured 50-patch backup absent; restore planning checks skipped'); process.exit(0); }
const backup = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// A ZDL carries its own id at 0x40 and version at 0x44; that is all this needs.
const zdl = (id, version = '1.00') => {
  const b = new Uint8Array(0x80), put = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  put(4, 'SIZE'); put(0x14, 'INFO'); put(0x44, version + '\0');
  new DataView(b.buffer).setUint32(0x40, parseInt(id, 16), true);
  return b;
};

// --- which effects the patches actually reference ---------------------------
const referenced = global.soundPackage.referencedEffects(backup.patches);
assert.equal(referenced.size, 68, 'the 50 real patches reference 68 distinct effects');
for (const [id, slots] of referenced) {
  assert.match(id, /^[0-9a-f]{8}$/, `${id} is an 8-digit hex id`);
  assert(slots.length > 0 && slots.length <= 50, `${id} is used by 1..50 patches`);
}
// Bypassed slots still count: their effect must exist for the patch to load.
assert(referenced.size > new Set(backup.patches.flatMap(p => p.name)).size / 2, 'sanity');

// --- build a package the way bundle.js does ---------------------------------
const chosen = [...referenced.keys()].slice(0, 5);
const files = [['patches.json', new TextEncoder().encode(JSON.stringify(backup))]];
const manifest = { format: 'stompshare-bundle', version: 1, effects: [] };
// Distinct names on purpose. The pedal has one flat namespace, so "is it
// installed" is decided by filename; two fixtures sharing one would make this
// test pass for the wrong reason.
for (const [n, id] of chosen.entries()) {
  const name = `FX${n}_${id.slice(-3).toUpperCase()}.ZDL`;
  files.push([`effects/${id}-${name}`, zdl(id)]);
  manifest.effects.push({ effectId: id, filename: name, path: `effects/${id}-${name}`,
                          version: '1.00', usedBy: referenced.get(id) });
}
files.push(['manifest.json', new TextEncoder().encode(JSON.stringify(manifest))]);
const packageZip = global.BackupBundle.zip(files);

(async () => {
  const pkg = await global.soundPackage.read(await packageZip.arrayBuffer());
  assert.equal(pkg.patches.length, 50, 'all 50 patches come back');
  assert.equal(pkg.complete, true, 'the backup was marked complete');
  assert.equal(pkg.effects.length, 5, 'five binaries come back');
  assert.equal(new Set(pkg.effects.map(e => e.filename)).size, 5, 'the fixture names are distinct');
  // The id prefix bundle.js adds must not become the filename.
  for (const e of pkg.effects) {
    assert(!/^[0-9a-f]{8}-/i.test(e.filename), `${e.filename} keeps the export prefix`);
    assert(e.filename.length <= 12, `${e.filename} is longer than a pedal filename`);
    assert.match(e.effectId, /^[0-9a-f]{8}$/, 'the manifest supplied the id');
    assert(e.data.length > 0, 'the binary came through');
  }

  // --- nothing installed yet -----------------------------------------------
  // A plan is driven by what the PATCHES reference, not by what the package
  // happens to carry: the point of dropping the binaries is that the pedal and
  // the library already hold them.
  const disk = { total: 4143170, free: 2437640 };
  let p = global.soundPackage.plan(pkg, { installedNames: [], disk });
  assert.equal(p.referenced, referenced.size, 'the plan covers every referenced effect');
  assert.equal(p.missing.length, 5, 'the five the ZIP carried are installable');
  assert.equal(p.present, 0);
  assert.equal(p.builtIn.length, referenced.size - 5,
               'ids the library does not list are factory effects, present on every pedal');
  assert(p.builtIn.every(e => /^[0-9a-f]{8}$/.test(e.effectId)), 'each names its id');
  assert.equal(p.fits, true, 'five small effects fit in 2.4 MB');
  assert.equal(p.patches, 50);

  // --- resolved from the library instead of the package ---------------------
  // The library knows an id's filename, which is the only way to ask the pedal
  // whether it already has it.
  const library = pkg.effects.map(e => ({ effectId: e.effectId, filename: e.filename,
                                          version: e.version, bytes: 4096 }));
  const jsonOnly = { ...pkg, effects: [] };
  p = global.soundPackage.plan(jsonOnly, { installedNames: [], disk, library });
  assert.equal(p.missing.length, 5, 'the library supplies what the package no longer carries');
  assert.equal(p.bytesNeeded, 5 * 4096, 'and its sizes drive the space check');

  // Already on the pedal: nothing to install.
  p = global.soundPackage.plan(jsonOnly,
        { installedNames: library.map(e => e.filename), disk, library });
  assert.equal(p.missing.length, 0, 'effects already on the pedal are not reinstalled');
  assert.equal(p.present, 5);

  // --- some already there ---------------------------------------------------
  const half = pkg.effects.slice(0, 2).map(e => e.filename);
  p = global.soundPackage.plan(pkg, { installedNames: half, disk });
  assert.equal(p.present, 2, 'two are recognised as already installed');
  assert.equal(p.missing.length, 3);

  // Matching is case-insensitive: the pedal reports uppercase names.
  p = global.soundPackage.plan(pkg, { installedNames: half.map(n => n.toLowerCase()) });
  assert.equal(p.present, 2, 'case does not decide whether an effect is installed');

  // --- no room --------------------------------------------------------------
  p = global.soundPackage.plan(pkg, { installedNames: [], disk: { total: 4143170, free: 1024 } });
  assert.equal(p.fits, false, 'a nearly full pedal is refused before anything is written');
  await assert.rejects(() => global.soundPackage.installMissing(pkg,
                         { disk: { total: 4143170, free: 1024 } }),
                       /free/, 'and installMissing refuses rather than starting');

  // Unknown free space is not the same as "it fits".
  assert.equal(global.soundPackage.plan(pkg, { installedNames: [] }).fits, null);

  // --- a patch backup on its own is a valid package -------------------------
  const jsonBuf = new TextEncoder().encode(JSON.stringify(backup)).buffer;
  const fromJson = await global.soundPackage.read(jsonBuf);
  assert.equal(fromJson.patches.length, 50, 'a plain backup JSON reads as a package');
  assert.equal(fromJson.effects.length, 0, 'and carries no binaries');
  assert.equal(fromJson.complete, true);
  await assert.rejects(() => global.soundPackage.read(
                         new TextEncoder().encode('{"nope":1}').buffer),
                       /no patches/, 'JSON without patches is refused by name');

  // --- a ZIP that is not a package -----------------------------------------
  const notAPackage = await global.BackupBundle.zip([['readme.txt', new TextEncoder().encode('hello')]]).arrayBuffer();
  await assert.rejects(() => global.soundPackage.read(notAPackage),
                       /patches\.json/, 'a ZIP without patches.json is refused by name');

  // --- patch restore ---------------------------------------------------------
  await assert.rejects(() => global.soundPackage.restorePatches(pkg), /Connect the pedal/,
                       'restore refuses without a pedal');

  // With a stubbed pedal it walks the slots and reports what it wrote.
  const calls = [];
  global.patchBackup = {
    writeSlot: async (slot, body) => {
      assert.equal(body.length, 122, 'each body handed to writeSlot is 122 bytes');
      calls.push(slot);
      return { slot: slot + 1, verified: true };
    },
  };
  const ok = await global.soundPackage.restorePatches(pkg, { slots: [1, 2, 3] });
  assert.deepEqual(calls, [0, 1, 2], 'slots are 0-based on the wire, 1-based in the package');
  assert.equal(ok.written.length, 3);
  assert.equal(ok.failed.length, 0);

  // AUTO SAVE off shows up as a failed verify, and must stop the run rather
  // than grind through fifty slots writing nothing.
  calls.length = 0;
  global.patchBackup = {
    writeSlot: async () => { throw Error('Patch 1 did not take: 40 unexpected bytes differ. Is AUTO SAVE on?'); },
  };
  const bad = await global.soundPackage.restorePatches(pkg);
  assert.equal(bad.written.length, 0);
  assert.equal(bad.failed.length, 1, 'stops on the first AUTO SAVE failure');
  assert.match(bad.failed[0].error, /AUTO SAVE/);

  // --- a failed effect holds back only the patches that need it -------------
  // One install timeout used to stop the whole restore before a single patch
  // was written, which is what happened to RED_CRU.ZDL in practice.
  const blockedId = [...referenced.keys()][0];
  const blockedSlots = referenced.get(blockedId);
  calls.length = 0;
  global.patchBackup = { writeSlot: async slot => { calls.push(slot + 1); return { slot: slot + 1 }; } };
  const partial = await global.soundPackage.restorePatches(pkg, { skipEffects: [blockedId] });
  assert.equal(partial.skipped.length, blockedSlots.length,
               'exactly the patches naming that effect are held back');
  assert.deepEqual(partial.skipped.map(s => s.slot).sort((a, b) => a - b),
                   [...blockedSlots].sort((a, b) => a - b));
  assert.equal(partial.written.length, 50 - blockedSlots.length, 'the rest are written');
  assert(!calls.some(slot => blockedSlots.includes(slot)), 'no blocked slot was written');
  assert(partial.skipped.every(s => /could not be installed/.test(s.reason)), 'each says why');
  // An empty skip list changes nothing.
  calls.length = 0;
  const all = await global.soundPackage.restorePatches(pkg, { skipEffects: [] });
  assert.equal(all.written.length, 50);
  assert.equal(all.skipped.length, 0);

  // --- the UI reads this object, so its shape is part of the contract --------
  // showPlan() crashed on `p.unresolved.length` after plan() was rewritten and
  // that field went away: undefined.length, thrown before anything else ran.
  // wiring.test.cjs checks `module.member` call sites, not fields on a returned
  // object, so nothing caught it. Scrape the fields ui.js actually reads off a
  // plan and require every one of them to exist.
  const uiSrc = fs.readFileSync(__dirname + '/ui.js', 'utf8');
  const showPlan = uiSrc.slice(uiSrc.indexOf('function showPlan'));
  const fields = new Set([...showPlan.slice(0, showPlan.indexOf('box.hidden=false'))
    .matchAll(/\bp\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
  assert(fields.size >= 5, `only found ${fields.size} plan fields in showPlan; the scrape is broken`);
  const shape = global.soundPackage.plan(pkg, { installedNames: [], disk });
  for (const f of fields)
    assert(f in shape, `ui.js showPlan reads p.${f}, which plan() does not return`);

  console.log(`Sound package: 50 patches referencing ${referenced.size} effects, read back from a real bundle; plan handles empty, partial, full, case differences, no room and unknown room; restore walks slots, verifies, and stops when AUTO SAVE is off`);
})();
