import frida,json,pathlib,datetime,threading,sys
root=pathlib.Path(__file__).resolve().parent
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
out=root/('protocol-'+stamp+'.jsonl');done=threading.Event();counts={'tx':0,'rx':0}
def message(m,data):
 record={'host_time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'message':m}
 if data is not None:record['hex']=data.hex()
 with out.open('a') as f:f.write(json.dumps(record)+'\n')
 p=m.get('payload',{});kind=p.get('kind')
 if kind=='packet_fragment':
  counts[p['direction']]+=1
  if sum(counts.values())<=12 or sum(counts.values())%100==0:print('traffic',counts,'last',p['direction'],p['length'],flush=True)
 elif kind in ['ready','query_start','query_result','query_error','complete'] or m.get('type')=='error':print(json.dumps(record),flush=True)
 if kind=='complete':done.set()
d=frida.get_device_manager().add_remote_device('127.0.0.1:27043');p=next(p for p in d.enumerate_processes() if p.name=='StompShare');s=d.attach(p.pid)
x=s.create_script((root/'record-query.js').read_text());x.on('message',message)
try:
 print('Recording to',out,flush=True);x.load()
 if not done.wait(120):raise TimeoutError('Query did not complete in 120 seconds')
finally:
 x.unload();s.detach();print('Detached;',counts,'saved',out,flush=True)
