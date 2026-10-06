/* One patch as a file.

   The editor can hand a single patch out and take one back. That is what patch
   sharing needs and what the backup format is bad at: a backup JSON is all
   fifty slots and belongs to the restore panel, while a patch somebody posts is
   one chain.

   WHAT IS WRITTEN. The 146-byte edit-buffer frame -- `F0 52 00 5E 28 <140
   packed> F7`, byte for byte what writeSlot() sends -- as lowercase hex text
   with no separators, extension `.100bt`. Two reasons for that shape rather
   than the bare 122-byte body. It keeps the model byte in the file, which is
   the only thing in a patch that says which pedal it is for. And it mirrors the
   convention of the sym.bios.is patch library, whose MS-70CDR patches are hex
   text named `.70cdr`, so a patch exported here is a shape that world already
   reads.

   WHAT IS ACCEPTED is deliberately wider, because files arrive in whatever
   shape their author had: hex text with or without separators, a binary `.syx`,
   a bare 122-byte body, the 0x08 slot dump a backup records, or a one-patch
   backup JSON. All five land on the same 122 bytes.

   IMPORTING ANOTHER MS MODEL. The family shares this envelope and this patch
   layout -- 122 bytes, six 18-byte slots, name at 111 -- so a sibling model's
   file parses perfectly. Whether it is *playable* here is a separate question,
   because what differs between models is which effects exist and a patch
   carries only ids. So read() reports the model byte rather than trusting it,
   and refuses nothing: the write rewrites that byte, and whether the effects
   are there is a question about the pedal, not about the file.

   That second question does not belong to this module. It needs the pedal's
   installed .ZDL list and the add-on catalog, which the page holds, so
   patch-editor-ui.js asks it -- see the note there, and why asking it of
   effect-names.json instead got a patch written with a slot missing.
   inspect() here reports only what the file says: its name and its chain.

   Measured on one real import, `LostDlys2W.70cdr` from the sym.bios.is library:
   model byte 0x61, chain FLTRDLY, DRIVE ECHO, DELAY, ROOM. Three are firmware
   effects; DRIVE ECHO is `08000100`, the add-on DRV_ECHO.ZDL, which has to be
   installed before the patch can hold it. docs/protocol.md 4 and 7.3. */
