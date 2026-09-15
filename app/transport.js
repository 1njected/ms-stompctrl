
// A full directory scan is the longest multi-exchange sequence in this client,
// and the pedal wedges whenever an exchange stalls -- so scanning automatically
// on connect can leave the filesystem busy before anything is asked of it.
// Default OFF while the read path is being troubleshooted; the Reload button in
// "Installed on pedal" still scans on demand, and setting this to true restores
// the old behaviour.
globalThis.stompAutoInventory = globalThis.stompAutoInventory === true;
let port,reader,reading,opened=false;const events=[];const el=id=>document.getElementById(id);const stompEvents=globalThis.stompEvents||new EventTarget();globalThis.stompEvents=stompEvents;globalThis.stompConnection={connected:false};const emit=(type,detail={})=>{stompEvents.dispatchEvent(new CustomEvent(type,{detail}));if(type==='connected')globalThis.onStompConnectionState?.('connected');if(type==='disconnected')globalThis.onStompConnectionState?.('disconnected');};
globalThis.__lastRxAt=0;
// The protocol log goes to the browser console, and is kept in memory so it can
// still be exported. Frame-level traffic is console.debug, which Chrome hides
// unless Verbose is on -- an install is a few thousand lines and would otherwise
// bury everything else. Failures are console.warn so they surface by default.
const VERBOSE=/^(rx|tx|install_tx|inventory_tx|iap_rx|iap_tx|pedal_rx|list_read)$/;
const TROUBLE=/(error|warn|abort|timeout|retransmit|busy)/;
function log(kind,value){
 if(kind==='rx')globalThis.__lastRxAt=Date.now();
 const entry={time:new Date().toISOString(),kind,value};
 events.push(entry);
 const line=`[stomp] ${kind}`;
 if(TROUBLE.test(kind))console.warn(line,value);
 else if(VERBOSE.test(kind))console.debug(line,value);
 else console.log(line,value);
}
globalThis.stompProtocolLog=events;
// Telling "the pedal never got it" apart from "the pedal got it and went quiet".
// Measured live 2026-09-13: the iAP layer kept acknowledging every 0x43 within
// ~40 ms while the application layer answered nothing at all -- not filesystem,
// not audio, not patch, not identity. Only a power cycle recovers that, so
// retrying is pointless, and calling it a write timeout sends you looking at the
// link. Two in a row is the signature, since one can just be a slow command.
globalThis.stompSilence={
 count:0,
 delivered(){return ++this.count;},
 answered(){this.count=0;},
 message(){return this.count>=2
  ? 'The pedal is acknowledging commands but answering none of them, so its application layer has stopped. Switch the pedal off and on again; nothing the app sends can recover this.'
  : 'The pedal took delivery of the command but did not answer it.';}
};
globalThis.clearProtocolLog=()=>{events.length=0;console.log('[stomp] protocol log cleared');};
// Kept because a saved log is what made several of this project's bugs findable.
globalThis.saveProtocolLog=()=>{
 const a=document.createElement('a');
 a.href=URL.createObjectURL(new Blob([JSON.stringify({writeStats:globalThis.__stompWriteStats,events},null,2)],{type:'application/json'}));
 a.download='ms-stompctrl-log.json';a.click();URL.revokeObjectURL(a.href);
 return `${events.length} entries`;
};
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join(' ');
globalThis.onStompConnectionState=globalThis.onStompConnectionState||(()=>{});
log('capabilities',{secure:isSecureContext,serial:!!navigator.serial,bluetooth:!!navigator.bluetooth,userAgent:navigator.userAgent});
// Chrome on macOS leaves the RFCOMM port in a state where the open that follows
// a successful close always fails.  It always takes ~10 s -- Chromium's SDP wait
// in bluetooth_socket_mac.mm -- while the system log shows
//   Connected to RFCOMM: 0x0 with uuid: (null), channel: (null), error: 0
//   -[IOBluetoothRFCOMMChannel setupRFCOMMChannelForDevice] No channel
// that is, macOS reports success and hands Chrome a null channel.  The very next
// open succeeds in ~700 ms, with no delay needed.  Measured over ten open/close
// cycles: FAIL OK FAIL OK FAIL OK FAIL OK FAIL OK -- failures 10,002-10,004 ms,
// successes 646-706 ms, without exception.  Retrying costs one 10 s wait and
// removes the need to restart Chrome in order to reconnect.
/* How long the RFCOMM channel needs after a close before it will reopen.
   Three seconds was enough in every measurement; four leaves margin.

   The timestamp is kept in sessionStorage, not just in this module, because the
   case that hurts most is a reload: the page comes back knowing nothing, opens
   immediately, and spends ten seconds failing at a channel that was in use a
   moment earlier. Unloading while the port is open records the moment too --
   port.close() is async and will not finish during unload, but a synchronous
   storage write will. */
