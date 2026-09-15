/* Every `module.member` a script calls must actually exist on that module.

   This keeps failing the same way. First `stompWrite` was defined in iap.js
   while only install.js was cache-busted, giving "g.stompWrite is not a
   function". Then effect-store.js defined extractZdls but exported the singular
   extractZdl beside it, so Import FX bundle died on
   "effectStore.extractZdls is not a function" -- a typo one character long,
   invisible to node --check, and reachable only by clicking the button.

   The modules below are the ones that can be loaded outside a browser. Each is
   required for real and every call site in the directory is checked against the
   object that actually results, so an export list that drifts from its
   definitions fails here instead of in the UI. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');

// Generated archives prefix hex to keep variants apart: exportZip writes
// <effectId>-<name>, build-bundle-assets.py writes <effectId>-<sha16>-<name>.
// Adopting a prefix as the filename corrupted the library on a backup round
// trip and broke the pedal-filename match behind the Installed badge.
const NAME_CASES = [
  ['effects/01000008-COMP.ZDL', 'COMP.ZDL'],
  ['01000008-da0a1c8055f22db4-COMP.ZDL', 'COMP.ZDL'],
  ['da0a1c8055f22db4-COMP.ZDL', 'COMP.ZDL'],
  ['effects/Whatever.100/_AG_AMP.ZDL', '_AG_AMP.ZDL'],
  ['COMP.ZDL', 'COMP.ZDL'],
  ['_ACOSTIC.ZDL', '_ACOSTIC.ZDL'],
  ['TAPEECH3.ZDL', 'TAPEECH3.ZDL'],
];

// Enough of a browser for the module bodies to evaluate. None of these modules
// touches the DOM at load; the stubs exist for the ones that capture globals.
global.indexedDB = {};
global.localStorage = { getItem: () => null, setItem() {} };
global.IAPCodec = { Parser: function () { this.feed = () => {}; }, frame: () => [] };
global.log = () => {};

for (const f of ['flst.js', 'iap.js', 'backup.js', 'bundle.js', 'effect-store.js', 'install.js',
                 'restore.js', 'patch-editor.js'])
  require('./' + f);

// Modules whose surface is fixed at load and therefore checkable here.
const MODULES = ['effectStore', 'FlstCodec', 'IAPCodec', 'BackupBundle', 'PatchBackupCodec',
                 'pedalCodec', 'pedalInstaller', 'soundPackage', 'PatchEditor'];

// Deliberately not checked: iapHost, pedalInventory and patchBackup gain their
// methods only after the DOM-dependent half of their module runs, so requiring
// them here would prove nothing about the real object.
const DOM_BOUND = ['iapHost', 'pedalInventory', 'patchBackup'];

for (const m of MODULES) assert(global[m], `${m} did not load`);

const scripts = fs.readdirSync(__dirname).filter(f => f.endsWith('.js'));
const missing = [], checked = new Set();

for (const file of scripts) {
  // Strip line comments and template/quoted strings so prose mentioning a
  // member name cannot masquerade as a call site.
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
  for (const m of MODULES) {
    const re = new RegExp(`\\b(?:globalThis\\.|global\\.|g\\.)?${m}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
    for (const hit of src.matchAll(re)) {
      const member = hit[1];
      checked.add(`${m}.${member}`);
      if (!(member in global[m])) missing.push(`${file}: ${m}.${member}`);
    }
  }
}

// A tripwire, not a target: if the scan ever matches nothing -- a broken regex,
// a renamed global -- it must fail loudly rather than report a clean pass over
// zero call sites. 15 are found today; pedalCodec and PatchBackupCodec have
// none, being surfaces that exist for the tests.
assert(checked.size >= 12, `the scan found only ${checked.size} call sites; it is probably broken`);
// The members the app cannot work without. effectStore.extractZdls was here
// until importArchive replaced it at the call site, which is the test doing its
// job: a member that stops being called should be noticed, not silently kept.
for (const required of ['effectStore.importArchive', 'effectStore.catalog', 'effectStore.artwork',
                        'effectStore.binary', 'effectStore.add', 'FlstCodec.remove',
                        'soundPackage.read', 'soundPackage.plan', 'soundPackage.installMissing',
                        'IAPCodec.frame', 'pedalInstaller.install',
                        'soundPackage.restorePatches',
                        'PatchEditor.decode', 'PatchEditor.encode', 'PatchEditor.rename',
                        'PatchEditor.toggle', 'PatchEditor.move', 'PatchEditor.clear'])
  assert(checked.has(required), `expected to see ${required} among the call sites`);

if (missing.length) assert.fail('called but not exported:\n  ' + missing.join('\n  '));

// The export being present is not the same as the import working, so round-trip
// a ZIP through the app's own writer and reader.
(async () => {
  // ZOOM's binaries are not part of the published app, so everything that needs
  // one is conditional on a local checkout that still has them.
  const assets = path.join(__dirname, 'bundle-assets');
  const zdlName = fs.existsSync(assets) && fs.readdirSync(assets).find(f => f.endsWith('.ZDL'));
  if (!zdlName) {
    for (const [given, want] of NAME_CASES) assert.equal(global.effectStore.effectName(given), want);
    console.log(`Module wiring: ${checked.size} member calls resolve; name normalisation checked; no local binaries, ZIP round trip skipped`);
    return;
  }
  const zdl = new Uint8Array(fs.readFileSync(path.join(__dirname, 'bundle-assets', zdlName)));
  const blob = global.BackupBundle.zip([
    ['effects/' + zdlName, zdl],
    ['manifest.json', new TextEncoder().encode('{}')],
  ]);
  const out = await global.effectStore.extractZdls(await blob.arrayBuffer());
  assert.equal(out.length, 1, 'exactly the one .ZDL entry comes back');
  assert.equal(out[0].name, zdlName, 'the directory prefix is stripped from the name');
  assert.deepEqual(Array.from(out[0].data), Array.from(zdl), 'bytes survive the round trip');

  // Generated archives prefix hex to keep variants apart: exportZip writes
  // <effectId>-<name>, build-bundle-assets.py writes <effectId>-<sha16>-<name>.
  // Adopting a prefix as the filename corrupted the library on a backup round
  // trip and broke the pedal-filename match behind the Installed badge.
  const clean = global.effectStore.effectName;
  for (const [given, want] of NAME_CASES) assert.equal(clean(given), want, `${given} should normalise to ${want}`);
  // Whatever it returns must be a name the pedal could actually hold.
  for (const name of fs.readdirSync(assets).filter(f => f.endsWith('.ZDL')))
    assert(clean(name).length <= 12, `${clean(name)} is longer than a pedal filename`);
  console.log(`Module wiring: ${checked.size} distinct member calls across ${scripts.length} scripts all resolve (${MODULES.length} modules checked, ${DOM_BOUND.length} DOM-bound skipped); Import FX bundle round-trips ${zdl.length} bytes`);
})().catch(e => { console.error(e); process.exit(1); });
