/* Single-patch files: every shape that goes in, and the one that comes out.

   No hardware fixture needed. The bodies here are synthesised, which is enough
   for a codec test -- what matters is that the five accepted shapes land on the
   same 122 bytes and that a round trip through write() is exact. The real
   50-patch backup is used as well when it happens to be present. */
const assert=require('node:assert/strict'),fs=require('node:fs');
require('./backup.js');require('./patch-editor.js');require('./patch-file.js');
const F=globalThis.PatchFile,E=globalThis.PatchEditor,C=globalThis.PatchBackupCodec;

// --- a body to work with ----------------------------------------------------
// Four filled slots and a name, laid out the way the pedal does it: the effect
// id in the low 28 bits of each slot's first little-endian word, shifted left
// by one, with the enable bit at the bottom. docs/protocol.md 7.3.
function body(ids,name){
 const b=new Array(122).fill(0);
 ids.forEach((id,i)=>{
  const w=((parseInt(id,16)<<1)>>>0|1)>>>0;
  b[i*18]=w&255;b[i*18+1]=(w>>>8)&255;b[i*18+2]=(w>>>16)&255;b[i*18+3]=(w>>>24)&255;
  for(let k=4;k<18;k++)b[i*18+k]=(i*7+k)&0x7f;      // plausible parameter bytes
 });
 for(let i=0;i<10;i++)b[111+i]=i<name.length?name.charCodeAt(i):0;
 return b;
}
/* The chain of a real imported patch, `LostDlys2W.70cdr`: FLTRDLY, DRIVE ECHO,
   DELAY, ROOM. Every one of them is an MS-100BT effect, which is what makes
   that file importable in the first place -- see the note in patch-file.js. */
const IDS=['08000070','08000100','08000008','09000020'];
const RAW=body(IDS,'LostDlys2W');
assert.equal(E.decode(RAW).name,'LostDlys2W','the synthetic body is a decodable patch');
assert.deepEqual(E.decode(RAW).slots.filter(s=>!s.empty).map(s=>s.effectId),IDS,
                 'the slot words round-trip to the ids they were built from');

// --- out: hex text of the 0x28 frame ----------------------------------------
const text=F.write(RAW);
assert.match(text,/^[0-9a-f]+$/,'written as lowercase hex with no separators');
assert.equal(text.length,F.FRAME*2,'146 bytes of frame, 292 hex digits');
assert.equal(text.slice(0,10),'f052005e28','the envelope is F0 52 00 5E 28');
assert.equal(text.slice(-2),'f7');
// Exactly the bytes writeSlot() sends, which is the point of writing the frame.
assert.deepEqual([...text.matchAll(/../g)].map(m=>parseInt(m[0],16)),
                 C.buildEditBuffer(RAW));
assert.throws(()=>F.write(RAW.slice(0,121)),/122/);

// --- in: all five accepted shapes land on the same 122 bytes ----------------
const bin=Uint8Array.from(C.buildEditBuffer(RAW));
const spaced=C.buildEditBuffer(RAW).map(b=>b.toString(16).padStart(2,'0')).join(' ');
const shapes={
 'hex text':text,
 'hex text with separators':spaced.toUpperCase()+'\n',
 'hex text with 0x prefixes':C.buildEditBuffer(RAW).map(b=>'0x'+b.toString(16).padStart(2,'0')).join(', '),
 'binary .syx':bin,
 'bare 122-byte body':Uint8Array.from(RAW),
};
for(const [what,input] of Object.entries(shapes)){
 const got=F.read(input);
 assert.deepEqual(got.body,RAW,`${what} reads back the same body`);
}
assert.equal(F.read(text).source,'edit-buffer frame');
assert.equal(F.read(text).model,0x5e);
// A bare body says nothing about which pedal it is for, and must not claim to.
assert.equal(F.read(Uint8Array.from(RAW)).model,null);
assert.equal(F.read(Uint8Array.from(RAW)).source,'bare body');