const SETTLE_MS=4000, ACTIVITY_KEY='stomp.portActiveAt';
let lastActiveAt=0;
function markPortActivity(){
 lastActiveAt=Date.now();
 try{sessionStorage.setItem(ACTIVITY_KEY,String(lastActiveAt));}catch{}
}
function portActiveAt(){
 let stored=0;
 try{stored=Number(sessionStorage.getItem(ACTIVITY_KEY))||0;}catch{}
 return Math.max(lastActiveAt,stored);
}
async function openWithRetry(attempts=3){
 /* Bind the port once. `port` is module-level mutable state and closePort()
    nulls it -- from the Disconnect button and from the serial `disconnect`
    listener -- so every await here is a window in which it can vanish. Reading
    it afresh on each attempt produced "Cannot read properties of null (reading
    'open')" once the backoff below made that window seconds wide instead of
    microseconds. Work from the local, and abandon the attempt if the module
    has moved on rather than reopening a port nobody wants any more. */
 const target=port;
 if(!target)throw Error('No pedal port selected.');
 const abandoned=()=>port!==target;

 /* Wait out the channel's cooldown before the first attempt rather than
    discovering it as a ten-second timeout. Measured: an open immediately after
    a close fails in 10,004 ms, three seconds later it succeeds in 59 ms. So the
    cheapest thing we can do is not try too early -- a short sleep costs seconds
    where a failed attempt costs ten, and this is the common path, because the
    usual reason to reconnect is having just disconnected. */
 const active=portActiveAt();
 const since=Date.now()-active;
 if(active&&since<SETTLE_MS){
  const wait=SETTLE_MS-since;
  log('open_settle',{wait});
  await new Promise(r=>setTimeout(r,wait));
  if(abandoned())throw Error('Connection cancelled.');
 }

 // Chrome 130+ exposes SerialPort.connected: true when the wireless device
 // hosting the port has an active connection to the system.  Checking it first
 // turns "device is not linked" into an immediate, accurate message instead of
 // a 10 s SDP timeout followed by a generic NetworkError.
 // https://developer.chrome.com/blog/bluetooth-rfcomm-updates-web-serial
 if(target.connected===false){
  log('open_device_not_connected',{hint:'The pedal is paired but not linked to this Mac. Switch it on, or re-pair it in Bluetooth settings.'});
  throw Error('The pedal is not connected to this Mac. Switch it on, or remove and re-pair it in Bluetooth settings.');
 }
 const primary={baudRate:115200,bufferSize:255,flowControl:'none'};
 let last=null;
 /* The channel needs a gap after it was last closed. Measured 2026-09-12,
    reopening the same port: immediately after a close it failed in 10,004 ms
    (an SDP timeout); three seconds later it opened in 59 ms; eight seconds
    after that, in 701 ms. So a failure is a "too soon", not a broken link, and
    retrying with no pause just buys another ten-second timeout -- which is what
    the old loop did, and why a report of three consecutive failures was
    possible. Wait between attempts instead. */
 for(let attempt=1;attempt<=attempts;attempt++){
  if(attempt>1){const wait=2000*(attempt-1);log('open_backoff',{attempt,wait});
   await new Promise(r=>setTimeout(r,wait));}
  if(abandoned()){log('open_abandoned',{attempt});throw Error('Connection cancelled.');}
  try{await target.open(primary);if(attempt>1)log('open_recovered',{attempt});return;}
  catch(e){last=e;log('open_retry',{attempt,error:String(e)});}
 }
 // Older Chrome builds reject flowControl; try once without it before giving up.
 if(abandoned()){log('open_abandoned',{final:true});throw Error('Connection cancelled.');}
 try{await target.open({baudRate:115200,bufferSize:255});log('open_recovered',{withoutFlowControl:true});return;}
 catch(e){log('flow_control_fallback',String(e));}

 /* Still failing after the backoff. The link itself is fine -- `connected` is
    true, and on the same pedal the plain SPP port opens, reads and closes in the
    same second while this one refuses. Say what actually works rather than
    repeating the browser's generic message: waiting longer. Power-cycling is
    the last resort, not the first, because every failure measured here cleared
    on its own within seconds. */
 if(last?.name==='NetworkError'&&target.connected!==false){
  log('open_channel_busy',{service:target.getInfo?.().bluetoothServiceClassId});
  throw Error('The pedal is connected but its data channel was not ready. It '+
              'needs a few seconds between sessions — wait about ten and press '+
              'Connect again. If it keeps failing, switch the pedal off and on.');
 }
 throw last;
}
// Every port write goes through here, so backpressure is visible in one place.
// A Web Serial writer exposes `ready`, which stays pending while the underlying
// sink -- for an RFCOMM port, the link's flow control -- will not take more
// data.  Nothing awaited it before, so a pedal that had stopped granting credit
// was indistinguishable from one that simply was not answering.
//
// Observed 2026-09-11: the pedal retransmitted an 8-frame window of an effect
// list read 11 times over ten seconds at a metronomic 500 ms, we acknowledged
// all 88 copies with well-formed 0x02, and nine of our own command frames
// (60 21, 60 25, 60 01 01, three attempts each) went unacknowledged in the same
// window -- then it gave up, discarded the transfer, and worked normally.  The
// question that separates "the Mac could not send" from "the pedal would not
// receive" is how long `ready` takes, and nobody was measuring it.
//
// Writes are serialised on one promise chain.  Every caller used to spin on
// port.writable.locked and then call getWriter(), which throws if it lost the
// race; there were eight such copies.
const WRITE_STALL_MS=50;
globalThis.__stompWriteStats={writes:0,stalls:0,worstReadyMs:0,worstWriteMs:0,stalledBytes:0,windowWorstReadyMs:0,windowWorstWriteMs:0};
let writeChain=Promise.resolve();
function stompWrite(bytes,label='write'){
 const run=async()=>{
  const stats=globalThis.__stompWriteStats,buf=bytes instanceof Uint8Array?bytes:Uint8Array.from(bytes);
  const w=port.writable.getWriter();
  try{
   const t0=performance.now();
   await w.ready;
   const readyMs=performance.now()-t0,t1=performance.now();
   await w.write(buf);
   const writeMs=performance.now()-t1;
   stats.writes++;
   stats.worstReadyMs=Math.max(stats.worstReadyMs,readyMs);
   stats.worstWriteMs=Math.max(stats.worstWriteMs,writeMs);
   stats.windowWorstReadyMs=Math.max(stats.windowWorstReadyMs,readyMs);
   stats.windowWorstWriteMs=Math.max(stats.windowWorstWriteMs,writeMs);
   if(readyMs>=WRITE_STALL_MS||writeMs>=WRITE_STALL_MS){
    stats.stalls++;stats.stalledBytes+=buf.length;
    log('write_backpressure',{label,readyMs:Math.round(readyMs),writeMs:Math.round(writeMs),bytes:buf.length});
   }
  }finally{w.releaseLock();}
 };
 const done=writeChain.then(run,run);
 writeChain=done.catch(()=>{});   // a failed write must not wedge the chain
 return done;
}
globalThis.stompWrite=stompWrite;
// Backpressure only matters over the operation that failed, and a worst case
// does not survive being averaged across a session.  Open a window before an
// install, close it after, and the numbers land in the protocol log by
// themselves -- nobody should have to know to type __stompWriteStats.
globalThis.stompWriteWindow=()=>{
 const s=globalThis.__stompWriteStats,base={writes:s.writes,stalls:s.stalls,stalledBytes:s.stalledBytes};
 s.windowWorstReadyMs=0;s.windowWorstWriteMs=0;
 return()=>({writes:s.writes-base.writes,stalls:s.stalls-base.stalls,
             stalledBytes:s.stalledBytes-base.stalledBytes,
             worstReadyMs:+s.windowWorstReadyMs.toFixed(1),
             worstWriteMs:+s.windowWorstWriteMs.toFixed(1),
             sessionWorstReadyMs:+s.worstReadyMs.toFixed(1)});
};
// The pedal's Apple accessory service, from its SDP record. Overridable for
// probing another service -- the standard SPP record on channel 2, say.
const SERVICE_UUID='00000000-deca-fade-deca-deafdecacaff';
el('choose').onclick=async()=>{try{const uuid=(globalThis.stompServiceUuid??SERVICE_UUID).trim();const chosen=await navigator.serial.requestPort(uuid?{allowedBluetoothServiceClassIds:[uuid],filters:[{bluetoothServiceClassId:uuid}]}:{});port=chosen;log('selected',chosen.getInfo());const picked=(chosen.getInfo().bluetoothServiceClassId||'').toLowerCase();if(uuid&&picked&&picked!==uuid.toLowerCase()){log('selected_wrong_service',{picked,expected:uuid});port=null;throw Error('That is the pedal\'s plain serial port, which never answers. '+'Disconnect, press Connect again and choose the other entry for the pedal.');}await openWithRetry();if(port!==chosen){log('connect_abandoned',true);try{await chosen.close();}catch{}return;}opened=true;globalThis.stompConnection.connected=true;emit('connected',chosen.getInfo());log('opened',chosen.getInfo());el('identity').disabled=true;el('close').disabled=false;el('choose').disabled=true;reader=chosen.readable.getReader();let heard=false;setTimeout(()=>{if(opened&&!heard)log('silent_after_open',{hint:'Port open but the pedal has sent nothing. iAP identification is started by the pedal, so nothing we send will prompt it. Switch the pedal off and on, or reconnect and pick the other port entry.'});},6000);reading=(async()=>{try{while(true){const {value,done}=await reader.read();if(done)break;heard=true;log('rx',hex(value));}}catch(e){log('read_error',String(e));}finally{reader.releaseLock();}})();}catch(e){log('connect_error',String(e));emit('error',{message:String(e)});}};
el('identity').onclick=async()=>{try{const b=Uint8Array.from([240,126,0,6,1,247]);await stompWrite(b,'identity');log('tx',hex(b));}catch(e){log('write_error',String(e));}};
let closing=false;
/* Closing the port is not enough: the pedal keeps its iAP data session, and a
   held session is what makes the next open() fail. iapHost.closeSession() sends
   the 0x40 that ends it. On a real disconnect this is awaited; while the page is
   going away nothing async is guaranteed to finish, so it is fired best-effort
   and the user-facing advice above covers the case where it does not land. */
