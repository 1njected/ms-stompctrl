/* The random chain builder. It only ever draws from effects the loaded patches
   already use, because those carry the real 14-byte parameter blocks the pedal
   expects -- an invented effect id has none. */
const assert=require('node:assert/strict');
require('./patch-editor.js');
const E=global.PatchEditor;

const empty=E.decode(new Array(E.BODY).fill(0));
const source=(id,fill)=>({effectId:id,params:new Array(E.SLOT-4).fill(fill)});
// ids chosen across categories: 09=reverb, 03=drive, 01=dynamics, 08=delay
const sources=new Map([
 ['09000010',source('09000010',9)],['03000060',source('03000060',3)],
 ['01000050',source('01000050',1)],['08000010',source('08000010',8)],
 ['06000070',source('06000070',6)],
]);
// A deterministic stand-in for Math.random.
const seeded=seq=>{let i=0;return()=>seq[i++%seq.length];};

const p=E.randomChain(empty,sources,seeded([0.99,0.1,0.4,0.7,0.2,0.5,0.3]));
const filled=p.slots.filter(s=>!s.empty);
assert.ok(filled.length>=2&&filled.length<=4,`2-4 effects, got ${filled.length}`);
assert.ok(filled.every(s=>s.enabled),'a random chain arrives switched on');
assert.equal(new Set(filled.map(s=>s.effectId)).size,filled.length,'no effect twice');
assert.ok(filled.every(s=>sources.has(s.effectId)),'only effects we have parameters for');

/* Slots after the chain are cleared, so a previous patch does not leak through. */
const used=p.slots.findIndex(s=>s.empty);
assert.ok(p.slots.slice(used).every(s=>s.empty),'the tail of the chain is empty');

/* Ordered like a signal chain: dynamics before drive before delay before reverb. */
const cats=filled.map(s=>E.describe(s.effectId).category);
assert.deepEqual(cats,[...cats].sort((a,b)=>a-b),'categories ascend');

/* Parameters travel with the effect -- the pedal is never handed a bare id. */
for(const s of filled) assert.deepEqual(s.params,sources.get(s.effectId).params);

/* It survives the round trip the pedal actually receives. */
const again=E.decode(E.encode(p));
assert.deepEqual(again.slots.map(s=>s.effectId),p.slots.map(s=>s.effectId));
assert.equal(again.name,p.name.slice(0,E.NAME_LEN));

/* Names fit the pedal's field. */
for(let i=0;i<200;i++) assert.ok(E.randomName().length<=E.NAME_LEN,'name fits NAME_LEN');

/* Nothing to draw from is a clear refusal, not a broken patch. */
assert.throws(()=>E.randomChain(empty,new Map()),/Read the patches off the pedal first/);
assert.throws(()=>E.randomChain(empty,new Map([['x',{effectId:'x',params:[1,2]}]])),/Read the patches off the pedal first/);

/* --- Full random: the manners come off, the safety does not --- */

/* Restrained runs never exceed four effects, never bypass, always ascend. */
for(let seed=0;seed<40;seed++){
 const r=seeded([seed/40,(seed*7%40)/40,(seed*13%40)/40,(seed*29%40)/40,(seed*3%40)/40]);
 const q=E.randomChain(empty,sources,r);
 const on=q.slots.filter(s=>!s.empty);
 assert.ok(on.length>=2&&on.length<=4,'restrained stays within 2-4');
 assert.ok(on.every(s=>s.enabled),'restrained never bypasses');
 const c=on.map(s=>E.describe(s.effectId).category);
 assert.deepEqual(c,[...c].sort((a,b)=>a-b),'restrained ascends');
}

/* Full random reaches sizes and orderings the restrained one cannot. What it
   never does is hand back a chain with something switched off: a random patch
   is meant to be heard, and a bypassed slot is indistinguishable from a bug. */
