/* When the page may replace itself with a newer one. */
const assert=require('node:assert/strict');
require('./version-check.js');
const {shouldReload}=global.VersionCheck;

assert.equal(shouldReload('abc','abc'),false,'same version, nothing to do');
assert.equal(shouldReload('abc','def'),true,'a new deploy reloads');

/* Never mid-operation: a reload during a patch write leaves the pedal half
   written, which is worse than running yesterday's code for another minute. */
assert.equal(shouldReload('abc','def',{busy:true}),false,'not while the pedal is busy');
/* Never over an open editor: an unsaved chain would vanish. */
assert.equal(shouldReload('abc','def',{editing:true}),false,'not while a patch is being edited');
assert.equal(shouldReload('abc','def',{busy:true,editing:true}),false);

/* Missing or unreadable version information is not a reason to reload. */
assert.equal(shouldReload(null,'def'),false,'unknown own version');
assert.equal(shouldReload('abc',''),false,'empty response');
assert.equal(shouldReload('abc',null),false,'no response');
assert.equal(shouldReload(undefined,undefined),false);

/* One attempt per version. GitHub Pages serves this page with max-age=600, so
   for up to ten minutes after a deploy version.txt reports the new commit while
   index.html still comes from cache with the old token. Reloading on a loop
   until the cache expires would be worse than waiting. */
assert.equal(shouldReload('abc','def',{tried:'def'}),false,'already tried this version');
assert.equal(shouldReload('abc','def',{tried:'ghi'}),true,'a different new version is worth one attempt');
assert.equal(shouldReload('abc','def',{tried:null}),true);

console.log('Version check: reloads once per deploy, never during a pedal operation or an open editor');
