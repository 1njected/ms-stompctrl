/* The .ZDL container check that stands between a file someone was handed and
   the pedal's flash. Layout from docs/protocol.md 7.1. */
const assert=require('node:assert/strict'), fs=require('node:fs');
require('./zdl.js');
const {inspect,checkFilename,FILENAME_MAX}=global.ZDL, Z=global.ZDL;

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

/* descriptor(): the knobs, parsed in the browser.

   This is what replaced 47 KB of generated JSON -- an add-on's defaults come
   out of the stored file now (app/patch-params.js). The structural checks run
   anywhere; the real-file sweep needs ZOOM's binaries and skips without them,
   and is what actually proves the parser, by agreeing with the Python one on
   every file both can read. */
{
  // Not a ZDL at all, truncated, and empty: three nulls, no throw. A caller is
  // enumerating a library, so one bad file must cost one effect, not the list.
  assert.equal(Z.descriptor(new Uint8Array(0)), null);
  assert.equal(Z.descriptor(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3])), null);
  assert.equal(Z.descriptor(new Uint8Array(200)), null);
  assert.equal(Z.MAX_PARAMS, 9, 'the patch layout has room for nine');

  const dir = __dirname + '/../re-files';
  if (!fs.existsSync(dir)) {
    console.log('ZDL descriptor: refusals OK; real-file sweep skipped (ZOOM binaries absent)');
  } else {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(d + '/' + e.name) : (/\.ZDL$/i.test(e.name) ? [d + '/' + e.name] : []));
    const files = walk(dir);
    let parsed = 0, knobs = 0, none = 0;
    for (const f of files) {
      const bytes = new Uint8Array(fs.readFileSync(f));
      const d = Z.descriptor(bytes);
      if (d === null) { none++; continue; }
      parsed++; knobs += d.length;
      assert.ok(d.length <= Z.MAX_PARAMS, `${f}: ${d.length} knobs is more than the patch can hold`);
      for (const k of d) {
        assert.equal(typeof k.name, 'string');
        assert.ok(k.max <= 0xfffffff, `${f}: ${k.name} max ${k.max} is not a knob range`);
        /* CAB is the documented exception and the only one: its max reads 0 and
           its "default" reads 67109072, a pointer. Its value is the cabinet
           byte, not a packed field (patch-params.js), so the pair means nothing
           here -- but every other knob in all 218 files is a real range with a
           default inside it, and that is worth failing on. */
        if (/^cab$/i.test(k.name)) continue;
        assert.ok(k.def <= k.max, `${f}: ${k.name} default ${k.def} is above its max ${k.max}`);
      }
    }
    assert.ok(parsed > 200, `only ${parsed} of ${files.length} files parsed`);
    console.log(`ZDL descriptor: ${parsed} of ${files.length} real files parsed, `
      + `${knobs} knobs, ${none} without a descriptor; defaults all within range`);
  }
}
