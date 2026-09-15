/* Editing a patch body.

   A patch is 122 bytes: six 18-byte effect slots, then a tail carrying the
   name. Every field below is read off the 50 factory patches in a real backup,
   not inferred from sibling models.

     offset 0..107   six slots, 18 bytes each
       slot +0..+3   u32 little-endian:
                       bit 0       1 = effect on, 0 = bypassed
                       bits 1..28  effect id, 0 for an empty slot
                       bits 29..31 unidentified, and NOT always zero in the
                                   factory patches -- carried through verbatim
                                   as `flags` so a round trip is byte-exact
       slot +4..+17  that effect's parameters, meaningless to any other effect
     offset 108..110 patch-level fields, not decoded; preserved verbatim
     offset 111..120 name, 10 characters, space padded
     offset 121      always 0 in all 50 factory patches

   Bit 0 is the bypass flag and not part of the id: five effect ids appear in
   the factory patches with the bit both set and clear. `CrunchAmp` ships with
   its first slot bypassed.

   SWAPPING AN EFFECT IS THE ONE UNSAFE EDIT. Bytes +4..+17 belong to whichever
   effect the slot held, and nothing here knows what a given effect expects, so
   setEffect() demands the caller supply the parameter bytes and says so. The
   other edits -- rename, bypass, reorder, clear -- only move or flip bytes the
   pedal already wrote, so they cannot produce a combination it has not seen.

   Writing a patch back is browser-probe/backup.js writeSlot(); it needs AUTO
   SAVE on and does not round-trip three derived bytes. docs/protocol.md 5.5. */
