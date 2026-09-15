/* Read-only iAP accessory authentication diagnostics, usable on an existing connection. */
(function(global){
 if(global.iapAuth)return;
 const state=global.iapAuth={sections:[],certificate:null};
 const originalLog=log;let queue=Promise.resolve();
 async function send(cmd,tr,data=[]){const b=IAPCodec.frame(cmd,tr,data);await stompWrite(b,'auth');originalLog('iap_auth_tx',{cmd:cmd.toString(16),transaction:tr,hex:hex(b)});}
 const parser=new IAPCodec.Parser(p=>{if(p.lingo!==0||p.cmd!==0x15)return;queue=queue.then(async()=>{
  const d=p.data;if(d.length<4||d[0]<2)throw Error('Unsupported authentication info format');
  const section=d[2],last=d[3];if(section===0)state.sections=[];
  if(section<state.sections.length&&JSON.stringify(state.sections[section])===JSON.stringify(d.slice(4))){originalLog('iap_auth_certificate_retry',{section,last});if(section<last)await send(2,p.transaction,[0,0x15]);return;}
  if(section!==state.sections.length||section>last)throw Error('Out-of-order certificate section');
  state.sections.push(d.slice(4));originalLog('iap_auth_certificate_section',{major:d[0],minor:d[1],section,last,bytes:d.length-4});
  if(section<last)await send(2,p.transaction,[0,0x15]);
  else {state.certificate=state.sections.flat();state.finalTransaction=p.transaction;originalLog('iap_auth_certificate',{bytes:state.certificate.length,hex:hex(state.certificate)});originalLog('iap_auth_state','Certificate captured; verification pending');if(global.iapSignature)global.iapSignature.start();}
 }).catch(e=>originalLog('iap_auth_error',String(e)));});
 log=function(kind,value){originalLog(kind,value);if(kind==='rx')parser.feed(value.split(' ').map(x=>parseInt(x,16)));};
 state.request=()=>{queue=queue.then(()=>send(0x14,0x100)).catch(e=>originalLog('iap_auth_error',String(e)));};
 originalLog('iap_auth_loaded','Certificate capture enabled');
})(globalThis);
