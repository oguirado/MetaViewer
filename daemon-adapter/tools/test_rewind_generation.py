import copy,importlib.util,json,os,sys,tempfile,unittest,hashlib
from pathlib import Path
W=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(W/'daemon-adapter'));sys.path.insert(0,str(W/'daemon-adapter/tools'))
from test_rewind_runner import Backend as OriginalBackend,B
class Backend(OriginalBackend):
 def request(self,r,**kw):
  super().request(r,**kw)
  if r['op']=='restore':self.native.mapped=kw['point_id']
from guest_command_runtime.schema import Contracts
spec=importlib.util.spec_from_file_location('generation_runner',Path(__file__).with_name('rewind_runner.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def episode():
 events=[];tmp=tempfile.TemporaryDirectory(dir='/dev/shm');a=m.Adapter(Backend(),'session-core',tmp.name,Contracts(),events.append);b=copy.deepcopy(B);point='point-'+hashlib.sha256(b''.join(len(x.encode()).to_bytes(8,'big')+x.encode() for x in ('session-one','workload-test','request-3'))).hexdigest()
 def send(op,family='guest_command_request/v0.2',**params):
  request={'schema':family,'request_id':'request-'+str(len(a.seen)+1),'op':op,'params':params};a.submit({'request':request,'binding':copy.deepcopy(b),'point_id':point if op in ('mark','restore') else '', 'public_reservation':'reservation-public'})
 def run():send('run',workload_id=b['workload_id'],generation=b['generation'],job_id='job-'+str(b['generation']),command_utf8='printf hi',cwd='',stdin_b64='',timeout_ms=500)
 def rw(op,advance=False):
  old=copy.deepcopy(b)
  if advance:b['generation']+=1;b['authority_epoch']+=1
  send(op,'rewind_request/v0.2',**{k:old[k] for k in ('workload_id','generation','authority_epoch')},**({'label':'Before'} if op=='mark' else {'point_id':point} if op=='restore' else {}))
 send('create',profile_id='guest-command-arm64-v1');run();rw('mark',True);run();rw('pause');rw('restore',True);run();rw('pause');rw('resume',True);send('stop',workload_id=b['workload_id'],generation=b['generation'])
 os.close(a.journal);tmp.cleanup();return events
class Tests(unittest.TestCase):
 def test_three_jobs_rewind_then_stop_retains_count_not_stale_job(self):
  events=episode();ack=next(e for e in events if e['event']=='accepted' and e['data'].get('op')=='stop');closed=events[-1]
  self.assertEqual(ack['session']['generation'],4);self.assertEqual(ack['session']['jobs_started'],3);self.assertIsNone(ack['session']['job']);self.assertEqual(ack['session']['controls']['stop'],{'request_id':ack['request_id'],'ack':'accepted'})
  self.assertEqual(closed['event'],'stopped');self.assertTrue(closed['data']['native_absent']);self.assertIsNone(closed['session']['job'])
 def test_real_sdk_passive_consumes_sequence_and_confirmed_stop(self):
  sys.path.insert(0,str(W/'agents'));sys.path.insert(0,str(W/'agents/tests'))
  from test_guest_command import Harness
  from metaviewer_agents.guest_command import _reservation
  from metaviewer_agents.envelope import make_envelope
  h=Harness();h.sdk._observe_owned=True;h.sdk.rewind
  try:
   events=episode();token=_reservation('session-one',events[0]['request_id'])
   for seq,e in enumerate(events,1):
    e=copy.deepcopy(e);e['owner_id']=h.sdk._owner;e['session']['owner_id']=h.sdk._owner
    if e['schema']=='guest_command_event/v0.2':e['reservation_id']=token
    env=make_envelope(msg_id='synth-'+str(seq),from_component='core',from_instance='core-one',to_component='agent',to_instance='agent-one',session_id='session-one',seq=seq,body=e)
    with h.sdk._lock:h.sdk._handle(env)
   self.assertTrue(h.sdk.closed);self.assertEqual(h.sdk.session['generation'],4);self.assertEqual(h.sdk.session['ownership'],'released');self.assertIsNone(h.sdk.session['job']);self.assertTrue(h.core.out.empty())
  finally:h.close()
 def test_pause_and_failed_resume_do_not_clear_historical_job(self):
  with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
   backend=Backend();events=[];a=m.Adapter(backend,'session-core',d,Contracts(),events.append)
   old={'job_id':'job-history','state':'exited','exit_code':0,'signal':None,'stdout_bytes':0,'stderr_bytes':0,'output_complete':True}
   try:
    a.submit({'request':{'schema':'guest_command_request/v0.2','request_id':'request-create','op':'create','params':{'profile_id':'guest-command-arm64-v1'}},'binding':B,'point_id':'','public_reservation':'reservation-public'})
    a.gc.update(job=copy.deepcopy(old),jobs_started=1)
    a.submit({'request':{'schema':'rewind_request/v0.2','request_id':'request-pause','op':'pause','params':{'workload_id':B['workload_id'],'generation':1,'authority_epoch':1}},'binding':B,'point_id':'','public_reservation':'reservation-public'})
    self.assertEqual(a.gc['job'],old)
    backend.request=lambda *args,**kwargs:(_ for _ in ()).throw(RuntimeError('synthetic failed resume'))
    a.submit({'request':{'schema':'rewind_request/v0.2','request_id':'request-resume','op':'resume','params':{'workload_id':B['workload_id'],'generation':1,'authority_epoch':1}},'binding':{**B,'generation':2,'authority_epoch':2},'point_id':'','public_reservation':'reservation-public'})
    self.assertEqual(events[-1]['event'],'outcome_unknown');self.assertEqual(a.gc['job'],old);self.assertEqual(a.gc['jobs_started'],1)
   finally:os.close(a.journal)
 def test_paused_completion_preserves_historical_job(self):
  events=episode();pauses=[e for e in events if e['event']=='completed' and e['data'].get('op')=='pause'];self.assertEqual(len(pauses),2)
  # Public Rewind session does not invent GC job fields.
  self.assertTrue(all('job' not in e['session'] for e in pauses))
if __name__=='__main__':unittest.main()
