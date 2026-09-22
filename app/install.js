/* Verified MS-100BT ZDL writer, based on the native AG_AMP capture. */
(function(g){
 const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join(' ');
 // Five 7-bit groups, little-endian.  The shift MUST be unsigned: crc() returns
 // a full 32-bit value, and with >> any CRC with bit 31 set makes n>>28 negative,
 // so the top group goes out as 120-127 instead of 0-15.  That is 15 of the 36
 // write chunks in the native capture -- 42% of every file written.  The pedal
 // answers a rejected chunk with a status word install.js used to discard, so it
 // corrupted files silently.  install-codec.test.cjs checks this against the
 // captured chunks; it regressed once already when main was restored to b0fc67b.
 const enc=n=>[0,7,14,21,28].map(s=>(n>>>s)&127);
 const pack=data=>{const out=[];for(let i=0;i<data.length;i+=7){const part=data.slice(i,i+7);out.push(part.reduce((m,v,j)=>m|((v>>7&1)<<(6-j)),0),...part.map(v=>v&127));}return out;};
 const unpack=data=>{const out=[];for(let i=0;i<data.length;){const mask=data[i++];for(let j=0;j<7&&i<data.length;j++,i++)out.push((data[i]&127)|(((mask>>(6-j))&1)<<7));}return out;};
 const crc=data=>{let c=0xffffffff;for(const v of data){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return c>>>0;};
 let pending=null,buf=[];
 // The accessory acknowledges each encapsulated 0x43 with 0x41 (data 00 43).
 // Fragments of one SysEx packet must not be sent faster than that: observed
 // live, a second fragment written 2 ms after the first -- before the pedal
 // had acknowledged it 200 ms later -- was dropped, leaving the pedal holding
 // half a packet and waiting forever.
 const fragmentAcks=new Map();
 // One logical packet keeps ONE transaction id across every retransmission of
 // it, and the delivery holds that id registered until the command finishes, so
 // an 0x41 settles it whenever it arrives -- including after the attempt window
 // that sent it has closed.  (delivery() still accepts a set of ids, which is
 // what the first version of this needed; nothing registers more than one now.)
 //
 // Two bugs were fixed here in turn.  Each attempt used to wait on its own id
 // alone and delete it on timeout, so a late ack satisfied nothing: three
 // attempts waited 2500 ms each and every one discarded its own ack.  Seen
 // 2026-09-11 -- an install aborted with "did not take delivery of
 // f0 7e 00 06 01 f7" while the pedal acked the next command 37 ms later.
 //
 // Allocating a fresh id per attempt was the deeper error.  iAP1 R38 states, for
 // both directions, that a sender whose packet goes unacknowledged resends the
 // same packet with the same transaction id: that id is how the accessory tells
 // a retransmission from new data.  Under a new id each time, a 60 23 fragment
 // the pedal had in fact received was appended to the file a second time.  The
 // old comment calling retransmission safe because "no 0x41 means it never
 // arrived" was reasoning about the wrong thing -- the protection is the id, not
 // the ack.  See docs/iap-audit.md.
 function delivery(){
  const ids=new Set();
  let settle;
  const acked=new Promise(r=>{settle=r;});
  return {
   sent(tr){ids.add(tr);fragmentAcks.set(tr,()=>settle(tr));},
   /* The acking transaction id, or false if nothing has acked within ms. */
   wait(ms){return Promise.race([acked,new Promise(r=>setTimeout(()=>r(false),ms))]);},
   release(){for(const tr of ids)fragmentAcks.delete(tr);}
  };
 }
 const ackParser=new IAPCodec.Parser(p=>{
  if(p.lingo!==0||p.cmd!==0x41||p.data[1]!==0x43)return;
  const done=fragmentAcks.get(p.transaction);
  if(done)done();
 });
 const parser=new IAPCodec.Parser(p=>{if(p.lingo!==0||p.data[0]*256+p.data[1]!==iapHost.session)return;for(const b of p.data.slice(2)){if(b===240)buf=[];buf.push(b);if(b!==247)continue;const f=buf;buf=[];if(pending&&pending.match(f)){const q=pending;pending=null;clearTimeout(q.timer);q.resolve(f);}}});
 const old=g.log;g.log=(k,v)=>{old(k,v);if(k==='rx'){const bytes=v.split(' ').map(x=>parseInt(x,16));ackParser.feed(bytes.slice());parser.feed(bytes);}};
 // The response clock deliberately does not start here. Delivery below is
 // separately bounded and can take 7.5 s (or 12 s fragmented), and running one
 // clock across both meant a delivery stall spent the response budget -- the
 // same defect fixed in inventory.js. `pending` is registered immediately so an
 // early reply is still matched; only the deadline waits for delivery.
 const wait=match=>new Promise((resolve,reject)=>{pending={resolve,reject,match,timer:null};});
 const armWait=ms=>{const q=pending;if(!q)return;clearTimeout(q.timer);q.timer=setTimeout(()=>{if(pending===q){pending=null;q.reject(Error('Pedal write response timeout'));}},ms);};
 // Delivery confirmed but no answer is a distinct, actionable state; see
 // stompSilence in transport.js.
 const answered=f=>{globalThis.stompSilence?.answered();return f;};
 const silent=e=>{const n=globalThis.stompSilence?.delivered?.()??0;
  throw /response timeout/i.test(String(e))&&n?Error(globalThis.stompSilence.message()):e;};
async function exchange(data,match,timeout=8000){
 // Every encapsulated 0x43 is acknowledged by the accessory with 0x41, so the
 // host can tell whether the pedal actually took delivery of a command.  Without
 // that check a lost command is indistinguishable from a pedal that has stopped
 // answering: measured across eight installs the stalls landed on a different
 // command each time (60 05 00, 60 02, 61 05), all normally answered in ~40 ms.
 //
 // Re-sending is safe because it is conditional on the missing 0x41: no 0x41
 // means the pedal never received the frame, so it cannot be executed twice.
 // The fragment path has done this since the 1024-byte fix; small commands were
 // left without it.
 const result=wait(match,timeout);
 // One packet, one transaction id, one frame -- retransmitted byte for byte.
 const post=delivery(),tr=iapHost.nextTransaction++;
 post.sent(tr);
 const frame=IAPCodec.frame(0x43,tr,[iapHost.session>>8,iapHost.session&255,...data]);
 let acked=false;
 try{
  for(let attempt=1;attempt<=3&&acked===false;attempt++){
   old('install_tx',{transaction:tr,sysex:hex(data),attempt,timeout});
   await stompWrite(frame,'command');
   acked=await post.wait(2500);
   if(acked===false){old('fragment_ack_timeout',{transaction:tr});old('command_retransmit',{sysex:hex(data),attempt});}
   else if(attempt>1)old('late_ack_recovered',{transaction:tr,attempt,sysex:hex(data)});
  }
 }finally{post.release();}
 if(acked===false)throw Error(`Pedal did not take delivery of ${hex(data)}`);
 armWait(timeout);   // the pedal has it now; the answer gets a full window from here
 const f=answered(await result.catch(silent));
  // Native pacing, measured over 1,880 exchanges in the iPad capture: the app
  // sends its next command a median of 1 ms after a reply (94% within 40 ms),
  // and its command-to-command interval is a median of 25 ms.  Ours were 102 ms
  // and 151 ms -- six times slower between commands, a hundred times slower
  // after a reply.  A 40 ms "wait for quiet" was tried first, on the theory that
  // we transmitted into an in-flight reply; the capture disproves it, since the
  // native app transmits almost immediately and never stalls.
 await new Promise(r=>setTimeout(r,2));
 if(f[4]===0x60&&f[5]===4&&(f[6]===2||f[6]===0x20||f[6]===0x29)){await new Promise(r=>setTimeout(r,300));await fsAck();}
 return f;
}
async function exchangeFragmented(data,match,timeout=30000){
  const result=wait(match);
  // A 4,704-byte write packet is split across encapsulated 0x43 frames.  3800
  // was too large: fragment 1 goes out as 3,811 wire bytes and fragment 2 as
  // 915, which together exceed the 4,096-byte transport boundary.  Observed
  // live -- the pedal acknowledged fragment 1, then went silent for twelve
  // seconds, ignoring the second fragment and two retransmissions of it, and
  // answered the next small frame in 33 ms.  It will not take more data while
  // holding a partial packet, so retrying cannot help; the fragments have to be
  // small enough to sit inside the boundary together.
  const maxPayload=1024;
  for(let off=0;off<data.length;off+=maxPayload){
   const part=data.slice(off,Math.min(off+maxPayload,data.length));
   // Every fragment must be acknowledged with 0x41 before the next is sent, and
   // an unacknowledged one is retransmitted.  A missing 0x41 means the pedal did
   // not take delivery, so resending cannot duplicate data in the file.  Seen
   // live: the final short fragment of a file silently dropped, leaving the
   // pedal holding an incomplete packet until the host gave up.
   // One fragment, one transaction id: resending under a fresh id is what
   // duplicated file data, because the pedal read it as more of the stream.
   const post=delivery(),tr=iapHost.nextTransaction++;
   post.sent(tr);
   const frame=IAPCodec.frame(0x43,tr,[iapHost.session>>8,iapHost.session&255,...part]);
   let acked=false;
   try{
    for(let attempt=1;attempt<=3&&acked===false;attempt++){
     old('install_tx',{transaction:tr,fragment:true,offset:off,bytes:part.length,attempt,timeout});
     await stompWrite(frame,'fragment');
     acked=await post.wait(4000);
     if(acked===false)old('fragment_retransmit',{offset:off,bytes:part.length,attempt});
     else if(attempt>1)old('late_ack_recovered',{transaction:tr,attempt,offset:off});
    }
   }finally{post.release();}
   if(acked===false)throw Error(`Pedal did not take delivery of a ${part.length}-byte fragment at offset ${off}`);
  }
  armWait(timeout);   // every fragment is delivered; now wait for the answer
  const f=answered(await result.catch(silent));await new Promise(r=>setTimeout(r,2));return f;
}
const is=(cmd,sub)=>f=>f[4]===0x60&&f[5]===cmd&&(!sub||f[6]===sub);
 // A 60 23 chunk is answered in one of two ways, and this pedal uses both
 // within a single install: either 60 04 23, after which the host sends
 // 60 05 00 and gets the 60 03 result, or that 60 03 result directly.
 // Accepting only 60 04 23 discards a perfectly good success reply -- the
 // installer then waits out its timeout while the pedal retransmits the
 // ignored frame every ~500 ms. Observed live: chunk 4 answered 60 03 result 0
 // and the write stalled for 30 s regardless.
 const writeAnswer=f=>f[4]===0x60&&((f[5]===4&&f[6]===0x23)||f[5]===3);const fsAck=()=>exchange([240,82,0,94,0x60,5,0,247],is(3));
 async function statusExchange(data,match,label){const f=await exchange(data,match);const status=f[6];if(status!==0)throw Error(`${label||'Pedal filesystem operation'} failed (status ${status})`);return f;}
 async function acquire(){let last=1;for(let attempt=1;attempt<=8;attempt++){const f=await exchange([240,82,0,94,0x60,6,247],is(5));last=f[6];if(last===0)return f;old('install_busy',{attempt,status:last});await new Promise(r=>setTimeout(r,350*attempt));}throw Error(`Pedal filesystem busy (status ${last})`);}
 // ---- the pedal's effect list, read-only for now ---------------------------
 // A written .ZDL is not shown by the pedal until FLST_SEQ.ZDT names it; until
 // then it sits on "Now loading".  Reading it first, and writing nothing, keeps
 // this reversible: the read path can be proven on hardware before anything
 // touches the file that tells the pedal which effects it has.
 // Effect binaries live in the browser's own library, not on the server: a
 // published copy of this page ships no ZOOM assets.  A served path is still
 // honoured when one exists, so a local checkout with bundle-assets/ keeps
 // working unchanged.
 const bytesOf=async effect=>{
  if(effect.data)return effect.data instanceof Uint8Array?effect.data:new Uint8Array(effect.data);
  if(g.effectStore?.binary)return await g.effectStore.binary(effect);
  if(effect.path)return new Uint8Array(await (await fetch(effect.path)).arrayBuffer());
  throw Error(`No binary available for ${effect.filename||'that effect'}`);
 };
 const LIST='FLST_SEQ.ZDT';
 const nameField=n=>Array.from(new TextEncoder().encode(n.padEnd(12,'\0')));
 // Every 60 24 in both captures is exactly 20 bytes: the filename sits in a
 // fixed 13-byte field, NUL-padded -- _AG_AMP.ZDL (11 chars) takes two pad
 // bytes, FLST_SEQ.ZDT (12) takes one.  Building the frame from the unpadded
 // name instead happened to be right for 11-character names, the only length in
 // the captured install, and wrong for every other: 12-character names such as
 // _ACOSTIC.ZDL overran the field by a byte and 8-character ones fell three
 // short, so the delete silently did nothing and the write that followed
 // appended to a file that was still there.
 const deleteFrame=name=>[240,82,0,94,0x60,0x24,...nameField(name),0,247];
 const identity=()=>exchange([240,126,0,6,1,247],f=>f[0]===240&&f[1]===126&&f[4]===2);
 const dec5=(f,i)=>f[i]|(f[i+1]<<7)|(f[i+2]<<14)|(f[i+3]<<21)|(f[i+4]<<28);
 // 60 03 carries a five-group signed result at offsets 6-10.
 const resultOf=f=>f[6]|(f[7]<<7)|(f[8]<<14)|(f[9]<<21)|(f[10]<<28);

 // The pedal keeps showing "Now loading" after a write until the host
 // enumerates the directory: the user observed that reading the installed-effects
 // list clears the message, and the native capture ends every install the same
 // way -- 60 21, 60 09, the effect-list update, then 60 25 / 60 26 ... 60 27
 // before releasing the semaphore.  Enumerating appears to be what makes the
 // pedal reload its effect table, so it is part of finishing an install, not a
 // separate verification step.
 async function enumerateDirectory(limit=400){
  const entryOrEnd=f=>f[4]===0x60&&((f[5]===4&&f[6]===0x25)||f[5]===3);
  const files=[];
  let f=await exchange([240,82,0,94,0x60,0x25,0,0,0x2a,0x2e,0x2a,...Array(10).fill(0),247],entryOrEnd,15000);
  for(let i=0;i<limit&&f[4]===0x60&&f[5]===4;i++){
   files.push({filename:String.fromCharCode(...f.slice(15,27)).split('\0')[0],
               bytes:f.slice(30,35).reduce((n,v,j)=>n+v*2**(7*j),0)});
   f=await exchange([240,82,0,94,0x60,0x26,247],entryOrEnd,15000);
  }
  try{await exchange([240,82,0,94,0x60,0x27,247],is(3),15000);}catch(e){old('find_close_warn',String(e));}
  old('install_enumerated',{files:files.length});
  return files;
 }

 async function readEffectList(){
  const info=await exchange([240,82,0,94,0x60,0x28,...nameField(LIST),0,247],is(4,0x28));
  const size=dec5(info,11);
  if(size!==FlstCodec.SIZE)throw Error(`Effect list is ${size} bytes, expected ${FlstCodec.SIZE}`);
  await exchange([240,82,0,94,0x60,0x20,2,0,0,0,0,0,0,0,0,0,...nameField(LIST),247],is(4,0x20));
  const out=[];
  try{
   while(out.length<size){
    const want=Math.min(0x1000,size-out.length);
    const ack=await exchange([240,82,0,94,0x60,0x22,0,0,0,0,0,...enc(want),247],is(4,0x22),20000);
    // The payload arrives as its own frame, after our filesystem acknowledgement.
    const data=ack.length>100?ack:await exchange([240,82,0,94,0x60,5,0,247],is(4,0x22),20000);
    // Layout CRC-verified against the native capture: seven header bytes, four
    // unidentified fields, packed payload from offset 11, five-byte CRC, F7.
    const raw=unpack(data.slice(11,-6));
    const stored=(data[data.length-6]|(data[data.length-5]<<7)|(data[data.length-4]<<14)|(data[data.length-3]<<21)|(data[data.length-2]<<28))>>>0;
    if((crc(raw)>>>0)!==stored)throw Error('Effect list read failed its CRC check');
    if(raw.length!==want)throw Error(`Effect list chunk was ${raw.length} bytes, expected ${want}`);
    out.push(...raw);
    old('list_read',{got:out.length,of:size});
   }
  }finally{
   try{await exchange([240,82,0,94,0x60,0x21,0,0,0,0,0,247],is(3));}catch(e){old('list_close_warn',String(e));}
  }
  return Uint8Array.from(out);
 }

 // Read the effect list, insert the new entry and write it back.  Assumes the
 // caller already holds the semaphore and is in file mode -- it is a step inside
 // an install, not a standalone operation, exactly as in the native sequence.
 async function updateEffectList(name,zdl){
  const {effectId,category}=FlstCodec.categoryOf(zdl);
  await identity();
  await exchange([240,82,0,94,0x60,2,247],is(4,2));
  const before=await readEffectList();
  g.__lastEffectList=before;
  const res=FlstCodec.insert(before,name,category);
  old('list_insert',{filename:name,effectId:effectId.toString(16),category,
                     changed:res.changed,entries:FlstCodec.entries(res.bytes).length});
  if(!res.changed)return {listed:true,changed:false,category,reason:res.reason};
  await writeEffectList(res.bytes);
  return {listed:true,changed:true,category,entries:FlstCodec.entries(res.bytes).length};
 }

 // Rewrite the effect list with one entry inserted.  Captured native order:
 //   identity, 60 24 delete, identity, 60 02, 60 05 00, 60 20 flag1,
 //   60 05 00, 60 23 x2, 60 21 close, 60 09 flush
 async function writeEffectList(bytes){
  if(bytes.length!==FlstCodec.SIZE)throw Error(`Refusing to write a ${bytes.length}-byte effect list`);
  await identity();
  await exchange(deleteFrame(LIST),is(3));
  await identity();
  await exchange([240,82,0,94,0x60,2,247],is(4,2));
  await exchange([240,82,0,94,0x60,0x20,1,0,0,0,0,0,0,0,0,0,...nameField(LIST),247],is(4,0x20));
  for(let off=0;off<bytes.length;off+=0x1000){
   const chunk=Array.from(bytes.slice(off,off+0x1000));
   const data=[240,82,0,94,0x60,0x23,0,0,0,0,0,...enc(chunk.length),...pack(chunk),...enc(crc(chunk)),247];
   const resp=await exchangeFragmented(data,writeAnswer,30000);
   if(resp[5]!==3)await exchange([240,82,0,94,0x60,5,0,247],is(3),15000);
  }
  const closed=await exchange([240,82,0,94,0x60,0x21,0,0,0,0,0,247],is(3));
  if(resultOf(closed)!==0)throw Error(`Effect list close rejected (result ${resultOf(closed)})`);
  await exchange([240,82,0,94,0x60,9,247],is(5));
 }

 // Register an already-written effect in the pedal's list, as its own operation.
 async function registerEffect(effect){
  if(iapHost.session===null)throw Error('Open a StompShare data session first');
  const raw=await bytesOf(effect);
  const name=effect.filename.toUpperCase();
  const {effectId,category}=FlstCodec.categoryOf(raw);
  await acquire();
  try{
   await exchange([240,82,0,94,0x61,5,247],f=>f[4]===0&&f[5]===0);
   await statusExchange([240,82,0,94,0x60,0,1,247],is(5),'File mode setup');
   await identity();
   await exchange([240,82,0,94,0x60,2,247],is(4,2));
   const before=await readEffectList();
   g.__lastEffectList=before;                       // restore point for this session
   const res=FlstCodec.insert(before,name,category);
   old('list_insert',{filename:name,effectId:effectId.toString(16),category,
                      changed:res.changed,entries:FlstCodec.entries(res.bytes).length});
   if(!res.changed)return {listed:true,changed:false,category,reason:res.reason};
   await writeEffectList(res.bytes);
   // Read it back and confirm the pedal now names the effect.
   const after=await readEffectList();
   const listed=FlstCodec.entries(after).some(f=>f.toUpperCase()===name);
   if(!listed)throw Error('Effect list was written but does not list the effect');
   return {listed:true,changed:true,category,entries:FlstCodec.entries(after).length,verified:true};
  }finally{
   try{await exchange([240,82,0,94,0x60,1,0,247],is(5));}catch{}
   try{await exchange([240,82,0,94,0x61,6,247],f=>f[4]===0&&f[5]===0);}catch{}
   try{await exchange([240,82,0,94,0x60,7,247],is(5));}catch{}
  }
 }

 // ---- deleting an effect --------------------------------------------------
 // The inverse of an install, in the same shape the native app uses for one:
 // a single semaphore, mute, file mode, the effect list, the file, then a
 // directory enumeration so the pedal reloads its table instead of sitting on
 // "Now loading".
 //
 // The list is rewritten BEFORE the file is deleted, deliberately.  If the file
 // delete then fails, the pedal holds a file it no longer lists -- invisible,
 // harmless, and reinstallable.  The other order would leave the list naming a
 // file that is gone, which is the state to avoid.
 const PROTECTED=['FLST_SEQ.ZDT','PAIR.DAT'];
 async function removeEffect(filename){
  if(iapHost.session===null)throw Error('Open a StompShare data session first');
  const name=String(filename||'').toUpperCase();
  // FLST_SEQ.ZDT is the pedal's only copy of its effect list and PAIR.DAT is its
  // pairing state; neither is recoverable from the catalog.  The extension test
  // already excludes them, but name them explicitly so the refusal is readable.
  if(PROTECTED.includes(name))throw Error(`${name} is a pedal system file and is never deletable`);
  if(!/^[A-Z0-9_]{1,8}\.ZDL$/.test(name))throw Error(`Refusing to delete "${name}": only .ZDL effect files can be deleted`);
  await acquire();
  let unlisted=false,removed=false,files=[],verifyError=null;
  try{
   await exchange([240,82,0,94,0x61,5,247],f=>f[4]===0&&f[5]===0);
   await statusExchange([240,82,0,94,0x60,0,1,247],is(5),'File mode setup');
   await identity();
   await exchange([240,82,0,94,0x60,2,247],is(4,2));
   const before=await readEffectList();
   g.__lastEffectList=before;                       // restore point for this session
   const res=FlstCodec.remove(before,name);
   old('list_remove',{filename:name,changed:res.changed,reason:res.reason,
                      entries:FlstCodec.entries(res.bytes).length});
   if(res.changed)await writeEffectList(res.bytes);
   unlisted=res.changed;
   // Only now is the file unreferenced by anything the pedal reads.
   await identity();
   const f=await exchange(deleteFrame(name),is(3));
   old('file_deleted',{filename:name,result:resultOf(f)});
   // The enumeration both clears the display and verifies the delete, so the
   // result is checked against the pedal rather than against its status byte.
   try{files=await enumerateDirectory();removed=!files.some(x=>x.filename.toUpperCase()===name);}
   catch(e){old('teardown_warn',{step:'directory enumeration',error:String(e)});verifyError=String(e);}
  }finally{
   try{await exchange([240,82,0,94,0x60,1,1,247],is(5));}catch(e){old('teardown_warn',{step:'file mode end',error:String(e)});}
   try{await exchange([240,82,0,94,0x61,6,247],f=>f[4]===0&&f[5]===0);}catch(e){old('teardown_warn',{step:'audio open',error:String(e)});}
   await exchange([240,82,0,94,0x60,7,247],is(5));
  }
  // Raised after the semaphore is released, so a failure never leaves it held.
  if(verifyError)throw Error(`${name} was deleted, but the directory could not be re-read to confirm it (${verifyError}). Reload from pedal to check.`);
  if(!removed)throw Error(`The pedal still holds ${name} after the delete.`);
  return {deleted:true,filename:name,unlisted,files};
 }

 // ---- free space -----------------------------------------------------------
 // 60 29 00 is answered by a fixed 27-byte frame carrying total at offset 11 and
 // free at 16, five 7-bit groups each.  Confirmed against the figures StompShare
 // itself displays -- see docs/protocol.md.
 //
 // Deliberately does NOT mute: the native read-only query uses 60 06, 60 29,
 // then 60 01 / 61 06 / 60 07, and never sends 61 05.  Cutting the user's guitar
 // signal to read a number would be a poor trade.
 async function diskSpace(){
  if(iapHost.session===null)throw Error('Open a StompShare data session first');
  await acquire();
  try{
   const f=await exchange([240,82,0,94,0x60,0x29,0,247],is(4,0x29));
   const total=dec5(f,11)>>>0,free=dec5(f,16)>>>0;
   // A misread frame would show as nonsense rather than a plausible number.
   if(!total||free>total)throw Error(`Unexpected disk reply: ${hex(f)}`);
   old('disk_space',{total,free,used:total-free});
   return {total,free,used:total-free};
  }finally{
   try{await exchange([240,82,0,94,0x60,1,0,247],is(5));}catch{}
   try{await exchange([240,82,0,94,0x61,6,247],f=>f[4]===0&&f[5]===0);}catch{}
   try{await exchange([240,82,0,94,0x60,7,247],is(5));}catch{}
  }
 }

 // Read the list and report what an install would change. Writes nothing.
 async function previewList(effect){
  if(iapHost.session===null)throw Error('Open a StompShare data session first');
  const raw=effect?await bytesOf(effect):null;
  await acquire();
  try{
   await exchange([240,82,0,94,0x61,5,247],f=>f[4]===0&&f[5]===0);
   await statusExchange([240,82,0,94,0x60,0,1,247],is(5),'File mode setup');
   await identity();
   await exchange([240,82,0,94,0x60,2,247],is(4,2));
   const bytes=await readEffectList();
   g.__lastEffectList=bytes;
   const cats=FlstCodec.categories(bytes).filter(c=>c.files.length);
   const report={bytes:bytes.length,entries:FlstCodec.entries(bytes).length,
     categories:cats.map(c=>({id:c.id,count:c.files.length,first:c.files[0]}))};
   if(raw){
    const {effectId,category}=FlstCodec.categoryOf(raw);
    const res=FlstCodec.insert(bytes,effect.filename.toUpperCase(),category);
    report.wouldInsert={filename:effect.filename.toUpperCase(),effectId:effectId.toString(16),
      category,changed:res.changed,entriesAfter:FlstCodec.entries(res.bytes).length};
   }
   return report;
  }finally{
   try{await exchange([240,82,0,94,0x60,1,0,247],is(5));}catch{}
   try{await exchange([240,82,0,94,0x61,6,247],f=>f[4]===0&&f[5]===0);}catch{}
   try{await exchange([240,82,0,94,0x60,7,247],is(5));}catch{}
  }
 }

 async function writeFile(effect){if(iapHost.session===null)throw Error('Open a StompShare data session first');const raw=await bytesOf(effect);if(raw.length<76||new TextDecoder().decode(raw.slice(4,8))!=='SIZE')throw Error('Invalid ZDL effect');const name=effect.filename.toUpperCase();if(name.length>12)throw Error('Effect filename exceeds 12 characters');const filename=nameField(name);
  const writeWindow=globalThis.stompWriteWindow?.();
  await acquire();await exchange([240,82,0,94,0x61,5,247],f=>f[4]===0&&f[5]===0);await statusExchange([240,82,0,94,0x60,0,1,247],is(5),'File mode setup');await exchange([240,82,0,94,0x60,0x29,0,247],is(4,0x29));await exchange([240,126,0,6,1,247],f=>f[0]===240&&f[1]===126&&f[4]===2);await exchange(deleteFrame(name),is(3));await exchange([240,126,0,6,1,247],f=>f[0]===240&&f[1]===126&&f[4]===2);await exchange([240,82,0,94,0x60,2,247],is(4,2));await exchange([240,82,0,94,0x60,0x20,1,0,0,0,0,0,0,0,0,0,filename[0],...filename.slice(1),247],is(4,0x20));
  // A write response can be delayed by the pedal's flash task.  The trace
  // shows a valid 60 04 23 response arriving just after the old 120 s limit;
  // keep the file session open long enough to receive it and continue.
  for(let off=0;off<raw.length;off+=0x1000){const chunk=Array.from(raw.slice(off,off+0x1000)),data=[240,82,0,94,0x60,0x23,0,0,0,0,0,...enc(chunk.length),...pack(chunk),...enc(crc(chunk)),247];const resp=await exchangeFragmented(data,writeAnswer,30000);if(resp[5]!==3)await exchange([240,82,0,94,0x60,5,0,247],is(3),15000);}
  await exchange([240,82,0,94,0x60,0x21,0,0,0,0,0,247],is(3));
  // Match the native iPad install teardown: close the file, flush the
  // filesystem task, then release the semaphore. The inventory teardown
  // (60 01 01 / 61 06) is a different path and leaves installs in “Now
  // loading” on some pedal revisions.
  await exchange([240,82,0,94,0x60,9,247],is(5));
  // Every install enters file mode (60 00 01) and mutes audio (61 05); both must
  // be exited or the state accumulates across installs.  Measured without these:
  // the first two installs in a session succeed and later ones fail, at 2/4
  // whether run back to back or 12 s apart.  The verified capture ends the
  // sequence 60 01 00, 61 06, 60 07, in that order.
  // Everything below stays inside the single semaphore this install already
  // holds.  The native app performs the whole operation -- binary, effect list,
  // directory enumeration -- under one 60 06 / 60 07 pair, and never stalls:
  // 12 back-to-back installs, 1,883 exchanges, worst reply 0.73 s, no retries.
  // Our earlier structure took the semaphore three times (install, then a
  // separate list update, then a separate scan), which is the clearest
  // behavioural difference from an app that does not provoke the lockup.
  // The effect list must name the effect or the pedal will never offer it, so a
  // failure here is an incomplete install and is reported as one.  Swallowing it
  // reported success for an effect the pedal would not show.  Retrying is safe:
  // the write deletes the target and rewrites it from the first chunk.
  let listedError=null;
  try{
   const listed=await updateEffectList(name,raw);
   old('install_listed',listed);
  }catch(e){old('install_list_warn',String(e));listedError=e;}

  // The pedal keeps showing "Now loading" until the directory is enumerated,
  // and the native app does this while still IN file mode, before 60 01.
  try{await enumerateDirectory();}catch(e){old('teardown_warn',{step:'directory enumeration',error:String(e)});}

  // Native install teardown ends 60 01 01, 61 06, 60 07.  Note the parameter:
  // the read-only capture ends 60 01 00, but every install in the native
  // capture uses 60 01 01.
  try{await exchange([240,82,0,94,0x60,1,1,247],is(5));}catch(e){old('teardown_warn',{step:'file mode end',error:String(e)});}
  try{await exchange([240,82,0,94,0x61,6,247],f=>f[4]===0&&f[5]===0);}catch(e){old('teardown_warn',{step:'audio open',error:String(e)});}
  /* The release used to be the one teardown step that could fail the install,
     because it alone was unwrapped. That turned a completed install into a
     reported failure, and the reported failure ran abortInstall against a pedal
     that had nothing to abort -- which, with the old abort, left it in file mode
     showing "Now loading". Observed 2026-09-13 on RED_CRU.ZDL: the binary was on
     the filesystem and listed in FLST_SEQ.ZDT, and the install was still
     reported as "Pedal write response timeout".

     The file is written and listed by this point, so the install has succeeded
     whatever the semaphore does. Say so, and carry the warning in the result:
     a semaphore that really is stuck will surface on the next operation, and
     abortInstall retries the release anyway. */
  let released=true;
  try{await exchange([240,82,0,94,0x60,7,247],is(5));}
  catch(e){released=false;old('teardown_warn',{step:'semaphore release',error:String(e)});}
  // Every install reports its own backpressure, pass or fail, so the numbers for
  // the run that failed are in the log without anyone having to ask for them.
  // readyMs in the seconds means the pedal stopped granting RFCOMM credit and
  // our bytes never left the Mac; readyMs near zero means they did leave and the
  // pedal dropped them.  See docs/plan.md section 5.3.
  try{old('write_stats',writeWindow?.());}catch{}
  // Raised after the semaphore is released, so a failure never leaves it held.
  if(listedError)throw Error(`Effect written, but the pedal's effect list could not be updated (${listedError.message}). The pedal will not show it until this succeeds.`);
  return {filename:effect.filename,released};
 }
 /* Abandoning an install has to leave the pedal usable, and the old version did
    not. It closed the file, flushed and released the semaphore -- and skipped
    the two steps that clear the display. The pedal shows "Now loading" until
    its directory is enumerated, and it was left in file mode as well, so every
    failed install stranded it there until something else happened to enumerate.

    A half-written file is the other half of the problem: it sits on the
    filesystem, absent from FLST_SEQ.ZDT, and flst.js records that the pedal
    will not show such a file -- it stays on "Now loading" permanently. So the
    partial file is deleted before enumerating, which is also what makes a
    retry clean, since a write begins by deleting its target anyway.

    Every step is best-effort: this runs because something already went wrong,
    and one more failure must not stop the rest of the teardown. */
 async function abortInstall(name=null){
  const step=async(data,match,label)=>{
   try{await exchange(data,match,8000);}catch(e){old('abort_warn',{step:label,error:String(e)});}
  };
  const any=f=>f[4]===0||f[5]===3||f[5]===5;
  await step([240,82,0,94,0x60,0x21,0,0,0,0,0,247],any,'close file');
  await step([240,82,0,94,0x60,9,247],any,'flush');
  if(name)await step(deleteFrame(name),any,`delete partial ${name}`);
  // Enumeration clears "Now loading", and the native app does it in file mode.
  try{await enumerateDirectory();}catch(e){old('abort_warn',{step:'enumerate',error:String(e)});}
  await step([240,82,0,94,0x60,1,1,247],is(5),'leave file mode');
  await step([240,82,0,94,0x61,6,247],f=>f[4]===0&&f[5]===0,'unmute');
  await step([240,82,0,94,0x60,7,247],is(5),'release');
 }
 // Distinguish a locked-up pedal from a working one in about a second.
 // When the pedal locks up its iAP layer keeps acknowledging every 0x43 with
 // 0x41 while the application answers nothing at all -- including the identity
 // request, which is handled outside the filesystem task.  So "delivered but
 // never answered" is a reliable lockup signature, and only a power cycle
 // clears it.  Without this check a locked pedal costs a 32 s timeout per
 // operation and can leave a half-written file.
 async function alive(timeout=2500){
  if(iapHost.session===null)return {alive:false,reason:'no data session'};
  let receipt=false,reply=false;
  const rp=new IAPCodec.Parser(p=>{
   if(p.lingo!==0)return;
   if(p.cmd===0x41&&p.data[1]===0x43)receipt=true;
   if(p.cmd===0x42)reply=true;
  });
  const prev=g.log;
  g.log=(k,v)=>{prev(k,v);if(k==='rx')rp.feed(v.split(' ').map(x=>parseInt(x,16)));};
  try{
   const frame=IAPCodec.frame(0x43,iapHost.nextTransaction++,[iapHost.session>>8,iapHost.session&255,240,126,0,6,1,247]);
   await stompWrite(frame,'alive');
   for(let i=0;i<timeout/50&&!reply;i++)await new Promise(r=>setTimeout(r,50));
  }finally{g.log=prev;}
  if(reply)return {alive:true};
  if(receipt)return {alive:false,locked:true,
    reason:'The pedal is receiving commands but has stopped answering them. Switch it off and on again.'};
  return {alive:false,locked:false,reason:'No response from the pedal; check the connection.'};
 }

 // After an install the pedal keeps showing "Now loading" until the host
 // enumerates its directory -- the user's observation, and the native capture
 // ends every install with 60 25 / 60 26 ... 60 27 before releasing the
 // semaphore.  Run the existing inventory scan for that: it is already
 // delivery-confirmed and tested, and it is exactly what clears the display by
 // hand.  It must run as its own transfer, since stompTransfer is a serial queue
 // and nesting it inside writeFile would deadlock.

 // Exported for install-codec.test.cjs: these four are the whole on-the-wire
 // encode chain and are verifiable against the captured native writes.
 g.pedalCodec={enc,pack,unpack,crc,delivery,fragmentAcks};
 /* Each of these is a multi-step conversation with the pedal, so it holds the
   operation lock for its whole length as well as taking the frame queue. A disk
   query is short enough that refusing a concurrent one would be unhelpful, so it
   is the one that may run inside another operation. */
const exclusive=(label,fn,opts)=>g.pedalLock.run(label,()=>g.stompTransfer(fn),opts);
g.pedalInstaller={
 register:e=>exclusive(`registering ${e?.filename||'an effect'}`,()=>registerEffect(e)),
 disk:(opts={})=>exclusive('reading the pedal\u2019s free space',()=>diskSpace(),opts),
 remove:name=>exclusive(`deleting ${name}`,async()=>{try{return await removeEffect(name);}catch(e){old('delete_abort',String(e));await abortInstall();throw e;}}),
 previewList:e=>exclusive('reading the effect list',()=>previewList(e)),
 alive:()=>exclusive('checking the pedal',()=>alive()),
 install:effect=>exclusive(`installing ${effect?.filename||'an effect'}`,async()=>{try{return await writeFile(effect);}catch(e){old('install_abort',String(e));await abortInstall(effect.filename);throw e;}})
};
})(globalThis);
