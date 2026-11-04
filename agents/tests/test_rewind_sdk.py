"""No core/guest runtime: faithful single-owner fake transport plus canonical bodies."""
import copy
import json
from pathlib import Path
import queue
import time
import unittest
from test_guest_command import Harness, _reservation
from metaviewer_agents.envelope import make_envelope, validate_envelope, EnvelopeError
from metaviewer_agents.rewind import RewindError, RewindRequest, RewindEvent
from metaviewer_agents.guest_command import GuestCommandError, GuestCommandUnknown
ROOT=Path(__file__).resolve().parents[2]

def fixture(name):return json.loads((ROOT/'contracts/examples/v0.2'/name).read_text())

class RewindHarness(Harness):
 def __init__(self):
  super().__init__();self.rewind=self.sdk.rewind;self.rstate=None
 def emit_rewind(self,body,kind,*,state=None,data=None):
  self.seq+=1
  e={'schema':'rewind_event/v0.2','event_id':'event-rw-'+str(self.seq),'request_id':body['request_id'],'owner_id':self.sdk._owner,'event':kind,'session':copy.deepcopy(state if state is not None else self.rstate),'data':data or {'op':body['op']}}
  self.core.incoming.put(make_envelope(msg_id='rw-'+str(self.seq),from_component='core',from_instance='core-one',to_component='agent',to_instance='agent-one',session_id='session-one',seq=self.seq,body=e))
 def accept(self,body):
  old=body['params'];op=body['op'];phase=self.rstate['phase'] if self.rstate else 'ready'
  if self.rstate is None:
   self.rstate=fixture('rewind_session.valid.json');self.rstate.update(owner_id=self.sdk._owner,workload_id='workload-one',points=[],last_good_usable=None)
  n=op in ('resume','restore') or op=='mark' and phase=='ready'
  self.rstate.update(generation=old['generation']+int(n),authority_epoch=old['authority_epoch']+int(n),pending_request_id=body['request_id'],phase={'pause':'pausing','resume':'resuming','mark':'marking','restore':'restoring'}[op])
  self.emit_rewind(body,'accepted')
 def complete(self,body,origin='ready'):
  op=body['op'];self.rstate['pending_request_id']=None;self.rstate['phase']='paused' if op=='pause' or op=='mark' and origin=='paused' else 'ready';point=None
  if op=='mark':
   p=fixture('rewind_point.valid.json');point=self.rewind._point_id(body['request_id'],'workload-one');p.update(point_id=point,label=body['params']['label'],source_generation=body['params']['generation'],source_authority_epoch=body['params']['authority_epoch']);self.rstate['points'].append(p);self.rstate['last_good_usable']=point
  if op=='restore':
   point=body['params']['point_id'];self.rstate['last_good_usable']=point
   for p in self.rstate['points']:p['active_references']=int(p['point_id']==point)
  self.emit_rewind(body,'completed',data={'op':op,'point_id':point})
 def operation(self,op,**kwargs):
  future=self.pool.submit(getattr(self.rewind,op),**kwargs);body=self.request();self.accept(body);self.complete(body);value=future.result(timeout=2);self.state=self.sdk.session;return value

