'use strict';
function emit(kind, value) { send({kind:kind, value:value, time:new Date().toISOString()}); }
function inspect() {
 const bundle=ObjC.classes.NSBundle.mainBundle();
 emit('app',{path:bundle.bundlePath().toString(),version:bundle.objectForInfoDictionaryKey_('CFBundleVersion').toString(),base:Process.getModuleByName('StompShare').base.toString()});
 const names=['BlueToothConnectManager','MidiToBluetoothManager'];
 names.forEach(function(name){
  const c=ObjC.classes[name];
  if (!c) return;
  const instances=ObjC.chooseSync(c);
  emit('instances',{class:name,count:instances.length});
  instances.forEach(function(o){
   let v={class:name,address:o.handle.toString()};
   const fields=name==='BlueToothConnectManager'?['session','accessoryTarget','getRecvBufLength','isCompeleteStreamOpen']:['deviceID','isConnect','diskTotalSize','diskFreeSize','filenameList','filesizeList','receiveThreadFlag'];
   fields.forEach(function(k){try {let x=o[k]();v[k]=x===null?null:x.toString();}catch(e){v[k]='error: '+e;}});
   emit('state',v);
  });
 });
 const ac=ObjC.classes.EAAccessoryManager.sharedAccessoryManager().connectedAccessories();
 let accessories=[];
 for(let i=0;i<ac.count();i++){let a=ac.objectAtIndex_(i);accessories.push({name:a.name().toString(),manufacturer:a.manufacturer().toString(),model:a.modelNumber().toString(),firmware:a.firmwareRevision().toString(),protocols:a.protocolStrings().toString(),connected:!!a.isConnected()});}
 emit('accessories',accessories);
 const c=ObjC.classes.BlueToothConnectManager;
 ['- SendData:len:','- putRecvRingBuffer:len:'].forEach(function(sel){
  const method=c[sel]; emit('hook',{selector:sel,address:method.implementation.toString()});
  Interceptor.attach(method.implementation,{onEnter(args){let n=args[3].toInt32();if(n<0||n>65536){emit('invalid_length',{selector:sel,length:n});return;}send({kind:'packet_fragment',direction:sel.indexOf('SendData')>=0?'tx':'rx',length:n,time:new Date().toISOString()},args[2].readByteArray(n));}});
 });
 emit('ready','Passive capture installed; no device commands sent.');
}
ObjC.schedule(ObjC.mainQueue, function(){try{inspect();}catch(e){emit('error',e.stack||String(e));}});
