const assert=require('node:assert/strict');require('./iap.js');const {frame,Parser}=global.IAPCodec;
const received=[];let errors=0;const p=new Parser(x=>received.push(x),()=>errors++);
const start=Uint8Array.from([0x55,4,0,0x38,0,1,0xc3]);for(const b of start)p.feed([b]);assert.deepEqual(received[0],{lingo:0,cmd:0x38,transaction:1,data:[]});
assert.equal(Buffer.from(frame(2,1,[0,0x38])).toString('hex'),'5506000200010038bf');
const large=frame(0x39,7,Array(300).fill(9));p.feed(large.slice(0,73));p.feed(large.slice(73));assert.equal(received[1].data.length,300);
const bad=Array.from(start);bad[6]=0;p.feed([...bad,...start,...start]);assert.equal(errors,1);assert.equal(received.length,4);console.log('Framing, fragmentation, extended length, checksum rejection and resynchronization passed');
// Exercise host negotiation with fragmented recorded framing and a protocol token.
const vm=require('node:vm'),fs=require('node:fs');
const nodes=new Map(),sent=[],logs=[];const node=()=>({disabled:false,textContent:'',children:[],before(){},append(...k){this.children.push(...k);}});
const el=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
let buttons=[];const ctx={Uint8Array,TextDecoder,Promise,console,document:{createElement(tag){const n=node();if(tag==='button')buttons.push(n);return n;}},el,log:(k,v)=>logs.push({k,v}),hex:b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join(' '),stompWrite:async b=>{sent.push(Array.from(b));}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(__dirname+'/iap.js','utf8'),ctx);
const drain=()=>new Promise(r=>setImmediate(r));
function incoming(b){ctx.log('rx',ctx.hex(b));}
(async()=>{
 incoming(start);await drain();assert.equal(Buffer.from(sent[0]).toString('hex'),'5506000200010038bf');
 const token=[0,4,7,...Buffer.from('jp.co.zoom.p1\0')];
 incoming(frame(0x39,2,[1,token.length,...token]));await drain();assert.equal(ctx.iapHost.protocols[0].name,'jp.co.zoom.p1');
 incoming(frame(0x3b,3,[0]));await drain();assert.equal(ctx.iapHost.identified,true);assert.equal(el('identity').disabled,true);
 buttons[0].onclick();await drain();assert.equal(ctx.iapHost.pendingSession.id,1);
 incoming(frame(0x41,1,[0,0x3f]));await drain();assert.equal(ctx.iapHost.session,1);assert.equal(el('identity').disabled,false);
 el('identity').onclick();await drain();const data=[];new Parser(p=>data.push(p)).feed(sent.at(-1));assert.equal(data[0].cmd,0x43);assert.deepEqual(data[0].data,[0,1,240,126,0,6,1,247]);
 assert.equal(logs.filter(e=>e.k==='iap_error').length,0);// The debug panel is gone: modules park their controls in #staging and ui.js
// moves them. The session button goes in via identity.before(), which this fake
// does not model, so only the status line is countable here. What matters is
// that nothing reaches for the old #log anchor any more.
 assert.equal(el('staging').children.length, 1, 'the iAP status line parks in #staging');
 assert(!nodes.has('log'), 'iap.js must not depend on the removed #log element');
 console.log('Identification, advertised protocol, session acknowledgement and wrapped identity fixtures passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
