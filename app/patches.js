/* Writing patches: an unproven path, exposed as a ladder of experiments.

   Nothing here is wired to a button. Each rung is meant to be run by hand, from
   the console, with the pedal in front of you, and only after the rung below it
   has worked.

   Why the care. No patch-write command appears anywhere in our captures --
   StompShare never writes patches -- so everything below is inferred from
   thammer/zoom-explorer, which documents the ZOOM MS family. The MS-100BT
   answers 09 with 08 in exactly the shape that project records for the "Plus"
   pedals, so the family is right; the byte layout of a write to this model is
   still a guess until a read-back proves it.

   And the neighbourhood is dangerous. In the same command space,
   zoom-explorer records 0x5B as a factory reset that wipes all user patches,
   and 0x01 as firmware mode. A mistyped command byte here is not a failed
   experiment, it is a lost pedal. Every frame this module sends is checked
   against an allowlist before it goes anywhere near the port.

   RUNG 0 FAILED ON 2026-09-12, AND WE NOW KNOW WHY: A MISSING PREREQUISITE.

   The pedal answered neither F0 52 00 5E 29 F7 nor F0 52 00 5E 64 13 F7. The
   measurement was sound -- slot 1 read back correctly in the same minute -- but
   the conclusion drawn from it, that no edit buffer is reachable, did not follow.

   Firmware analysis on 2026-09-12 found the SysEx command table. 0x29 IS in it.
   So is 0x28. Both are gated behind an editor-mode flag that a received 0x50
   sets and 0x51 clears, and when that flag is set the pedal builds and sends
   F0 52 00 <model> 28 <122 bytes> F7 -- 122 being exactly the patch body length
   this file's sibling backup.js validates. Nothing in this client has ever sent
   0x50, and neither did StompShare, which is why no capture contains it.

   RERUN RUNG 0 AS: 0x50, then 0x29, then 0x51 to restore the mode. If 0x29
   answers with 0x28 this time, rungs 1 and 2 below become live again and the
   guard below becomes load-bearing rather than decorative.

   See docs/firmware.md for the command table and addresses, and
   docs/protocol.md 5.5 for the path that does work.

   That measurement is the whole case. Two firmware arguments that once stood
   beside it have since been withdrawn, and neither should be repeated:

     -- "0x28 is never built, so it is not a command the pedal accepts." The
        firmware's SysEx template table has no entry for 0x08 or 0x09 either,
        and backup.js reads all fifty patches with exactly that pair. The table
        is not an inventory; absence from it proves nothing.

     -- "build_sysex_32 ends in the send routine, so 0x32 is transmit-only."
        The first half is still true -- the pedal does build and send 0x32, with
        the current patch number as its argument. It does not follow that no
        receive handler exists; that is a separate code path and it has not been
        found either way.

   See docs/protocol.md 5.4. The guard below is kept regardless: it is
   worth having whatever the ladder turns out to be.

   THE LADDER (as designed, before that result)

     0. patchBackup.readCurrent()      read the edit buffer. Pure read, no risk.
                                       Proves 29 -> 28 works and shows the exact
                                       layout a write would have to produce.

     1. pedalPatches.rewriteEditBuffer()
                                       read the edit buffer, send it straight
                                       back, read again, compare. Writes only to
                                       the edit buffer, which is volatile --
                                       changing patch on the pedal discards it --
                                       so a wrong guess costs an unsaved sound.

     2. pedalPatches.storeEditBufferToSlot(n)   RUN 2026-09-12: DOES NOT STORE.
                                       The edit buffer took a probe name, the
                                       0x32 frame below was sent, and the slot
                                       came back byte-identical to its backup --
                                       as did all fifty. See docs/protocol.md 5.4.
                                       with patch n selected on the pedal, store
                                       the edit buffer back into slot n and
                                       compare. Persistent. Only after rung 1,
                                       and only on a slot held in a backup.

   Rung 2 is the first that can lose anything. It writes a patch back with the
   bytes it just read, so a success changes nothing at all -- which is the point.
   A failure damages one slot, whose correct contents are in the backup, and
   which becomes restorable the moment this path is proven. */
