ObjC.schedule(ObjC.mainQueue,function(){try {
 const matches=[];
 function visit(v){if(v.respondsToSelector_(ObjC.selector('currentTitle'))&&String(v.currentTitle())==='Manage effects on the pedal')matches.push(v);const a=v.subviews();for(let i=0;i<a.count();i++)visit(a.objectAtIndex_(i));}
 visit(ObjC.classes.UIApplication.sharedApplication().keyWindow());
 if(matches.length!==1)throw Error('Expected one Manage effects button, found '+matches.length);
 if(!matches[0].isEnabled())throw Error('Manage effects button is disabled');
 matches[0].sendActionsForControlEvents_(64);
 send({action:'opened installed-effect list via Manage effects on the pedal',time:new Date().toISOString()});
}catch(e){send({error:e.stack||String(e)});}});