async function endSession({unloading=false}={}){
 const host=globalThis.iapHost;
 if(!host||host.session==null||typeof host.closeSession!=='function')return;
 try{
  const done=host.closeSession();
  if(unloading)return;                       // fire and let go; the page is dying
  await Promise.race([done,new Promise(r=>setTimeout(r,600))]);
  log('session_closed_on_disconnect',true);
 }catch(e){log('session_close_failed',String(e));}
}
async function closePort({unloading=false}={}){if(closing)return;closing=true;const p=port,r=reader,loop=reading;try{await endSession({unloading});if(r){try{await r.cancel();}catch(e){if(!unloading)throw e;}}if(loop){try{await loop;}catch(e){if(!unloading)throw e;}}if(p&&opened){try{await p.close();}catch(e){if(!unloading)throw e;}}opened=false;globalThis.stompConnection.connected=false;if(!unloading){emit('disconnected');el('identity').disabled=true;el('close').disabled=true;el('choose').disabled=false;log('closed',true);}}catch(e){if(!unloading){log('close_error',String(e));emit('error',{message:String(e)});}}finally{reader=null;reading=null;port=null;closing=false;markPortActivity();}}
globalThis.closeStompPort=closePort;
el('close').onclick=()=>closePort();
window.addEventListener('pagehide',()=>{if(opened){markPortActivity();try{reader?.cancel();}catch{}void closePort({unloading:true});}});
window.addEventListener('beforeunload',()=>{if(opened){markPortActivity();try{reader?.cancel();}catch{}void closePort({unloading:true});}});
if(navigator.serial)navigator.serial.addEventListener('disconnect',e=>{if(e.target===port)void closePort();});

