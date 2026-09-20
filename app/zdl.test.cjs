/* The .ZDL container check that stands between a file someone was handed and
   the pedal's flash. Layout from docs/protocol.md 7.1. */
const assert=require('node:assert/strict');
require('./zdl.js');
const {inspect,checkFilename,FILENAME_MAX}=global.ZDL;

/* Build a structurally valid file: 'SIZE' at 4, section lengths at 0x0C/0x10,
   'INFO' at 0x14, id at 0x40, version at 0x44, ELF at 0x14+A. */
function build({a=0x38,b=64,id=0x08000090,version='1.00',truncate=0,elf=true}={}){
 const total=0x14+a+b, data=new Uint8Array(total-truncate), view=new DataView(data.buffer);
 const put=(off,text)=>{for(let i=0;i<text.length;i++)data[off+i]=text.charCodeAt(i);};
 put(4,'SIZE'); view.setUint32(0x0c,a,true); view.setUint32(0x10,b,true); put(0x14,'INFO');
 view.setUint32(0x40,id,true); put(0x44,version);
 if(elf&&0x14+a+4<=data.length){data[0x14+a]=0x7f;put(0x14+a+1,'ELF');}
 return data;
}

const good=build();
assert.deepEqual(inspect(good,'TEST.ZDL',{strict:true}),
 {id:'08000090',version:'1.00',bytes:good.length});
assert.equal(inspect(good,'TEST.ZDL').id,'08000090','the loose check reads the same id');

/* Loose is what bulk archive imports use, so it must not start rejecting the
   things strict rejects. */
const short=build({truncate:10});
assert.doesNotThrow(()=>inspect(short,'ODD.ZDL'),'archives stay lenient');
assert.throws(()=>inspect(short,'ODD.ZDL',{strict:true}),/truncated or padded/);

const noElf=build({elf:false});
assert.throws(()=>inspect(noElf,'ODD.ZDL',{strict:true}),/no DSP image/);

assert.throws(()=>inspect(new Uint8Array(200),'JUNK.ZDL'),/not a recognized ZDL/);
assert.throws(()=>inspect(good.slice(0,40),'CUT.ZDL'),/not a recognized ZDL/);

/* The pedal's 8.3 rule. install.js refuses a longer name at write time, which
   is far too late to tell someone. */
assert.equal(checkFilename('squeak.zdl'),'SQUEAK.ZDL');
assert.equal(FILENAME_MAX,12);
assert.equal(checkFilename('ABCDEFGH.ZDL'),'ABCDEFGH.ZDL','12 characters is allowed');
assert.throws(()=>checkFilename('ABCDEFGHI.ZDL'),/12 characters/);
assert.throws(()=>checkFilename('effect.bin'),/\.ZDL extension/);

/* The version string is NUL-terminated inside a fixed field. */
assert.equal(inspect(build({version:'2.10'}),'V.ZDL').version,'2.10');

console.log('ZDL container: strict and loose checks, id, version and the 8.3 filename rule passed');
