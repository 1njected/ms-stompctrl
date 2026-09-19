/* Tests the iOS transport shim without a device: the translation both ways, and
   the runtime surface the rest of the app binds to. Plain Node, no deps, like
   every other test in this project.

     node transport-ea.test.cjs

   APP is the public repo's app/ directory. The iOS build reuses those files
   rather than copying them; this require is the same boundary, resolved the
   same way. */
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const APP=path.resolve(__dirname,'../../app');
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join(' ');

/* ---------------------------------------------- 1. translation, no DOM ---- */

require(APP+'/iap.js');                 // publishes IAPCodec, then returns
require('../web/transport-ea.js');      // publishes EATransport, then returns
const {frame,Parser}=global.IAPCodec;
const {outbound,inbound,SESSION_ID}=global.EATransport;

const sysex=[0xf0,0x52,0x00,0x5e,0x60,0x06,0xf7];        // "acquire", from the capture
const sent=outbound(frame(0x43,0x111,[SESSION_ID>>8,SESSION_ID&255,...sysex]));
assert.equal(sent.kind,'data');
assert.equal(sent.session,SESSION_ID);
assert.equal(sent.transaction,0x111);
assert.deepEqual(Array.from(sent.payload),sysex,'the session header is stripped, the SysEx is not');

/* The synthetic receipt has to satisfy install.js:53 exactly:
   if(p.lingo!==0||p.cmd!==0x41||p.data[1]!==0x43)return; keyed by transaction. */
let ack=null;new Parser(p=>{ack=p;}).feed(Array.from(sent.ack));
assert.equal(ack.lingo,0);
assert.equal(ack.cmd,0x41);
assert.equal(ack.data[1],0x43);
assert.equal(ack.transaction,0x111,'the ack must carry the transaction id it acknowledges');

/* Transport housekeeping never reaches the pedal: iOS already did it. */
for(const [cmd,what] of [[0x02,'ACK'],[0x3f,'OpenDataSessionForProtocol'],[0x40,'CloseDataSession'],[0x14,'GetAccessoryAuthenticationInfo']])
 assert.equal(outbound(frame(cmd,9,[0,0])).kind,'absorbed',what+' must be absorbed');

/* pedal -> host, and back out through the filter backup.js:124 applies:
   p.cmd!==0x42 || p.data[0]*256+p.data[1]!==iapHost.session */
const reply=[0xf0,0x52,0x00,0x5e,0x60,0x05,0x00,0xf7];
let got=null;new Parser(p=>{got=p;}).feed(Array.from(inbound(reply,0x201)));
assert.equal(got.cmd,0x42);
assert.equal(got.data[0]*256+got.data[1],SESSION_ID);
assert.deepEqual(got.data.slice(2),reply);

/* A split payload must survive: each chunk is its own frame, and the consumers
   upstream rebuild F0..F7 across frames the way they already do for the pedal's
   own fragmentation. */
const rebuilt=[];let buf=[];
const p2=new Parser(p=>{for(const b of p.data.slice(2)){if(b===0xf0)buf=[];buf.push(b);if(b===0xf7){rebuilt.push(buf);buf=[];}}});
p2.feed(Array.from(inbound(reply.slice(0,3),1)));
p2.feed(Array.from(inbound(reply.slice(3),2)));
assert.deepEqual(rebuilt,[reply],'a SysEx split across two frames reassembles');

console.log('Translation: 0x43 unwrap, synthetic DevACK, housekeeping absorbed, 0x42 wrap, fragmentation passed');

/* ------------------------------------------------- 2. runtime surface ----- */

const nodes=new Map(),logs=[],written=[],bridgeCalls=[];
/* Mirrors the fake node in iap.test.cjs. `before` matters: ui.js finds the
   session button by label, so the shim has to place one the same way iap.js
   does. */
const node=()=>({disabled:false,textContent:'',hidden:false,children:[],
 append(...k){this.children.push(...k);},before(...k){this.children.push(...k);},
 classList:{toggle(){},add(){}}});