(function(g){
 const EXT='.100bt', MODEL=0x5e, BODY=122, FRAME=146;

 /* Only the two models this project has evidence for: 0x5E is measured against
    hardware (docs/protocol.md 4), 0x61 comes off a `.70cdr` file from the
    sym.bios.is library. Every other byte is reported as a byte rather than
    guessed at a name. */
 const MODELS={0x5e:'MS-100BT',0x61:'MS-70CDR'};
 const modelLabel=m=>m==null?'unknown model'
   :(MODELS[m]||`model 0x${m.toString(16).padStart(2,'0')}`);

 const codec=()=>{
  if(!g.PatchBackupCodec)throw Error('backup.js is not loaded');
  return g.PatchBackupCodec;
 };

 /* Text or bytes? Not the extension -- a hex dump saved as `.syx` is still hex
    -- so the test is on the content. A file of printable ASCII is text; a
    binary SysEx fails it on its first byte, 0xF0 being above 0x7f. */
 const toU8=x=>x instanceof Uint8Array?x:new Uint8Array(x);
 function textIfPrintable(input){
  if(typeof input==='string')return input;
  const u=toU8(input);
  if(!u.length)return '';
  return u.every(b=>b===9||b===10||b===13||(b>=32&&b<127))
   ?new TextDecoder().decode(u):null;
 }

 /* Separators are stripped, but nothing else is: silently discarding whatever
    does not look like hex would turn a prose file into a patch made of the few
    letters a-f it happened to contain. */
 function fromHexText(text){
  const cleaned=String(text).replace(/0[xX]/g,'').replace(/[\s,:;_-]+/g,'');
  if(!cleaned)throw Error('That file is empty.');
  if(!/^[0-9a-fA-F]+$/.test(cleaned))
   throw Error('That file is text, but not hex: a patch file is a run of hex bytes.');
  if(cleaned.length%2)throw Error('That hex is an odd number of digits, so it is incomplete.');
  const out=[];
  for(let i=0;i<cleaned.length;i+=2)out.push(parseInt(cleaned.slice(i,i+2),16));
  return out;
 }

 /* A 0x08 slot dump carries a CRC-32 of the unpacked body in five 7-bit groups;
    the 0x28 edit-buffer frame carries none. Same polynomial as backup.js
    validate(), which is the reflected CRC-32 the pedal uses. */
 const crc32=raw=>{
  let c=0xffffffff;
  for(const v of raw){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}
  return c>>>0;
 };

 function fromFrame(bytes){
  const end=bytes.indexOf(0xf7);
  if(end<0)throw Error('That SysEx has no end byte (F7), so it is truncated.');
  const f=bytes.slice(0,end+1);
  if(f[1]!==0x52)
   throw Error(`That is not a ZOOM SysEx: byte 2 is 0x${(f[1]??0).toString(16)}, not 0x52.`);
  const model=f[3],cmd=f[4];
  if(cmd===0x28){
   if(f.length!==FRAME)
    throw Error(`An edit-buffer patch is ${FRAME} bytes, and that one is ${f.length}.`);
   const body=codec().unpack7(f.slice(5,-1));
   if(body.length!==BODY)throw Error(`That frame unpacks to ${body.length} bytes, not ${BODY}.`);
   return {body,model,slot:null,source:'edit-buffer frame'};
  }
  if(cmd===0x08){
   const length=f[8]+128*f[9];
   if(length!==BODY)throw Error(`That slot dump declares ${length} bytes, not ${BODY}.`);
   const packed=f.slice(10,-6);
   if(packed.length!==length+Math.ceil(length/7))
    throw Error(`That slot dump carries ${packed.length} packed bytes, not ${length+Math.ceil(length/7)}.`);
   const body=codec().unpack7(packed);
   if(body.length!==BODY)throw Error(`That dump unpacks to ${body.length} bytes, not ${BODY}.`);
   const stored=f.slice(-6,-1).reduce((n,v,i)=>n+v*2**(7*i),0);
   if(crc32(body)!==stored)throw Error('That slot dump fails its own checksum.');
   return {body,model,slot:f[7]+1,source:'slot dump'};
  }
  throw Error(`That SysEx is command 0x${(cmd??0).toString(16)}, which carries no patch. `+
              'A patch file is a 0x28 edit-buffer frame or a 0x08 slot dump.');
 }

 function fromJson(text){
  let d;
  try{d=JSON.parse(text);}catch{throw Error('That file looks like JSON but will not parse.');}
  let entry=null;
  if(Array.isArray(d?.patches)){
   if(!d.patches.length)throw Error('That backup holds no patches.');
   if(d.patches.length>1)
    throw Error(`That is a ${d.patches.length}-patch backup, not a single patch. `+
                'Use "Bring it back" on the Patches page to restore a whole backup.');
   entry=d.patches[0];
  }else if(typeof d?.rawHex==='string'||typeof d?.sysexHex==='string')entry=d;
  if(!entry)throw Error('That JSON carries no patch: no rawHex and no patches array.');
  const hex=entry.rawHex||entry.sysexHex;
  const bytes=fromHexText(hex);
  const model=Number.isInteger(d?.deviceId)?d.deviceId:MODEL;
  if(bytes.length===BODY)
   return {body:bytes,model,slot:entry.slot??null,source:'backup JSON'};
  const got=fromFrame(bytes);
  return {...got,slot:entry.slot??got.slot,source:'backup JSON'};
 }

 /* The 122 bytes a patch file carries, plus what the file said about itself.
    `model` is null for a bare body, which says nothing about its pedal. */
 function read(input){
  const text=textIfPrintable(input);
  if(text!==null&&text.trimStart().startsWith('{'))return fromJson(text);
  const bytes=text!==null?fromHexText(text):Array.from(toU8(input));
  if(!bytes.length)throw Error('That file is empty.');
  const got=bytes[0]===0xf0?fromFrame(bytes)
   :bytes.length===BODY?{body:bytes,model:null,slot:null,source:'bare body'}
   :null;
  if(!got)
   throw Error(`That file is ${bytes.length} bytes and does not start with F0, `+
               `so it is neither a SysEx patch nor a bare ${BODY}-byte body.`);
  if(got.body.some(v=>!Number.isInteger(v)||v<0||v>255))throw Error('Patch bytes must be 0-255');
  // Proves it is a patch and not 122 bytes of something else.
  if(g.PatchEditor)g.PatchEditor.decode(got.body);
  return got;
 }

 /* Hex text of the 0x28 frame. buildEditBuffer() does the packing and the
    length check, so what is written here is exactly what a write sends. */
 function write(body){
  return codec().buildEditBuffer(Array.from(body))
   .map(b=>b.toString(16).padStart(2,'0')).join('');
 }

 /* A filename from the patch's own name, the way the library this format
    mirrors does it. Patch names are ten bytes of pedal ASCII and can hold
    spaces and punctuation, so they are reduced to what every filesystem takes;
    a patch with no usable name falls back to its slot. */
 function filename(name,slot){
  const safe=String(name||'').trim().replace(/[^A-Za-z0-9 ._-]+/g,'').trim().replace(/\s+/g,'_');
  return (safe||`patch-${String((slot??0)+1).padStart(2,'0')}`)+EXT;
 }

 /* What the file says it is: the patch's name and the effects it names, in
    chain order and 1-based so it reads like the panel. Deliberately no verdict
    on availability -- that is the pedal's business, not the file's. */
 function inspect(body){
  if(!g.PatchEditor)throw Error('patch-editor.js is not loaded');
  const p=g.PatchEditor.decode(Array.from(body));
  const used=p.slots.filter(s=>!s.empty);
  return {name:p.name,effects:used.length,
          chain:used.map(s=>({slot:s.index+1,effectId:s.effectId,enabled:s.enabled}))};
 }

 g.PatchFile={read,write,filename,inspect,modelLabel,EXT,MODEL,MODELS,BODY,FRAME};
})(globalThis);
