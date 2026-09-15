/* The patch editor panel.

   Opens on a patch from the library, shows its six slots, and writes the result
   back. The codec is patch-editor.js; the write path is backup.js writeSlot().

   Only the edits that are safe by construction are exposed: rename, bypass,
   reorder and clear all move or flip bytes the pedal itself wrote. Choosing a
   *different* effect for a slot is deliberately absent -- the 14 parameter bytes
   belong to whichever effect the slot held, and nothing here knows what a new
   one expects. docs/protocol.md 5.5 and 7.3.

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

 let overlay=null,state=null,original=null,slot=null,onSaved=null;
 // Survives update(): a successful write leaves the panel clean, so without
 // this the confirmation is immediately overwritten by 'No changes yet.'
 let notice=null;
 // effectId -> a working 14-byte block, harvested from the loaded patches.
 let sources=new Map();

 function close(){overlay?.remove();overlay=null;state=null;}

 function dirty(){
  if(!state||!original)return false;
  try{return JSON.stringify(g.PatchEditor.encode(state))!==JSON.stringify(g.PatchEditor.encode(original));}
  catch{return true;}
 }

 function render(){
  const body=overlay.querySelector('.pe-body');body.replaceChildren();

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
   if(tags.childElementCount)info.append(tags);

   const actions=el('div','pe-actions');

   /* Swapping the effect. The 14 parameter bytes are the obstacle -- they mean
      whatever the new effect's code says, and this module cannot invent them --
      so the only effects offered are ones the loaded patches already use, whose
      blocks the pedal itself wrote. That is 68 effects on a factory pedal. */
   if(sources.size){
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
    const groups=new Map();
    for(const src of sources.values()){
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
     const src=sources.get(pick.value);
     if(!src)return;
     state=g.PatchEditor.setEffect(state,i,src.effectId,src.params);
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
  if(changed)notice=null;                       // a fresh edit supersedes the last result
  if(notice)status.textContent=notice;
  else if(g.iapHost?.session==null)status.textContent='Open the pedal session to write changes.';
  else if(!changed)status.textContent='No changes yet.';
  else status.textContent='Writing needs AUTO SAVE switched on in the pedal’s system menu.';
 }

 function open(patch,{slotIndex,onWritten}={}){
  if(!g.PatchEditor)throw Error('patch-editor.js is not loaded');
  // close() clears state, so any previous panel goes before the new one is
  // decoded -- the other order left render() dereferencing a null state.
  close();
  notice=null;
  sources=g.PatchEditor.paramSources(g.patchBackup?.last?.patches||[]);
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

  const foot=el('footer','pe-foot');
  const status=el('p','pe-status action-status');status.setAttribute('aria-live','polite');
  const revert=el('button',null,'Revert');
  revert.onclick=()=>{state=g.PatchEditor.decode(body);render();update();};
  const save=el('button','pe-save primary','Write to pedal');
  save.onclick=async()=>{
   save.disabled=true;const before=save.textContent;
   try{
    notice=null;status.textContent='Selecting patch and writing…';
    const res=await g.patchBackup.writeSlot(slot,g.PatchEditor.encode(state));
    const drift=res.drift?` (${res.drift} byte${res.drift===1?'':'s'} the pedal recomputed)`:'';
    notice=`Patch ${res.slot} written and verified as “${res.name}”${drift}.`;
    original=g.PatchEditor.decode(g.PatchEditor.encode(state));
    save.textContent='Written';setTimeout(()=>{save.textContent=before;},1600);
    onSaved?.(res);
   }catch(e){
    notice=e.message;save.textContent='Retry';
   }finally{update();}
  };
  foot.append(status,revert,save);

  panel.append(head,el('div','pe-body'),foot);
  overlay.append(panel);
  overlay.onclick=e=>{if(e.target===overlay&&!dirty())close();};
  document.addEventListener('keydown',function esc(e){
   if(e.key==='Escape'&&overlay){if(!dirty())close();document.removeEventListener('keydown',esc);}});
  document.body.append(overlay);
  render();update();
  overlay.querySelector('#pe-name')?.focus();
 }

 g.openPatchEditor=open;
 g.closePatchEditor=close;
})(globalThis);