const getNode=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
const ctx={
 Uint8Array,Promise,console,setTimeout,Date,Blob:class{},URL:{createObjectURL:()=>''},
 performance:{now:()=>Date.now()},
 EventTarget,CustomEvent,
 navigator:{userAgent:'test'},
 window:{addEventListener(){}},
 document:{createElement:()=>node(),getElementById:getNode},
 stompNativeBridge:{
  connect(){bridgeCalls.push('connect');},
  disconnect(){bridgeCalls.push('disconnect');},
  write(payload){written.push(Array.from(payload));}
 }
};
ctx.globalThis=ctx;
vm.createContext(ctx);
/* Browser load order: the shim first, so iap.js finds iapHost taken. */
vm.runInContext(fs.readFileSync(__dirname+'/../web/transport-ea.js','utf8'),ctx);
const hostBefore=ctx.iapHost;
vm.runInContext(fs.readFileSync(APP+'/iap.js','utf8'),ctx);
assert.equal(ctx.iapHost,hostBefore,'iap.js must not install its RFCOMM host machine over ours');
assert.ok(ctx.IAPCodec,'iap.js still contributes the codec');

/* Chain the log exactly the way backup.js:127 and install.js:59 do. If the
   shim logged to a private function instead of global.log, this chain would
   see nothing -- which is the whole receive path for every module upstream. */
const seen=[];const originalLog=ctx.log;ctx.log=(k,v)=>{originalLog(k,v);seen.push({k,v});};
assert.equal(ctx.opened,false,'ui.js:334 reads `opened` off the global');
/* ui.js:65 finds this by its exact label and throws if it is missing, taking
   the session and disconnected listeners down with it. */
const buttons=getNode('identity').children.concat(getNode('staging').children);
const opener=buttons.find(b=>b.textContent==='Open StompShare data session');
assert.ok(opener,'the session button ui.js looks for exists');
assert.equal(opener.disabled,true,'and is disabled: iOS opened the session already');
assert.equal(ctx.stompConnection.connected,false);

const fired=[];
for(const type of ['connected','session','disconnected'])
 ctx.stompEvents.addEventListener(type,()=>fired.push(type));

ctx.stompNativeState('open');
assert.equal(ctx.opened,true,'ui.js shows Connected off this flag');
assert.equal(ctx.stompConnection.connected,true);
assert.equal(ctx.iapHost.session,ctx.EATransport.SESSION_ID);
assert.deepEqual(fired,['connected','session'],'ui.js waits on both');
assert.equal(getNode('close').disabled,false);

/* The synthetic receipt is scheduled on a timer, so draining has to be a timer
   too: a setImmediate resolves in the check phase, before the timers phase the
   receipt is waiting in. */
const drain=()=>new Promise(r=>setTimeout(r,0));
(async()=>{
 await ctx.stompWrite(ctx.IAPCodec.frame(0x43,7,[0,ctx.EATransport.SESSION_ID,...sysex]),'test');
 assert.deepEqual(written,[sysex],'only the payload crosses the bridge');
 await drain();
 const receipt=seen.filter(e=>e.k==='rx');
 assert.equal(receipt.length,1,'one synthetic receipt per write');
 assert.equal(receipt[0].v,hex(ctx.IAPCodec.frame(0x41,7,[0,0x43])));

 await ctx.stompWrite(ctx.IAPCodec.frame(0x02,8,[0,0x42]),'housekeeping');
 assert.equal(written.length,1,'an iAP ack is absorbed, not sent');

 ctx.stompNativeReceive(hex(reply));
 const inboundFrames=seen.filter(e=>e.k==='rx').slice(1);
 assert.equal(inboundFrames.length,1);
 let parsed=null;new Parser(x=>{parsed=x;}).feed(inboundFrames[0].v.split(' ').map(x=>parseInt(x,16)));
 assert.equal(parsed.cmd,0x42);
 assert.deepEqual(parsed.data.slice(2),reply);

 /* stompTransfer is the serial queue install.js and inventory.js route through. */
 const order=[];
 const a=ctx.stompTransfer(async()=>{await drain();order.push('a');});
 const b=ctx.stompTransfer(async()=>{order.push('b');});
 await Promise.all([a,b]);
 assert.deepEqual(order,['a','b'],'transfers do not interleave');

 ctx.stompNativeState('closed');
 assert.equal(ctx.stompConnection.connected,false);
 assert.equal(ctx.iapHost.session,null);
 assert.ok(seen.some(e=>e.k==='closed'),'modules reset their parsers on closed');
 assert.deepEqual(fired,['connected','session','disconnected']);

 console.log('Runtime: load-order guard, connect, write, absorb, receive, serial queue and teardown passed');
})().catch(e=>{console.error(e);process.exit(1);});

/* ------------------------------------- 3. the real capture, round-tripped -- */

/* The strongest check available without hardware: take every frame the native
   app actually exchanged with the pedal and push it through the translation in
   the direction it travelled. The capture sits below iAP -- Frida hooked above
   that layer -- so each frame is exactly what an EASession carries. */
