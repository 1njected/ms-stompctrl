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

g.ZDL={inspect,checkFilename,FILENAME_MAX};
})(globalThis);
