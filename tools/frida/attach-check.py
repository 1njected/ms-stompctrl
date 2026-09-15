import frida,json,pathlib,datetime,threading
root=pathlib.Path(__file__).resolve().parent
records=[]
def record(x):
    x={'host_time':datetime.datetime.now(datetime.timezone.utc).isoformat(),**x}
    records.append(x);print(json.dumps(x),flush=True)
device=frida.get_device_manager().add_remote_device('127.0.0.1:27043')
ps=[p for p in device.enumerate_processes() if p.name=='StompShare']
if len(ps)!=1:raise RuntimeError('Expected exactly one StompShare process')
session=None
try:
    session=device.attach(ps[0].pid);record({'attached_pid':ps[0].pid})
    done=threading.Event()
    script=session.create_script('''
const app=Process.getModuleByName('StompShare');
const info={pid:Process.id,base:app.base.toString(),objc:ObjC.available};
if(ObjC.available){
 info.home=new NativeFunction(Module.getExportByName(null,'NSHomeDirectory'),'pointer',[])();
 info.home=new ObjC.Object(info.home).toString();
 info.version=ObjC.classes.NSBundle.mainBundle().objectForInfoDictionaryKey_('CFBundleVersion').toString();
 info.sendData=ObjC.classes.BlueToothConnectManager['- SendData:len:'].implementation.toString();
 info.sendDataOffset=ObjC.classes.BlueToothConnectManager['- SendData:len:'].implementation.sub(app.base).toString();
}
send(info);
''')
    def message(m,data):record({'message':m});done.set()
    script.on('message',message);script.load()
    if not done.wait(15):raise TimeoutError('No injected script response')
    script.unload()
except Exception as e:
    record({'error':str(e),'type':type(e).__name__});raise
finally:
    if session is not None:session.detach();record({'detached':True})
    (root/'attachment-check.json').write_text(json.dumps(records,indent=2)+'\n')
