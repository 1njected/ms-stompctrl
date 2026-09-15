const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
require('./iap.js');
const sent=[],logs=[];
const ctx={IAPCodec:global.IAPCodec,log:(k,v)=>logs.push({k,v}),hex:b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join(' '),stompWrite:async b=>{sent.push(b);}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(__dirname+'/iap-auth.js','utf8'),ctx);
const drain=()=>new Promise(r=>setImmediate(r));
(async()=>{
 ctx.iapAuth.request();await drain();assert.equal(Buffer.from(sent[0]).toString('hex'),'550400140100e7');
 ctx.log('rx',ctx.hex(global.IAPCodec.frame(0x15,256,[2,0,0,1,48,3])));await drain();
 assert.equal(Buffer.from(sent[1]).toString('hex'),'5506000201000015e2');
 ctx.log('rx',ctx.hex(global.IAPCodec.frame(0x15,256,[2,0,1,1,1,2,3])));await drain();
 assert.deepEqual(Array.from(ctx.iapAuth.certificate),[48,3,1,2,3]);assert.equal(sent.length,2,'Capture must not claim authentication success');
 ctx.log('rx',ctx.hex(global.IAPCodec.frame(0x15,256,[2,0,3,3,1])));await drain();assert(logs.some(x=>x.k==='iap_auth_error'));
 console.log('Authentication request, section assembly, ACK, ordering rejection and no premature success passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
