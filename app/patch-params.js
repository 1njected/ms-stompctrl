/* Where a slot's nine parameters live in its eighteen bytes.

   WHY THIS EXISTS. setEffect() refused to invent the fourteen parameter bytes,
   so the patch editor could only offer effects the loaded patches already used
   -- 68 on a factory pedal, out of 218 the pedal can play. The missing piece
   was never the values: every `.ZDL` carries its own defaults (§7.1, and
   tools/build-effect-params.py extracts them). It was the packing, and the
   packing is published.

   THE LAYOUT IS NOT OURS. g200kg's zoom-ms-utility documents the MS-50G /
   MS-60B / MS-70CDR patch dump bit by bit, as a table over the 146-byte SysEx
   frame naming every bit `<effect>p<param>b<bit>`:

     https://github.com/g200kg/zoom-ms-utility/blob/master/midimessage.md

   The table below is that table, converted once from frame coordinates to the
   122-byte body this app works in -- the frame's seven-bit packing undone with
   the same rule as PatchBackupCodec.unpack7() -- and expressed slot-relative,
   because all six slots carry the identical layout. That conversion was checked
   against the 50-patch hardware backup: 780 of 786 parameters decode inside
   their descriptor's range, and 327 sit exactly on the descriptor's default.
   The six that do not are all `CAB`, which the same table marks as a special
   byte rather than a packed field -- see CAB_AT.

   THE SHAPE IS ODD AND DELIBERATE. Parameters are bit fields, not bytes, and
   they are not contiguous:

     p0   12 bits   byte 3 bits 5-7, then byte 4, then byte 5 bit 0
     p1   11 bits   byte 5 bits 2-7, then byte 6 bits 0-4
     p2   11 bits   byte 6 bit 7, then byte 7, then byte 8 bits 0-1
     p3-p6 8 bits   nibble-straddling pairs through byte 12
     p7    9 bits
     p8    8 bits   byte 16, on its own

   Byte 3 is the surprise and it matters. Bytes 0-3 are the id word, and
   patch-editor.js calls its top three bits `flags` -- "unidentified, and NOT
   always zero in the factory patches". They are not flags: they are p0's low
   three bits. That is why this module speaks in {flags, params} rather than
   just the fourteen bytes, and why setEffect() now takes the flags too. Copying
   an effect between patches while zeroing them silently rewrote the first
   parameter -- for a delay, its time.

   WHAT THIS MODULE DOES NOT KNOW is what a value means. A parameter's stored
   number is not always its displayed one: the pedal shows ZNR THRSH as 1-25
   over a stored 0-24, and an effect's own edit handler can scale as it likes.
   Defaults go out exactly as the `.ZDL` stated them, which is the one mapping
   that needs no interpretation. docs/protocol.md 7.3. */