class RewindTests(unittest.TestCase):
 def setUp(self):self.h=RewindHarness();self.h.create()
 def tearDown(self):self.h.close()
 def test_pause_resume_same_io_owner_and_no_create(self):
  self.h.operation('pause');self.assertFalse(self.h.rewind.wait_ready(0));self.assertRaises(GuestCommandError,self.h.sdk.start,'echo forbidden')
  s=self.h.operation('resume');self.assertEqual(s['generation'],2);self.assertEqual(self.h.sdk.session['generation'],2);self.assertEqual(len(self.h.core.owners),1)
 def test_after_restore_commands_use_new_binding_old_result_is_retained(self):
  job=self.h.start();self.h.output('stdout',b'old');self.h.finish();old=job.result(timeout=1)
  self.h.operation('mark',label='Point');self.h.operation('pause');point=self.h.rewind.status['last_good_usable'];self.h.operation('restore',point_id=point)
  self.assertEqual(self.h.sdk.last_result,old);self.assertEqual(self.h.sdk.session['generation'],3)
  self.h.state=self.h.sdk.session;new=self.h.start();self.assertEqual(self.h.run_body['params']['generation'],3);self.h.finish();new.result(timeout=1)
 def test_unknown_keeps_fence_and_does_not_retry(self):
  future=self.h.pool.submit(self.h.rewind.pause,timeout_ms=1000);body=self.h.request();self.h.accept(body);self.h.rstate['phase']='uncertain';self.h.emit_rewind(body,'outcome_unknown',data={'op':'pause','code':'NATIVE'})
  self.assertRaises(GuestCommandUnknown,future.result,1);self.assertRaises(RewindError,self.h.rewind.pause);self.assertRaises(GuestCommandError,self.h.sdk.start,'echo bad');self.assertTrue(self.h.core.out.empty())
 def test_local_rewind_cannot_overlap_active_job(self):
  job=self.h.start();self.assertRaises(RewindError,self.h.rewind.pause);self.h.finish();job.result(timeout=1)
 def test_foreign_unknown_cannot_create_ring(self):
  op=self.h.rewind.start('pause');body=self.h.request();s=fixture('rewind_session.valid.json');s.update(owner_id=self.h.sdk._owner,generation=1,authority_epoch=1,phase='uncertain',pending_request_id=body['request_id'])
  e={'schema':'rewind_event/v0.2','event_id':'event-bad','request_id':body['request_id'],'owner_id':self.h.sdk._owner,'event':'outcome_unknown','session':s,'data':{'op':'pause','code':'NATIVE'}}
  with self.h.sdk._lock:self.assertRaises(RewindError,self.h.rewind._handle,e)
  self.assertIsNone(self.h.rewind.status)
 def test_stop_uses_planned_generation_before_ready(self):
  self.h.operation('pause');rw=self.h.rewind.start('resume');body=self.h.request();self.h.accept(body)
  for _ in range(100):
   if rw.accepted:break
   time.sleep(.001)
  future=self.h.pool.submit(self.h.sdk.stop);stop=self.h.request();self.assertEqual(stop['params']['generation'],2)
  self.h.state=self.h.sdk.session;self.h.ack_control(stop);self.h.state.update(phase='stopped',ownership='released');self.h.emit(stop['request_id'],'stopped',{'native_absent':True});future.result(timeout=1);self.assertTrue(self.h.sdk.closed);self.assertRaises(GuestCommandUnknown,rw.result,1)
 def test_typed_shapes_and_family_crosspair(self):
  b=fixture('rewind_request.valid.pause.json');self.assertEqual(RewindRequest.parse(b).value,b)
  b['path']='/tmp/escape';self.assertRaises(RewindError,RewindRequest.parse,b)
  b=fixture('rewind_request.valid.pause.json');e=make_envelope(msg_id='x',from_component='agent',from_instance='agent-one',to_component='core',to_instance='core-one',session_id='session-one',seq=1,body=b);self.assertEqual(e['schema'],'rewind_envelope/v0.2')
  e['schema']='capsule_envelope/v0.2';self.assertRaises(EnvelopeError,validate_envelope,e)
 def test_owned_ui_creation_can_be_observed_without_send(self):
  self.h.close();self.h=RewindHarness();self.h.sdk._observe_owned=True
  self.h.rid=_reservation('session-one','request-ui-create');self.h.state={'schema':'guest_command_session/v0.2','workload_id':'workload-one','generation':1,'owner_id':self.h.sdk._owner,'profile_id':'guest-command-arm64-v1','backend':'firecracker','isa':'aarch64','phase':'starting','ownership':'held','jobs_started':0,'job':None,'controls':{'cancel':None,'stop':None}}
  self.h.emit('request-ui-create','accepted',{'op':'create'});self.h.state['phase']='ready';self.h.emit('request-ui-create','ready',{})
  self.assertTrue(self.h.rewind.wait_ready(1));self.assertTrue(self.h.core.out.empty());self.assertEqual(self.h.rewind.target['authority_epoch'],1)
 def test_toolclient_exposes_existing_claim(self):self.assertIs(self.h.client.rewind,self.h.rewind);self.assertIs(self.h.client.guest_commands,self.h.sdk)

if __name__=='__main__':unittest.main()

