/* The pedal walks a patch's chain from slot 1 and stops at the first empty
   slot. Measured on hardware 2026-09-21: clearing the first three effects of a
   six-effect patch left the pedal showing none of the remaining three. 48 of
   the 50 factory patches are packed with no gaps; the two that are not are both
   named "Empty". So removing an effect has to close the gap behind it. */
const assert=require('node:assert/strict');
require('./patch-editor.js');
const E=global.PatchEditor;

const word=(id,on)=>(((parseInt(id,16)<<1)>>>0)|(on?1:0))>>>0;
function body(ids){
 const b=new Array(E.BODY).fill(0);
 ids.forEach((id,i)=>{const w=word(id||'0',1);
  b[i*E.SLOT]=w&255;b[i*E.SLOT+1]=(w>>>8)&255;b[i*E.SLOT+2]=(w>>>16)&255;b[i*E.SLOT+3]=(w>>>24)&255;});
 return b;
}
const shape=p=>p.slots.map(s=>s.empty?'.':'X').join('');
const ids=p=>p.slots.filter(s=>!s.empty).map(s=>s.effectId);

const six=E.decode(body(['01000050','02000010','03000060','08000010','06000070','09000010']));
assert.equal(shape(six),'XXXXXX');

/* Clearing the first slot pulls everything up; the hole never reaches the pedal. */
let p=E.clear(six,0);
assert.equal(shape(p),'XXXXX.','slot 1 cleared, chain closes up');
assert.deepEqual(ids(p),['02000010','03000060','08000010','06000070','09000010'],'order kept');

/* The reported case: the first three removed, three left, all at the front. */
p=E.clear(E.clear(E.clear(six,0),0),0);
assert.equal(shape(p),'XXX...','three removed, three packed at the front');
assert.deepEqual(ids(p),['08000010','06000070','09000010']);

/* Clearing in the middle closes up too. */
assert.equal(shape(E.clear(six,2)),'XXXXX.');
assert.deepEqual(ids(E.clear(six,2)),['01000050','02000010','08000010','06000070','09000010']);

/* A patch that already had a gap comes back packed. */
const gappy=E.decode(body(['01000050','','03000060']));
assert.equal(shape(gappy),'X.X...','the fixture really does have a hole');
assert.equal(shape(E.clear(gappy,5)),'XX....','clearing anything repacks it');

/* An empty slot is written the way the pedal writes one: id 0, enable bit set,
   parameters zeroed -- not eighteen zero bytes. */
const encoded=E.encode(E.clear(six,0));
const last=encoded.slice(5*E.SLOT,6*E.SLOT);
assert.deepEqual(last,[1,0,0,0,...new Array(E.SLOT-4).fill(0)],'empty slot reads 01 00 00 00 ...');

/* Parameters travel with their effect when the chain closes up. */
const withParams=E.setEffect(six,1,'08000010',new Array(E.SLOT-4).fill(7));
const moved=E.clear(withParams,0);
assert.deepEqual(moved.slots[0].params,new Array(E.SLOT-4).fill(7),'parameters move with the effect');

/* Clearing everything leaves a wholly empty, still-valid patch. */
let none=six; for(let i=0;i<E.SLOTS;i++)none=E.clear(none,0);
assert.equal(shape(none),'......');
assert.deepEqual(E.decode(E.encode(none)).slots.map(s=>s.empty),new Array(E.SLOTS).fill(true));

/* Reordering cannot open a gap either. */
const three=E.decode(body(['01000050','03000060','08000010']));
assert.equal(shape(E.move(three,2,3)),'XXX...','pushing the last effect into empty space does nothing');
assert.deepEqual(ids(E.move(three,2,3)),['01000050','03000060','08000010'],'and leaves the order alone');
assert.deepEqual(ids(E.move(three,0,1)),['03000060','01000050','08000010'],'a real reorder still works');
assert.deepEqual(ids(E.move(three,2,0)),['08000010','01000050','03000060'],'moving to the front works');
assert.equal(shape(E.move(three,4,0)),'XXX...','dragging an empty slot to the front changes nothing');

/* Choosing an effect beyond the end of the chain puts it at the end of the
   chain, not past it -- the pedal never looks there. */
const blank=E.decode(new Array(E.BODY).fill(0));
const late=E.setEffect(blank,5,'04000140',new Array(E.SLOT-4).fill(3));
assert.equal(shape(late),'X.....','an effect chosen in slot 6 of an empty patch lands in slot 1');
assert.equal(late.slots[0].effectId,'04000140');
const after=E.setEffect(three,4,'09000010',new Array(E.SLOT-4).fill(1));
assert.equal(shape(after),'XXXX..','and otherwise lands right after the existing chain');

/* The field that tells the pedal how many slots to show follows the chain. */
const donors=E.chainFields([
 {rawHex:body(['01000050']).map(v=>v.toString(16).padStart(2,'0')).join(' ')},
 {rawHex:body(['01000050','03000060','08000010']).map(v=>v.toString(16).padStart(2,'0')).join(' ')},
]);
// give the donors distinguishable fields
donors.set(1,[11,5,15]); donors.set(3,[64,13,15]);
const stale=E.decode(body(['01000050','03000060','08000010']));
stale.tail[0]=64;stale.tail[1]=13;stale.tail[2]=15;
assert.deepEqual(E.stampChain(stale,donors).tail.slice(0,3),[64,13,15],'a 3-effect chain keeps 3-effect fields');
const cut=E.clear(E.clear(stale,0),0);
assert.equal(shape(cut),'X.....');
assert.deepEqual(E.stampChain(cut,donors).tail.slice(0,3),[11,5,15],'cut to one effect, takes the 1-effect fields');
assert.deepEqual(E.stampChain(cut,null).tail.slice(0,3),[64,13,15],'with no donors nothing is touched');

console.log('Chain packing: gaps closed on clear, order and parameters kept, empty slots in the pedal’s own form');
