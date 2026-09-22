/* One operation at a time.

   The frame queue in the transport already stops two exchanges overlapping, but
   an operation is not one exchange. A patch write is selectPatch, editorMode,
   the write itself, two more selectPatch calls and a read-back; an install is
   acquire, mute, file mode, a disk query and a chunked transfer. Nothing stopped
   the steps of one operation landing between the steps of another, and the pedal
   answers that by stopping: docs/bluetooth.md records it acknowledging every
   frame while answering none, recoverable only by a power cycle.

   So a long operation holds this lock for its whole length, and a second one is
   refused with a message naming what is already running rather than queued
   behind it. Queueing would be worse: pressing Sync during an install would
   appear to do nothing for a minute and then start on its own.

   Work that is already inside a held lock passes {nested:true} rather than
   trying to take it again -- restore.js holds the lock across fifty writes, and
   each write would otherwise deadlock on it. */
(function(g){
if(g.pedalLock)return;
const lock={
 busy:false,
 label:null,
 /* Fires on every change so the page can grey out what must not be pressed. */
 events:new EventTarget(),
 async run(label,fn,{nested=false}={}){
  if(nested)return fn();
  if(lock.busy)throw Error(`The pedal is busy: ${lock.label}. Wait for that to finish, then try again.`);
  lock.busy=true;lock.label=label;
  lock.events.dispatchEvent(new CustomEvent('change',{detail:{busy:true,label}}));
  try{
   return await fn();
  }finally{
   lock.busy=false;lock.label=null;
   lock.events.dispatchEvent(new CustomEvent('change',{detail:{busy:false,label:null}}));
  }
 }
};
g.pedalLock=lock;
})(globalThis);
