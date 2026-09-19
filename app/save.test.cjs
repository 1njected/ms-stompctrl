/* stompSave picks the host when one is present and the anchor when it is not.
   The anchor path is what every desktop browser uses; the host path exists
   because a WKWebView ignores the download attribute without erroring, so a
   regression here loses files silently rather than loudly. */
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');

const clicked=[];const revoked=[];
const ctx={Blob:class Blob{constructor(parts,opts){this.parts=parts;this.type=opts?.type;}},
 URL:{createObjectURL:()=>'blob:x',revokeObjectURL:u=>revoked.push(u)},
 setTimeout,Promise,console,
 document:{createElement:()=>({set download(v){this._d=v;},get download(){return this._d;},
   click(){clicked.push(this._d);}})}};
ctx.globalThis=ctx;vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname+'/save.js','utf8'),ctx);

(async()=>{
 await ctx.stompSave('patches.json','{}','application/json');
 assert.deepEqual(clicked,['patches.json'],'no host: the anchor is used');

 const host=[];
 ctx.stompHostSave=(name,blob)=>{host.push([name,blob.type]);};
 await ctx.stompSave('bundle.zip',new ctx.Blob([1],{type:'application/zip'}));
 assert.deepEqual(host,[['bundle.zip','application/zip']],'host takes the file');
 assert.equal(clicked.length,1,'and the anchor is not also fired');

 /* A Blob passes through unchanged; anything else is wrapped with its type. */
 await ctx.stompSave('log.json','{"a":1}','application/json');
 assert.equal(host[1][1],'application/json');

 console.log('Saving: anchor fallback, host handover and blob typing passed');
})().catch(e=>{console.error(e);process.exit(1);});
