/* Read-only patch dumps. Slot request protocol reference: thammer/zoom-explorer. */
(function(g){
 const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join(' ');
 /* Seven-bit packing: each group of 7 body bytes becomes 8 wire bytes, the
    first carrying their high bits, most significant element first. */
 const unpack7=p=>{const r=[];for(let i=0;i<p.length;i+=8)for(let j=0;j<7&&i+j+1<p.length;j++)
  r.push(p[i+j+1]|(((p[i]>>(6-j))&1)<<7));return r;};
 const pack7=r=>{const o=[];for(let i=0;i<r.length;i+=7){const g=r.slice(i,i+7);let m=0;
  g.forEach((v,j)=>{if(v&0x80)m|=1<<(6-j);});o.push(m,...g.map(v=>v&0x7f));}return o;};
 function validate(b,slot){
  if(!Number.isInteger(slot)||slot<0||slot>=50)throw Error('Invalid slot');
  if(b.length<16||b[0]!==240||b[1]!==82||b[2]!==0||b[3]!==94||b[4]!==8||b.at(-1)!==247)throw Error('Invalid patch response');
  if(b.slice(1,-1).some(x=>!Number.isInteger(x)||x<0||x>127))throw Error('Non-MIDI data');
  if(b[5]!==0||b[6]!==0||b[7]!==slot)throw Error('Patch slot mismatch');
  const length=b[8]+128*b[9],packed=b.slice(10,-6),raw=[];
  if(length!==122||packed.length!==length+Math.ceil(length/7))throw Error('Unexpected patch length');
  for(let i=0;i<packed.length;i+=8)for(let j=0;j<7&&i+j+1<packed.length;j++)raw.push(packed[i+j+1]|(((packed[i]>>(6-j))&1)<<7));
  let crc=0xffffffff;for(const v of raw){crc^=v;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc>>>=0;
  const stored=b.slice(-6,-1).reduce((n,v,i)=>n+v*2**(7*i),0);if(crc!==stored)throw Error('Patch CRC mismatch');
  const name=String.fromCharCode(...raw.slice(111,121)).replace(/\0.*$/,'').trim();
  return {slot:slot+1,name,sysexHex:hex(b),bytes:b.length,rawHex:hex(raw),crc32:crc.toString(16).padStart(8,'0'),crcValid:true};
 }
 /* The 0x28 edit-buffer dump, measured against hardware 2026-09-12:
    F0 52 00 5E 28 + 140 packed bytes + F7 = 146 bytes. Unlike the 08 slot dump
    it carries no slot, no length field and no CRC -- the firmware emits a fixed
    122-byte body (140 = 122 + ceil(122/7)). docs/protocol.md 5.4. */
 function validateEditBuffer(b){
  if(b.length!==146||b[0]!==240||b[1]!==82||b[2]!==0||b[3]!==94||b[4]!==0x28||b.at(-1)!==247)
   throw Error(`Invalid edit-buffer response: ${b.length} bytes, ${hex(b.slice(0,6))}…`);
  if(b.slice(1,-1).some(x=>!Number.isInteger(x)||x<0||x>127))throw Error('Non-MIDI data');
  const raw=unpack7(b.slice(5,-1));
  if(raw.length!==122)throw Error(`Expected a 122-byte patch body, got ${raw.length}`);
  const name=String.fromCharCode(...raw.slice(111,121)).replace(/\0.*$/,'').trim();
  return {name,body:raw,sysexHex:hex(b),bytes:b.length,rawHex:hex(raw)};
 }

 /* Build a 0x28 frame from a 122-byte body. Proven a real write against
    hardware on 2026-09-12: the name at body offset 111 was changed to
    RUNG1TEST, read back changed, and restored. docs/protocol.md 5.4. */
 function buildEditBuffer(body){
  if(!Array.isArray(body)&&!ArrayBuffer.isView(body))throw Error('Body must be an array of 122 bytes');
  const raw=Array.from(body);
  if(raw.length!==122)throw Error(`A patch body is 122 bytes, got ${raw.length}`);
  if(raw.some(x=>!Number.isInteger(x)||x<0||x>255))throw Error('Body bytes must be 0-255');
  const frame=[240,82,0,94,0x28,...pack7(raw),247];
  if(frame.length!==146)throw Error(`Built frame is ${frame.length} bytes, expected 146`);
  return frame;
 }
 /* Did a written patch take? Compare what a patch *is*, not every byte.

    The pedal recomputes some parameter fields when it loads a patch, and which
    fields depends on the effects in the chain. Treating any byte difference as
    failure reported real writes as failures -- a patch came back with the right
    name and the right chain and was still called a failure over four bytes the
    pedal had recalculated, and writing the same body again then showed zero
    drift because the first write had settled them.

    So: the name and the chain decide, and the drift is reported as a number. */
 const chainOf=b=>Array.from({length:6},(_,i)=>{
  const w=(b[i*18]|b[i*18+1]<<8|b[i*18+2]<<16|b[i*18+3]<<24)>>>0;
  return {id:((w>>>1)&0xfffffff).toString(16).padStart(8,'0'),on:(w&1)===1};});
 const patchName=b=>String.fromCharCode(...b.slice(111,121)).replace(/\0.*$/,'').trimEnd();
 function comparePatch(sent,got){
  const a=Array.from(sent),b=Array.from(got);
  if(a.length!==122||b.length!==122)throw Error('A patch body is 122 bytes');
  const sentChain=chainOf(a),gotChain=chainOf(b);
  const badSlot=sentChain.findIndex((s,i)=>s.id!==gotChain[i].id||s.on!==gotChain[i].on);
  return {nameOk:patchName(a)===patchName(b),sentName:patchName(a),gotName:patchName(b),
          badSlot,sentChain,gotChain,
          drift:a.reduce((n,v,i)=>n+(v!==b[i]?1:0),0),
          ok:patchName(a)===patchName(b)&&badSlot<0};
 }

 g.PatchBackupCodec={validate,validateEditBuffer,buildEditBuffer,pack7,unpack7,comparePatch};if(typeof document==='undefined'||g.patchBackup)return;
 const state=g.patchBackup={running:false,last:null};let pending=null,buffer=[];
 const panel=document.createElement('section'),title=document.createElement('h2'),button=document.createElement('button'),save=document.createElement('button'),status=document.createElement('p');
 state.panel=panel;panel.id='patch-backup';title.textContent='Back up effect chains';button.textContent='Sync from pedal';save.textContent='Download backup';save.disabled=true;status.textContent='Open a StompShare data session first. Reads saved patches without changing the selected patch.';
 panel.append(title,button,save,status);el('staging').append(panel);
 const original=log;

 /* The last sync is kept in localStorage. Without it a page reload threw the
    patches away, and this project reloads constantly -- which also emptied the
    editor's effect picker, because its list of swappable effects is derived
    from the loaded patches. Restoring means the patch list, the editor and the
    bundle builder all work with no pedal attached.

    Every access is wrapped: storage can be full, disabled by policy, or throw
    outright in a private window, and none of that may stop the app loading.
    A stored backup is data we wrote, but it is still parsed defensively --
    a truncated or hand-edited entry must not take the page down with it. */
 const STORE_KEY='stomp.patchBackup.v1';
 function persist(){
  if(!state.last)return;
  try{localStorage.setItem(STORE_KEY,JSON.stringify(state.last));}
  catch(e){original('backup_persist_failed',String(e));}
 }
 function restore(){
  let raw=null;
  try{raw=localStorage.getItem(STORE_KEY);}catch(e){original('backup_restore_failed',String(e));return null;}
  if(!raw)return null;
  try{
   const data=JSON.parse(raw);
   if(data?.format!=='stompshare-patch-backup'||!Array.isArray(data.patches))throw Error('Not a patch backup');
   if(!data.patches.every(x=>typeof x?.rawHex==='string'&&typeof x?.sysexHex==='string'))throw Error('Malformed patch entry');
   return data;
  }catch(e){
   original('backup_restore_failed',String(e));
   try{localStorage.removeItem(STORE_KEY);}catch{}
   return null;
  }
 }
 state.forget=()=>{state.last=null;try{localStorage.removeItem(STORE_KEY);}catch{}};

 const stored=restore();
 if(stored){
  state.last=stored;
  save.disabled=stored.patches.length===0;
  if(!stored.complete)button.textContent='Resume sync from pedal';
  const when=new Date(stored.createdAt);
  status.textContent=`${stored.patches.length} of 50 patches held locally from ${isNaN(when)?'an earlier sync':when.toLocaleString()}. Sync again to refresh from the pedal.`;
  original('backup_restored',{patches:stored.patches.length,complete:!!stored.complete,createdAt:stored.createdAt});
 }

 const parser=new IAPCodec.Parser(p=>{if(p.lingo!==0||p.cmd!==0x42||p.data[0]*256+p.data[1]!==iapHost.session)return;
 for(const b of p.data.slice(2)){if(b===240)buffer=[];buffer.push(b);if(buffer.length>32768)buffer=[];if(b===247){const frame=buffer;buffer=[];if(pending&&frame[0]===240&&frame[1]===82&&frame[3]===94&&frame[4]===pending.command){if(pending.slot!==null&&frame[7]!==pending.slot)return;const q=pending;pending=null;clearTimeout(q.timer);q.resolve(frame);}}}
 });
 log=function(k,v){original(k,v);if(k==='rx')parser.feed(v.split(' ').map(x=>parseInt(x,16)));if(k==='closed'&&pending){clearTimeout(pending.timer);pending.reject(Error('Disconnected during backup'));pending=null;}};
 async function request(data,command,slot=null){return stompTransfer(()=>requestExclusive(data,command,slot));}
 /* One waiter per request, kept alive across resends.

    Measured over a full 50-slot sweep: the median reply is 80 ms, but two slots
    took 5.3 s and 10.6 s, the slow one while the pedal was pushing 21 unrelated
    frames. So a reply is often merely late, not missing -- the same thing
    protocol.md section 9 records about a missing DevACK.

    The old shape made that unrecoverable. Each attempt armed its own 5 s timer,
    dropped `pending` when it fired, and started again; a reply arriving at 6 s
    therefore satisfied nothing, and three attempts could not cover a ten-second
    pedal. Now the waiter lives for the whole budget and any matching frame
    resolves it, whichever resend it answers. */
 const REQUEST_BUDGET=20000, RESEND_AFTER=6000;
 async function requestExclusive(data,command,slot=null,{budget=REQUEST_BUDGET,resendAfter=RESEND_AFTER}={}){
  if(!opened||iapHost.session===null)throw Error('Open the StompShare data session first');
  if(pending)throw Error('A patch request is already pending');
  let resolve,reject;const result=new Promise((a,b)=>{resolve=a;reject=b;});result.catch(()=>{});
  pending={resolve,reject,command,slot};
  const transmit=async()=>{
   const session=iapHost.session;
   await stompWrite(IAPCodec.frame(0x43,iapHost.nextTransaction++,
     [session>>8,session&255,...data]),'backup');
  };
  const deadline=Date.now()+budget;
  let timer=null,sends=0;
  const again=async()=>{
   if(!pending)return;
   if(Date.now()>=deadline){
    const q=pending;pending=null;
    q.reject(Error(`No patch response within ${Math.round(budget/1000)} seconds (${sends} requests sent)`));
    return;
   }
   original('backup_resend',{slot:slot===null?null:slot+1,attempt:sends+1});
   try{await transmit();sends++;}catch(e){const q=pending;pending=null;q.reject(e);return;}
   timer=setTimeout(again,resendAfter);
  };
  try{
   await transmit();sends++;
   original('backup_request',{slot:slot===null?null:slot+1,sysex:hex(data)});
   timer=setTimeout(again,resendAfter);
   return await result;
  }finally{clearTimeout(timer);pending=null;}
 }
 /* No outer retry loop: the budget above already covers several resends, and a
    second loop on top of it only multiplies the wait on a pedal that is not
    going to answer. */
 state.readSlot=async slot=>validate(await request([240,82,0,94,9,0,0,slot,247],8,slot),slot);
 /* Editor mode. A received 0x50 sets the firmware's gate flag and 0x51 clears
    it; neither draws a reply. 0x28 and 0x32 are both gated behind it, which is
    why reading the edit buffer used to time out. docs/protocol.md 5.4. */
 state.editorMode=async on=>{if(!opened||iapHost.session===null)throw Error('Open the StompShare data session first');
  const session=iapHost.session;
  await stompWrite(IAPCodec.frame(0x43,iapHost.nextTransaction++,[session>>8,session&255,240,82,0,94,on?0x50:0x51,247]),'editor');
  original('editor_mode',{on});
  // Measured repeatedly: 0x29 after 0x50 drew no reply at 400 and 1200 ms and
  // answered every time at 2000 and 3000. The threshold moves, so allow plenty;
  // a short wait looks exactly like a dead command path.
  await new Promise(r=>setTimeout(r,2500));};
 // Leaves the pedal as it found it, including when the request times out.
 state.readCurrent=async()=>{await state.editorMode(true);
  try{return validateEditBuffer(await request([240,82,0,94,0x29,247],0x28));}
  finally{await state.editorMode(false);}};

 /* Patch selection is MIDI Program Change, not SysEx -- two raw bytes down the
    same transport. docs/protocol.md 5.3. */
 state.selectPatch=async slot=>{
  if(!Number.isInteger(slot)||slot<0||slot>49)throw Error('Slot must be 0-49');
  if(!opened||iapHost.session===null)throw Error('Open the StompShare data session first');
  const session=iapHost.session;
  await stompWrite(IAPCodec.frame(0x43,iapHost.nextTransaction++,
    [session>>8,session&255,0xC0,slot]),'select');
  original('patch_select',{patch:slot+1});
  await new Promise(r=>setTimeout(r,1200));};

 /* Write one patch. Proven against hardware 2026-09-12.

    There is no store command -- 0x32 is not one, see docs/firmware.md. What
    works is the pedal's own AUTO SAVE: select the patch, load the body into the
    buffer, then leave the patch, and the pedal commits the edit rather than
    discarding it.

    PREREQUISITE: AUTO SAVE must be ON in the pedal's system menu. It is a
    front-panel setting with no command to read or set it, so this cannot be
    checked from here -- verify() below reads the slot back instead, which
    catches an unset AUTO SAVE as a failed write.

    Not byte-exact: three derived fields (offsets 12, 13 and 16 of effect slot 0)
    are zeroed by the pedal when it loads a patch, so they cannot be restored. */
 state.writeSlot=async(slot,body,{verify=true}={})=>{
  if(!Number.isInteger(slot)||slot<0||slot>49)throw Error('Slot must be 0-49');
  const frame=buildEditBuffer(body);
  await state.selectPatch(slot);
  await state.editorMode(true);
  try{
   const session=iapHost.session;
   await stompWrite(IAPCodec.frame(0x43,iapHost.nextTransaction++,
     [session>>8,session&255,...frame]),'write');
   await new Promise(r=>setTimeout(r,1200));
   // leaving the patch is what commits it
   await state.selectPatch(slot===0?1:0);
   await state.selectPatch(slot);
  }finally{await state.editorMode(false);}
  if(!verify)return {slot:slot+1,verified:false};
  const back=await state.readSlot(slot);
  const want=Array.from(body),got=back.rawHex.split(' ').map(x=>parseInt(x,16));

  // Pure comparison, tested in backup.test.cjs.
  const cmp=g.PatchBackupCodec.comparePatch(want,got);
  if(!cmp.nameOk)
   throw Error(`Patch ${slot+1} did not take: the name reads "${cmp.gotName}" rather than "${cmp.sentName}". Is AUTO SAVE on?`);
  if(cmp.badSlot>=0)
   throw Error(`Patch ${slot+1} did not take: slot ${cmp.badSlot+1} holds ${cmp.gotChain[cmp.badSlot].id} rather than ${cmp.sentChain[cmp.badSlot].id}. Is AUTO SAVE on?`);
  const drift=cmp.drift;
  original('patch_written',{patch:slot+1,name:back.name,drift});
  return {slot:slot+1,name:back.name,verified:true,drift};};
 button.onclick=async()=>{if(state.running)return;state.running=true;button.disabled=true;save.disabled=true;const backup=state.last&&!state.last.complete?state.last:{format:'stompshare-patch-backup',version:1,device:'ZOOM MS-100BT',deviceId:94,createdAt:new Date().toISOString(),complete:false,restoreTested:false,patches:[]};state.last=backup;delete backup.error;
 /* Adaptive pacing. A slow reply means the pedal is busy -- the 10.6 s slot in
    the reference sweep arrived while it was pushing 21 unrelated frames -- and
    the sensible response is to stop crowding it. Back off after a slow read and
    ease back down as it recovers, rather than hammering a fixed 150 ms. */
 let gap=150;
 try{for(let slot=backup.patches.length;slot<50;slot++){status.textContent=`Reading patch ${slot+1} of 50…`;
   const t0=Date.now();backup.patches.push(await state.readSlot(slot));const took=Date.now()-t0;
   gap=took>1000?Math.min(1200,gap*3):Math.max(150,Math.round(gap*0.7));
   if(took>1000)original('backup_slow',{slot:slot+1,ms:took,nextGap:gap});
   persist();
   await new Promise(r=>setTimeout(r,gap));}backup.patches=backup.patches.map((p,i)=>validate(p.sysexHex.split(' ').map(x=>parseInt(x,16)),i));backup.complete=true;status.textContent='50 of 50 patches captured. Download your backup. Restore has not been tested.';persist();original('backup_complete',{patches:50});}catch(e){backup.error=String(e);persist();status.textContent=`Backup stopped: ${e.message}. ${backup.patches.length}/50 captured; any download is partial.`;original('backup_error',String(e));}finally{button.textContent=backup.complete?'Sync from pedal':'Resume sync from pedal';state.running=false;button.disabled=false;save.disabled=backup.patches.length===0;}};
 save.onclick=()=>{const b=state.last;if(!b)return;void stompSave(`ms100bt-patches-${b.createdAt.replaceAll(':','-')}${b.complete?'':'-PARTIAL'}.json`,JSON.stringify(b,null,2),'application/json');};
 state.run=()=>button.onclick();state.download=()=>save.onclick();original('backup_loaded','Read-only slot backup ready');
})(globalThis);
