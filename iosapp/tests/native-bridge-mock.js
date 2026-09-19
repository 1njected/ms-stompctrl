/* A stand-in for the Swift side, so transport-ea.js can be developed and driven
   in a desktop browser with no device and no pedal.

   It answers writes from a recorded capture: tools/protocol-*.decoded.json is
   already stripped of iAP framing -- Frida hooked the native app above that
   layer -- so its frames are exactly the payload stream an EASession carries.

     <script>
       fetch('../../tools/protocol-20260908T150705Z.decoded.json')
         .then(r => r.json())
         .then(installMockBridge);
     </script>
     <script src="transport-ea.js"></script>
     <script src="iap.js"></script>

   Unmatched commands answer nothing, which is a real pedal state too: see
   stompSilence in transport-ea.js. */
globalThis.installMockBridge=function(capture,{latencyMs=35}={}){
 const replies=indexCapture(capture);
 const delay=fn=>setTimeout(fn,latencyMs);
 globalThis.stompNativeBridge={
  connect(){delay(()=>globalThis.stompNativeState('open'));},
  disconnect(){delay(()=>globalThis.stompNativeState('closed'));},
  /* Resolves when the bytes are "gone", like the real bridge, so the page's
     write timings and its synthetic DevACK are sequenced the same way here. */
  write(payload){
   const answers=replies.get(hexOf(payload))||[];
   for(const answer of answers)delay(()=>globalThis.stompNativeReceive(answer));
   if(!answers.length)console.debug('[mock] no recorded answer for',hexOf(payload));
   return new Promise(r=>delay(r));
  },
  save(filename,text){console.log('[mock] save',filename,text.length,'bytes');}
 };
 console.log(`[mock] bridge installed; ${replies.size} recorded exchanges`);
 return replies;
};

/* Every request maps to the answers that followed it before the next request. */
globalThis.indexCapture=function(capture){
 const frames=Array.isArray(capture)?capture:capture.frames||[];
 const replies=new Map();let current=null;
 for(const f of frames){
  if(f.direction==='tx'){current=f.hex;if(!replies.has(current))replies.set(current,[]);}
  else if(current)replies.get(current).push(f.hex);
 }
 return replies;
};

function hexOf(bytes){return Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join(' ');}
if(typeof module!=='undefined')module.exports={indexCapture:globalThis.indexCapture};