(function(g){
 const SLOT=18,PARAMS=9,CAB_AT=15;

 /* Per parameter, its bits from b0 upward, as flat [byte,bit] pairs. Byte
    indices are slot-relative: 3 is the id word's top byte, 4-17 the parameter
    bytes patch-editor.js exposes as `params`. */
 const LAYOUT=[
  [3,5,3,6,3,7,4,0,4,1,4,2,4,3,4,4,4,5,4,6,4,7,5,0],
  [5,2,5,3,5,4,5,5,5,6,5,7,6,0,6,1,6,2,6,3,6,4],
  [6,7,7,0,7,1,7,2,7,3,7,4,7,5,7,6,7,7,8,0,8,1],
  [8,4,8,5,8,6,8,7,9,0,9,1,9,2,9,3],
  [9,4,9,5,9,6,9,7,10,0,10,1,10,2,10,3],
  [10,4,10,5,10,6,10,7,11,0,11,1,11,2,11,3],
  [11,4,11,5,11,6,11,7,12,0,12,1,12,2,12,3],
  [12,4,12,5,12,6,12,7,13,0,13,1,13,2,13,3,13,4],
  [16,0,16,1,16,2,16,3,16,4,16,5,16,6,16,7],
 ];
 const WIDTH=LAYOUT.map(l=>l.length/2);

 /* One bit, addressed the way patch-editor.js holds a slot. Byte 3's bits 5-7
    are `flags` bits 0-2, because flags is the id word shifted right by 29. */
 const get=(flags,params,byte,bit)=>
   byte===3?(flags>>>(bit-5))&1:(params[byte-4]>>>bit)&1;
 const set=(out,byte,bit,v)=>{
  if(!v)return;
  if(byte===3)out.flags|=1<<(bit-5);
  else out.params[byte-4]|=1<<bit;
 };

 /* The nine stored values of a slot. `flags` and `params` are exactly what
    PatchEditor.decode() puts on a slot, so a caller never assembles bytes. */
 function read(slot){
  const flags=slot?.flags||0,params=Array.from(slot?.params||[]);
  if(params.length!==SLOT-4)throw Error(`A slot has ${SLOT-4} parameter bytes, got ${params.length}`);
  return LAYOUT.map(bits=>{
   let v=0;
   for(let b=0;b*2<bits.length;b++)v|=get(flags,params,bits[b*2],bits[b*2+1])<<b;
   return v;
  });
 }

 /* The inverse: nine values to the bytes a slot carries. Values are clamped to
    the field rather than wrapped -- a default wider than its field would
    otherwise write a small number with no sign anything was lost -- and a short
    list leaves the rest zero, which is what an effect with fewer than nine
    parameters stores. */
 function write(values){
  const out={flags:0,params:new Array(SLOT-4).fill(0)};
  LAYOUT.forEach((bits,i)=>{
   const v=Math.min(Math.max(Math.round(values?.[i]||0),0),(1<<WIDTH[i])-1);
   for(let b=0;b*2<bits.length;b++)set(out,bits[b*2],bits[b*2+1],(v>>>b)&1);
  });
  return out;
 }

 /* THE CABINET, WHICH IS TWO THINGS AND NEITHER IS A KNOB. Slot byte 15 is not
    a packed field: g200kg's table calls it `<effect>cab` and gives it whole-byte
    values -- 0x00 off, 0x40 a guitar cabinet, 0x50/0x51 the bass revisions.
    read() and write() leave it alone, which is why a round trip over the
    50-patch backup is byte-exact on every slot except the amp-ish ones, where
    that byte is the only difference.

    A `CAB` descriptor entry is not a knob either, though it occupies a
    parameter index. Its max reads 0 and its "default" reads 67109072, which is
    a pointer, not a value -- the only two fields in 217 descriptors that are
    not what their position says. It still consumes an index: in all 31 effects
    that have one, CAB sits at p7 with `OUT` at p8, and the backup confirms OUT
    decoding at p8 with its real range of 0-4.

    WHAT A DEFAULT WRITES: cabinet off, both parts of it. The 12 amp slots in
    the backup split 6 with byte 15 at 0x00 and 6 at 0x40, and the two parts
    move together -- every slot with 0x00 has p7 at 0, while the ones at 0x40
    carry p7 values of 240, 8, 304 and 320, some cabinet selection whose rule is
    not in the published table and not in the descriptor. Off is the state the
    factory patches themselves use, it is internally consistent, and it needs
    nothing guessed. The cabinet is then one press away on the pedal.

    (An earlier version of this wrote 0x40 for guitar effects and 0x50 for bass
    ones, on the strength of "every amp in the backup stores 0x40" -- which was
    simply not true, half of them store 0x00. It also left p7 holding that
    pointer, clamped to 511.) */
 const isCab=p=>/^cab$/i.test(p?.name||'');

 /* An effect's own starting point, from the descriptor its `.ZDL` carries.
    `params` is one {name,max,def} per knob, in the order the pedal numbers
    them -- an effect-params.json entry, or ZDL.descriptor() over a stored file.
    Everything past the effect's own parameter count stays zero. */
 function defaults(params){
  return write((params||[]).map(p=>isCab(p)?0:(p?.def||0)));
 }

 /* WHERE THE KNOBS COME FROM. Two places, for the same reason effect-names.json
    has two: an add-on is a file the browser holds, and a firmware effect is not
    a file at all.

      an add-on    parsed out of the stored `.ZDL` by ZDL.descriptor(). The
                   library is the authority -- it is the actual file that will
                   be installed -- and an effect ZOOM adds to the catalog
                   tomorrow works on import with nothing to regenerate
      firmware     effect-params.json, 100 entries, built by
                   tools/build-effect-params.py from ZOOM's StompShare bundle.
                   Those effects live in the firmware with no file anywhere the
                   browser can reach, so there is nothing to parse

    The library is re-scanned on every load() rather than cached, because
    importing or deleting an effect changes the answer and the editor calls
    load() each time it opens. 117 descriptors parse in a few milliseconds; the
    fetched index is kept, since that one cannot change.

    Neither source is required. No index and no library means paramsFor()
    answers null for everything, and the picker falls back to exactly the
    effects some loaded patch already uses -- what it offered before any of this
    existed. */
 let builtIn=null,fetching=null,derived=new Map();

 function fetchIndex(){
  if(builtIn)return Promise.resolve(builtIn);
  if(fetching)return fetching;
  if(typeof fetch!=='function')return Promise.resolve(null);
  fetching=fetch('effect-params.json').then(r=>r.ok?r.json():null)
   .then(d=>{builtIn=d?.params||null;return builtIn;}).catch(()=>null);
  return fetching;
 }

 /* Every stored `.ZDL`, by effect id. descriptor() returns null for a file it
    cannot read rather than throwing, so one bad entry costs that one effect. */
 function scanLibrary(){
  if(!g.effectStore?.all||!g.ZDL?.descriptor)return Promise.resolve(new Map());
  return g.effectStore.all().then(records=>{
   const out=new Map();
   for(const r of records||[]){
    if(!r?.id||!r.data)continue;
    const knobs=g.ZDL.descriptor(r.data);
    if(knobs)out.set(String(r.id).toLowerCase(),knobs);
   }
   return out;
  }).catch(()=>new Map());
 }

 function load(){
  return Promise.all([fetchIndex(),scanLibrary()]).then(([,lib])=>{
   derived=lib;
   // How many effects can now be named a default for -- 0 is falsy, so a
   // caller can re-render on a useful answer and ignore an empty one.
   return derived.size+Object.keys(builtIn||{}).length;
  });
 }
 const paramsFor=id=>{
  const key=String(id).toLowerCase();
  return derived.get(key)||builtIn?.[key]||null;
 };
 const defaultsFor=id=>{const p=paramsFor(id);return p?defaults(p):null;};

 g.PatchParams={read,write,defaults,load,paramsFor,defaultsFor,isCab,
                LAYOUT,WIDTH,PARAMS,CAB_AT};
})(globalThis);