(function(g){
 const SLOTS=6,SLOT=18,NAME_AT=111,NAME_LEN=10,BODY=122;
 const u32=(b,o)=>(b[o]|b[o+1]<<8|b[o+2]<<16|b[o+3]<<24)>>>0;
 const put32=(b,o,v)=>{b[o]=v&255;b[o+1]=(v>>>8)&255;b[o+2]=(v>>>16)&255;b[o+3]=(v>>>24)&255;};

 function decode(body){
  const b=Array.from(body||[]);
  if(b.length!==BODY)throw Error(`A patch body is ${BODY} bytes, got ${b.length}`);
  if(b.some(v=>!Number.isInteger(v)||v<0||v>255))throw Error('Body bytes must be 0-255');
  const slots=[];
  for(let i=0;i<SLOTS;i++){
   const w=u32(b,i*SLOT);
   slots.push({index:i,effectId:((w>>>1)&0xfffffff).toString(16).padStart(8,'0'),
               enabled:(w&1)===1,empty:((w>>>1)&0xfffffff)===0,
               flags:w>>>29,
               params:b.slice(i*SLOT+4,(i+1)*SLOT)});
  }
  return {name:String.fromCharCode(...b.slice(NAME_AT,NAME_AT+NAME_LEN)).replace(/\0.*$/,'').trimEnd(),
          slots,tail:b.slice(SLOTS*SLOT)};
 }

 function encode(patch){
  const b=new Array(BODY).fill(0);
  if(!patch||!Array.isArray(patch.slots)||patch.slots.length!==SLOTS)
   throw Error(`A patch has exactly ${SLOTS} slots`);
  patch.slots.forEach((s,i)=>{
   const id=parseInt(s.effectId||'0',16);
   if(!Number.isInteger(id)||id<0||id>0xfffffff)throw Error(`Slot ${i+1}: bad effect id`);
   const flags=(s.flags||0)&7;
   put32(b,i*SLOT,(((flags<<29)>>>0)|((id<<1)>>>0)|(s.enabled?1:0))>>>0);
   const p=Array.from(s.params||[]);
   if(p.length!==SLOT-4)throw Error(`Slot ${i+1}: parameters are ${SLOT-4} bytes, got ${p.length}`);
   for(let k=0;k<p.length;k++)b[i*SLOT+4+k]=p[k]&255;
  });
  const tail=Array.from(patch.tail||[]);
  if(tail.length!==BODY-SLOTS*SLOT)throw Error('Tail length changed');
  for(let k=0;k<tail.length;k++)b[SLOTS*SLOT+k]=tail[k]&255;
  setName(b,patch.name??'');
  return b;
 }

 /* 10 characters, space padded, ASCII only -- the pedal renders one 5x7 font
    and a byte over 0x7e would not survive the 7-bit packing intact anyway. */
 function setName(body,name){
  const clean=String(name).replace(/[^\x20-\x7e]/g,'').slice(0,NAME_LEN).padEnd(NAME_LEN,' ');
  for(let i=0;i<NAME_LEN;i++)body[NAME_AT+i]=clean.charCodeAt(i);
  return body;
 }

 const clone=p=>({name:p.name,tail:p.tail.slice(),
                  slots:p.slots.map(s=>({...s,params:s.params.slice()}))});

 const rename=(p,name)=>{const q=clone(p);q.name=String(name);return q;};
 const setEnabled=(p,i,on)=>{const q=clone(p);
  if(!q.slots[i])throw Error('No such slot');
  if(q.slots[i].empty)throw Error('An empty slot cannot be switched on');
  q.slots[i].enabled=!!on;return q;};
 const toggle=(p,i)=>setEnabled(p,i,!p.slots[i]?.enabled);
 const clear=(p,i)=>{const q=clone(p);
  if(!q.slots[i])throw Error('No such slot');
  q.slots[i]={index:i,effectId:'00000000',enabled:false,empty:true,flags:0,
              params:new Array(SLOT-4).fill(0)};
  return q;};
 /* Reorder moves whole slots, so each effect keeps its own parameters. */
 const move=(p,from,to)=>{const q=clone(p);
  if(!q.slots[from]||!q.slots[to])throw Error('No such slot');
  const [s]=q.slots.splice(from,1); q.slots.splice(to,0,s);
  q.slots.forEach((x,i)=>{x.index=i;}); return q;};
 /* Params must come from the caller; see the header. */
 const setEffect=(p,i,effectId,params)=>{const q=clone(p);
  if(!q.slots[i])throw Error('No such slot');
  if(!/^[0-9a-fA-F]{1,8}$/.test(String(effectId)))throw Error('Effect id must be hex');
  const pr=Array.from(params||[]);
  if(pr.length!==SLOT-4)
   throw Error(`Slot ${i+1}: setEffect needs all ${SLOT-4} parameter bytes for the new effect; `+
               `this module cannot invent them.`);
  // The high bits belong to whatever the slot held; a new effect starts clear.
  q.slots[i]={index:i,effectId:String(effectId).toLowerCase().padStart(8,'0'),
              enabled:true,empty:false,flags:0,params:pr};
  return q;};

 /* What an effect is, from its id alone.

    Most effect ids have no name available -- the catalog is the add-on store and
    a patch's effects are built into the firmware -- so without this a slot row
    can only show eight hex digits. The id itself carries the family: the top
    byte is the category (the same one FLST_SEQ.ZDT groups by, §7.2) and byte 2
    separates instrument families (§7.1).

    Derived by grouping all 117 catalog effects by (top byte, byte 2); every
    group was internally consistent, and the names below are what each group
    plainly contains. It applies to built-in ids too, because it reads the id
    rather than any file. */
 const FAMILIES={
  '01:00':'Dynamics','01:40':'Bass drive','01:60':'Bass preamp',
  '02:00':'Filter & EQ','03:00':'Drive','04:00':'Amp',
  '05:10':'Bass/acoustic amp','06:00':'Modulation','07:00':'Synth',
  '08:00':'Delay','09:00':'Reverb',
 };
 /* Compact forms for places that show a whole chain at once, where the full
    names do not fit. Spelled out rather than derived: trimming a prefix off
    "Bass drive" leaves a lowercase "drive", and off "Bass/acoustic amp"
    leaves nothing sensible at all. */
 const SHORT={'Dynamics':'Dynamics','Bass drive':'Bass OD','Bass preamp':'Bass pre',
              'Filter & EQ':'EQ','Drive':'Drive','Amp':'Amp','Bass/acoustic amp':'Bass amp',
              'Modulation':'Mod','Synth':'Synth','Delay':'Delay','Reverb':'Reverb'};
 const h2=n=>n.toString(16).padStart(2,'0');
 function describe(effectId){
  const id=parseInt(effectId||'0',16)||0;
  if(!id)return {empty:true,family:null,category:0,sub:0,bass:false};
  const category=(id>>>24)&0xff, sub=(id>>>16)&0xff;
  const family=FAMILIES[`${h2(category)}:${h2(sub)}`]||FAMILIES[`${h2(category)}:00`]||null;
  return {empty:false,category,sub,bass:sub!==0,family,short:family?SHORT[family]||family:null};
 }

 /* Where a new effect's 14 parameter bytes can honestly come from.

    Not from this module, and not from zeros: the bytes mean whatever the
    effect's own code says they mean, and an out-of-range value is a sound
    nobody asked for at best. But a patch that already uses the effect carries
    a block the pedal itself wrote, which is as good a starting point as exists
    without decoding the .ZDL descriptor.

    So: harvest one working block per effect id from the patches in hand. The
    pedal's own factory patches cover 68 effects, which is the set a user can
    actually put in a chain. Anything not represented has no honest default and
    is simply not offered. */
 function paramSources(patches){
  const found=new Map();
  for(const p of patches||[]){
   const raw=String(p.rawHex||'').split(' ').map(x=>parseInt(x,16));
   if(raw.length!==BODY)continue;
   let dec;try{dec=decode(raw);}catch{continue;}
   for(const s of dec.slots){
    if(s.empty)continue;
    const seen=found.get(s.effectId);
    if(seen){
     // Every patch that uses an effect, so a caller naming it by "the one in
     // <patch>" has alternatives when two effects would otherwise read alike.
     if(p.name&&!seen.usedBy.includes(p.name))seen.usedBy.push(p.name);
     continue;
    }
    found.set(s.effectId,{effectId:s.effectId,params:s.params.slice(),
                          flags:s.flags,fromPatch:p.slot??null,fromName:p.name??null,
                          position:s.index,usedBy:p.name?[p.name]:[]});
   }
  }
  return found;
 }

 g.PatchEditor={decode,encode,rename,setEnabled,toggle,clear,move,setEffect,
                paramSources,describe,FAMILIES,SLOTS,SLOT,BODY,NAME_LEN};
})(globalThis);
