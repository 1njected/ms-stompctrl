import frida,json,time,pathlib,datetime,sys
root=pathlib.Path(__file__).resolve().parent
out=root/'capture.jsonl'
def on_message(message,data):
    record={'host_time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'message':message}
    if data is not None: record['hex']=data.hex()
    with out.open('a') as f:f.write(json.dumps(record)+'\n')
    print(json.dumps(record),flush=True)
device=frida.get_device_manager().add_remote_device('127.0.0.1:27043')
processes=[p for p in device.enumerate_processes() if p.name=='StompShare']
if len(processes)!=1:raise RuntimeError(f'Expected one StompShare process, found {processes}')
session=device.attach(processes[0].pid)
print('Attached',processes[0].pid,flush=True)
script=session.create_script((root/'inspect.js').read_text());script.on('message',on_message)
try:
    script.load()
    time.sleep(int(sys.argv[1]) if len(sys.argv)>1 else 60)
finally:
    script.unload();session.detach()
    print('Detached',flush=True)
