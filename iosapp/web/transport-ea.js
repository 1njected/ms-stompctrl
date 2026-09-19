/* MS StompCtrl transport for the iOS app.

   Speaks two dialects: iAP1 upward to the rest of the app, bare SysEx downward
   to an ExternalAccessory stream pair. iOS owns the iAP layer -- identification,
   authentication, the data session, fragmentation -- so an EASession carries
   application payload and nothing else. Everything above this file already
   speaks iAP fluently and has a test suite to prove it, so this impersonates
   the old transport rather than asking those modules to change: not one line
   above here differs between the browser build and the iOS build.

   Replaces transport.js, iap.js's host half, iap-auth.js and iap-signature.js.

   LOAD ORDER: this file must load BEFORE iap.js. iap.js publishes IAPCodec,
   then returns early if globalThis.iapHost already exists (its own re-entry
   guard). Loading this first claims iapHost, so iap.js contributes its codec
   and leaves its RFCOMM state machine uninstalled. Nothing here touches
   IAPCodec at load time -- only from inside functions, by which point iap.js
   has run. */
(function(global){

/* The session id is invented. Its only job is to be the same number in the
   frames this file synthesises and in iapHost.session, because install.js and
   backup.js filter incoming data on `p.data[0]*256+p.data[1]!==iapHost.session`.
   iOS never shows us the real one. */
const SESSION_ID=1;

function parseFrame(bytes){
 let out=null;
 new IAPCodec.Parser(p=>{out=p;},()=>{}).feed(Array.from(bytes));
 return out;
}

/* host -> pedal. The app hands us a complete iAP frame; only 0x43
   iPodDataTransfer carries application bytes. Everything else is transport
   housekeeping -- 0x02 acks, 0x3F/0x40 session open and close, the 0x14-0x19
   authentication exchange -- which iOS has already performed, so it is absorbed
   here rather than sent. */
function outbound(bytes){
 const p=parseFrame(bytes);
 if(!p)return{kind:'unparsed'};
 if(p.lingo!==0||p.cmd!==0x43)return{kind:'absorbed',frame:p};
 return{
  kind:'data',
  session:p.data[0]*256+p.data[1],
  transaction:p.transaction,
  payload:Uint8Array.from(p.data.slice(2)),
  /* docs/protocol.md 3.5: every 0x43 must be answered by a DevACK carrying
     command id 0x43 and the same transaction id. install.js:53 waits on exactly
     that to confirm each chunk of a .ZDL landed, and iOS consumes the real ones
     internally. Synthesising it is the one place this shim is weaker than the
     browser transport: a resolved stream write means iOS took the bytes, not
     that the pedal acknowledged them. The comment at install.js:40 concluded
     the protection is the transaction id rather than the ack, which is what
     makes this tolerable -- but installs are where to look first if the iOS
     build ever misbehaves. */
  ack:IAPCodec.frame(0x41,p.transaction,[0,0x43])
 };
}

/* pedal -> host. Wrap each chunk as its own 0x42 DevDataTransfer. No attempt is
   made to reassemble SysEx first: the pedal fragments too, and every consumer
   upstream already rebuilds F0..F7 across frames. */
function inbound(payload,transaction,session=SESSION_ID){
 return IAPCodec.frame(0x42,transaction,[session>>8,session&255,...payload]);
}

global.EATransport={SESSION_ID,outbound,inbound,parseFrame};
if(typeof document==='undefined')return;      // Node: translation only
if(global.stompWrite)return;                  // a real transport already loaded

/* ---------------------------------------------------------------- runtime */

/* transport.js is a bare top-level script, so its `log`, `el` and `opened`
   are page-level bindings the rest of the app reads and writes directly. This
   file is an IIFE, so the same names have to be published on the global object
   by hand -- and that is not cosmetic:

     - seven modules chain the byte stream by reassigning `log` (backup.js:127
       does `log=function(k,v){...}`, install.js:59 does `g.log=...`). If this
       file called a private `log`, those chains would never see a byte and the
       whole receive path would be silently dead.
     - ui.js:334 reads `typeof opened!=='undefined'&&opened` for the badge.
     - backup.js and bundle.js call el().

   So every internal log goes through say(), which reads global.log at call
   time and therefore runs whatever chain is installed by then. */
global.opened=false;
const el=global.el=id=>document.getElementById(id);
const hex=global.hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join(' ');
const say=(kind,value)=>global.log(kind,value);
const events=[];
const stompEvents=global.stompEvents||new EventTarget();
global.stompEvents=stompEvents;
global.stompConnection={connected:false};
global.stompAutoInventory=global.stompAutoInventory===true;
global.__lastRxAt=0;
const emit=(type,detail={})=>{
 stompEvents.dispatchEvent(new CustomEvent(type,{detail}));
 if(type==='connected')global.onStompConnectionState?.('connected');
 if(type==='disconnected')global.onStompConnectionState?.('disconnected');
};
global.onStompConnectionState=global.onStompConnectionState||(()=>{});

const VERBOSE=/^(rx|tx|install_tx|inventory_tx|iap_rx|iap_tx|pedal_rx|list_read)$/;
const TROUBLE=/(error|warn|abort|timeout|retransmit|busy)/;
global.log=function log(kind,value){
 if(kind==='rx')global.__lastRxAt=Date.now();
 events.push({time:new Date().toISOString(),kind,value});
 const line=`[stomp] ${kind}`;
 if(TROUBLE.test(kind))console.warn(line,value);
 else if(VERBOSE.test(kind))console.debug(line,value);
 else console.log(line,value);
};
global.stompProtocolLog=events;
global.clearProtocolLog=()=>{events.length=0;console.log('[stomp] protocol log cleared');};
global.saveProtocolLog=()=>{
 void global.stompSave('ms-stompctrl-log.json',JSON.stringify({writeStats:global.__stompWriteStats,events},null,2),'application/json');
 return `${events.length} entries`;
};

/* Kept verbatim from transport.js: the distinction it draws -- delivered but
   unanswered, twice running, means the pedal's application layer has stopped --
   is a property of the pedal, not of the link, so it survives the transport
   change. install.js calls into it. */
global.stompSilence={
 count:0,
 delivered(){return ++this.count;},
 answered(){this.count=0;},
 message(){return this.count>=2
  ? 'The pedal is acknowledging commands but answering none of them, so its application layer has stopped. Switch the pedal off and on again; nothing the app sends can recover this.'
  : 'The pedal took delivery of the command but did not answer it.';}
};

/* The host's serial queue, normally iap.js:26. inventory.js and install.js
   route whole multi-exchange operations through it. */
let transferTail=Promise.resolve();
global.stompTransfer=fn=>{
 const wait=transferTail;let release;
 transferTail=new Promise(r=>{release=r;});
 return wait.then(fn).finally(release);
};

/* iapHost, reduced to what survives when iOS runs the protocol. Claiming it
   here is also what stops iap.js installing its own. */
const iapHost=global.iapHost={
 enabled:true,protocols:['jp.co.zoom.p1'],identified:false,
 session:null,pendingSession:null,nextTransaction:1,
 closeSession:async()=>{iapHost.session=null;}   // iOS closes the real one
};
/* ui.js:334 reads these to choose between "Connected" and "Not verified". The
   accessory really was authenticated -- iOS refuses the session otherwise -- we
   simply did not do it ourselves and have no certificate to show. */
global.iapSignature={verified:true,checked:true,error:null};

/* ------------------------------------------------------------ native side */

/* Two functions is the whole boundary: write(payload) out, and a call to
   global.stompNativeReceive(bytes) in. Swift satisfies it with the EASession
   streams; native-bridge-mock.js satisfies it on the desktop, which is how this
   file is developed and tested without a device. */
/* A write is only finished when the bytes have reached the output stream, so
   the host answers each one by sequence number. Without that the shim measures
   nothing (every write looks instant, so the backpressure figures install.js
   reports would be fiction) and the synthetic DevACK fires before the payload
   has gone anywhere. */
const pendingWrites=new Map();let writeSeq=0;
global.stompNativeWritten=(seq,error)=>{
 const settle=pendingWrites.get(seq);
 if(!settle)return;
 pendingWrites.delete(seq);
 error?settle.reject(Error(String(error))):settle.resolve();
};
function wkBridge(){
 const post=body=>global.webkit.messageHandlers.stomp?.postMessage(body);
 return {
  connect:()=>post({action:'connect'}),
  disconnect:()=>post({action:'disconnect'}),
  write:payload=>new Promise((resolve,reject)=>{
   const seq=++writeSeq;
   pendingWrites.set(seq,{resolve,reject});
   post({action:'write',seq,hex:hex(payload)});
  }),
  save:(filename,base64)=>post({action:'save',filename,base64})
 };
}
const bridge=global.stompNativeBridge||(global.webkit?.messageHandlers?.stomp?wkBridge():null);

/* save.js hands files to the host when one offers to take them, because the
   download attribute it falls back to does nothing in a WKWebView. Base64
   because the payload is often a zip. */
if(bridge&&bridge.save)global.stompHostSave=async(filename,blob)=>{
 const bytes=new Uint8Array(await blob.arrayBuffer());
 let text='';
 for(let i=0;i<bytes.length;i+=0x8000)text+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
 await bridge.save(filename,btoa(text));
};

let inboundTransaction=0x200;
/* Swift calls this with a hex string; the mock passes bytes. */
global.stompNativeReceive=data=>{
 const payload=typeof data==='string'?data.trim().split(/\s+/).map(x=>parseInt(x,16)):Array.from(data);
 if(!payload.length)return;
 const frame=inbound(payload,inboundTransaction++);
 say('rx',hex(frame));
};
/* Swift reports stream state through these rather than having the page poll. */
global.stompNativeState=state=>{
 if(state==='open'){
  global.opened=true;iapHost.identified=true;iapHost.session=SESSION_ID;
  global.stompConnection.connected=true;
  status('data session open');
  el('close').disabled=false;el('choose').disabled=true;el('identity').disabled=false;
  emit('connected',{name:'MS-100BT'});
  emit('session',{id:SESSION_ID});
 }else if(state==='closed'){
  teardown();
 }
};
global.stompNativeError=message=>{say('connect_error',String(message));emit('error',{message:String(message)});};

/* ----------------------------------------------------------------- writes */

const WRITE_STALL_MS=50;
global.__stompWriteStats={writes:0,stalls:0,worstReadyMs:0,worstWriteMs:0,stalledBytes:0,windowWorstReadyMs:0,windowWorstWriteMs:0};
let writeChain=Promise.resolve();
function stompWrite(bytes,label='write'){
 const run=async()=>{
  const decoded=outbound(bytes instanceof Uint8Array?bytes:Uint8Array.from(bytes));
  if(decoded.kind!=='data'){
   say('iap_absorbed',{cmd:decoded.frame?.cmd?.toString(16),label});
   return;
  }
  if(!bridge)throw Error('No native bridge. This build must run inside the iOS app.');
  const stats=global.__stompWriteStats,t0=performance.now();
  await bridge.write(decoded.payload);
  const writeMs=performance.now()-t0;
  stats.writes++;
  stats.worstWriteMs=Math.max(stats.worstWriteMs,writeMs);
  stats.windowWorstWriteMs=Math.max(stats.windowWorstWriteMs,writeMs);
  if(writeMs>=WRITE_STALL_MS){
   stats.stalls++;stats.stalledBytes+=decoded.payload.length;
   say('write_backpressure',{label,writeMs:Math.round(writeMs),bytes:decoded.payload.length});
  }
  /* The synthetic receipt, once the bytes are gone. Emitted on a later turn so
     a caller that registers its wait immediately after awaiting the write still
     sees it -- install.js:47 registers before writing, but nothing should
     depend on that ordering. */
  setTimeout(()=>say('rx',hex(decoded.ack)),0);
 };
 const done=writeChain.then(run,run);
 writeChain=done.catch(()=>{});
 return done;
}
global.stompWrite=stompWrite;
global.stompWriteWindow=()=>{
 const s=global.__stompWriteStats,base={writes:s.writes,stalls:s.stalls,stalledBytes:s.stalledBytes};
 s.windowWorstReadyMs=0;s.windowWorstWriteMs=0;
 return()=>({writes:s.writes-base.writes,stalls:s.stalls-base.stalls,
             stalledBytes:s.stalledBytes-base.stalledBytes,
             worstReadyMs:+s.windowWorstReadyMs.toFixed(1),
             worstWriteMs:+s.windowWorstWriteMs.toFixed(1),
             sessionWorstReadyMs:+s.worstReadyMs.toFixed(1)});
};

/* -------------------------------------------------------------------- UI */

const statusLine=document.createElement('p');
statusLine.id='iap-status';
statusLine.textContent='iAP: waiting for the accessory';
el('staging')?.append(statusLine);

/* ui.js:65 finds this button by its exact label and then writes to it:

     sessionButton=[...document.querySelectorAll('button')]
       .find(b=>b.textContent==='Open StompShare data session')
     $('session-action').append(sessionButton); sessionButton.textContent='Open session';

   iap.js's host half creates it, and this file stops that half installing, so
   without it `sessionButton` is undefined and ui.js throws mid-initialisation.
   Registration of the `session` and `disconnected` listeners happens after that
   line, so the page came up looking connected and then ignored every later
   state change -- silently, because the exception is thrown during load.

   It stays disabled: iOS opens the data session before the page hears about the
   accessory at all, so there is nothing to open. ui.js checks `disabled` before
   auto-clicking it, which is exactly the behaviour we want. */
const openButton=document.createElement('button');
openButton.textContent='Open StompShare data session';
openButton.disabled=true;
el('identity')?.before(openButton);
iapHost.openSession=()=>{};
function status(text){statusLine.textContent='iAP: '+text;say('iap_state',text);}

function teardown(){
 global.opened=false;
 for(const [seq,settle] of pendingWrites){settle.reject(Error('Disconnected'));pendingWrites.delete(seq);}
 iapHost.session=null;iapHost.identified=false;
 global.stompConnection.connected=false;
 el('close').disabled=true;el('choose').disabled=false;el('identity').disabled=true;
 status('disconnected');
 say('closed',true);            /* every module resets its parser on this */
 emit('disconnected');
}

el('identity').disabled=true;
el('close').disabled=true;
el('choose').onclick=async()=>{
 try{
  if(!bridge)throw Error('No native bridge. This build must run inside the iOS app.');
  status('opening the accessory session');
  await bridge.connect();      /* stompNativeState('open') answers */
 }catch(e){say('connect_error',String(e));emit('error',{message:String(e)});}
};
el('close').onclick=async()=>{try{await bridge?.disconnect();}catch(e){say('close_error',String(e));}teardown();};
el('identity').onclick=async()=>{
 const b=Uint8Array.from([240,126,0,6,1,247]);
 try{
  await stompWrite(IAPCodec.frame(0x43,iapHost.nextTransaction++,[SESSION_ID>>8,SESSION_ID&255,...b]),'identity');
  say('tx',hex(b));
 }catch(e){say('write_error',String(e));}
};
global.closeStompPort=async()=>{await bridge?.disconnect();teardown();};
window.addEventListener('pagehide',()=>{if(global.opened)void bridge?.disconnect();});

say('capabilities',{transport:'ExternalAccessory',bridge:!!bridge,userAgent:navigator.userAgent});
})(globalThis);
