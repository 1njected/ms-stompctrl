const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function setup(handler){
 const calls=[];
 const ctx=vm.createContext({EventTarget,Event,ReadableStream,WritableStream,Uint8Array,Blob,btoa,navigator:{},
  webkit:{messageHandlers:{stomp:{postMessage(message){calls.push(message);return handler(message);}}}}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/native-serial.js'),'utf8'),ctx);
 return {ctx,calls,port:ctx.navigator.serial.requestPort()};
}
test('raw iAP bytes, early receive, write backpressure, and reconnect',async()=>{
 let completeWrite;
 const s=setup(m=>m.action==='write'?new Promise(r=>completeWrite=r):Promise.resolve(true));
 const p=await s.port;
 assert.equal(p.connected,undefined); // cold paired devices reach native open
 const opening=p.open();
 s.ctx.stompMacReceive([0x55,4,0,0x38,0,1,0xc3]);
 await opening;
 const reader=p.readable.getReader();
 assert.deepEqual(Array.from((await reader.read()).value),[0x55,4,0,0x38,0,1,0xc3]);
 const writer=p.writable.getWriter();let written=false;
 const write=writer.write(Uint8Array.of(0x55,0xff,0)).then(()=>written=true);
 await new Promise(setImmediate);assert.equal(written,false);
 assert.deepEqual(Array.from(s.calls.at(-1).bytes),[0x55,0xff,0]);
 completeWrite(true);await write;writer.releaseLock();
 await reader.cancel();reader.releaseLock();await p.close();
 await p.open();await p.close();
});
test('native open failure does not leave the adapter locked',async()=>{
 let fail=true;const s=setup(()=>fail?Promise.reject(Error('refused')):Promise.resolve(true));
 const p=await s.port;await assert.rejects(p.open(),/refused/);
 fail=false;await p.open();await assert.rejects(p.open(),/already/);await p.close();
});
test('disconnect ends reads and identifies the same port to shared transport',async()=>{
 const s=setup(()=>Promise.resolve(true));const p=await s.port;await p.open();
 let target;s.ctx.navigator.serial.addEventListener('disconnect',e=>target=e.target);
 const r=p.readable.getReader();const read=r.read();s.ctx.stompMacClosed();
 assert.equal((await read).done,true);assert.equal(target,p);r.releaseLock();
});
test('write failures propagate; save preserves arbitrary bytes and cancellation',async()=>{
 const s=setup(m=>m.action==='write'?Promise.reject(Error('link lost')):Promise.resolve(true));
 const p=await s.port;await p.open();const w=p.writable.getWriter();
 await assert.rejects(w.write(Uint8Array.of(1)),/link lost/);w.releaseLock();await p.close();
 await s.ctx.stompHostSave('backup.bin',new Blob([Uint8Array.of(0,128,255)]));
 assert.equal(s.calls.at(-1).base64,'AID/');
 const cancelled=setup(()=>Promise.reject(Error('Save cancelled.')));
 await assert.rejects(cancelled.ctx.stompHostSave('backup.bin',new Blob(['x'])),/Save cancelled/);
});