class RewindAdditionalTests(unittest.TestCase):
 def setUp(self):self.h=RewindHarness();self.h.create()
 def tearDown(self):self.h.close()
 def test_stale_tuple_rejected_without_commit(self):
  op=self.h.rewind.start('pause');body=self.h.request();s=fixture('rewind_session.valid.json');s.update(owner_id=self.h.sdk._owner,workload_id='workload-one',generation=2,authority_epoch=1,phase='pausing',pending_request_id=body['request_id'],points=[],last_good_usable=None)
  e={'schema':'rewind_event/v0.2','event_id':'event-stale','request_id':body['request_id'],'owner_id':self.h.sdk._owner,'event':'accepted','session':s,'data':{'op':'pause'}}
  with self.h.sdk._lock:self.assertRaises(RewindError,self.h.rewind._handle,e)
  self.assertIsNone(self.h.rewind.status);self.assertFalse(op.accepted)
 def test_timeout_never_reissues(self):
  op=self.h.rewind.start('pause');self.h.request()
  with self.h.sdk._lock:op.deadline=time.monotonic()-1;self.h.rewind._poll(time.monotonic())
  self.assertRaises(GuestCommandUnknown,op.result,1);self.assertTrue(self.h.core.out.empty());self.assertRaises(RewindError,self.h.rewind.start,'pause')
 def test_failed_restore_needs_recovery_then_new_manual_id(self):
  self.h.operation('mark',label='Point');self.h.operation('pause');point=self.h.rewind.status['last_good_usable']
  op=self.h.rewind.start('restore',point_id=point);body=self.h.request();self.h.accept(body);self.h.rstate['phase']='uncertain';self.h.emit_rewind(body,'outcome_unknown',data={'op':'restore','code':'NATIVE'});self.assertRaises(GuestCommandUnknown,op.result,1)
  self.h.rstate.update(phase='recoverable',pending_request_id=None)
  for p in self.h.rstate['points']:p['active_references']=0
  self.h.emit_rewind(body,'recovery_ready',data={'op':'restore','failed_request_id':body['request_id'],'point_id':point,'no_active_vmm':True})
  until=time.monotonic()+1
  while self.h.rewind.status['phase']!='recoverable' and time.monotonic()<until:time.sleep(.001)
  self.assertEqual(self.h.rewind.status['phase'],'recoverable');self.assertTrue(self.h.core.out.empty());new=self.h.rewind.start('restore',point_id=point);self.assertNotEqual(new.request_id,op.request_id);self.h.request();self.assertRaises(GuestCommandUnknown,op.result,1)
 def test_typed_body_copy_is_not_mutable_authority(self):
  b=fixture('rewind_request.valid.pause.json');typed=RewindRequest.parse(b);b['op']='restore';copied=typed.value;copied['params']['generation']=99;self.assertEqual(typed.value['op'],'pause');self.assertEqual(typed.value['params']['generation'],2)

class RewindSocketTests(unittest.TestCase):
 def test_new_family_traverses_actual_single_owner_socket(self):
  import socket,threading
  from metaviewer_agents.client import CoreClient,ClientError
  from metaviewer_agents.envelope import dumps_envelope
  left,right=socket.socketpair();self.addCleanup(left.close);self.addCleanup(right.close)
  c=CoreClient('/unused',timeout_s=1,max_line_bytes=200000,max_reply_bytes=200000);c._sock=left;c._io_owner=threading.get_ident();self.addCleanup(c.close)
  body=fixture('rewind_request.valid.pause.json');frame=make_envelope(msg_id='rw-socket',from_component='core',from_instance='core-one',to_component='agent',to_instance='agent-one',session_id='session-one',seq=1,body=body)
  raw=dumps_envelope(frame,max_bytes=200000);right.sendall(raw[:15]);self.assertIsNone(c.recv_nowait());right.sendall(raw[15:]);self.assertEqual(c.recv_nowait()['schema'],'rewind_envelope/v0.2')
  refused=[]
  def foreign():
   try:c.recv_nowait()
   except ClientError:refused.append(True)
  thread=threading.Thread(target=foreign);thread.start();thread.join();self.assertEqual(refused,[True])

