/* iAP1 host identification over RFCOMM. Protocol reference: oandrew/ipod (MIT).
   Independent implementation; no effect/file writes or firmware commands. */
(function(global){
function frame(cmd,transaction,data=[]){
 const payload=[0,cmd,transaction>>8,transaction&255,...data];
 const header=payload.length<256?[payload.length]:[0,payload.length>>8,payload.length&255];
 return Uint8Array.from([0x55,...header,...payload,(-[...header,...payload].reduce((a,b)=>a+b,0))&255]);
}
class Parser{
 constructor(onFrame,onError=()=>{}){this.buf=[];this.onFrame=onFrame;this.onError=onError;}
 feed(bytes){this.buf.push(...bytes);while(this.buf.length){
  const pos=this.buf.indexOf(0x55);if(pos<0){this.buf=[];return;}if(pos)this.buf.splice(0,pos);
  if(this.buf.length<2)return;let off=2,len=this.buf[1];if(!len){if(this.buf.length<4)return;off=4;len=this.buf[2]*256+this.buf[3];}
  if(len<4||len>16384){this.buf.shift();this.onError('Invalid length');continue;}
  const end=off+len+1;if(this.buf.length<end)return;
  if(this.buf.slice(1,end).reduce((a,b)=>a+b,0)%256){this.buf.shift();this.onError('Checksum mismatch');continue;}
  const p=this.buf.slice(off,end-1);this.buf.splice(0,end);this.onFrame({lingo:p[0],cmd:p[1],transaction:p[2]*256+p[3],data:p.slice(4)});
 }}
}
global.IAPCodec={frame,Parser};
if(typeof document==='undefined')return;
if(global.iapHost)return;
const state=global.iapHost={enabled:true,protocols:[],identified:false,session:null,pendingSession:null,nextTransaction:1};
const previousLog=log;let queue=Promise.resolve();
let transferTail=Promise.resolve();
global.stompTransfer=fn=>{const wait=transferTail;let release;transferTail=new Promise(r=>{release=r});return wait.then(fn).finally(release);};
const status=document.createElement('p');status.id='iap-status';status.textContent='iAP: waiting for accessory identification';el('staging').append(status);
function stage(text){status.textContent='iAP: '+text;previousLog('iap_state',text);}
async function send(cmd,tr,data=[]){const b=frame(cmd,tr,data);await stompWrite(b,'iap');previousLog('iap_tx',{cmd:cmd.toString(16),transaction:tr,hex:hex(b)});}
const ack=(p,value=0)=>send(2,p.transaction,[value,p.cmd]);
async function receive(p){
 previousLog('iap_rx',{...p,cmd:p.cmd.toString(16),data:hex(p.data)});
 if(!state.enabled||p.lingo!==0)return;
 switch(p.cmd){
 case 0x38:state.protocols=[];state.identified=false;state.session=null;state.pendingSession=null;openButton.disabled=true;el('identity').disabled=true;stage('identifying accessory');await ack(p);break;
 case 0x11:await send(0x12,p.transaction,[0x10,0]);break;
 case 0x0f:await send(0x10,p.transaction,[p.data[0],1,9]);break;
 case 0x39:{
  const a=p.data,out=[a[0]];let pos=1;
  for(let i=0;i<a[0];i++){
   const n=a[pos++];if(n<2||pos+n>a.length)throw Error('Truncated FID token');
   const t=a.slice(pos,pos+n);pos+=n;previousLog('iap_token',{type:t[0],subtype:t[1],data:hex(t.slice(2))});
   let reply=[t[0],t[1],0];
   if(t[0]===0&&[2,3,4].includes(t[1]))reply.push(t[2]);
   if(t[0]===0&&t[1]===4){const name=new TextDecoder().decode(Uint8Array.from(t.slice(3))).split('\0')[0];state.protocols.push({index:t[2],name});previousLog('iap_protocol',state.protocols.at(-1));}
   if(!(t[0]===0&&t[1]<=7)&&!(t[0]===1&&t[1]===0))reply=[t[0],t[1],1];
   out.push(reply.length,...reply);
  }
  if(pos!==a.length)throw Error('Trailing FID token data');await send(0x3a,p.transaction,out);break;
 }
 case 0x3b:if(p.data[0]===0){await send(0x3c,p.transaction,[0]);state.identified=true;stage('identification accepted; ready to open advertised protocol');openButton.disabled=false;if(global.iapAuth)global.iapAuth.request();}else{await send(0x3c,p.transaction,[p.data[0]===1?4:6]);stage('accessory ended identification: '+p.data[0]);}break;
 case 0x15:if(global.iapAuth)break;await ack(p,5);break;
 case 0x4b:await send(0x4c,p.transaction,[p.data[0],0,0,0,0,0,0,0,0]);break;
 case 0x41:
  if(p.data[1]===0x3f&&state.pendingSession&&p.transaction===state.pendingSession.transaction){
   if(p.data[0]===0){state.session=state.pendingSession.id;stage('data session open');el('identity').disabled=false;global.stompEvents?.dispatchEvent(new CustomEvent('session',{detail:{id:state.session}}));}
   else stage('session rejected: '+p.data[0]);
   state.pendingSession=null;
  }
  // The accessory acknowledges every encapsulated 0x43 request with 0x41
  // (data 00 43).  iAP requires the host to ACK that frame before the
  // accessory sends the corresponding 0x42 payload; without this, inventory
  // requests time out after the 0x41 response.
  if(p.data.length>=2&&p.data[1]===0x43)await ack(p);
  break;
 case 0x42:if(p.data.length<2)throw Error('Missing session ID');previousLog('pedal_rx',{session:p.data[0]*256+p.data[1],hex:hex(p.data.slice(2))});await ack(p);break;
 case 0x02:previousLog('iap_ack',{status:p.data[0],command:p.data[1]});break;
 case 0x1a:case 0x1d:stage('accessory requests host authentication; not implemented');await ack(p,5);break;
 case 0x64:await ack(p,2);break;
 default:previousLog('iap_unhandled',p.cmd);await ack(p,5);
 }
}
const parser=new Parser(p=>{queue=queue.then(()=>receive(p)).catch(e=>{previousLog('iap_error',String(e));stage('error: '+e.message);});},e=>previousLog('iap_parse_error',e));
log=function(kind,value){previousLog(kind,value);if(kind==='rx')parser.feed(value.split(' ').map(x=>parseInt(x,16)));if(kind==='closed'){parser.buf=[];state.pendingSession=null;state.session=null;state.identified=false;openButton.disabled=true;stage('disconnected');globalThis.stompConnection.connected=false;stompEvents.dispatchEvent(new CustomEvent('disconnected'));}};
const openButton=document.createElement('button');openButton.textContent='Open StompShare data session';openButton.disabled=true;el('identity').before(openButton);
state.openSession=()=>openButton.click();
state.closeSession=async()=>{if(state.session===null)return;await send(0x40,state.nextTransaction++,[state.session>>8,state.session&255]);state.session=null;state.pendingSession=null;stage('data session closed');};
openButton.onclick=()=>{queue=queue.then(async()=>{if(global.iapSignature&&!global.iapSignature.verified)throw Error('Accessory signature verification required');const protocol=state.protocols.find(x=>x.name==='jp.co.zoom.p1');if(!protocol)throw Error('Pedal did not advertise jp.co.zoom.p1');const tr=state.nextTransaction++;state.pendingSession={id:1,transaction:tr};await send(0x3f,tr,[0,1,protocol.index]);stage('waiting for data-session acknowledgement');}).catch(e=>stage(e.message));};
el('identity').disabled=true;el('identity').onclick=()=>{queue=queue.then(async()=>{if(state.session===null)throw Error('No data session');await send(0x43,state.nextTransaction++,[state.session>>8,state.session&255,0xf0,0x7e,0,6,1,0xf7]);}).catch(e=>stage(e.message));};
previousLog('iap_loaded','StartIDPS / FID / EndIDPS enabled; waiting for next frame');
})(globalThis);
