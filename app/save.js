/* Handing a file to the person using the page.

   In a browser that is an anchor with a download attribute. Inside a native
   host it is not: a WKWebView ignores the attribute entirely and the click
   silently does nothing, which is how a backup can appear to save and leave no
   file. A host that can write files installs stompHostSave and receives the
   bytes instead; everything else keeps the anchor. */
globalThis.stompSave=async function(filename,data,type='application/octet-stream'){
 const blob=data instanceof Blob?data:new Blob([data],{type});
 if(typeof globalThis.stompHostSave==='function'){
  await globalThis.stompHostSave(filename,blob);
  return filename;
 }
 const a=document.createElement('a'),url=URL.createObjectURL(blob);
 a.href=url;a.download=filename;a.click();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
 return filename;
};