class NullUnknownTests(unittest.TestCase):
 def setUp(self):self.h=RewindHarness();self.h.create()
 def tearDown(self):self.h.close()
 def emit_null(self,body):
  self.h.seq+=1
  event={'schema':'rewind_event/v0.2','event_id':'event-null-'+str(self.h.seq),'request_id':body['request_id'],'owner_id':self.h.sdk._owner,'event':'outcome_unknown','session':None,'data':{'op':body['op'],'code':'NATIVE'}}
  self.h.core.incoming.put(make_envelope(msg_id='null-'+str(self.h.seq),from_component='core',from_instance='core-one',to_component='agent',to_instance='agent-one',session_id='session-one',seq=self.h.seq,body=event))
 def test_admitted_unknown_null_keeps_planned_stop_generation(self):
  op=self.h.rewind.start('mark',label='First');body=self.h.request();self.emit_null(body);self.assertRaises(GuestCommandUnknown,op.result,1)
  self.assertIsNone(self.h.rewind.status);self.assertEqual(self.h.rewind.target['generation'],2);self.assertRaises(GuestCommandError,self.h.sdk.start,'echo bad')
  future=self.h.pool.submit(self.h.sdk.stop);stop=self.h.request();self.assertEqual(stop['params']['generation'],2)
  self.h.state=self.h.sdk.session;self.h.ack_control(stop);self.h.state.update(phase='stopped',ownership='released');self.h.emit(stop['request_id'],'stopped',{'native_absent':True});future.result(timeout=1)
 def test_true_preadmission_refusal_leaves_old_target_usable(self):
  op=self.h.rewind.start('mark',label='First');body=self.h.request();self.h.emit_rewind(body,'refused',state=None,data={'op':'mark','code':'UNAVAILABLE'})
  self.assertRaises(RewindError,op.result,1);self.assertEqual(self.h.rewind.target['generation'],1);self.assertTrue(self.h.rewind.command_allowed())
 def test_passive_unknown_null_keeps_observer_fenced(self):
  self.h.sdk._observe_owned=True;self.emit_null({'request_id':'request-ui-mark','op':'mark'})
  until=time.monotonic()+1
  while self.h.rewind.target['generation']!=2 and time.monotonic()<until:time.sleep(.001)
  self.assertEqual(self.h.rewind.target['generation'],2);self.assertFalse(self.h.rewind.command_allowed());self.assertTrue(self.h.core.out.empty())

class RewindCallbackTests(unittest.TestCase):
 def test_sync_callback_refuses_before_enqueue(self):
  h=RewindHarness();h.create()
  try:
   observed=[];op=h.rewind.start('pause');body=h.request()
   def callback(_):
    try:h.rewind.resume()
    except RewindError:observed.append(True)
   op._future.add_done_callback(callback);h.accept(body);h.complete(body);op.result(1)
   until=time.monotonic()+1
   while not observed and time.monotonic()<until:time.sleep(.001)
   self.assertEqual(observed,[True]);self.assertTrue(h.core.out.empty())
  finally:h.close()
 def test_typed_parser_rejects_surrogate(self):
  b=fixture('rewind_request.valid.mark.json');b['params']['label']='bad\ud800';self.assertRaises(RewindError,RewindRequest.parse,b)

class RecoveryReplayTests(unittest.TestCase):
 def test_consumed_recovery_cannot_replace_next_restore(self):
  h=RewindHarness();h.create()
  try:
   h.operation('mark',label='Point');h.operation('pause');point=h.rewind.status['last_good_usable']
   first=h.rewind.start('restore',point_id=point);body=h.request();h.accept(body);h.rstate['phase']='uncertain';h.emit_rewind(body,'outcome_unknown',data={'op':'restore','code':'NATIVE'})
   self.assertRaises(GuestCommandUnknown,first.result,1);h.rstate.update(phase='recoverable',pending_request_id=None)
   for p in h.rstate['points']:p['active_references']=0
   old_state=copy.deepcopy(h.rstate)
   h.emit_rewind(body,'recovery_ready',data={'op':'restore','failed_request_id':body['request_id'],'point_id':point,'no_active_vmm':True})
   until=time.monotonic()+1
   while h.rewind.status['phase']!='recoverable' and time.monotonic()<until:time.sleep(.001)
   self.assertIn(first.request_id,h.rewind._recovered)
   second=h.rewind.start('restore',point_id=point);newbody=h.request();h.accept(newbody);self.assertTrue(second.wait_accepted(1));target=h.rewind.target
   old={'schema':'rewind_event/v0.2','event_id':'event-old-again','request_id':body['request_id'],'owner_id':h.sdk._owner,'event':'recovery_ready','session':old_state,'data':{'op':'restore','failed_request_id':body['request_id'],'point_id':point,'no_active_vmm':True}}
   with h.sdk._lock:self.assertRaises(RewindError,h.rewind._handle,old)
   self.assertEqual(h.rewind.target,target);self.assertIs(h.rewind._pending,second);self.assertTrue(first.unknown)
   old['event_id']='event-old-unknown-again';old['event']='outcome_unknown';old['session']['phase']='uncertain';old['session']['pending_request_id']=first.request_id;old['data']={'op':'restore','code':'NATIVE'}
   with h.sdk._lock:self.assertRaises(RewindError,h.rewind._handle,old)
   self.assertEqual(h.rewind.target,target);self.assertIs(h.rewind._pending,second)
  finally:h.close()