let sizes=new Set(),sawUnordered=false;
for(let seed=0;seed<200;seed++){
 const r=seeded([(seed%17)/17,(seed*7%23)/23,(seed*13%19)/19,(seed*29%11)/11,(seed*5%13)/13,(seed*3%7)/7]);
 const q=E.randomChain(empty,sources,r,{full:true});
 const on=q.slots.filter(s=>!s.empty);
 sizes.add(on.length);
 const c=on.map(s=>E.describe(s.effectId).category);
 if(JSON.stringify(c)!==JSON.stringify([...c].sort((a,b)=>a-b)))sawUnordered=true;
 assert.ok(on.every(s=>s.enabled),'full random never bypasses either');
 // The safety that does not come off:
 assert.ok(on.every(s=>sources.has(s.effectId)),'still only effects we have parameters for');
 for(const s of on) assert.deepEqual(s.params,sources.get(s.effectId).params,'parameters are never invented');
 assert.ok(on.length>=1&&on.length<=Math.min(E.SLOTS,sources.size),'within the slots the pedal has');
 assert.deepEqual(E.decode(E.encode(q)).slots.map(s=>s.effectId),q.slots.map(s=>s.effectId),'round trips');
}
assert.ok(sawUnordered,'full random eventually breaks signal order');
assert.ok(sizes.has(1)||sizes.has(5),`full random reaches sizes the restrained one cannot (saw ${[...sizes].sort()})`);

/* --- The patch-level bytes that track the chain --- */

/* Build two fake patches with known tails, one 2-effect and one 5-effect. */
function bodyWith(ids,tail){
 const b=new Array(E.BODY).fill(0);
 ids.forEach((id,i)=>{const w=((parseInt(id,16)<<1)>>>0)|1;
  b[i*E.SLOT]=w&255;b[i*E.SLOT+1]=(w>>>8)&255;b[i*E.SLOT+2]=(w>>>16)&255;b[i*E.SLOT+3]=(w>>>24)&255;});
 for(let k=0;k<tail.length;k++)b[E.SLOTS*E.SLOT+k]=tail[k];
 return b;
}
const donors=E.chainFields([
 {rawHex:bodyWith(['01000050','03000060'],[0,9,15]).map(v=>v.toString(16).padStart(2,'0')).join(' ')},
 {rawHex:bodyWith(['01000050','03000060','08000010','09000010','06000070'],[0,21,15]).map(v=>v.toString(16).padStart(2,'0')).join(' ')},
]);
assert.deepEqual(donors.get(2),[0,9,15],'a 2-effect patch donates its fields');
assert.deepEqual(donors.get(5),[0,21,15],'so does a 5-effect one');

/* A chain built with donors carries the fields of a real patch of that length,
   instead of the ones belonging to the patch it replaced. */
const stale=E.decode(bodyWith(['01000050','03000060'],[99,99,99]));
for(let seed=0;seed<60;seed++){
 const r=seeded([(seed%17)/17,(seed*7%23)/23,(seed*13%19)/19,(seed*29%11)/11,(seed*5%13)/13]);
 const q=E.randomChain(stale,sources,r,{full:true,fields:donors});
 const filled=q.slots.filter(s=>!s.empty).length;
 const want=donors.get(filled);
 if(want)assert.deepEqual(q.tail.slice(0,3),want,`a ${filled}-effect chain takes a ${filled}-effect patch's fields`);
 else assert.deepEqual(q.tail.slice(0,3),[99,99,99],'with no donor the existing bytes are left alone');
 assert.equal(q.tail.length,E.BODY-E.SLOTS*E.SLOT,'the tail keeps its length');
}

/* Without a donor table nothing changes -- the old behaviour, byte for byte. */
const untouched=E.randomChain(stale,sources,seeded([0.5,0.2,0.7,0.1]));
assert.deepEqual(untouched.tail.slice(0,3),[99,99,99]);

console.log('Chain fields: donors collected by length, transplanted on build, left alone without one');
console.log('Random chain: size, uniqueness, ordering, parameters, clearing, naming and refusal passed');
console.log(`Full random: sizes ${[...sizes].sort().join('/')}, free ordering reached, nothing bypassed, parameters still real`);
