/* Browser-local effect library.

   Effect binaries and artwork are ZOOM's, so this app does not serve them: the
   user imports one archive and everything lands in IndexedDB for that browser.
   A published copy of this page therefore ships no ZOOM assets at all, and the
   catalog is empty until someone imports their own.

   IndexedDB holds the binaries, the artwork and the catalog index; localStorage
   holds a small summary so the UI can report what is stored without opening the
   database. */
(function(g){
 // The database and localStorage keys keep their original names on purpose:
 // renaming them would orphan every library already stored in someone's browser.
 const DB='stompshare-effects', STORE='effects', ART='artwork', META='meta', SUMMARY='stompshare-effect-meta';
 function open(){return new Promise((resolve,reject)=>{
  // v1 had only the effects store. Existing binaries survive the upgrade; the
  // new stores are created beside them.
  const r=indexedDB.open(DB,2);
  r.onupgradeneeded=()=>{const db=r.result;
   if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'key'});
   if(!db.objectStoreNames.contains(ART))db.createObjectStore(ART,{keyPath:'id'});
   if(!db.objectStoreNames.contains(META))db.createObjectStore(META,{keyPath:'key'});};
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
 const read=(store,method,...args)=>open().then(db=>new Promise((resolve,reject)=>{
  const r=db.transaction(store).objectStore(store)[method](...args);
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}));
 const write=(store,records)=>open().then(db=>new Promise((resolve,reject)=>{
  const tx=db.transaction(store,'readwrite'),os=tx.objectStore(store);
  for(const record of records)os.put(record);
  tx.oncomplete=()=>resolve(records.length);tx.onerror=()=>reject(tx.error);}));

 const all=()=>read(STORE,'getAll');
 const allArtwork=()=>read(ART,'getAll');
 const put=record=>write(STORE,[record]);
 const key=(id,version)=>`${id}:${version}`;
 function remember(records){localStorage.setItem(SUMMARY,JSON.stringify({updatedAt:new Date().toISOString(),count:records.length,bytes:records.reduce((n,x)=>n+x.data.byteLength,0)}));}

 /* A ZDL carries its own identity: effect ID at 0x40, version string at 0x44. */
 function describe(data,filename){
  const v=new DataView(data.buffer,data.byteOffset,data.byteLength),text=(a,z)=>new TextDecoder().decode(data.slice(a,z));
  if(data.length<76||text(4,8)!=='SIZE'||text(20,24)!=='INFO')throw Error(`${filename||'File'} is not a recognized ZDL effect.`);
  return {id:v.getUint32(64,true).toString(16).padStart(8,'0'),version:text(68,76).split('\0')[0]};
 }
 async function add(file,source='local upload',filename){
  const data=file instanceof Uint8Array?file:new Uint8Array(await file.arrayBuffer());
  const name=filename||file.name||'effect.ZDL',{id,version}=describe(data,name);
  await put({key:key(id,version),id,version,filename:name,bytes:data.byteLength,data,source,storedAt:new Date().toISOString()});
  remember(await all());return {id,version,filename:name};
 }

 /* One ZIP reader for the whole app; extractZdls and importArchive both use it.
    Central directory only, so entry order and local-header padding do not
    matter. Stored (0) and deflated (8) entries are both handled. */
 async function zipEntries(zip,wanted=()=>true){
  const b=new Uint8Array(zip),v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  let e=-1;
  for(let i=b.length-22;i>=0&&i>b.length-65558;i--)if(v.getUint32(i,true)===0x06054b50){e=i;break;}
  if(e<0)throw Error('That file is not a ZIP archive.');
  const count=v.getUint16(e+10,true),base=v.getUint32(e+16,true),out=[];
  for(let i=0,o=base;i<count;i++){
   if(v.getUint32(o,true)!==0x02014b50)break;
   const method=v.getUint16(o+10,true),packed=v.getUint32(o+20,true),
         nameLen=v.getUint16(o+28,true),extraLen=v.getUint16(o+30,true),
         commentLen=v.getUint16(o+32,true),local=v.getUint32(o+42,true),
         name=new TextDecoder().decode(b.slice(o+46,o+46+nameLen));
   o+=46+nameLen+extraLen+commentLen;
   if(name.endsWith('/')||!wanted(name))continue;
   const ln=v.getUint16(local+26,true),le=v.getUint16(local+28,true),
         raw=b.slice(local+30+ln+le,local+30+ln+le+packed);
   if(method===0)out.push({name,data:raw});
   else if(method===8){const stream=new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    out.push({name,data:new Uint8Array(await new Response(stream).arrayBuffer())});}
  }
  return out;
 }
 const basename=n=>n.split('/').pop();
 /* Generated archives disambiguate entries by prefixing hex: exportZip writes
    effects/<effectId>-<name>, and build-bundle-assets.py writes
    <effectId>-<sha256[:16]>-<name>. Neither prefix is part of the filename the
    pedal knows, and adopting one breaks the name match that drives the
    Installed badge and the install itself. A real ZDL name is at most twelve
    characters, so no legitimate name begins with an 8- or 16-digit hex run
    followed by a hyphen; strip as many as are there. */
 const effectName=n=>basename(n).replace(/^(?:[0-9a-fA-F]{8}-|[0-9a-fA-F]{16}-)+/,'');
 async function extractZdls(zip){
  const out=(await zipEntries(zip,n=>/\.zdl$/i.test(n))).map(x=>({name:basename(x.name),data:x.data}));
  if(!out.length)throw Error('No ZDL effects found in ZIP.');
  return out;
 }
 /* Kept for the single-effect Zoom package; extractZdls covers the rest. */
 async function extractZdl(zip){const [first]=await extractZdls(zip);return first.data;}

 /* Import one archive: effect binaries, artwork and a catalog index, all into
    IndexedDB. Accepts anything laid out like the generated bundle -- .ZDL
    anywhere, images anywhere, and an index.json or manifest.json at any depth. */
 async function importArchive(zip,onProgress=()=>{}){
  onProgress('Reading archive…');
  const entries=await zipEntries(zip);
  const zdls=entries.filter(x=>/\.zdl$/i.test(x.name));
  const images=entries.filter(x=>/\.(png|jpe?g|webp)$/i.test(x.name));
  const indexEntry=entries.find(x=>/(^|\/)index\.json$/i.test(x.name))
                 ||entries.find(x=>/(^|\/)manifest\.json$/i.test(x.name));
  if(!zdls.length&&!images.length)throw Error('That archive contains no effects or artwork.');

  const effects=[],skipped=[];
  for(const [i,item] of zdls.entries()){
   const name=effectName(item.name);
   try{const {id,version}=describe(item.data,name);
    effects.push({key:key(id,version),id,version,filename:name,bytes:item.data.byteLength,
                  data:item.data,source:'archive import',storedAt:new Date().toISOString()});}
   catch{skipped.push(name);}
   if(i%25===0)onProgress(`Reading effects… ${i+1} of ${zdls.length}`);
  }
  // Artwork is keyed by the effect ID its filename carries, which is how the
  // generated bundle names it (010000a0.png). Anything else keeps its basename
  // so a catalog entry can still point at it by path.
  const art=images.map(item=>{const name=basename(item.name);
   return {id:name.replace(/\.[^.]+$/,''),name,path:item.name,
           type:/\.png$/i.test(name)?'image/png':/\.webp$/i.test(name)?'image/webp':'image/jpeg',
           data:item.data};});

  onProgress('Storing…');
  if(effects.length)await write(STORE,effects);
  if(art.length)await write(ART,art);
  let catalogued=0;
  if(indexEntry){
   try{const parsed=JSON.parse(new TextDecoder().decode(indexEntry.data));
    const named=indexByName(parsed);
    if(named.size){await write(META,[{key:'catalog',index:parsed,importedAt:new Date().toISOString()}]);
     catalogued=named.size;}}
   catch{/* an unreadable index is not fatal; the binaries describe themselves */}
  }
  remember(await all());
  await artwork(true);        // rebuild now; never leave a stale or empty cache
  return {effects:effects.length,artwork:art.length,catalogued,skipped};
 }

 /* The catalog the Effects page renders.

    The stored binaries are the spine, not the index. They carry their own id
    and version at ZDL offsets 0x40 and 0x44, so every entry is guaranteed to
    have the fields the UI groups and filters by -- and the catalog can never
    offer an effect whose bytes are missing.

    An index only enriches: artwork, hashes, provenance. Three incompatible
    shapes exist in the wild and all are tolerated. index.json from
    build-bundle-assets.py maps effect id to variants and uses `effectId`;
    manifest.json from exportZip is a flat array using `id`; manifest.json from
    download-effects.py is a flat array with neither, only a filename. Reading
    an index for its id was what broke import: entries arrived without effectId
    and the first render died on effectId.slice(). */
 function indexByName(index){
  const map=new Map();
  if(!index||!index.effects)return map;
  const flat=Array.isArray(index.effects)?index.effects:Object.values(index.effects).flat();
  for(const e of flat){
   if(!e||typeof e!=='object')continue;
   const name=(e.filename||e.name||'').toUpperCase();
   if(name)map.set(name,e);
  }
  return map;
 }
 async function catalog(){
  const records=await all();
  if(!records.length)return [];
  const meta=await read(META,'get','catalog'),extra=indexByName(meta?.index);
  return records.map(r=>{
   const e=extra.get((r.filename||'').toUpperCase())||{};
   const art=e.artwork?basename(String(e.artwork)).replace(/\.[^.]+$/,''):null;
   return {effectId:r.id,filename:r.filename,version:r.version,bytes:r.bytes,
           sha256:e.sha256||null,source:e.source||r.source,artwork:art||r.id};
  });
 }

 /* Blob URLs for stored artwork, built once and reused across renders.

    An empty result is never cached. The first import goes into an empty
    library, so the page has already asked for artwork and got nothing back;
    caching that would leave the Effects page imageless until a reload, since a
    Map with no entries is still truthy and would satisfy the cache check. */
 let artUrls=null;
 function revokeArtwork(){if(artUrls){for(const url of artUrls.values())URL.revokeObjectURL(url);artUrls=null;}}
 async function artwork(force=false){
  if(!force&&artUrls&&artUrls.size)return artUrls;
  const built=new Map();
  for(const item of await allArtwork())
   built.set(item.id,URL.createObjectURL(new Blob([item.data],{type:item.type||'image/png'})));
  revokeArtwork();
  artUrls=built;
  return artUrls;
 }

 /* The bytes to write to the pedal. Local storage first; a served path is only
    used when one is present, which a published copy will not have. */
 async function binary(effect){
  const id=(effect.effectId||effect.id||'').toLowerCase();
  const records=await all();
  const match=records.find(r=>r.id===id&&r.version===effect.version)
           ||records.find(r=>r.filename?.toUpperCase()===effect.filename?.toUpperCase())
           ||records.find(r=>r.id===id);
  if(match)return match.data instanceof Uint8Array?match.data:new Uint8Array(match.data);
  if(effect.path){const r=await fetch(effect.path);if(r.ok)return new Uint8Array(await r.arrayBuffer());}
  throw Error(`${effect.filename||'That effect'} is not in this browser's library. Import your FX archive first.`);
 }

 async function clear(){
  const db=await open();
  await new Promise((resolve,reject)=>{const tx=db.transaction([STORE,ART,META],'readwrite');
   for(const s of [STORE,ART,META])tx.objectStore(s).clear();
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
  localStorage.removeItem(SUMMARY);revokeArtwork();
 }

 /* No button calls this. The archive download-effects.py wrote is the backup,
    and a button that reproduces those same bytes is a second copy of a file
    already on disk.

    It stays reachable as effectStore.exportZip() from the console for the case
    that archive cannot reproduce: a library that also holds loose .ZDL files
    added through Import. */
 async function exportZip(){const records=await all();if(!records.length)throw Error('No effects are stored in this browser yet.');
  const files=records.map(x=>[`effects/${x.id}-${x.filename}`,x.data]);
  for(const item of await allArtwork())files.push([`artwork/${item.name}`,item.data]);
  const meta=await read(META,'get','catalog');
  if(meta?.index)files.push(['index.json',new TextEncoder().encode(JSON.stringify(meta.index,null,2))]);
  const manifest={format:'stompshare-effects',version:1,createdAt:new Date().toISOString(),count:records.length,effects:records.map(({data,...x})=>x)};
  files.push(['manifest.json',new TextEncoder().encode(JSON.stringify(manifest,null,2))]);
  void g.stompSave('ms-stompctrl-effects-'+new Date().toISOString().slice(0,10)+'.zip',g.BackupBundle.zip(files));
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 }

 g.effectStore={all,add,exportZip,extractZdl,extractZdls,importArchive,catalog,artwork,binary,clear,remember,zipEntries,effectName};
})(globalThis);
