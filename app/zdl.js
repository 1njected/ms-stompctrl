/* The .ZDL container, per docs/protocol.md 7.1 -- all of it verified on real
   files:

     0x04  'SIZE'
     0x0C  u32 LE  length of section A
     0x10  u32 LE  length of section B
     0x14  'INFO'
     0x40  u32 LE  effect id; the high byte is the category
     0x44  version string, ASCII
     0x14+A  \x7fELF, the DSP image

   Total length is 0x14 + A + B.

   `strict` exists because the two callers have different standing. An archive
   fetched by download-effects.py came from ZOOM and is checked loosely, the way
   it always has been -- rejecting a whole import over one odd file would be a
   regression. A single file someone hands the page is vouched for by nobody, and
   the next thing that happens to it is a write to the pedal's flash, so its
   declared lengths are made to add up first. */
(function(g){
const FILENAME_MAX=12;          // 8.3, uppercase, including ".ZDL"

function inspect(data,filename='File',{strict=false}={}){
 const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
 const text=(from,to)=>new TextDecoder().decode(data.slice(from,to));
 if(data.length<76||text(4,8)!=='SIZE'||text(20,24)!=='INFO')
  throw Error(`${filename} is not a recognized ZDL effect.`);
 const id=view.getUint32(64,true).toString(16).padStart(8,'0');
 const version=text(68,76).split('\0')[0];
 if(strict){
  const a=view.getUint32(12,true),b=view.getUint32(16,true);
  if(data.length!==20+a+b)
   throw Error(`${filename} is truncated or padded: its header declares ${20+a+b} bytes, the file is ${data.length}.`);
  if(text(20+a,24+a)!=='\x7fELF')
   throw Error(`${filename} has no DSP image where its header says one begins.`);
 }
 return {id,version,bytes:data.length};
}

/* The pedal stores 8.3 uppercase names; install.js refuses anything longer, and
   finding that out after a file has been imported and picked is too late. */
function checkFilename(filename){
 const name=String(filename||'').toUpperCase();
 if(!/\.ZDL$/.test(name))throw Error(`${filename} must be named with a .ZDL extension.`);
 if(name.length>FILENAME_MAX)
  throw Error(`The pedal allows ${FILENAME_MAX} characters including ".ZDL"; "${name}" is ${name.length}. Rename it and try again.`);
 return name;
}

/* The effect's own knobs, read out of the file.

   WHY IN THE BROWSER. An effect's defaults are what the patch editor needs to
   place it (patch-params.js), and for an add-on the browser already holds the
   bytes that state them -- effect-store.js keeps every imported `.ZDL` in
   IndexedDB. Shipping those in a generated index instead meant 47 KB of JSON
   saying what the stored files already say, and an effect ZOOM published after
   the index was built had no defaults until somebody with StompShare re-ran the
   script. So add-ons are parsed here, and `effect-params.json` is left holding
   only the firmware effects, which are not files and cannot be parsed from
   anywhere (docs/app.md).

   WHAT IT READS. The container's section A is a TI C6000 ELF32, little-endian
   (docs/protocol.md 7.1). In its `.const` sits the registration struct the
   loader reads: 48-byte blocks, block 0 always `OnOff`, block 1 the effect
   itself, blocks 2 onward the knobs.

     +0x00  12 bytes  name, NUL padded
     +0x0c  u32       max
     +0x10  u32       default

   The struct is found by that `OnOff` signature rather than by a fixed address:
   the symbol in `.const` whose size is a multiple of 48 and whose first block
   is named `OnOff`. Of 218 real files, 217 match exactly once; `CMN_DRV.ZDL`
   has no descriptor at all and comes back null.

   WHY IT NEVER THROWS. A caller is enumerating a library, not checking a file
   somebody just handed over -- inspect() is where a bad file is refused, with
   `strict` and a message. Here a file that cannot be read is a file with no
   defaults, so the editor offers it from a patch or not at all. One malformed
   `.ZDL` must not take the whole list down with it. */
const MAX_PARAMS=9;              // p0..p8; the patch layout has nowhere for a tenth
const BLOCK=48;

function descriptor(data){
 try{
  const bytes=data instanceof Uint8Array?data:new Uint8Array(data);
  const base=indexOfElf(bytes);
  if(base<0)return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const u32=o=>view.getUint32(o,true),u16=o=>view.getUint16(o,true);
  const shoff=base+u32(base+0x20),shentsize=u16(base+0x2e),
        shnum=u16(base+0x30),shstrndx=u16(base+0x32);
  if(!shnum||shentsize<40||shoff+shnum*shentsize>bytes.length)return null;
  const sec=i=>{const o=shoff+i*shentsize;
   return {nameoff:u32(o),type:u32(o+4),addr:u32(o+12),off:base+u32(o+16),size:u32(o+20)};};
  const secs=[];for(let i=0;i<shnum;i++)secs.push(sec(i));
  if(shstrndx>=shnum)return null;
  const shstr=secs[shstrndx].off;
  for(const s of secs)s.name=cstr(bytes,shstr+s.nameoff,64);
  const named=n=>secs.find(s=>s.name===n&&s.size);
  // .const appears several times, all but one of them empty placeholders.
  const konst=secs.find(s=>s.name==='.const'&&s.type===1&&s.size);
  const symtab=named('.symtab'),strtab=named('.strtab');
  if(!konst||!symtab||!strtab)return null;
  let best=null;
  for(let o=symtab.off;o+16<=symtab.off+symtab.size;o+=16){
   const value=u32(o+4),size=u32(o+8);
   if(!size||size%BLOCK||size<2*BLOCK)continue;
   if(value<konst.addr||value>=konst.addr+konst.size)continue;
   const at=konst.off+(value-konst.addr);
   if(at+size>bytes.length)continue;
   if(cstr(bytes,at,12)!=='OnOff')continue;
   if(!best||value<best.at)best={at,size,value};
  }
  if(!best)return null;
  const out=[];
  for(let i=2*BLOCK;i+BLOCK<=best.size&&out.length<MAX_PARAMS;i+=BLOCK){
   const at=best.at+i,max=u32(at+12);
   // 0xffffffff where a max belongs marks the effect's own block, not a knob.
   if(max>0xfffffff)continue;
   out.push({name:cstr(bytes,at,12),max,def:u32(at+16)});
  }
  /* An empty list is an answer, not a failure: `ORANGELM.ZDL` has a descriptor
     with no knobs at all, and it is still an effect you can put in a slot --
     its fourteen bytes are simply all zero. Only a file with no descriptor to
     find comes back null. */
  return out;
 }catch{return null;}
}

const indexOfElf=b=>{
 for(let i=0;i+4<=b.length;i++)
  if(b[i]===0x7f&&b[i+1]===0x45&&b[i+2]===0x4c&&b[i+3]===0x46)return i;
 return -1;
};
const cstr=(b,at,max)=>{
 let end=at;const stop=Math.min(b.length,at+max);
 while(end<stop&&b[end])end++;
 return new TextDecoder().decode(b.subarray(at,end));
};

g.ZDL={inspect,checkFilename,descriptor,FILENAME_MAX,MAX_PARAMS};
})(globalThis);