(function(g){
 const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join(' ');

 // Commands this module is permitted to transmit. Anything else -- 0x5B factory
 // reset above all -- is refused before a byte is written.
 // 0x50/0x51 toggle editor mode, the prerequisite for 0x28 and 0x29 (protocol.md 5.4).
 const ALLOWED=new Set([0x28,0x29,0x32,0x50,0x51]);
 const DANGEROUS={0x5b:'factory reset: wipes all user patches',0x01:'firmware update mode'};

 function check(frame){
  if(frame[0]!==0xf0||frame[1]!==0x52||frame[2]!==0x00||frame[3]!==0x5e||frame.at(-1)!==0xf7)
   throw Error(`Refusing to send a frame that is not a ZOOM MS-100BT SysEx: ${hex(frame.slice(0,6))}…`);
  const cmd=frame[4];
  if(DANGEROUS[cmd])throw Error(`Refusing command 0x${cmd.toString(16)} — ${DANGEROUS[cmd]}`);
  if(!ALLOWED.has(cmd))throw Error(`Refusing command 0x${cmd.toString(16)}: not one this module may send`);
  return frame;
 }

 const sameBytes=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);

 /* Rung 1. The edit buffer only. */
 async function rewriteEditBuffer(){
  if(g.iapHost?.session==null)throw Error('Open a data session first');
  const before=await g.patchBackup.readCurrent();
  g.log('patch_edit_buffer_read',{bytes:before.length,hex:hex(before.slice(0,16))+'…'});
  if(before[4]!==0x28)throw Error(`Expected a 0x28 reply, got 0x${before[4].toString(16)}`);

  // Send the reply straight back as a command. If 0x28 is symmetric -- the same
  // frame in both directions, as 0x08/0x09 are for slots -- this is a no-op.
  const frame=Uint8Array.from(check(Array.from(before)));
  await g.stompWrite(g.IAPCodec.frame(0x43,g.iapHost.nextTransaction++,
    [g.iapHost.session>>8,g.iapHost.session&255,...frame]),'patch');
  await new Promise(r=>setTimeout(r,400));

  const after=await g.patchBackup.readCurrent();
  const identical=sameBytes(Array.from(before),Array.from(after));
  g.log('patch_edit_buffer_rewrite',{identical,before:before.length,after:after.length});
  return {identical,before:Array.from(before),after:Array.from(after),
          verdict:identical?'0x28 accepted and the edit buffer is unchanged'
                           :'the edit buffer changed — do NOT go on to rung 2'};
 }

 /* Rung 2. Store whatever is in the edit buffer into a slot.

    0x32 is the only store command documented for this family, and it stores the
    edit buffer -- it takes no patch data of its own. So the safe no-op is:
    select patch n on the pedal, so its edit buffer already holds patch n
    unchanged, then store it back to n. Nothing should differ afterwards.

    An earlier draft of this rung sent the 0x08 slot dump straight back, on the
    guess that it is symmetric the way 0x09 and 0x08 are. check() refused it,
    correctly: zoom-explorer records 0x08 only ever coming from the pedal, so
    that was a guess stacked on a guess. Building a 0x28 frame from a slot dump
    needs the edit-buffer layout that rung 1 reveals, and is a decoding step to
    do with that evidence in hand rather than blind. */
 async function storeEditBufferToSlot(slot){
  if(g.iapHost?.session==null)throw Error('Open a data session first');
  if(!Number.isInteger(slot)||slot<0||slot>49)throw Error('Slot must be 0-49');
  const read=async()=>{const p=await g.patchBackup.readSlot(slot);
   return p.sysexHex.split(' ').map(x=>parseInt(x,16));};
  const before=await read();
  g.log('patch_slot_read',{slot,bytes:before.length});

  const frame=Uint8Array.from(check([0xf0,0x52,0x00,0x5e,0x32,0x01,0x00,0x00,slot,0,0,0,0,0,0xf7]));
  await g.stompWrite(g.IAPCodec.frame(0x43,g.iapHost.nextTransaction++,
    [g.iapHost.session>>8,g.iapHost.session&255,...frame]),'patch');
  await new Promise(r=>setTimeout(r,800));   // the pedal shows "Storing…"

  const after=await read();
  const identical=before.length===after.length&&before.every((v,i)=>v===after[i]);
  g.log('patch_slot_store',{slot,identical});
  return {slot,identical,
          verdict:identical?'slot unchanged; 0x32 stores without corrupting'
                           :'SLOT CHANGED — restore it from your backup before anything else'};
 }

 g.pedalPatches={rewriteEditBuffer,storeEditBufferToSlot,check,ALLOWED,DANGEROUS};
})(globalThis);
