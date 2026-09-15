/* Restoring patches, and the effects they need.

   A package used to be patches plus a copy of every effect binary they
   reference. That was unnecessary, and this now takes the patch backup alone.

   Why the binaries were redundant. Every effect a patch can name is either part
   of the pedal's factory set -- which ships on every MS-100BT, so it is already
   there -- or an add-on, which is in the browser's own effect library. Measured
   against a real backup: of the 68 effects the 50 factory patches reference, 65
   are factory (`InitialStomps`) and 3 are catalog add-ons, and **none is
   missing from those two sources**. Carrying the bytes in the package just
   duplicated what both ends already had, and made a 4 KB backup into a
   multi-megabyte ZIP.

   So a restore is:

     1. read the patch backup
     2. see which effect ids the patches name
     3. resolve each against the pedal's directory and the local library
     4. install only the ones genuinely absent from the pedal
     5. restore the patches

   Step 5 works by loading the buffer with 0x28 and then leaving the patch, so
   the pedal's AUTO SAVE commits it; there is no store command. It needs AUTO
   SAVE on, which nothing can read, so every write is verified by reading the
   slot back. Three derived bytes per patch do not survive. See
   docs/protocol.md 5.5.

   A ZIP that carries binaries is still accepted, so packages written by the
   older code keep working; its binaries are simply preferred when present. */
