const assert=require('node:assert/strict'),fs=require('node:fs');require('./backup.js');
// Hardware-captured fixture, not redistributable: it holds the author's own
// pedal contents or ZOOM binary data. Skip cleanly when it is absent, the way
// iap-signature.test.cjs already does, so a published checkout runs green.
const FIXTURE=__dirname+'/../backups/ms100bt-patches-20260908.json';
if(!fs.existsSync(FIXTURE)){console.log('Captured 50-patch backup absent; slot-backup checks skipped');process.exit(0);}
const backup=JSON.parse(fs.readFileSync(FIXTURE));
for(const p of backup.patches){const b=p.sysexHex.split(' ').map(x=>parseInt(x,16));const decoded=PatchBackupCodec.validate(b,p.slot-1);assert(decoded.crcValid);assert.equal(decoded.bytes,156);const bad=b.slice();bad[20]^=1;assert.throws(()=>PatchBackupCodec.validate(bad,p.slot-1),/CRC/);assert.throws(()=>PatchBackupCodec.validate(b,(p.slot)%50),/slot/);assert.throws(()=>PatchBackupCodec.validate(b.slice(0,-2),p.slot-1));}
assert.equal(PatchBackupCodec.validate(backup.patches[0].sysexHex.split(' ').map(x=>parseInt(x,16)),0).name,'RAT Drive2');
console.log(`Validated ${backup.patches.length} real patch CRCs, slot correlation, truncation and corrupted-data rejection`);