// --- in: the 0x08 slot dump a backup records --------------------------------
function slotDump(raw,slot,model=0x5e){
 let crc=0xffffffff;
 for(const v of raw){crc^=v;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 crc>>>=0;
 const five=[0,1,2,3,4].map(i=>(Math.floor(crc/2**(7*i)))&0x7f);
 return [0xf0,0x52,0,model,8,0,0,slot,raw.length&127,raw.length>>7,...C.pack7(raw),...five,0xf7];
}
const dump=slotDump(RAW,4);
assert.equal(dump.length,156,'the slot dump is the 156 bytes backup.js validates');
assert.deepEqual(F.read(Uint8Array.from(dump)).body,RAW);
assert.equal(F.read(Uint8Array.from(dump)).source,'slot dump');
assert.equal(F.read(Uint8Array.from(dump)).slot,5,'the slot number is reported 1-based');
const bent=dump.slice();bent[20]^=1;
assert.throws(()=>F.read(Uint8Array.from(bent)),/checksum/,'a corrupted dump is refused');

// --- in: a one-patch backup JSON --------------------------------------------
const hex=b=>b.map(x=>x.toString(16).padStart(2,'0')).join(' ');
const one={format:'stompshare-patch-backup',deviceId:94,
           patches:[{slot:7,name:'LostDlys2W',rawHex:hex(RAW)}]};
assert.deepEqual(F.read(JSON.stringify(one)).body,RAW);
assert.equal(F.read(JSON.stringify(one)).slot,7);
assert.equal(F.read(JSON.stringify(one)).source,'backup JSON');
// A JSON carrying the frame rather than the body works too.
assert.deepEqual(F.read(JSON.stringify({rawHex:hex(C.buildEditBuffer(RAW))})).body,RAW);
// A whole backup is the restore panel's job, and the error has to say so.
const fifty={patches:Array.from({length:50},(_,i)=>({slot:i+1,rawHex:hex(RAW)}))};
assert.throws(()=>F.read(JSON.stringify(fifty)),/50-patch backup/);
assert.throws(()=>F.read(JSON.stringify(fifty)),/Bring it back/);
assert.throws(()=>F.read('{"patches":[]}'),/no patches/);
assert.throws(()=>F.read('{"nope":1}'),/no rawHex/);
assert.throws(()=>F.read('{not json'),/will not parse/);

// --- a sibling model parses, and is reported as one -------------------------
/* The whole MS family shares this envelope and this 122-byte layout, so an
   MS-70CDR file decodes perfectly. That is exactly why the model byte has to be
   reported rather than trusted. */
const cdr=C.buildEditBuffer(RAW).slice();cdr[3]=0x61;
const foreign=F.read(Uint8Array.from(cdr));
assert.equal(foreign.model,0x61);
assert.deepEqual(foreign.body,RAW,'it parses; it is still not an MS-100BT patch');
assert.equal(F.modelLabel(0x61),'MS-70CDR');
assert.equal(F.modelLabel(0x5e),'MS-100BT');
assert.equal(F.modelLabel(0x62),'model 0x62','an unevidenced byte is not given a name');
assert.equal(F.modelLabel(null),'unknown model');

// --- refusals ---------------------------------------------------------------
assert.throws(()=>F.read(new Uint8Array(0)),/empty/);
// A complete but too-short 0x28 frame: the body is not silently zero-padded.
assert.throws(()=>F.read('f052005e2800f7'),/146 bytes/);
assert.throws(()=>F.read(text.slice(0,-1)),/odd number/);
assert.throws(()=>F.read('the quick brown fox'),/not hex/);
// Prose that happens to be all hex digits is still refused on length.
assert.throws(()=>F.read('deadbeef'),/does not start with F0/);
// No end byte at all.
assert.throws(()=>F.read(Uint8Array.from([0xf0,0x52,0,0x5e,0x28,1,2,3])),/no end byte/);
// Right envelope, wrong command: 0x09 is a request, it carries no patch.
assert.throws(()=>F.read(Uint8Array.from([0xf0,0x52,0,0x5e,9,0,0,0,0xf7])),/command 0x9/);
// Not ZOOM at all -- a generic MIDI identity reply.
assert.throws(()=>F.read(Uint8Array.from([0xf0,0x7e,0,6,2,0xf7])),/not a ZOOM SysEx/);

// --- filenames --------------------------------------------------------------
assert.equal(F.filename('LostDlys2W',4),'LostDlys2W.100bt');
assert.equal(F.filename('Dusty Dunes',0),'Dusty_Dunes.100bt');
assert.equal(F.filename('A/B:C*D',0),'ABCD.100bt','path and glob characters are dropped');
assert.equal(F.filename('',0),'patch-01.100bt','a nameless patch falls back to its slot');
assert.equal(F.filename('   ',49),'patch-50.100bt');
assert.equal(F.filename('☃☃☃',2),'patch-03.100bt','a name with nothing portable in it also falls back');

// --- inspect: what the file says, and nothing about availability ----------
/* inspect() used to take a predicate and check each id against
   effect-names.json. That was the wrong question and it let a real write
   through with a slot missing: the index covers the 101 firmware effects AND
   the 117-effect download catalog, so an uninstalled add-on passes it. Whether
   the pedal has an effect is answered in patch-editor-ui.js, which can see the
   installed .ZDL list. So this reports the chain and leaves the verdict alone. */
const info=F.inspect(RAW);
assert.equal(info.name,'LostDlys2W');
assert.equal(info.effects,4);
assert.deepEqual(info.chain.map(c=>c.slot),[1,2,3,4],'slots are 1-based and in chain order');
assert.deepEqual(info.chain.map(c=>c.effectId),IDS);
assert(info.chain.every(c=>c.enabled),'these four ship switched on');
assert.equal('unknown' in info,false,'no availability verdict is offered');

// Empty slots are not effects and are not in the chain.
const sparse=F.inspect(body(['08000100'],'One'));
assert.equal(sparse.effects,1);
assert.deepEqual(sparse.chain,[{slot:1,effectId:'08000100',enabled:true}]);

// A gap mid-chain keeps the real slot numbers, so a warning can name them.
const gapped=F.inspect(body(['08000070','00000000','09000020'],'Gapped'));
assert.deepEqual(gapped.chain.map(c=>c.slot),[1,3]);

/* The patch editor's slot classification rests on two questions, and this is
   where their invariants are guarded.

   "Is this an MS-100BT effect at all" -- the `unlisted` case -- is answered by
   the id, not by an index: docs/protocol.md 7.1 shows that (top byte, byte 2)
   names a family for every one of the 218 known effects and for nothing else,
   which is the rule describe() implements. It used to be a lookup in
   effect-names.json, but that index now holds only the 101 firmware effects
   (an add-on's name is its filename, which the library carries), so a lookup
   would have called an add-on nobody imported "not an MS-100BT effect" when
   the honest answer is "not in your library".

   "Firmware, or a .ZDL that has to be installed" is what decides whether a
   slot survives a write, and that is still the index's `factory` list. Its
   absence -- build-effect-names.py omits it when StompShare.app was not passed
   -- makes the editor fall back to guessing, so absence or a changed size is
   worth failing on. */
const idx=JSON.parse(fs.readFileSync(__dirname+'/effect-names.json','utf8'));
const index=idx.names;
assert(Array.isArray(idx.factory),'the index records which ids are firmware');
assert(Array.isArray(idx.addons),'and which ids are add-ons');
const factory=new Set(idx.factory),addons=new Set(idx.addons);
const listed=id=>factory.has(id)||addons.has(id);

for(const id of IDS)assert.equal(listed(id),true,`${id} is an MS-100BT effect`);
assert.equal(listed('08004030'),false,'an id in neither list is not an MS-100BT effect');
// An add-on nobody imported is still an MS-100BT effect, and the id cannot say
// so on its own: 08004030 and 08000100 are both perfectly ordinary Delay ids.
assert.equal(listed('08000100'),true,'DRV_ECHO is an effect even when unimported');
assert.equal(E.describe('08004030').family,E.describe('08000100').family,
             'the two are indistinguishable by family, which is why the lists exist');

assert.equal(factory.size,101,'101 InitialStomps effects');
assert.equal(addons.size,117,'117 catalog add-ons');
assert.equal(factory.size+addons.size,218,'and together they are every known effect');
assert.deepEqual([...factory].filter(id=>addons.has(id)),[],'the two lists are disjoint');
// Names are firmware-only now: an add-on's name is its filename, which the
// browser library carries.
assert.equal(Object.keys(index).length,101,'the names map is the firmware set');
assert.deepEqual(Object.keys(index).filter(id=>!factory.has(id)),[],
                 'no add-on is named here');
assert.deepEqual([...factory].filter(id=>!index[id]),[],'every firmware id is named');
// The chain that made this necessary: three firmware effects and one add-on.
assert.deepEqual(IDS.map(id=>factory.has(id)),[true,false,true,true]);
assert.equal(factory.has('08000100'),false,'DRV_ECHO.ZDL is an add-on, not firmware');

// --- against the real backup, when it is there ------------------------------
const FIXTURE=__dirname+'/../backups/ms100bt-patches-20260908.json';
let real=0;
if(fs.existsSync(FIXTURE)){
 for(const p of JSON.parse(fs.readFileSync(FIXTURE,'utf8')).patches){
  const raw=p.rawHex.split(' ').map(x=>parseInt(x,16));
  assert.deepEqual(F.read(F.write(raw)).body,raw,`patch ${p.slot} round-trips`);
  assert.deepEqual(F.read(p.sysexHex).body,raw,`patch ${p.slot} reads from its slot dump`);
  assert.deepEqual(F.inspect(raw).chain.map(c=>c.effectId).filter(id=>!listed(id)),[],
                   `patch ${p.slot} names only MS-100BT effects`);
  real++;
 }
}

console.log(`Patch files: ${Object.keys(shapes).length} input shapes, slot dumps, backup JSON, `+
            `a sibling-model file, 15 refusals and 6 filenames`+
            (real?`; ${real} real patches round-tripped`:'; real-backup round trip skipped (fixture absent)'));
