/* Presentation layer; transport and device operations remain in their modules. */
(()=>{
 const $=id=>document.getElementById(id);
 const errorLine=document.createElement('p');errorLine.id='connection-error';errorLine.className='connection-error';errorLine.setAttribute('role','alert');document.querySelector('.connection-copy').append(errorLine);
 $('choose').addEventListener('click',()=>{$('choose').textContent='Connecting…';$('choose').disabled=true;});
 globalThis.onStompConnectionState=(state)=>{const badge=$('connection-badge');if(!badge)return;badge.textContent=state==='connected'?'Connected':'Disconnected';badge.classList.toggle('ready',state==='session');};
 // One list, one source of truth: the pedal scan marks entries in the catalog
 // rather than filling a second section that repeated them.  Reload rescans the
 // pedal; update() owns its disabled state so it cannot be pressed without a
 // session or during a scan.
 const reloadInventoryButton=$('reload-inventory');
 reloadInventoryButton.onclick=async()=>{if(globalThis.iapHost?.session==null||globalThis.pedalInventory?.running)return;reloadInventoryButton.disabled=true;globalThis.pedalInventory.files=[];syncPedalFiles([]);setInventoryStatus('Reading pedal effect inventory…');await globalThis.pedalInventory.run();syncPedalFiles();setInventoryStatus(`${pedalFiles.size} effects on the pedal.`);};
 const connection=$('connection-card'),aside=document.querySelector('aside');aside.insertBefore(connection,aside.querySelector('.workspace-label'));
 // Pedal storage, under the connection card. Hidden until a session reports it.
 // The pedal holds about 4 MB and effects run 10-26 KB, so knowing what is left
 // is the difference between planning an install and discovering it mid-write.
 const storage=document.createElement('section');storage.className='pedal-storage';storage.hidden=true;
 const storageLabel=document.createElement('div');storageLabel.className='storage-label';storageLabel.textContent='PEDAL STORAGE';
 const storageBar=document.createElement('div');storageBar.className='storage-bar';
 const storageFill=document.createElement('span');storageBar.append(storageFill);
 const storageFree=document.createElement('div');storageFree.className='storage-free';
 const storageDetail=document.createElement('small');storageDetail.className='storage-detail';
 storage.append(storageLabel,storageBar,storageFree,storageDetail);
 connection.after(storage);
 const sizeText=n=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.round(n/1024)} KB`;
 let diskBusy=false;
 async function refreshDisk(){
  if(globalThis.iapHost?.session==null){storage.hidden=true;return;}
  if(diskBusy)return;                       // installs can finish faster than a query
  diskBusy=true;
  try{
   const d=await globalThis.pedalInstaller.disk();
   storageFill.style.width=Math.min(100,Math.max(2,Math.round(d.used/d.total*100)))+'%';
   storageFree.textContent=`${sizeText(d.free)} free`;
   storageDetail.textContent=`${sizeText(d.total)} total · ${sizeText(d.used)} used`;
   storage.classList.toggle('low',d.free<256*1024);
   storage.hidden=false;
  }catch(e){
   if(!storage.hidden)storageDetail.textContent='Storage unavailable';
   log('disk_error',String(e));
  }finally{diskBusy=false;}
 }
 globalThis.__refreshDisk=refreshDisk;
 /* backup.js builds one panel holding its title, Read, Download and status.
    The page no longer wants them together: reading is the gate at the top,
    downloading belongs with the other transfer actions. Distribute the nodes
    rather than duplicating them, so backup.js keeps its own references. */
 const backupPanel=$('patch-backup');
 const [,readBtn,saveBtn,backupStatus]=backupPanel.children;
 $('backup-controls').append(readBtn);
 $('backup-save-slot').append(saveBtn);
 $('backup-status-slot').append(backupStatus);
 backupPanel.remove();
 backupPanel.querySelector('h2').textContent='Back up your patches';
 /* The complete ZIP is gone from the page. It bundled every effect binary a
    backup referenced, which duplicated what the pedal and the local library
    both already hold -- of the 68 effects a factory pedal's patches use, 65 are
    in the factory set and 3 are catalog add-ons, and none is missing from those
    two. The patch JSON is the whole backup now. bundle.js still builds its
    button; it is kept off-page rather than deleted so the ZIP writer stays
    available to BackupBundle and its tests. */
 const bundleButton=[...document.querySelectorAll('button')].find(b=>b.textContent==='Download patches + effects ZIP');
 const bundleStatus=bundleButton?.nextElementSibling;
 if(bundleButton){bundleButton.hidden=true;if(bundleStatus)bundleStatus.hidden=true;}
 const sessionButton=[...document.querySelectorAll('button')].find(b=>b.textContent==='Open StompShare data session');$('session-action').append(sessionButton);sessionButton.textContent='Open session';
 const closeOriginal=$('close').onclick;$('close').onclick=async()=>{if(globalThis.iapHost?.closeSession)await globalThis.iapHost.closeSession();return closeOriginal();};
 const readButton=readBtn;readButton.classList.add('primary');
 /* The label is backup.js's to set, not this module's. It carries state this
    page does not track -- "Resume sync from pedal" when a restored or
    interrupted sync is partial -- and overwriting it here put the button back
    to the idle wording while a half-finished sync was sitting in storage. */
 let effects=[],localEffects=[],artUrls=new Map(),pedalFiles=new Set(),lastRender='',lastConnection='',eventSession=false,inventoryStarted=false;
 const setInventoryStatus=text=>{$('effect-caption').textContent=text;};
 // "Installed on pedal" is the only authority on what is actually on the
 // filesystem, so Available FX marks its entries from that scan rather than
 // from the local browser store or the patch references.  Catalog and pedal
 // both use 8.3 names such as _ACOSTIC.ZDL; compare case-insensitively anyway.
 const installedOnPedal=e=>pedalFiles.has(e.filename.toUpperCase());
 function syncPedalFiles(files=globalThis.pedalInventory?.files||[]){pedalFiles=new Set(files.filter(f=>/\.ZDL$/i.test(f.filename)).map(f=>f.filename.toUpperCase()));renderEffects();}
 let libraryLoaded=false;
 function updateEffectCount(){$('effect-count').textContent=!effects.length?(libraryLoaded?'No effects imported':'Loading library…'):pedalFiles.size?`${effects.filter(installedOnPedal).length} of ${effects.length} on pedal`:`${effects.length} catalog effects`;}
 function page(name){if(!['patches','effects'].includes(name))name='effects';document.querySelectorAll('.page').forEach(p=>p.hidden=p.id!=='page-'+name);document.querySelectorAll('[data-page]').forEach(b=>{b.classList.toggle('active',b.dataset.page===name);b.setAttribute('aria-current',b.dataset.page===name?'page':'false');});$('page-label').textContent={patches:'Patches',effects:'Effects'}[name];}


 document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{location.hash=b.dataset.page;page(b.dataset.page);});addEventListener('hashchange',()=>page(location.hash.slice(1)));page(location.hash.slice(1));
 function renderPatches(){const patches=globalThis.patchBackup?.last?.patches||[],query=$('patch-search').value.toLowerCase(),filtered=patches.filter(p=>(p.name||'').toLowerCase().includes(query)||String(p.slot).includes(query));$('patch-count').textContent=patches.length;$('backup-progress').value=patches.length;$('patch-caption').textContent=patches.length?`${patches.length} saved patches captured · ${patchBackup.last.complete?'All checksums verified':'Backup in progress or partial'}`:'Read the pedal to see your saved chains.';if(!patches.length)return;
 const list=$('patch-list');list.replaceChildren();list.className='patch-grid';if(!filtered.length){const p=document.createElement('p');p.textContent='No patches match your search.';list.append(p);}
 for(const p of filtered){const item=document.createElement('article');item.className='patch-item';const number=document.createElement('span'),name=document.createElement('div'),meta=document.createElement('div');number.className='patch-number';number.textContent=String(p.slot).padStart(2,'0');name.className='patch-name';name.textContent=p.name||'Untitled patch';meta.className='patch-meta';meta.textContent=p.crcValid?'✓ Checksum verified':'Captured';item.append(number,name);if(p.rawHex&&globalThis.PatchEditor){try{const dec=PatchEditor.decode(p.rawHex.split(' ').map(x=>parseInt(x,16)));const chain=document.createElement('div');chain.className='patch-chain';const used=dec.slots.filter(s=>!s.empty);if(!used.length)chain.append(Object.assign(document.createElement('span'),{className:'patch-chain-empty',textContent:'no effects'}));for(const s of used){const c=document.createElement('span');c.className='chain-node'+(s.enabled?'':' off');const d=PatchEditor.describe(s.effectId);c.textContent=d.short||'FX';c.title=`${d.family||'Effect'} — ${s.effectId}${s.enabled?'':' (bypassed)'}`;chain.append(c);}item.append(chain);}catch(e){}}item.append(meta);/* Clicking a patch opens the editor. The codec needs rawHex, which only a verified read produces, so a card without it stays inert rather than opening an editor over nothing. */if(p.rawHex&&globalThis.openPatchEditor){item.classList.add('editable');item.tabIndex=0;item.setAttribute('role','button');item.title='Edit this patch';const open=()=>globalThis.openPatchEditor(p,{onWritten:()=>{$('patch-caption').textContent=`Patch ${p.slot} written to the pedal. Re-read to refresh the library.`;}});item.onclick=open;item.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}};}list.append(item);}}
 $('patch-search').oninput=renderPatches;
 /* Effect id -> name. Two sources, because neither covers the ground alone:
    the browser library holds what the user imported, and effect-names.json is
    an id/name index covering the pedal's built-in effects, which are not files
    anyone installs and so never appear in the library. Without the index the
    editor could name 3 of the 68 effects a factory pedal's patches use. */
 let builtinNames={};
 fetch('effect-names.json').then(r=>r.ok?r.json():null)
  .then(d=>{if(d?.names){builtinNames=d.names;renderPatches();}})
  .catch(()=>{});
 globalThis.__effectName=id=>
   effects.find(e=>e.effectId===id)?.filename.replace(/\.zdl$/i,'')
   ||builtinNames[id]||null;
 const categoryOf=e=>{const n=e.filename.toUpperCase();if(/COMP|LIMIT|GATE|DYN/.test(n))return'Dynamics';if(/DRIVE|DIST|FUZZ|OD|CRUNCH/.test(n))return'Drive & Distortion';if(/AMP|CAB|COMBO|PRE/.test(n))return'Amps & Cabinets';if(/CHOR|FLANG|PHAS|TREMO|VIB/.test(n))return'Modulation';if(/DELAY|ECHO/.test(n))return'Delay';if(/REVERB|ROOM|HALL|SPRING/.test(n))return'Reverb';if(/WAH|FILTER|EQ|AUTO/.test(n))return'Filter & Wah';if(/PITCH|OCT|HARM/.test(n))return'Pitch';return'Other'};
 // Effect IDs the saved patches reference, so a delete can say what it breaks.
 // Six slots per patch, 18 bytes each, the id in the low 28 bits of the first
 // word shifted right by one -- the decode the old installed-effects panel used.
 // A patch is counted once even if two of its slots hold the same effect.
 function patchEffectUses(){const uses=new Map();for(const p of globalThis.patchBackup?.last?.patches||[]){const b=p.rawHex.split(' ').map(x=>parseInt(x,16)),seen=new Set();for(let i=0;i<6;i++){const id=((b[i*18]|b[i*18+1]<<8|b[i*18+2]<<16|b[i*18+3]<<24)>>>1)&0xfffffff;if(id)seen.add(id.toString(16).padStart(8,'0'));}for(const id of seen)uses.set(id,(uses.get(id)||0)+1);}return uses;}
 async function waitForInventory(){for(let i=0;globalThis.pedalInventory?.running&&i<120;i++)await new Promise(r=>setTimeout(r,250));if(globalThis.pedalInventory?.running)throw Error('Pedal inventory is still busy; reload it and try again.');}
 const categorySelect=document.createElement('select');categorySelect.id='effect-category';categorySelect.setAttribute('aria-label','Filter effects by category');categorySelect.innerHTML='<option value="">All categories</option>';$('effect-search').before(categorySelect);categorySelect.onchange=renderEffects;
 $('effect-status').onchange=renderEffects;
 function renderEffects(){const uses=patchEffectUses(),query=$('effect-search').value.toLowerCase(),category=categorySelect.value,list=$('effect-list');list.className='effects-grid';list.replaceChildren();const status=$('effect-status').value;const filtered=effects.filter(e=>(!category||categoryOf(e)===category)&&(!status||(status==='installed')===installedOnPedal(e))&&(e.filename+' '+e.effectId).toLowerCase().includes(query));const groups={};for(const e of filtered)(groups[categoryOf(e)]??=[]).push(e);for(const [group,items] of Object.entries(groups)){const heading=document.createElement('h3');heading.className='effect-category-heading';heading.textContent=group;list.append(heading);for(const e of items){const card=document.createElement('article'),name=document.createElement('strong'),detail=document.createElement('small'),install=document.createElement('button'),del=document.createElement('button'),row=document.createElement('div');row.className='effect-row';del.className='danger';del.textContent='Delete';card.className='effect-item';const artUrl=e.artwork&&artUrls.get(e.artwork);if(artUrl){const image=document.createElement('img');image.className='effect-art';image.src=artUrl;image.alt='';image.loading='lazy';image.onerror=()=>image.remove();card.append(image);}const onPedal=installedOnPedal(e);if(onPedal)card.classList.add('installed');const badge=document.createElement('span');badge.className='effect-badge';badge.textContent='✓ Installed';name.textContent=e.filename.replace(/\.zdl$/i,'');detail.textContent=`v${e.version} · ${(e.bytes/1024).toFixed(1)} KB`;install.textContent=onPedal?'Reinstall':'Install to pedal';install.onclick=async()=>{if(globalThis.iapHost?.session==null){install.textContent='Open session first';setTimeout(()=>install.textContent='Install to pedal',1800);return;}install.disabled=true;try{$('effect-action-status').textContent='Preparing pedal download…';if(globalThis.pedalInventory?.running){install.textContent='Waiting for inventory…';await waitForInventory();}install.textContent='Downloading…';await globalThis.pedalInstaller.install(e);install.textContent='Installed';$('effect-action-status').textContent=`Installed ${e.filename} on the pedal.`;pedalFiles.add(e.filename.toUpperCase());renderEffects();void refreshDisk();}catch(err){install.textContent='Retry';$('effect-action-status').textContent=err.message;}finally{install.disabled=false;}};// Deleting is destructive and the pedal has no undo, so the button arms first
   // and states what it will break before the second click commits.  The effect
   // binary is in the local catalog either way, so a delete is reinstallable.
   let armed=false,armTimer=null;
   const disarm=()=>{armed=false;clearTimeout(armTimer);del.textContent='Delete';del.classList.remove('armed');};
   del.onclick=async()=>{
    if(globalThis.iapHost?.session==null){del.textContent='Open session first';armTimer=setTimeout(disarm,1800);return;}
    if(!armed){armed=true;const n=uses.get(e.effectId)||0;del.textContent=n?`Confirm — breaks ${n} patch${n===1?'':'es'}`:'Confirm delete';del.classList.add('armed');armTimer=setTimeout(disarm,5000);return;}
    disarm();del.disabled=install.disabled=true;
    try{
     if(globalThis.pedalInventory?.running){del.textContent='Waiting for inventory…';await waitForInventory();}
     del.textContent='Deleting…';$('effect-action-status').textContent=`Deleting ${e.filename} from the pedal…`;
     const res=await globalThis.pedalInstaller.remove(e.filename);
     globalThis.pedalInventory.files=res.files;
     $('effect-action-status').textContent=`Deleted ${e.filename} from the pedal.`;
     syncPedalFiles(res.files);setInventoryStatus(`${pedalFiles.size} effects on the pedal.`);void refreshDisk();
    }catch(err){del.textContent='Retry delete';$('effect-action-status').textContent=err.message;}
    finally{del.disabled=install.disabled=false;}
   };
   if(onPedal)row.append(badge);
   row.append(install);
   if(onPedal)row.append(del);
   card.append(name,detail,row);list.append(card);}}if(!list.children.length)list.textContent='No matching effects.';updateEffectCount();}
 $('effect-search').oninput=renderEffects;
 async function refreshEffectStore(){localEffects=await effectStore.all();$('effect-storage-status').textContent=localEffects.length?`${localEffects.length} effect${localEffects.length===1?'':'s'} stored in this browser.`:'No effects stored in this browser yet.';}

 // Nothing here is served: the catalog, the binaries and the artwork all come
 // out of this browser's own library, which is empty until the user imports an
 // archive. That is what lets a published copy carry no ZOOM assets.
 async function loadCatalog(reloadArtwork=false){
  try{
   // The catalog is built from user-supplied files, so an entry missing the
   // fields every render groups and filters by is dropped rather than allowed
   // to throw. An import once produced entries with no effectId at all and the
   // first render died on effectId.slice().
   const raw=await effectStore.catalog();
   effects=raw.filter(e=>e&&typeof e.effectId==='string'&&typeof e.filename==='string');
   if(effects.length!==raw.length)console.warn(`Skipped ${raw.length-effects.length} unusable catalog entries`);
   artUrls=await effectStore.artwork(reloadArtwork);
   libraryLoaded=true;
   if(!effects.length){
    categorySelect.replaceChildren(new Option('All categories',''));
    renderEffects();
    $('effect-list').textContent='Import your FX archive to fill the catalog.';
    return;
   }
   // Many effects share one family image; fall back within the family, then to
   // any image at all, so a card is never blank when artwork exists.
   const familyArt={},has=a=>a&&artUrls.has(a);
   for(const e of effects)if(has(e.artwork)&&!familyArt[e.effectId.slice(0,2)])familyArt[e.effectId.slice(0,2)]=e.artwork;
   const fallback=effects.find(e=>has(e.artwork))?.artwork||null;
   for(const e of effects)if(!has(e.artwork))e.artwork=familyArt[e.effectId.slice(0,2)]||fallback;
   const categories=[...new Set(effects.map(categoryOf))].sort();
   categorySelect.replaceChildren(new Option('All categories',''),...categories.map(c=>new Option(c,c)));
   effects.sort((a,b)=>a.filename.localeCompare(b.filename));
   await refreshEffectStore();
   renderEffects();
  }catch(err){$('effect-count').textContent='Library unavailable';$('effect-list').textContent=err.message;}
 }
 loadCatalog();
 // Re-read the library after it changes from outside this page, and report
 // render state for diagnosing a catalog that loads but does not draw.
 globalThis.__reloadCatalog=loadCatalog;

 // ---- restoring a sound package -------------------------------------------
 // The analysis is offline and costs nothing, so it runs the moment a file is
 // chosen: the user sees what would happen before anything touches the pedal.
 let loadedPackage=null,loadedLibrary=[];
 const kb=n=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.round(n/1024)} KB`;
 function showPlan(p){
  const box=$('restore-summary');box.replaceChildren();
  const row=(label,value,tone)=>{const d=document.createElement('div');d.className='restore-row'+(tone?' '+tone:'');
   const k=document.createElement('span');k.textContent=label;const v=document.createElement('strong');v.textContent=value;
   d.append(k,v);box.append(d);return d;};
  row('Patches to restore',`${p.patches}${p.complete?'':' (incomplete backup)'}`,p.complete?'':'warn');
  row('Effects they use',String(p.referenced));
  if(p.builtIn.length)row('Built into the pedal',String(p.builtIn.length));
  row('Add-ons already installed',String(p.present));
  row('Add-ons to install',`${p.missing.length}${p.missing.length?` · ${kb(p.bytesNeeded)}`:''}`);
  if(p.free!=null)row('Free on the pedal',kb(p.free),p.fits===false?'warn':'');
  box.hidden=false;
 }
 /* Restoring a subset. A backup is usually loaded to put one patch back, not
    all fifty, so the package's patches are listed and the selection drives
    everything: the plan is computed for the chosen patches alone, so effects
    are installed only if a chosen patch needs them. */
 let restoreSelection=new Set(),restoreContext={installedNames:[],disk:null};
 const selectedPackage=()=>loadedPackage&&
   {...loadedPackage,patches:loadedPackage.patches.filter(p=>restoreSelection.has(p.slot))};

 function renderRestorePicker(){
  const list=$('restore-list');if(!list)return;
  list.replaceChildren();
  for(const p of loadedPackage?.patches||[]){
   const row=document.createElement('label');row.className='restore-pick';
   const box=document.createElement('input');box.type='checkbox';
   box.checked=restoreSelection.has(p.slot);
   box.onchange=()=>{box.checked?restoreSelection.add(p.slot):restoreSelection.delete(p.slot);
                     refreshRestorePlan();};
   const num=document.createElement('span');num.className='restore-pick-no';
   num.textContent=String(p.slot).padStart(2,'0');
   const name=document.createElement('span');name.className='restore-pick-name';
   name.textContent=p.name||'Untitled';
   row.append(box,num,name);list.append(row);
  }
  $('restore-picker').hidden=!loadedPackage;
 }

 function refreshRestorePlan(){
  if(!loadedPackage)return;
  const subset=selectedPackage();
  const n=subset.patches.length;
  const p=soundPackage.plan(subset,{...restoreContext,library:loadedLibrary});
  showPlan(p);
  const ready=globalThis.iapHost?.session!=null;
  $('restore-run').disabled=!ready||!n||p.fits===false;
  $('restore-run').textContent=n===0?'Nothing selected'
   :n===loadedPackage.patches.length?'Install and restore all'
   :`Restore ${n} patch${n===1?'':'es'}`;
  $('restore-status').textContent=!n?'Choose at least one patch.'
   :!ready?`${n} patch${n===1?'':'es'} ready. Connect the pedal to restore.`
   :p.fits===false?'Not enough free space on the pedal for the missing effects.'
   :p.missing.length
     ?`Ready: install ${p.missing.length} add-on effect${p.missing.length===1?'':'s'}, then restore ${n} patch${n===1?'':'es'}.`
     :`Ready to restore ${n} patch${n===1?'':'es'}. Nothing to install.`;
 }

 if($('restore-all'))$('restore-all').onclick=()=>{
  restoreSelection=new Set((loadedPackage?.patches||[]).map(p=>p.slot));
  renderRestorePicker();refreshRestorePlan();};
 if($('restore-none'))$('restore-none').onclick=()=>{
  restoreSelection.clear();renderRestorePicker();refreshRestorePlan();};

 if($('restore-file'))$('restore-file').onchange=async()=>{
  const file=$('restore-file').files[0];if(!file)return;
  $('restore-run').disabled=true;loadedPackage=null;$('restore-picker').hidden=true;
  $('restore-status').textContent='Reading package…';
  try{
   const pkg=await soundPackage.read(await file.arrayBuffer());
   // Only ask the pedal for anything if there is a session; otherwise plan dry.
   let installedNames=[...pedalFiles],disk=null;
   if(globalThis.iapHost?.session!=null){
    if(!installedNames.length){$('restore-status').textContent='Reading the pedal…';
     const files=await pedalInventory.run();syncPedalFiles(files);installedNames=[...pedalFiles];}
    try{disk=await globalThis.pedalInstaller.disk();}catch{}
   }
   // The package no longer carries binaries; the library is what knows an
   // effect id's filename, and therefore whether the pedal already has it.
   loadedLibrary=await effectStore.catalog().catch(()=>[]);
   loadedPackage=pkg;restoreContext={installedNames,disk};
   restoreSelection=new Set(pkg.patches.map(p=>p.slot));
   renderRestorePicker();refreshRestorePlan();
  }catch(e){$('restore-status').textContent=e.message;$('restore-summary').hidden=true;
            $('restore-picker').hidden=true;}
 };
 if($('restore-run'))$('restore-run').onclick=async()=>{
  const subset=selectedPackage();
  if(!subset||!subset.patches.length)return;
  $('restore-run').disabled=true;$('restore-file').disabled=true;
  try{
   const res=await soundPackage.installMissing(subset,{
    library:loadedLibrary,
    installedNames:[...pedalFiles],
    disk:await globalThis.pedalInstaller.disk().catch(()=>null),
    onProgress:s=>{$('restore-status').textContent=s.phase==='installing'
     ? `Installing ${s.effect} — ${s.done+1} of ${s.total}…` : 'Finishing…';}});
   for(const name of res.installed)pedalFiles.add(name.toUpperCase());
   renderEffects();void refreshDisk();
   // A failure here is normal enough that it is reported, not thrown: each
   // effect that landed is on the pedal and a second run skips it.
   /* A failed effect no longer stops the patches. Only the patches naming that
      effect are held back; the rest are written, and the summary says which
      were skipped and why, so a re-run has something smaller to do. */
   if(res.failed.length){
    const p=await soundPackage.restorePatches(subset,{
     skipEffects:res.failed.map(f=>f.effectId),
     onProgress:s=>{$('restore-status').textContent=s.phase==='restoring'
      ? `Writing patch ${s.slot} of ${s.total} — ${s.patch}…` : 'Finishing…';}});
    const f=res.failed[0];
    $('restore-status').textContent=
     `Installed ${res.installed.length} of ${res.installed.length+res.failed.length} effects — `+
     `${f.filename} failed (${f.error}). Restored ${p.written.length} patches`+
     `${p.skipped.length?`, held back ${p.skipped.length} that need it`:''}. Run it again to retry.`;
   }else{
    // Patches come second on purpose: a patch whose effects are missing loads
    // wrong, so nothing is written until the effects it names are present.
    const p=await soundPackage.restorePatches(subset,{
     onProgress:s=>{$('restore-status').textContent=s.phase==='restoring'
      ? `Writing patch ${s.slot} of ${s.total} — ${s.patch}…` : 'Finishing…';}});
    $('restore-status').textContent=p.failed.length
     ? `Installed ${res.installed.length} effects, wrote ${p.written.length} patches, then stopped: ${p.failed[0].error}`
     : `Installed ${res.installed.length} effect${res.installed.length===1?'':'s'} and restored ${p.written.length} patch${p.written.length===1?'':'es'}.`;
   }
   $('restore-file').value='';
  }catch(e){$('restore-status').textContent=e.message;}
  finally{$('restore-file').disabled=false;$('restore-run').disabled=false;}
 };
 globalThis.__uiState=()=>({effects:effects.length,artUrls:artUrls.size,
  withArtKey:effects.filter(e=>e.artwork).length,
  resolvable:effects.filter(e=>e.artwork&&artUrls.has(e.artwork)).length,
  sample:effects.slice(0,3).map(e=>({f:e.filename,id:e.effectId,art:e.artwork}))});
 
 $('effects-upload').onchange=async()=>{const files=[...$('effects-upload').files];if(!files.length)return;
  const report=[];let effectsAdded=0,artAdded=0,skipped=[];
  $('effects-upload').disabled=true;
  try{
   for(const file of files){
    if(/\.zip$/i.test(file.name)){
     const r=await effectStore.importArchive(await file.arrayBuffer(),text=>{$('effect-action-status').textContent=text;});
     effectsAdded+=r.effects;artAdded+=r.artwork;skipped=skipped.concat(r.skipped);
     if(r.catalogued)report.push(`catalog of ${r.catalogued}`);
    }else if(/\.zdl$/i.test(file.name)){await effectStore.add(file,'computer upload');effectsAdded++;}
   }
   await loadCatalog(true);
   report.unshift(`${effectsAdded} effect${effectsAdded===1?'':'s'}`);
   // Say so when an archive carries no artwork, rather than leaving a catalog
   // of blank cards looking like a failure to load.
   report.push(artAdded?`${artAdded} image${artAdded===1?'':'s'}`:'no artwork in this archive');
   $('effect-action-status').textContent=`Imported ${report.join(', ')} into this browser.`+
    (skipped.length?` ${skipped.length} file${skipped.length===1?'':'s'} skipped as unreadable.`:'');
  }catch(e){$('effect-action-status').textContent=e.message;}
  finally{$('effects-upload').disabled=false;$('effects-upload').value='';}};
 if($('fx-file'))$('fx-file').onchange=async()=>{const file=$('fx-file').files[0];if(!file)return;try{const b=new Uint8Array(await file.arrayBuffer()),v=new DataView(b.buffer),ascii=(a,z)=>new TextDecoder().decode(b.slice(a,z));if(b.length<76||ascii(4,8)!=='SIZE'||ascii(20,24)!=='INFO')throw Error('This file is not a recognized ZDL effect.');const a=v.getUint32(12,true),n=v.getUint32(16,true);if(b.length!==20+a+n||ascii(20+a,24+a)!=='\x7fELF')throw Error('The ZDL file is incomplete or has an invalid structure.');$('fx-preview').textContent=`${file.name} · v${ascii(68,76).split('\0')[0]} · ${(b.length/1024).toFixed(1)} KB · ID ${v.getUint32(64,true).toString(16).padStart(8,'0')}`;}catch(e){$('fx-preview').textContent=e.message;}};
 /* The four getting-started cards are a wall on a phone -- taller than the
    catalog they introduce -- so they start closed and the heading carries a
    toggle. The choice is remembered, because someone who opened it once is
    usually still setting up; storage can be unavailable or throw outright, and
    neither may stop the page working, so every access is wrapped and a failure
    just means the default. */
 const HELP_KEY='stomp.fxHelp.open';
 const helpToggle=$('fx-help-toggle'),helpList=$('fx-help');
 if(helpToggle&&helpList){
  const paint=open=>{helpList.hidden=!open;helpToggle.setAttribute('aria-expanded',String(open));
   helpToggle.textContent=open?'Hide':'How this works';};
  let open=false;
  try{open=localStorage.getItem(HELP_KEY)==='1';}catch{}
  paint(open);
  helpToggle.onclick=()=>{open=!open;paint(open);try{localStorage.setItem(HELP_KEY,open?'1':'0');}catch{}};
 }
 function update(){const ready=globalThis.iapHost?.session!=null,connected=typeof opened!=='undefined'&&opened,verified=globalThis.iapSignature?.verified;const sigFailed=!!globalThis.iapSignature?.checked&&!verified;
  const state=ready?'Session ready':connected?(verified?'Connected':sigFailed?'Not verified':'Identifying…'):'Disconnected';$('connection-card').classList.toggle('connected',connected);if(state!==lastConnection){lastConnection=state;$('connection-badge').textContent=state;$('connection-badge').classList.toggle('ready',ready||connected);$('connection-description').textContent=ready?'Ready to read your patches and create a backup.':connected?(verified?'Open the pedal session to access your patches.':sigFailed?`${globalThis.iapSignature?.error||'Authentication failed.'} Disconnect and try again.`:'Identifying and authenticating the pedal…'):'Connect your paired pedal to read and back up patches.';}sessionButton.hidden=ready||!connected;$('close').hidden=!connected;$('choose').hidden=connected;if(bundleButton)bundleButton.disabled=!!globalThis.backupBundleBusy||!!globalThis.patchBackup?.running||!globalThis.patchBackup?.last?.complete;readButton.disabled=!!globalThis.patchBackup?.running||!ready;reloadInventoryButton.disabled=!ready||!!globalThis.pedalInventory?.running;const signature=JSON.stringify([patchBackup.last?.patches?.length,patchBackup.last?.complete,patchBackup.running]);if(signature!==lastRender){lastRender=signature;renderPatches();}}
 stompEvents.addEventListener('connected',()=>{eventSession=false;setInventoryStatus('Connected — opening the pedal session…');update();$('connection-badge').textContent='Connected';setTimeout(()=>{if(!eventSession&&!sessionButton.hidden&&!sessionButton.disabled)sessionButton.click();},700);});
 stompEvents.addEventListener('error',e=>{errorLine.textContent=e.detail?.message||'Connection failed. Check the pedal is in Pairing mode and try again.';$('choose').textContent='Connect pedal';$('choose').disabled=false;});
 stompEvents.addEventListener('connected',()=>{errorLine.textContent='';$('choose').textContent='Connected';});

 stompEvents.addEventListener('session',()=>{eventSession=true;update();$('connection-badge').textContent='Session ready';setTimeout(()=>{void refreshDisk();if(globalThis.stompAutoInventory===false){setInventoryStatus('Automatic scan is off — press Reload from pedal to see what is installed.');return;}setInventoryStatus('Reading pedal effect inventory…');pedalInventory.run().then(()=>{syncPedalFiles();setInventoryStatus(`${pedalFiles.size} effects on the pedal.`);});},1000);});
 stompEvents.addEventListener('disconnected',()=>{eventSession=false;storage.hidden=true;syncPedalFiles([]);setInventoryStatus('Connect the pedal and reload to see what is installed.');update();});
 function renderInventoryProgress(){const count=(globalThis.pedalInventory?.files||[]).filter(f=>/\.ZDL$/i.test(f.filename)).length;setInventoryStatus(`Reading pedal effect inventory… ${count}`);}
 update();setInterval(()=>{const ready=globalThis.iapHost?.session!=null;if(globalThis.pedalInventory?.running)renderInventoryProgress();if(ready&&!inventoryStarted){inventoryStarted=true;$('connection-badge').textContent='Session ready';$('connection-badge').classList.add('ready');}if(!ready)inventoryStarted=false;update();},250);
})();