(function(g){
 const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join(' ');
 const upper=n=>String(n||'').toUpperCase();

 /* Effect IDs referenced by a patch backup, with the slots that use each.
    Six slots per patch, 18 bytes each, the id in the low 28 bits of the first
    little-endian word shifted right by one -- the same decode backup.js and the
    Effects page use. Bypassed slots still carry their id and still count: the
    effect has to be present for the patch to load. */
 function referencedEffects(patches){
  const used=new Map();
  for(const p of patches||[]){
   const b=String(p.rawHex||'').split(' ').map(x=>parseInt(x,16));
   if(b.length<108)continue;
   const seen=new Set();
   for(let i=0;i<6;i++){
    const id=((b[i*18]|b[i*18+1]<<8|b[i*18+2]<<16|b[i*18+3]<<24)>>>1)&0xfffffff;
    if(id)seen.add(id.toString(16).padStart(8,'0'));
   }
   for(const id of seen){
    if(!used.has(id))used.set(id,[]);
    used.get(id).push(p.slot??null);
   }
  }
  return used;
 }

 /* Read a package: a patch-backup JSON, or a ZIP that also carries binaries. */
 async function read(buffer){
  const text=new TextDecoder().decode(new Uint8Array(buffer).slice(0,2048));
  if(text.trimStart().startsWith('{'))return readJson(buffer);
  return readZip(buffer);
 }

 function readJson(buffer){
  let parsed;
  try{parsed=JSON.parse(new TextDecoder().decode(buffer));}
  catch{throw Error('That file is neither a patch backup nor a package ZIP.');}
  if(!parsed||!Array.isArray(parsed.patches))
   throw Error('That JSON has no patches. Use a file from "Download backup".');
  return {patches:parsed.patches,backup:parsed,manifest:null,effects:[],
          complete:parsed.complete===true};
 }

 async function readZip(buffer){
  const entries=await g.effectStore.zipEntries(buffer);
  const find=re=>entries.find(e=>re.test(e.name));
  const text=e=>e?new TextDecoder().decode(e.data):null;

  let patches=null,manifest=null;
  try{patches=JSON.parse(text(find(/(^|\/)patches\.json$/i))||'null');}catch{}
  try{manifest=JSON.parse(text(find(/(^|\/)manifest\.json$/i))||'null');}catch{}
  if(!patches||!Array.isArray(patches.patches))
   throw Error('That ZIP has no patches.json. Use a backup from "Download backup".');

  const byName=new Map();
  for(const item of manifest?.effects||[])
   byName.set(upper(g.effectStore.effectName(item.path||item.filename||'')),item);

  const effects=[];
  for(const entry of entries){
   if(!/\.zdl$/i.test(entry.name))continue;
   const filename=g.effectStore.effectName(entry.name);
   const meta=byName.get(upper(filename))||{};
   effects.push({filename,data:entry.data,bytes:entry.data.length,
                 effectId:meta.effectId||null,version:meta.version||null,
                 sha256:meta.sha256||null,usedBy:meta.usedBy||null});
  }
  return {patches:patches.patches,backup:patches,manifest,effects,
          complete:patches.complete===true};
 }

 /* What a restore would do, given the pedal's directory and the local library.

    Effects are resolved by id, because that is what a patch carries. The pedal
    reports filenames, and only the library maps an id to one, so an id the
    library does not list cannot be checked against the pedal -- see the note
    below on why that means factory rather than missing.

    `library` is effectStore.catalog(); `pkg.effects` is used first when a ZIP
    carried binaries, so old packages still restore without a library. */
 function plan(pkg,{installedNames=[],disk=null,library=[]}={}){
  const onPedal=new Set(installedNames.map(upper));
  const byId=new Map();
  for(const e of library||[])if(e.effectId)byId.set(String(e.effectId).toLowerCase(),e);
  const carried=new Map();
  for(const e of pkg.effects||[])if(e.effectId)carried.set(String(e.effectId).toLowerCase(),e);

  /* An id the library has never heard of is a FACTORY effect, not a missing
     one. The library is the add-on catalog; the factory set is not in it and
     does not need to be, because it ships on every MS-100BT. Measured against a
     real backup: 65 of the 68 effects the factory patches use are factory and 3
     are add-ons. Reporting 65 as "unavailable" would be alarming and wrong --
     they are the effects most certain to be present.

     It also cannot be checked against the pedal, because the pedal reports
     filenames and only the library maps an id to one. Assuming present is the
     right call: a restore installs nothing for them, which is correct, and if
     one really were absent the patch write is verified anyway. */
  const referenced=referencedEffects(pkg.patches);
  const present=[],missing=[],builtIn=[];
  for(const [id,slots] of referenced){
   const from=carried.get(id)||byId.get(id);
   if(!from){builtIn.push({effectId:id,usedBy:slots});continue;}
   const filename=from.filename||'';
   (onPedal.has(upper(filename))?present:missing).push({...from,effectId:id,filename,usedBy:slots});
  }

  const bytesNeeded=missing.reduce((n,e)=>n+(e.bytes||e.data?.length||0),0);
  const free=disk?disk.free:null;
  return {patches:pkg.patches.length,complete:pkg.complete,
          referenced:referenced.size,present:present.length,missing,builtIn,
          bytesNeeded,free,
          // Flash needs room for the write itself; leave a little headroom
          // rather than discovering the shortfall mid-install.
          fits:free===null?null:bytesNeeded+16384<=free};
 }

 /* Install the effects the pedal is missing, one at a time.

    Resumable on purpose. An install still fails often enough that a thirty
    effect restore will meet one, and the useful behaviour then is to report what
    landed and let the user run it again -- not to unwind or to stop dead. Each
    success is independent and already on the pedal. */
 async function installMissing(pkg,{installedNames=[],disk=null,library=[],
                                   onProgress=()=>{},stopOnError=false}={}){
  const p=plan(pkg,{installedNames,disk,library});
  if(p.fits===false)
   throw Error(`The missing effects need ${(p.bytesNeeded/1024).toFixed(0)} KB but the pedal has ${(p.free/1024).toFixed(0)} KB free.`);

  const installed=[],failed=[];
  for(const [i,effect] of p.missing.entries()){
   onProgress({phase:'installing',effect:effect.filename,done:i,total:p.missing.length});
   try{
    // A ZIP may have carried the bytes; otherwise the library holds them.
    const data=effect.data||await g.effectStore.binary(effect);
    if(!data||!data.length)throw Error('no binary available for this effect');
    await g.pedalInstaller.install({filename:effect.filename,data,
                                    effectId:effect.effectId,version:effect.version});
    installed.push(effect.filename);
   }catch(e){
    failed.push({filename:effect.filename,effectId:effect.effectId,error:e.message});
    g.log?.('restore_install_failed',{filename:effect.filename,error:e.message});
    if(stopOnError)break;
   }
  }
  onProgress({phase:'done',done:installed.length,total:p.missing.length});
  return {installed,failed,remaining:p.missing.length-installed.length};
 }

 /* Restore patches, one slot at a time, resumably.

    Each slot is selected, loaded and committed by leaving the patch -- the
    pedal's AUTO SAVE does the commit, because no store command exists. Every
    write is read back and verified, so a pedal with AUTO SAVE switched off
    fails on the first slot instead of silently doing nothing.

    Three derived bytes per patch do not survive the round trip; see
    backup.js writeSlot. */
 async function restorePatches(pkg,{onProgress=()=>{},stopOnError=false,slots=null,
                                  skipEffects=[]}={}){
  if(!g.patchBackup?.writeSlot)throw Error('Connect the pedal first');
  const wanted=(pkg?.patches||[]).filter(p=>slots===null||slots.includes(p.slot));
  if(!wanted.length)throw Error('That package carries no patches to restore.');

  /* An effect that would not install only spoils the patches that name it.
     Writing the other forty-nine is strictly better than writing none, which is
     what refusing outright used to do -- one timeout on one effect and the
     whole restore stopped before a single patch was written. */
  const skip=new Set([...skipEffects].filter(Boolean).map(x=>String(x).toLowerCase()));
  const uses=skip.size?referencedEffects(wanted):new Map();
  const blocked=new Set();
  for(const id of skip)for(const slot of uses.get(id)||[])blocked.add(slot);

  const written=[],failed=[],skipped=[];
  for(const [i,patch] of wanted.entries()){
   if(blocked.has(patch.slot)){
    skipped.push({slot:patch.slot,name:patch.name,
                  reason:'an effect it uses could not be installed'});
    continue;
   }
   const slot=(patch.slot??0)-1;
   onProgress({phase:'restoring',patch:patch.name,slot:patch.slot,done:i,total:wanted.length});
   try{
    const body=String(patch.rawHex||'').split(' ').map(x=>parseInt(x,16));
    if(body.length!==122)throw Error(`patch body is ${body.length} bytes, expected 122`);
    written.push(await g.patchBackup.writeSlot(slot,body));
   }catch(e){
    failed.push({slot:patch.slot,name:patch.name,error:e.message});
    g.log?.('restore_patch_failed',{slot:patch.slot,error:e.message});
    if(stopOnError||/AUTO SAVE/.test(e.message))break;
   }
  }
  onProgress({phase:'done',done:written.length,total:wanted.length});
  return {written,failed,skipped,remaining:wanted.length-written.length};
 }

 g.soundPackage={read,plan,installMissing,restorePatches,referencedEffects};
})(globalThis);
