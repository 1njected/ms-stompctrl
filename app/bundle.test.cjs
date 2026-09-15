const assert=require('node:assert/strict'),fs=require('node:fs');require('./bundle.js');
// Hardware-captured fixture, not redistributable: it holds the author's own
// pedal contents or ZOOM binary data. Skip cleanly when it is absent, the way
// iap-signature.test.cjs already does, so a published checkout runs green.
const FIXTURE=__dirname+'/../backups/ms100bt-patches-20260908.json';
if(!fs.existsSync(FIXTURE)){console.log('Captured 50-patch backup absent; dependency-mapping checks skipped');process.exit(0);}
const b=JSON.parse(fs.readFileSync(FIXTURE));const deps=BackupBundle.dependencies(b);assert.equal(deps.size,68);assert(deps.get('03000060').some(x=>x.patch===1));assert(deps.get('01000050').some(x=>x.patch===1));assert.throws(()=>BackupBundle.dependencies({...b,complete:false}));console.log('50-patch mapping: 68 nonempty effect IDs, RAT and ZNR fixture matches; incomplete backup rejected');
