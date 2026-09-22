/* Notices when a new version has been deployed and reloads the page itself.

   The ?v= token on every script is stamped at deploy time with the commit that
   produced it, so a new deploy changes every URL and the browser fetches the new
   code rather than serving what it cached. That only helps someone who reloads,
   though, and this page is one people leave open while the pedal is connected.
   So it asks the server what the live version is, and reloads when it differs.

   Two things it will not interrupt: an operation on the pedal, and an open
   patch editor. Reloading in the middle of a write is worse than running old
   code, and losing an unsaved chain is worse than either. It tries again later
   instead.

   Where no version.txt is served -- a local checkout, the iOS bundle -- the
   first check fails and the timer stops. Nothing is logged and nothing retries. */
(function(g){
const CHECK_EVERY_MS=120000;
const TRIED_KEY='stomp.versionReloadTried';

/* Pure, so the decision can be tested without a server or a clock.

   `tried` is the version a previous reload was already attempted for. GitHub
   Pages serves this page with max-age=600, so for up to ten minutes after a
   deploy version.txt reports the new commit while index.html still comes from
   the browser's cache carrying the old token. Without this guard the page would
   reload, come back unchanged, and do it again every couple of minutes until
   the cache expired. One attempt per version is enough. */
function shouldReload(own,live,{busy=false,editing=false,tried=null}={}){
 if(!own||!live)return false;
 if(live===own)return false;
 if(live===tried)return false;
 return !busy&&!editing;
}
g.VersionCheck={shouldReload};
if(typeof document==='undefined')return;

const own=(()=>{
 try{return new URL(document.currentScript.src,location.href).searchParams.get('v');}
 catch{return null;}
})();
if(!own)return;

let timer=null;
const stop=()=>{if(timer){clearInterval(timer);timer=null;}};

async function check(){
 let live;
 try{
  const res=await fetch('version.txt',{cache:'no-store'});
  if(!res.ok)return stop();
  live=(await res.text()).trim();
 }catch{return stop();}
 if(!live)return stop();
 const busy=!!g.pedalLock?.busy;
 const editing=!!document.querySelector('.pe-overlay');
 let tried=null;
 try{tried=sessionStorage.getItem(TRIED_KEY);}catch{}
 if(!shouldReload(own,live,{busy,editing,tried}))return;
 try{sessionStorage.setItem(TRIED_KEY,live);}catch{}
 /* Refresh the cached copy of this page first. A plain reload inside the
    max-age window would be served the old HTML with the old tokens, and the
    new code would not arrive until the cache expired. */
 try{await fetch(location.href,{cache:'reload'});}catch{}
 location.reload();
}

timer=setInterval(check,CHECK_EVERY_MS);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&timer)void check();});
})(globalThis);
