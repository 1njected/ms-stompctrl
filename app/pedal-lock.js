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
 /* The lock is also where the pedal's data session is taken and given back.

    Those two things have the same lifetime -- an operation needs a session and
    nothing else does -- and putting them in one place means no caller has to
    remember. iapHost.withSession() reference-counts, so `nested` work inside a
    held lock reuses the session rather than closing it on the way out.

    Why it matters: a session the pedal still believes in after the page is gone
    is what makes the next connect fail, and nothing host-side clears that
    (docs/bluetooth.md). Holding one only for the length of an operation is what
    shrinks that window from "the whole time you are connected" to "while work
    is running". The run() signature is unchanged; a host without withSession --
    a test with a stubbed iapHost, the module loaded alone -- just runs fn. */
 async run(label,fn,{nested=false}={}){
  if(nested)return fn();
  if(lock.busy)throw Error(`The pedal is busy: ${lock.label}. Wait for that to finish, then try again.`);
  lock.busy=true;lock.label=label;
  lock.events.dispatchEvent(new CustomEvent('change',{detail:{busy:true,label}}));
  const host=globalThis.iapHost;
  try{
   return await (typeof host?.withSession==='function'?host.withSession(fn):fn());
  }finally{
   lock.busy=false;lock.label=null;
   lock.events.dispatchEvent(new CustomEvent('change',{detail:{busy:false,label:null}}));
  }
 }
};
g.pedalLock=lock;
})(globalThis);
