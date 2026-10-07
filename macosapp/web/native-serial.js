/* A byte transport only. The shared transport/iAP/authentication modules still
   own framing, signature verification, session state and real pedal ACKs. */
(()=>{
 'use strict';
 const request=(action,body={})=>webkit.messageHandlers.stomp.postMessage({action,...body});
 const port=new EventTarget();
 let input=null, opening=false, live=false;
 port.getInfo=()=>({bluetoothServiceClassId:'00000000-deca-fade-deca-deafdecacaff'});
 // Deliberately omit SerialPort.connected: the shared browser guard must not
 // reject a paired pedal just because its baseband connection is currently down.
 port.open=async()=>{
  if(opening||live)throw Error('The pedal port is already open or opening.');
  opening=true;
  port.readable=new ReadableStream({start(c){input=c;},cancel(){input=null;}});
  port.writable=new WritableStream({write(bytes){
   if(!live)throw Error('The pedal disconnected.');
   return request('write',{bytes:Array.from(bytes)});
  }});
  try{await request('connect');live=true;}
  catch(e){input?.close();input=null;port.readable=null;port.writable=null;throw e;}
  finally{opening=false;}
 };
 port.close=async()=>{await request('disconnect');finish();};
 function finish(){live=false;input?.close();input=null;port.readable=null;port.writable=null;}
 globalThis.stompMacReceive=bytes=>{if(input)input.enqueue(Uint8Array.from(bytes));};
 globalThis.stompMacClosed=()=>{finish();port.dispatchEvent(new Event('disconnect'));};
 Object.defineProperty(navigator,'serial',{value:{
  requestPort:async()=>port,getPorts:async()=>[port],
  addEventListener:(...args)=>port.addEventListener(...args),
  removeEventListener:(...args)=>port.removeEventListener(...args)
 }});
 globalThis.stompHostSave=async(filename,blob)=>{
  const bytes=new Uint8Array(await blob.arrayBuffer());
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  await request('save',{filename,base64:btoa(binary)});
 };
})();
