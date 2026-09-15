/* iAP v2 proof-of-possession verification. Does not establish Apple CA trust. */
(function(g){
function tlv(b,p){const start=p,tag=b[p++];let n=b[p++];if(n&128){const count=n&127;if(!count||count>4||p+count>b.length)throw Error('Invalid DER length');n=0;for(let i=0;i<count;i++)n=n*256+b[p++];}if(p+n>b.length)throw Error('Truncated DER');return{tag,start,body:p,end:p+n};}
function children(b,t){const a=[];for(let p=t.body;p<t.end;){const c=tlv(b,p);if(c.end>t.end)throw Error('Invalid DER child');a.push(c);p=c.end;}return a;}
function spki(b){let result;function walk(t){if(t.tag===48){const c=children(b,t);if(c.length===2&&c[0].tag===48&&c[1].tag===3){const alg=children(b,c[0]);if(alg[0]?.tag===6&&Array.from(b.slice(alg[0].body,alg[0].end)).join(',')==='42,134,72,134,247,13,1,1,1')result=b.slice(t.start,t.end);}}if(t.tag&32)for(const c of children(b,t))walk(c);}walk(tlv(b,0));if(!result)throw Error('RSA public key missing');return result;}
const bigint=b=>BigInt('0x'+Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''));
function modpow(x,e,n){let y=1n;for(;e;e>>=1n,x=x*x%n)if(e&1n)y=y*x%n;return y;}
async function verify(certificate,signature,challenge){
 const key=spki(Uint8Array.from(certificate)),parts=children(key,tlv(key,0));const bits=parts[1];if(key[bits.body]!==0)throw Error('Invalid RSA bit string');const ints=children(key,tlv(key,bits.body+1));const n=bigint(key.slice(ints[0].body,ints[0].end)),e=bigint(key.slice(ints[1].body,ints[1].end));const size=Math.ceil(n.toString(2).length/8),s=bigint(signature);if(signature.length!==size||s>=n)return false;
 const decoded=modpow(s,e,n).toString(16).padStart(size*2,'0');
 const digest=Array.from(challenge,x=>x.toString(16).padStart(2,'0')).join('');const tail='3021300906052b0e03021a05000414'+digest;
 return decoded==='0001'+'ff'.repeat(size-3-tail.length/2)+'00'+tail;
}
g.IAPSignature={spki,verify};if(typeof document==='undefined')return;if(g.iapSignature)return;
/* `checked` distinguishes "not verified yet" from "verified and failed".
   Without it both read as verified:false, so a rejected signature showed the
   same "Identifying and authenticating" as a handshake still in progress and
   the UI waited forever on something that had already finished. */
const state=g.iapSignature={challenge:null,verified:false,checked:false,error:null};let queue=Promise.resolve();const oldLog=log;
async function send(cmd,tr,data=[]){const b=IAPCodec.frame(cmd,tr,data);await stompWrite(b,'signature');oldLog('iap_signature_tx',{cmd:cmd.toString(16),transaction:tr,hex:hex(b)});}
const parser=new IAPCodec.Parser(p=>{if(p.lingo!==0||p.cmd!==0x18)return;queue=queue.then(async()=>{
 if(!state.challenge)throw Error('Unsolicited signature');oldLog('iap_signature_rx',{transaction:p.transaction,hex:hex(p.data)});
 state.verified=await verify(iapAuth.certificate,p.data,state.challenge);state.checked=true;state.error=state.verified?null:'The pedal\'s signature did not verify.';oldLog('iap_signature_verified',{valid:state.verified,scope:'Proof of possession only; certificate chain and expiry not validated'});
 await send(0x19,p.transaction,[state.verified?0:1]);iapHost.enabled=true;if(state.verified&&iapHost.openSession)setTimeout(()=>iapHost.openSession(),100);document.getElementById('iap-status').textContent=state.verified?'iAP: accessory signature verified; ready to open data session':'iAP: signature verification failed';
 }).catch(e=>{state.checked=true;state.error=String(e&&e.message||e);oldLog('iap_signature_error',String(e));});});
log=function(k,v){oldLog(k,v);if(k==='closed'){state.challenge=null;state.verified=false;state.checked=false;state.error=null;iapHost.enabled=true;parser.buf=[];}if(k==='rx')parser.feed(v.split(' ').map(x=>parseInt(x,16)));};
state.start=()=>{queue=queue.then(async()=>{if(!iapAuth.certificate)throw Error('No captured certificate');iapHost.enabled=false;state.verified=false;state.checked=false;state.error=null;state.challenge=Array.from(crypto.getRandomValues(new Uint8Array(20)));oldLog('iap_signature_challenge',hex(state.challenge));await send(0x16,iapAuth.finalTransaction??5,[0]);await send(0x17,0x101,[...state.challenge,0]);}).catch(e=>oldLog('iap_signature_error',String(e)));};
})(globalThis);
