/* The lock that keeps two pedal operations from interleaving. */
const assert=require('node:assert/strict');
global.CustomEvent=global.CustomEvent||class{constructor(t,o){this.type=t;this.detail=o&&o.detail;}};
require('./pedal-lock.js');
const lock=global.pedalLock;

const idle=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
 assert.equal(lock.busy,false);

 /* A second operation is refused while the first holds it, and the message
    names what is running so the page can say something useful. */
 let released;
 const first=lock.run('Reading patch 12 of 50',async()=>{await new Promise(r=>{released=r;});return 'done';});
 await idle(0);
 assert.equal(lock.busy,true);
 assert.equal(lock.label,'Reading patch 12 of 50');
 await assert.rejects(()=>lock.run('Installing SQUEAK.ZDL',async()=>'never'),
   /busy: Reading patch 12 of 50/,'the refusal names the operation in progress');
 released();
 assert.equal(await first,'done');
 assert.equal(lock.busy,false,'released when the operation finishes');

 /* A failure must not leave it held -- that would wedge the app, not the pedal. */
 await assert.rejects(()=>lock.run('Writing patch 3',async()=>{throw Error('pedal said no');}),/pedal said no/);
 assert.equal(lock.busy,false,'released after a failure too');

 /* Work already inside a held lock runs instead of deadlocking on it. */
 const out=await lock.run('Restoring 50 patches',async()=>{
  const each=[];
  for(let i=0;i<3;i++) each.push(await lock.run(`Writing patch ${i}`,async()=>i,{nested:true}));
  return each;
 });
 assert.deepEqual(out,[0,1,2],'nested work completes');
 assert.equal(lock.busy,false);

 /* The page is told, so it can disable what must not be pressed. */
 const seen=[];
 lock.events.addEventListener('change',e=>seen.push(e.detail.busy));
 await lock.run('Reading the effect list',async()=>{});
 assert.deepEqual(seen,[true,false],'one event on the way in, one on the way out');

 /* Back-to-back operations are fine; it is only overlap that is refused. */
 await lock.run('a',async()=>{});
 await lock.run('b',async()=>{});
 assert.equal(lock.busy,false);

 console.log('Pedal lock: refuses overlap by name, releases on success and failure, allows nested work, reports state');
})().catch(e=>{console.error(e);process.exit(1);});
