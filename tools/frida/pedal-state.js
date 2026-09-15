ObjC.schedule(ObjC.mainQueue,function(){try {
 const app=ObjC.classes.UIApplication.sharedApplication(),d=app.delegate();
 function brief(o){return o?{class:o.$className,address:o.handle.toString(),description:String(o).slice(0,500)}:null;}
 function read(o,keys){let r=brief(o);if(!o)return r;for(const k of keys){try{let v=o[k]();r[k]=v&&v.$className?brief(v):String(v);}catch(e){r[k]='error '+e;}}return r;}
 let r={delegate:brief(d),methods:d.$ownMethods};
 try {let m=d.mToB();r.manager=read(m,['btConnectManager','isConnect','deviceID','filenameList','filesizeList','diskTotalSize','diskFreeSize','receiveThreadFlag']);r.managerMethods=m.$ownMethods;r.managerIvars={};Object.keys(m.$ivars).forEach(k=>{let v=m.$ivars[k];if(v&&v.$className)r.managerIvars[k]=brief(v);});}catch(e){r.managerError=String(e);}
 function walk(c){let v=brief(c);v.title=String(c.title());v.methods=c.$ownMethods;v.ivars={};Object.keys(c.$ivars).forEach(k=>{let x=c.$ivars[k];if(x&&x.$className&&!x.$className.startsWith('UI')&&!x.$className.startsWith('_UI'))v.ivars[k]=brief(x);});v.children=[];let a=c.childViewControllers();for(let i=0;i<a.count();i++)v.children.push(walk(a.objectAtIndex_(i)));if(c.presentedViewController())v.presented=walk(c.presentedViewController());return v;}
 r.root=walk(app.keyWindow().rootViewController());send(r);
}catch(e){send({error:e.stack||String(e)});}});
