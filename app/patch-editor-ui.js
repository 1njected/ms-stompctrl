/* The patch editor panel.

   Opens on a patch from the library, shows its six slots, and writes the result
   back. The codec is patch-editor.js; the write path is backup.js writeSlot().

   Rename, bypass, reorder and clear are safe by construction: they move or flip
   bytes the pedal itself wrote. Choosing a *different* effect for a slot is the
   one edit that needs 14 parameter bytes nothing in the patch supplies, so the
   picker offers only effects whose bytes it can account for -- from a loaded
   patch, or from the effect's own `.ZDL` defaults. See the picker, and
   docs/protocol.md 5.5 and 7.3.

   Writing needs AUTO SAVE on in the pedal's system menu. No command can read
   that setting, so the panel says so up front and writeSlot() verifies by
   reading the slot back -- a pedal with AUTO SAVE off fails loudly rather than
   silently doing nothing. */
(function(g){
 if(typeof document==='undefined')return;
 const el=(t,c,txt)=>{const n=document.createElement(t);if(c)n.className=c;if(txt!=null)n.textContent=txt;return n;};
 /* A displayable effect name. Catalog filenames carry a leading underscore
    to mark bass and acoustic effects (docs/protocol.md 7.1) -- internal
    notation the family badge already says in words, so it is stripped. */
 const displayName=id=>{const n=g.__effectName?.(id);return n?n.replace(/^_+/,''):null;};
 const nameOf=id=>displayName(id)||(id==='00000000'?'—':'Unknown effect');

 let overlay=null,state=null,original=null,slot=null,onSaved=null,chainFields=null;
 /* The last result line, and the patch it was about.

    update() has to drop a stale notice -- a write confirmation must not sit
    there while the chain is edited underneath it -- and it used to do that by
    clearing on any unsaved change. That was too blunt once a notice could
    belong to a change: importing a file both makes the panel dirty and has
    something to say about it, so its message was written and wiped in the same
    call. Pinning the notice to the bytes it describes keeps both behaviours --
    a notice survives until the patch moves on from it. */
 let notice=null,noticeFor=null;
 // effectId -> a working 14-byte block, harvested from the loaded patches.
 let sources=new Map(),extraSources=new Map();

 function close(){overlay?.remove();overlay=null;state=null;}

 /* Will this pedal actually play this effect?

    Not the same question as whether the effect exists, and the difference cost
    a write. On 2026-10-04 an imported patch went to slot 45 and came back with
    slot 2 emptied: `08000100` is DRV_ECHO.ZDL, a download-catalog add-on, and
    it was not installed. The import had been checked against effect-names.json
    and passed, because that index covers the 101 firmware effects AND the
    117-effect catalog -- so it answers "is this an MS-100BT effect at all",
    which an uninstalled add-on still is.

    The pedal's answer needs two things the page holds and this panel does not:
    the .ZDL filenames read off the device, and the add-on catalog that maps an
    id to a filename. ui.js hands both over through __effectAvailability().

      builtIn      -- firmware, so on every MS-100BT. effect-names.json names
                      the 101 firmware ids outright; where it does not, the
                      fallback is restore.js plan()'s rule, that an id absent
                      from the add-on catalog is firmware
      installed    -- an add-on whose .ZDL is on the pedal
      notInstalled -- an add-on in the browser library but not on the pedal.
                      THE CASE ABOVE, and the one the panel can fix itself:
                      effectStore.catalog() is built from the stored binaries,
                      so an entry in the library is guaranteed to have its
                      bytes and the slot gets an Install button
      notImported  -- a catalog add-on that is not in the browser library
                      either, so there is nothing to install from. Only the
                      factory split can see this: the fallback rule cannot tell
                      it from a firmware effect, and would call it present
      unlisted     -- in no MS-100BT source at all; not an MS-100BT effect
      unchecked    -- the library or the pedal scan is missing, so no answer.
                      Reported rather than passed: silence would read as "fine"

    Returned per slot, with the catalog entry where there is one, so the chain
    says which slot is the problem and the row can act on it. */
 function availability(){
  const ctx=g.__effectAvailability?.();
  const chain=state.slots.filter(s=>!s.empty).map(s=>({slot:s.index+1,effectId:s.effectId}));
  const blind=why=>({chain:chain.map(c=>({...c,status:'unchecked'})),
                     problems:[],unchecked:chain,reason:why,checked:!chain.length});
  if(!ctx)return blind('The effect library is not loaded, so the effects this patch needs cannot be checked.');

  /* What each source can and cannot settle, which is why this is per slot and
     not one verdict for the patch.

     The factory list settles firmware on its own -- no library, no pedal scan
     -- so a firmware-only patch comes back clean with nothing connected. An
     add-on needs the pedal's file list to say installed or not, and the browser
     library to say whether there are bytes to install. Missing either leaves
     only the add-on slots unanswered, and an earlier version that gave up on
     the whole patch reported an uninstalled add-on as "cannot check" when it
     could in fact say exactly what was wrong. */
  const scanned=ctx.installed.length>0;
  const onPedal=new Set(ctx.installed.map(n=>String(n).toUpperCase()));
  const stocked=ctx.libraryLoaded&&ctx.library.length>0;
  const rated=chain.map(c=>{
   const entry=ctx.library.find(e=>e.effectId===c.effectId);
   let status;
   if(entry)
    status=onPedal.has(String(entry.filename||'').toUpperCase())?'installed'
          :scanned?'notInstalled':'unchecked';
   else if(ctx.factory)
    status=ctx.factory.has(c.effectId)?'builtIn'
          :ctx.listed(c.effectId)?'notImported':'unlisted';
   else if(!stocked)status='unchecked';
   else status=ctx.indexLoaded&&!ctx.listed(c.effectId)?'unlisted':'builtIn';
   return {...c,status,entry:entry||null,
           filename:entry?.filename||null,
           name:g.__effectName?.(c.effectId)?.replace(/^_+/,'')||null};
  });

  const PROBLEM=new Set(['notInstalled','notImported','unlisted']);
  const unchecked=rated.filter(c=>c.status==='unchecked');
  return {checked:!unchecked.length,verified:ctx.verified,chain:rated,
          problems:rated.filter(c=>PROBLEM.has(c.status)),unchecked,
          reason:!unchecked.length?null
           :`Slot${unchecked.length===1?'':'s'} ${unchecked.map(c=>c.slot).join(', ')} `+
            `cannot be checked until you `+
            `${!stocked?'import your FX archive':'press Reload from pedal'} on the Effects page.`};
 }

 /* Effects this pedal can play that no loaded patch uses, seeded from their own
    `.ZDL` defaults -- the other half of the picker's list.

    WHICH EFFECTS. Only ones the pedal will resolve, because an id it cannot
    resolve is not refused: it commits the patch and zeroes that slot, silently
    (docs/protocol.md 5.5). So: firmware ids, which are on every MS-100BT, plus
    add-ons in the browser library, which the slot's own Install button can put
    on the pedal. A catalog add-on that is not imported is left out -- there
    would be nothing to install from, and availability() already explains that
    case for a slot that holds one.

    An effect a loaded patch already uses is left out too. Those bytes came off
    the pedal, which beats a default, and sources is checked first everywhere.

    WHY IT CAN BE EMPTY. effect-params.json is generated from the `.ZDL` files
    (tools/build-effect-params.py) and fetched lazily, so a checkout without it
    simply gets the old list back rather than an error. */
 function defaultSources(){
  const out=new Map();
  const ctx=g.__effectAvailability?.();
  if(!ctx||!g.PatchParams?.defaultsFor)return out;
  const playable=new Set();
  for(const e of ctx.library||[])if(e.effectId)playable.add(String(e.effectId).toLowerCase());
  for(const id of ctx.factory||[])playable.add(String(id).toLowerCase());
  for(const id of playable){
   if(sources.has(id)||id==='00000000')continue;
   const seed=g.PatchParams.defaultsFor(id);
   if(!seed)continue;
   out.set(id,{effectId:id,params:seed.params,flags:seed.flags,fromDefaults:true});
  }
  return out;
 }

 /* One sentence about the effects a write would drop, or null when there is
    nothing to say. Used by the import message and shown standing in the footer,
    because the pedal empties those slots silently -- the only other way to find
    out is the failed write. */
 function shortfall(){
  const a=availability();
  if(!a.problems.length)return null;
  const label=c=>`${c.name||(c.filename||'').replace(/\.zdl$/i,'').replace(/^_+/,'')
                    ||'that effect'} (slot ${c.slot})`;
  const pick=s=>a.problems.filter(c=>c.status===s);
  const absent=pick('notInstalled'),unimported=pick('notImported'),alien=pick('unlisted');
  const out=[];
  // Installable from here, so the sentence ends at the button rather than at a page.
  if(absent.length){
   const one=absent.length===1;
   out.push(`${absent.map(label).join(' and ')} ${one?'is':'are'} not on the pedal, so the write `+
            `will empty ${one?'that slot':'those slots'}. `+
            `Press Install on ${one?'that slot':'those slots'}.`);
  }
  // In ZOOM's catalog, but not in this browser, so there are no bytes to send.
  if(unimported.length){
   const one=unimported.length===1;
   out.push(`${unimported.map(label).join(' and ')} ${one?'is':'are'} not in your effect `+
            `library, so ${one?'it':'they'} cannot be installed from here. `+
            `Import your FX archive on the Effects page.`);
  }
  if(alien.length){
   const one=alien.length===1;
   out.push(`Slot${one?'':'s'} ${alien.map(c=>c.slot).join(' and ')} `+
            `${one?'holds an effect':'hold effects'} no MS-100BT has, so the write `+
            `will empty ${one?'it':'them'}.`);
  }
  return out.join(' ');
 }

 const signature=()=>{try{return JSON.stringify(g.PatchEditor.encode(state));}catch{return null;}};
 const setNotice=t=>{notice=t;noticeFor=signature();};
 const clearNotice=()=>{notice=null;noticeFor=null;};

 function dirty(){
  if(!state||!original)return false;
  try{return JSON.stringify(g.PatchEditor.encode(state))!==JSON.stringify(g.PatchEditor.encode(original));}
  catch{return true;}
 }

 /* The bytes a write would send.

    Any edit that changes how many effects are in the chain has to update the
    field that tells the pedal how many slots to show, or it keeps displaying
    the old count and ignores everything past it. Only stamped when the length
    actually changed, so an edit that leaves it alone writes exactly the bytes
    it used to.

    Download goes through here too, and has to: a file saved from the unstamped
    state carries the old count, and on the way back in it becomes the baseline,
    so the write that follows sees no length change and never stamps it. The
    patch would then land one effect short with nothing having gone wrong
    anywhere. Both paths taking the same bytes is also what makes a download,
    upload and write round trip produce the patch on screen. */
 function bodyToWrite(){
  const was=original.slots.filter(s=>!s.empty).length;
  const now=state.slots.filter(s=>!s.empty).length;
  return g.PatchEditor.encode(was===now?state:g.PatchEditor.stampChain(state,chainFields));
 }

 function render(){
  const body=overlay.querySelector('.pe-body');body.replaceChildren();
  // One lookup for the whole chain rather than one per row.
  const avail=new Map(availability().chain.map(c=>[c.slot,c]));
  // Same reason: built once here, read by all six slot pickers.
  extraSources=defaultSources();

  const nameRow=el('div','pe-name-row');
  const label=el('label',null,'Name');label.htmlFor='pe-name';
  const input=el('input');input.id='pe-name';input.type='text';input.maxLength=g.PatchEditor.NAME_LEN;
  input.value=state.name;
  input.oninput=()=>{state=g.PatchEditor.rename(state,input.value);update();};
  const counter=el('small','pe-counter',`${input.value.length}/${g.PatchEditor.NAME_LEN}`);
  input.addEventListener('input',()=>{counter.textContent=`${input.value.length}/${g.PatchEditor.NAME_LEN}`;});
  nameRow.append(label,input,counter);
  body.append(nameRow);

  const chain=el('div','pe-chain');
  chain.append(el('span','pe-chain-end','INPUT'));
  chain.append(el('span','pe-chain-line'));
  chain.append(el('span','pe-chain-end','OUTPUT'));
  body.append(chain);

  const list=el('ol','pe-slots');
  state.slots.forEach((s,i)=>{
   const li=el('li','pe-slot');
   if(s.empty)li.classList.add('empty');
   if(!s.empty&&!s.enabled)li.classList.add('bypassed');

   /* What a slot shows. The catalog can name only 3 of the 68 effects a factory
      pedal's patches use, so a row led by the effect name is a row led by eight
      hex digits. The family, which comes from the id itself, is always
      available and is what actually tells you the shape of the chain:
      "Dynamics, Drive, Delay, Reverb" reads as a signal path where
      "01000008, 03000020, 08000040, 09000020" does not. */
   const d=g.PatchEditor.describe(s.effectId);
   const known=s.empty?null:displayName(s.effectId);
   const pos=el('span','pe-pos',String(i+1));
   const info=el('div','pe-info');
   /* Two lines: the effect's name, then what kind of thing it is. Scanning a
      chain is looking down the column of names, and a badge sitting in front
      of each one pushed the names out of alignment with each other. */
   const title=el('div','pe-title');
   /* No ids anywhere in this panel. effect-names.json names every effect a
      patch can hold, so the id has no job left on screen: it is an internal
      identifier, and printing it beside a name that already says what the
      effect is only adds noise. An effect with no name and no family would
      read as "Unknown effect" rather than eight hex digits. */
   title.append(el('strong',null,s.empty?'Empty':(known||d.family||'Unknown effect')));
   info.append(title);

   // Second line, and only when it has something to say.
   const tags=el('div','pe-tags');
   // The badge earns its place only when the title is not already the family:
   // with no catalog name, the family *is* the identity and saying it twice
   // just makes the row noisier.
   if(!s.empty&&(known||d.bass)){
    const fam=el('span','pe-family',d.family||'Effect');
    if(d.bass)fam.classList.add('bass');
    fam.title=d.bass?'A bass or acoustic effect':'What kind of effect this is';
    tags.append(fam);
   }
   if(!s.empty&&!s.enabled)tags.append(el('span','pe-byp','BYPASSED'));
   /* An effect the pedal cannot resolve is dropped on write, and nothing else
      on screen would say so until the write came back with the slot empty. */
   const have=avail.get(i+1);
   const FLAG={notInstalled:['NOT INSTALLED',
     'Not on the pedal. Install it here, or the pedal will empty this slot.'],
    notImported:['NOT IN YOUR LIBRARY',
     'A ZOOM catalog effect this browser does not hold. Import your FX archive on the Effects page.'],
    unlisted:['NOT AN MS-100BT EFFECT',
     'No MS-100BT effect has this id, so the pedal will empty this slot.']};
   if(have&&FLAG[have.status]){
    const [text,why]=FLAG[have.status];
    const flag=el('span','pe-missing',text);
    flag.title=why;
    tags.append(flag);
   }
   if(tags.childElementCount)info.append(tags);

   const actions=el('div','pe-actions');

   /* Swapping the effect. One list of effects, which is all it should ever have
      been: everything this pedal can play, by name, grouped by family.

      It used to be the 68 effects some loaded patch happened to use, because
      the 14 parameter bytes belong to whichever effect held the slot and
      nothing here could invent them -- which is how an add-on could be missing
      from its own pedal's editor. There are two places to get those bytes now:
      a loaded patch, where the pedal wrote them itself, or the effect's own
      `.ZDL` defaults, which patch-params.js packs. A patch wins where there is
      one. That choice is this code's business and says nothing about the
      effect, so it does not reach the list -- an earlier version split the
      groups by it and only raised the question of what the split meant.

      What the list leaves out is effects the pedal could not resolve: it
      commits the patch and empties that slot, silently (docs/protocol.md 5.5).
      So firmware effects, which are on every MS-100BT, and add-ons in the
      browser library, which the slot's own Install button can put on the pedal
      -- the same effects the Effects page shows, plus the built-ins, which are
      not files and so appear on no page. */
   if(sources.size||extraSources.size){
    const pick=el('select','pe-pick');
    pick.title='Replace the effect in this slot';
    const keep=el('option',null,s.empty?'— choose an effect —'
      :(displayName(s.effectId)||d.family||'Effect'));
    keep.value='';pick.append(keep);
    /* Effects only. An option is the effect's name and nothing else -- no id,
       no patch reference. That is possible because effect-names.json supplies
       names for the pedal's built-in effects, which are not files anyone
       installs and so never appear in the browser library; without it only 3 of
       68 could be named and the list fell back to hex or to "from <patch>",
       which read as part of the effect's name.

       The family stays as the group heading: it is how the list is organised,
       not something an option has to spell out. */
    // Defaults first, so a patch-sourced block replaces it for the same id:
    // bytes the pedal wrote beat bytes we assembled.
    const offered=new Map([...extraSources,...sources]);
    const groups=new Map();
    for(const src of offered.values()){
     if(src.effectId===s.effectId)continue;
     const fam=g.PatchEditor.describe(src.effectId).family||'Other';
     if(!groups.has(fam))groups.set(fam,[]);
     groups.get(fam).push(src);
    }
    for(const fam of [...groups.keys()].sort()){
     const group=document.createElement('optgroup');group.label=fam;
     const taken=new Set();
     for(const src of groups.get(fam).sort((a,b)=>
        (displayName(a.effectId)||'').localeCompare(displayName(b.effectId)||''))){
      let label=displayName(src.effectId)||g.PatchEditor.describe(src.effectId).family||'Unknown effect';
      while(taken.has(label))label+=' ·';
      taken.add(label);
      const o=el('option',null,label);o.value=src.effectId;
      o.title=label;
      group.append(o);
     }
     pick.append(group);
    }
    pick.onchange=()=>{
     const src=offered.get(pick.value);
     if(!src)return;
     state=g.PatchEditor.setEffect(state,i,src.effectId,src.params,src.flags);
     render();update();
    };
    actions.append(pick);
   }

   if(!s.empty){
    const power=el('button','pe-toggle',s.enabled?'On':'Off');
    power.setAttribute('aria-pressed',String(s.enabled));
    power.title=s.enabled?'Bypass this effect':'Switch this effect on';
    power.onclick=()=>{state=g.PatchEditor.toggle(state,i);render();update();};
    actions.append(power);
   }
   /* Installing the effect this slot needs, from the slot that needs it.

      Only offered for `notInstalled`, where the browser library holds the
      effect: effectStore.catalog() is built from the stored binaries, so a
      library entry is a guarantee that there are bytes to send. `notImported`
      and `unlisted` get no button because there would be nothing for it to do
      -- the badge and the footer say which of the two it is and what would
      help. pedalInstaller.install() takes the pedal lock itself, so this
      cannot overlap a write. */
   if(have?.status==='notInstalled'&&have.entry&&g.pedalInstaller){
    const shown=have.name||have.filename.replace(/\.zdl$/i,'');
    const add=el('button','pe-install','Install');
    add.title=`Install ${shown} on the pedal`;
    add.onclick=async()=>{
     if(g.iapHost?.session==null){
      setNotice('Connect the pedal before installing an effect.');return update();
     }
     const row=[...overlay.querySelectorAll('.pe-install')];
     row.forEach(b=>{b.disabled=true;});
     add.textContent='Installing…';
     try{
      setNotice(`Installing ${shown} on the pedal…`);update();
      await g.pedalInstaller.install(have.entry);
      /* ui.js owns the installed-file list and the Effects page reads it, so
         tell it rather than keeping a second copy here. availability() reads
         it back on the next render, which is what clears this badge. */
      g.__effectInstalled?.(have.entry.filename);
      setNotice(`Installed ${shown}. Slot ${i+1} will take now.`);
      render();
     }catch(e){
      setNotice(`Could not install ${shown}: ${e.message}`);
      add.textContent='Retry';
     }finally{
      row.forEach(b=>{b.disabled=false;});
      update();
     }
    };
    actions.append(add);
   }
   const up=el('button','pe-move','↑');up.title='Move earlier in the chain';up.disabled=i===0;
   up.onclick=()=>{state=g.PatchEditor.move(state,i,i-1);render();update();};
   const down=el('button','pe-move','↓');down.title='Move later in the chain';down.disabled=i===state.slots.length-1;
   down.onclick=()=>{state=g.PatchEditor.move(state,i,i+1);render();update();};
   actions.append(up,down);
   if(!s.empty){
    const clear=el('button','pe-clear','Clear');clear.title='Empty this slot';
    clear.onclick=()=>{state=g.PatchEditor.clear(state,i);render();update();};
    actions.append(clear);
   }
   li.append(pos,info,actions);
   list.append(li);
  });
  body.append(list);
 }

 function update(){
  const save=overlay.querySelector('.pe-save'),status=overlay.querySelector('.pe-status');
  const changed=dirty();
  save.disabled=!changed||g.iapHost?.session==null;
  // Superseded the moment the patch it described is no longer the patch on screen.
  if(notice&&noticeFor!==signature())clearNotice();
  if(notice)status.textContent=notice;
  else if(g.iapHost?.session==null)status.textContent='Connect the pedal to write changes.';
  else if(!changed)status.textContent='No changes yet.';
  /* A shortfall outranks the AUTO SAVE reminder. AUTO SAVE is a prerequisite
     that is usually already met; a missing effect means this write is going to
     come back with a slot emptied, and it has something to do about it. */
  else status.textContent=[shortfall(),availability().reason].filter(Boolean).join(' ')
   ||'Writing needs AUTO SAVE switched on in the pedal’s system menu.';
 }

 function open(patch,{slotIndex,onWritten}={}){
  if(!g.PatchEditor)throw Error('patch-editor.js is not loaded');
  // close() clears state, so any previous panel goes before the new one is
  // decoded -- the other order left render() dereferencing a null state.
  close();
  clearNotice();
  sources=g.PatchEditor.paramSources(g.patchBackup?.last?.patches||[]);
  /* The defaults index is fetched once, and the panel may well open before it
     arrives. Re-render when it does rather than making open() wait: the list is
     usable without it, and a panel that has since been closed is skipped. */
  g.PatchParams?.load?.().then(t=>{if(t&&overlay&&state)render();}).catch(()=>{});
  /* Bytes 108-110 track the chain length; a random chain takes them from a real
     patch with the same number of effects rather than keeping the ones that
     belonged to the patch being replaced. */
  chainFields=g.PatchEditor.chainFields(g.patchBackup?.last?.patches||[]);
  const body=String(patch.rawHex||'').split(' ').map(x=>parseInt(x,16));
  original=g.PatchEditor.decode(body);
  state=g.PatchEditor.decode(body);
  slot=(slotIndex??((patch.slot??1)-1));
  onSaved=onWritten;

  overlay=el('div','pe-overlay');
  const panel=el('section','pe-panel');
  panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
  panel.setAttribute('aria-label',`Edit patch ${slot+1}`);

  const head=el('header','pe-head');
  head.append(el('span','pe-slotno',String(slot+1).padStart(2,'0')));
  head.append(el('h2',null,'Edit patch'));
  const shut=el('button','pe-close','×');shut.title='Close';shut.onclick=close;
  head.append(shut);

  /* Patch files. Separated from the footer on purpose: everything down there
     acts on the pedal and needs a session, and these two are local and work
     with the pedal unplugged. A file loaded here lands in the editor rather
     than going straight to the pedal, so the chain and any warning about it are
     on screen before Write to pedal is pressed -- and that keeps one verified
     write path instead of adding a second. */
  const io=el('div','pe-io');
  io.append(el('span','pe-io-label','Patch file'));
  const download=el('button','pe-io-btn','Download');
  download.type='button';
  download.title=`Save this patch as a ${g.PatchFile?.EXT||'.100bt'} file`;
  const upload=el('button','pe-io-btn','Import…');
  upload.type='button';
  upload.title='Replace this chain with one from a patch file';
  const picker=document.createElement('input');
  picker.type='file';picker.hidden=true;
  picker.accept='.100bt,.70cdr,.50g,.60b,.syx,.json,.txt';
  io.append(download,upload,picker);

  download.onclick=()=>{
   try{
    const name=g.PatchFile.filename(state.name,slot);
    void g.stompSave(name,g.PatchFile.write(bodyToWrite()),'text/plain');
    setNotice(`Saved ${name}.`);
   }catch(e){setNotice(`Could not save: ${e.message}`);}
   update();
  };
  upload.onclick=()=>picker.click();
  picker.onchange=async()=>{
   const file=picker.files[0];
   // Cleared immediately so re-picking the same file after a failure still fires.
   picker.value='';
   if(!file)return;
   try{
    const got=g.PatchFile.read(new Uint8Array(await file.arrayBuffer()));
    const info=g.PatchFile.inspect(got.body);
    /* `original` stays the slot's own patch. The file is an edit to this slot,
       which is what makes Write enable, Revert go back to what the pedal holds,
       and a close-without-saving warn. */
    state=g.PatchEditor.decode(got.body);

    /* Two separate facts, and only one of them is an obstacle.

       The model byte is information. Every MS model shares this 122-byte
       layout, so a sibling's patch decodes cleanly, and whether it plays here
       turns on its effects rather than on the byte -- which the write rewrites
       to ours anyway. Saying "wrong model" and stopping there would refuse a
       patch that works.

       Which effects the pedal actually has is the obstacle, it is per-slot, and
       it is what a write cannot recover from: the pedal empties the slots it
       cannot resolve and takes the rest. render() goes first so availability()
       reads the imported chain and the rows carry their badges. */
    render();
    const foreign=got.model!=null&&got.model!==g.PatchFile.MODEL
     ?` It is from a different model (${g.PatchFile.modelLabel(got.model)}), which the write rewrites to this one.`:'';
    const a=availability(),short=shortfall();
    const said=[short,a.reason].filter(Boolean).join(' ');
    const verdict=said?` ${said}`
     :g.iapHost?.session==null?' Connect the pedal to write it.'
     :` All ${info.effects} of its effects are on the pedal — press Write to pedal to install it.`;
    setNotice(`Loaded “${info.name||'untitled'}” from ${file.name}.${foreign}${verdict}`);
   }catch(e){setNotice(`Could not load ${file.name}: ${e.message}`);}
   update();
  };

  const foot=el('footer','pe-foot');
  const status=el('p','pe-status action-status');status.setAttribute('aria-live','polite');
  /* Draws from the effects the loaded patches use, so it needs them read
     first; the picker beside each slot is fed from the same place. */
  const random=el('button',null,'Randomize patch');
  const fullBox=document.createElement('input');
  fullBox.type='checkbox';fullBox.id='pe-full';
  const fullLabel=el('label','pe-full');
  fullLabel.htmlFor='pe-full';
  fullLabel.append(fullBox,document.createTextNode('Full random'));
  const help=el('button','pe-help','What’s this?');
  help.type='button';
  help.setAttribute('aria-controls','pe-full-help');
  help.setAttribute('aria-expanded','false');
  const helpText=el('p','pe-help-text');
  helpText.id='pe-full-help';helpText.hidden=true;
  helpText.textContent=
   'Off: two to four effects, arranged in signal order — dynamics, filter, drive, amp, '+
   'modulation, delay, reverb. On: anything from one to six slots, in any order. '+
   'Either way every effect comes back switched on, and they are drawn from patches already '+
   'read off this pedal keeping the settings they had there, because those are the only '+
   'values known to be good; only the arrangement varies. '+
   'Nothing reaches the pedal until you press Write to pedal.';
  help.onclick=()=>{
   helpText.hidden=!helpText.hidden;
   help.setAttribute('aria-expanded',String(!helpText.hidden));
   help.textContent=helpText.hidden?'What’s this?':'Hide';
  };
  random.onclick=()=>{
   try{
    state=g.PatchEditor.randomChain(state,sources,Math.random,{full:fullBox.checked,fields:chainFields});
    clearNotice();
   }catch(e){setNotice(e.message);}
   render();update();
  };
  const revert=el('button',null,'Revert');
  revert.onclick=()=>{state=g.PatchEditor.decode(body);render();update();};
  const save=el('button','pe-save primary','Write to pedal');
  save.onclick=async()=>{
   save.disabled=true;const restingLabel=save.textContent;
   try{
    clearNotice();status.textContent='Selecting patch and writing…';
    const toWrite=bodyToWrite();
    const res=await g.patchBackup.writeSlot(slot,toWrite);
    const drift=res.drift?` (${res.drift} byte${res.drift===1?'':'s'} the pedal recomputed)`:'';
    /* Both sides move to the written bytes. `original` alone was not enough:
       where the write stamped the chain-length field, `state` still held the
       unstamped tail, so a successful write left the panel reporting unsaved
       changes and wiped its own confirmation. */
    state=g.PatchEditor.decode(toWrite);
    original=g.PatchEditor.decode(toWrite);
    setNotice(`Patch ${res.slot} written and verified as “${res.name}”${drift}.`);
    save.textContent='Written';setTimeout(()=>{save.textContent=restingLabel;},1600);
    onSaved?.(res);
   }catch(e){
    setNotice(e.message);save.textContent='Retry';
   }finally{update();}
  };
  foot.append(status,fullLabel,help,random,revert,save);

  panel.tabIndex=-1;
  // No patch-file.js, no file bar: two dead buttons are worse than none.
  panel.append(head,...(g.PatchFile?[io]:[]),el('div','pe-body'),helpText,foot);
  overlay.append(panel);
  overlay.onclick=e=>{if(e.target===overlay&&!dirty())close();};
  document.addEventListener('keydown',function esc(e){
   if(e.key==='Escape'&&overlay){if(!dirty())close();document.removeEventListener('keydown',esc);}});
  document.body.append(overlay);
  render();update();
  /* Focusing the name raises the keyboard the moment the editor opens on a
     phone, covering the chain it was opened to edit. Do it only where focus
     costs nothing -- a pointer device -- and otherwise put focus on the panel,
     so Escape and screen readers still land inside the dialog. */
  if(matchMedia('(pointer:fine)').matches)overlay.querySelector('#pe-name')?.focus();
  else panel.focus();
 }

 g.openPatchEditor=open;
 g.closePatchEditor=close;
})(globalThis);