const CAPTURE=path.resolve(__dirname,'../../tools/protocol-20260908T150705Z.decoded.json');
const capture=JSON.parse(fs.readFileSync(CAPTURE,'utf8'));
const bytesOf=h=>h.trim().split(/\s+/).map(x=>parseInt(x,16));
let tx=0,rx=0;
for(const f of capture.frames){
 const payload=bytesOf(f.hex);
 if(f.direction==='tx'){
  const out=outbound(frame(0x43,(tx+1)&0xffff,[SESSION_ID>>8,SESSION_ID&255,...payload]));
  assert.equal(out.kind,'data');
  assert.deepEqual(Array.from(out.payload),payload,`tx frame ${f.index} survives the unwrap`);
  tx++;
 }else{
  let back=null;new Parser(x=>{back=x;}).feed(Array.from(inbound(payload,(rx+1)&0xffff)));
  assert.equal(back.cmd,0x42);
  assert.equal(back.data[0]*256+back.data[1],SESSION_ID);
  assert.deepEqual(back.data.slice(2),payload,`rx frame ${f.index} survives the wrap`);
  rx++;
 }
}
assert.ok(tx>100&&rx>100,'the capture should carry both directions in bulk');

/* The mock indexes that same capture into request -> answers. */
const {indexCapture}=require('./native-bridge-mock.js');
const replies=indexCapture(capture);
const acquire='f0 52 00 5e 60 06 f7';
assert.ok(replies.has(acquire),'the mock can answer an acquire');
assert.deepEqual(replies.get(acquire)[0],'f0 52 00 5e 60 05 00 f7');

console.log(`Capture: ${tx} host frames and ${rx} pedal frames round-tripped, ${replies.size} exchanges indexed`);

/* --------------------------------------- 4. the WKWebView bridge itself ---- */

/* Section 2 substituted the whole bridge. This exercises the one the app
   actually uses: messages posted to the webkit handler, and a write that stays
   unfinished until the host says the bytes are gone. */
const posted=[];
const wk={
 Uint8Array,Promise,console,setTimeout,Date,Blob:class{},URL:{createObjectURL:()=>''},
 performance:{now:()=>Date.now()},EventTarget,CustomEvent,
 navigator:{userAgent:'test'},window:{addEventListener(){}},
 document:{createElement:()=>node(),getElementById:getNode},
 webkit:{messageHandlers:{stomp:{postMessage:b=>posted.push(b)}}},
 btoa:t=>Buffer.from(t,'binary').toString('base64')
};
wk.globalThis=wk;vm.createContext(wk);
vm.runInContext(fs.readFileSync(__dirname+'/../web/transport-ea.js','utf8'),wk);
vm.runInContext(fs.readFileSync(APP+'/iap.js','utf8'),wk);

(async()=>{
 wk.stompNativeState('open');
 assert.deepEqual(posted,[],'opening the session is the host telling us, not a post');

 let settled=false;
 const write=wk.stompWrite(wk.IAPCodec.frame(0x43,3,[0,1,...sysex]),'test').then(()=>{settled=true;});
 await new Promise(r=>setTimeout(r,0));
 assert.equal(posted.length,1);
 assert.equal(posted[0].action,'write');
 assert.equal(posted[0].hex,hex(sysex),'only the payload is posted');
 assert.ok(posted[0].seq>0,'every write carries a sequence number');
 assert.equal(settled,false,'the write is not finished until the host says so');

 wk.stompNativeWritten(posted[0].seq);
 await write;
 assert.equal(settled,true,'the host acknowledgement finishes it');

 /* A write still in flight when the link drops must reject, not hang. */
 const orphan=wk.stompWrite(wk.IAPCodec.frame(0x43,4,[0,1,...sysex]),'test');
 await new Promise(r=>setTimeout(r,0));
 wk.stompNativeState('closed');
 await assert.rejects(orphan,/Disconnected/,'a write in flight at teardown rejects');

 /* Saving goes to the host as base64, because the payload is often a zip. */
 assert.equal(typeof wk.stompHostSave,'function','the host takes files when it can');
 await wk.stompHostSave('b.zip',{arrayBuffer:async()=>Uint8Array.from([80,75,3,4]).buffer});
 const save=posted.find(p=>p.action==='save');
 assert.equal(save.filename,'b.zip');
 assert.equal(Buffer.from(save.base64,'base64').toString('hex'),'504b0304','the bytes survive');

 console.log('Bridge: posted writes, host acknowledgement, teardown rejection and base64 saving passed');
})().catch(e=>{console.error(e);process.exit(1);});
