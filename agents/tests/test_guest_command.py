"""Pure/mock SDK tests. No guest, core daemon, shell or network provider."""
import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import json
import queue
import socket
import threading
import time
import unittest

from metaviewer_agents.client import ToolClient, CoreClient, ClientError
from metaviewer_agents.envelope import make_envelope, dumps_envelope, loads_envelope
from metaviewer_agents.guest_command import GuestCommandSession, GuestCommandError, GuestCommandUnknown, _reservation, _command, _heartbeat_due


class FakeCore:
    def __init__(self):
        self._last_received_seq = 0
        self._io_owner = None
        self._timeout_s = 1
        self.next_seq = 1
        self.out = queue.Queue()
        self.incoming = queue.Queue()
        self.closed = False
        self.owners = set()
        self.reserved = 0

    def send(self, envelope):
        assert self._io_owner == threading.get_ident()
        assert self.reserved == envelope['seq']
        self.owners.add(threading.get_ident())
        self.next_seq += 1
        self.out.put(copy.deepcopy(envelope['body']))

    def recv_nowait(self):
        assert self._io_owner == threading.get_ident()
        self.owners.add(threading.get_ident())
        if self.closed:raise ClientError('socket', 'closed')
        try:return self.incoming.get_nowait()
        except queue.Empty:return None

    def close(self):self.closed = True


class Harness:
    def __init__(self):
        self.client = ToolClient('/unused', session_id='session-one', local={'endpoint': {'component':'agent','instance':'agent-one'}}, core={'endpoint':{'component':'core','instance':'core-one'}}, dependency_pins=[],sequence_path='/unused',timeout_s=1,max_line_bytes=200000,max_reply_bytes=200000)
        self.core = self.client.active = FakeCore()
        self.client._ready = True
        self.client._reserve = lambda: setattr(self.core,'reserved',self.core.next_seq)
        self.sdk = GuestCommandSession.claim(self.client)
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.seq = 0
        self.state = None
        self.rid = None
        self.run_body = None
        self.buffers = {'stdout':b'', 'stderr':b''}

    def close(self):
        self.sdk.close()
        self.pool.shutdown(wait=True)

    def request(self):return self.core.out.get(timeout=1)

    def emit(self, request_id, event, data, state=None, **overrides):
        self.seq += 1
        body={'schema':'guest_command_event/v0.2','event_id':'event-'+str(self.seq),'request_id':request_id,'reservation_id':self.rid,'owner_id':self.sdk._owner,'session':copy.deepcopy(self.state if state is None else state),'event':event,'data':data}
        body.update(overrides)
        self.core.incoming.put(make_envelope(msg_id='message-'+str(self.seq),from_component='core',from_instance='core-one',to_component='agent',to_instance='agent-one',session_id='session-one',seq=self.seq,body=body))

    def create(self):
        result=self.pool.submit(self.sdk.create,timeout_ms=1000)
        body=self.request();self.rid=_reservation('session-one',body['request_id'])
        self.state={'schema':'guest_command_session/v0.2','workload_id':'workload-one','generation':1,'owner_id':self.sdk._owner,'profile_id':'guest-command-arm64-v1','backend':'firecracker','isa':'aarch64','phase':'starting','ownership':'held','jobs_started':0,'job':None,'controls':{'cancel':None,'stop':None}}
        self.emit(body['request_id'],'accepted',{'op':'create'})
        self.state['phase']='ready';self.emit(body['request_id'],'ready',{})
        return result.result(timeout=2)

    def start(self, command='printf ok', **kwargs):
        self.buffers={'stdout':b'','stderr':b''}
        handle=self.sdk.start(command,**kwargs);body=self.request();self.run_body=body
        self.state['phase']='running';self.state['jobs_started']+=1;self.state['controls']={'cancel':None,'stop':None}
        self.state['job']={'job_id':body['params']['job_id'],'state':'running','exit_code':None,'signal':None,'stdout_bytes':0,'stderr_bytes':0,'output_complete':False}
        self.emit(body['request_id'],'accepted',{'op':'run'})
        assert handle.wait_accepted(1)
        return handle

    def output(self, stream, raw):
        index=0 if not self.buffers[stream] else 1
        self.buffers[stream]+=raw;self.state['job'][stream+'_bytes']=len(self.buffers[stream])
        self.emit(self.run_body['request_id'],'output',{'job_id':self.run_body['params']['job_id'],'stream':stream,'chunk_index':index,'data_b64':base64.b64encode(raw).decode()})

    def finish(self, cause='exit', bad_hash=False):
        self.state['job'].update(state={'exit':'exited','cancel':'cancelled','stop':'cancelled','timeout':'timed_out','output_limit':'output_limit'}[cause],exit_code=0,signal=None,output_complete=cause!='output_limit')
        self.state['phase']='awaiting_control' if any(c is not None and c['ack']=='pending' for c in self.state['controls'].values()) else ('stopping' if self.state['controls']['stop'] is not None else 'ready')
        data={'job_id':self.run_body['params']['job_id'],'cause':cause,'guest_job_empty':True}
        for stream in ('stdout','stderr'):
            data[stream+'_sent_bytes']=len(self.buffers[stream]);data[stream+'_sha256']=hashlib.sha256(self.buffers[stream]).hexdigest()
        if bad_hash:data['stdout_sha256']='0'*64
        for ctl in ('cancel','stop'):
            entry=self.state['controls'][ctl];data[ctl+'_request_id']=entry['request_id'] if entry and entry['ack']=='accepted' else None
        self.emit(self.run_body['request_id'],'job_finished',data)

    def ack_control(self, body):
        op=body['op'];self.state['controls'][op]={'request_id':body['request_id'],'ack':'accepted'};self.state['phase']='cancelling' if op=='cancel' else 'stopping';self.emit(body['request_id'],'accepted',{'op':op})


class GuestCommandTests(unittest.TestCase):
    def setUp(self):self.h=Harness();self.addCleanup(self.h.close)

    def starting_stop(self):
        create=self.h.pool.submit(self.h.sdk.create,timeout_ms=1000);body=self.h.request();self.h.rid=_reservation('session-one',body['request_id'])
        self.h.state={'schema':'guest_command_session/v0.2','workload_id':'workload-one','generation':1,'owner_id':self.h.sdk._owner,'profile_id':'guest-command-arm64-v1','backend':'firecracker','isa':'aarch64','phase':'starting','ownership':'held','jobs_started':0,'job':None,'controls':{'cancel':None,'stop':None}}
        self.h.emit(body['request_id'],'accepted',{'op':'create'})
        end=time.monotonic()+1
        while self.h.sdk.session is None and time.monotonic()<end:time.sleep(.005)
        stop=self.h.pool.submit(self.h.sdk.stop,timeout_ms=1000);stop_body=self.h.request()
        self.h.state['controls']['stop']={'request_id':stop_body['request_id'],'ack':'pending'}
        return create,body,stop,stop_body

    def test_ready_normalizes_starting_stop_without_consuming_stop(self):
        create,body,stop,stop_body=self.starting_stop();self.h.state['phase']='awaiting_control'
        self.h.emit(body['request_id'],'ready',{})
        self.assertEqual(create.result(1)['phase'],'awaiting_control');self.assertFalse(stop.done())
        with self.assertRaises(GuestCommandError):self.h.sdk.start('pwd')
        self.h.ack_control(stop_body);self.h.state.update(phase='stopped',ownership='released');self.h.emit(stop_body['request_id'],'stopped',{'native_absent':True});stop.result(1)

    def test_ready_cannot_hide_pending_control_with_ready_phase(self):
        create,body,stop,stop_body=self.starting_stop();self.h.state['phase']='ready'
        self.h.emit(body['request_id'],'ready',{})
        with self.assertRaises(GuestCommandUnknown):create.result(1)
        with self.assertRaises(GuestCommandUnknown):stop.result(1)

    def test_owner_pump_keepalive_without_waiting_ten_seconds(self):
        self.h.create()
        with self.h.sdk._lock:self.h.sdk._last_send=time.monotonic()-10.0
        self.h.sdk._wake.set()
        self.assertEqual(self.h.request(),{'schema':'surface_request/v0.2','op':'list','params':{}})
        self.assertEqual(len(self.h.core.owners),1)
        self.assertFalse(self.h.sdk.uncertain)

    def test_fake_clock_heartbeat_boundary(self):
        self.assertFalse(_heartbeat_due(109.999,100))
        self.assertTrue(_heartbeat_due(110,100))
        self.assertFalse(_heartbeat_due(105,110))

    def test_two_jobs_bytes_and_one_io_owner(self):
        self.h.create();h=self.h.start('cat',stdin=b'\0data',cwd='')
        self.h.output('stdout',b'\0out');self.h.output('stderr',b'warning');self.h.finish()
        result=h.result(1);self.assertEqual(result['stdout'],b'\0out');self.assertEqual(result['stderr'],b'warning')
        h2=self.h.start('pwd',cwd='folder');self.assertEqual(self.h.run_body['params']['cwd'],'folder');self.h.finish();h2.result(1)
        self.assertEqual(len(self.h.core.owners),1)
        with self.assertRaises(ClientError):self.h.client.request({},'',timeout_ms=1)
        with self.assertRaises(GuestCommandError):GuestCommandSession.claim(self.h.client)

    def test_cancel_does_not_consume_run_terminal(self):
        self.h.create();handle=self.h.start()
        cancel=self.h.pool.submit(self.h.sdk.cancel,timeout_ms=1000);body=self.h.request();self.assertEqual(body['op'],'cancel');self.h.ack_control(body)
        cancel.result(1);self.assertFalse(handle.done());self.h.finish('cancel')
        self.assertEqual(handle.result(1)['cause'],'cancel')

    def test_stop_independent_and_requires_native_closure(self):
        self.h.create();handle=self.h.start()
        stop=self.h.pool.submit(self.h.sdk.stop,timeout_ms=1000);body=self.h.request();self.h.ack_control(body)
        self.h.finish('stop');handle.result(1);self.assertFalse(stop.done())
        self.h.state.update(phase='stopped',ownership='released');self.h.emit(body['request_id'],'stopped',{'native_absent':True})
        self.assertEqual(stop.result(1)['ownership'],'released');self.assertTrue(self.h.sdk.closed)

    def test_lost_cancel_ack_preserves_finished_job_and_fences(self):
        self.h.create();handle=self.h.start();cancel=self.h.pool.submit(self.h.sdk.cancel,timeout_ms=1000);body=self.h.request()
        self.h.state['controls']['cancel']={'request_id':body['request_id'],'ack':'pending'}
        self.h.finish();saved=handle.result(1)
        self.h.state['phase']='uncertain';self.h.emit(body['request_id'],'outcome_unknown',{'op':'cancel','code':'TRANSPORT'})
        with self.assertRaises(GuestCommandUnknown):cancel.result(1)
        self.assertEqual(self.h.sdk.last_result,saved)
        with self.assertRaises(GuestCommandError):self.h.sdk.start('pwd')

    def test_stop_while_run_ack_is_pending_keeps_both_operations(self):
        self.h.create();handle=self.h.sdk.start('sleep 1');run=self.h.request();self.h.run_body=run
        with self.assertRaises(GuestCommandError):self.h.sdk.cancel()
        stop=self.h.pool.submit(self.h.sdk.stop,timeout_ms=1000);body=self.h.request()
        self.h.state['phase']='running';self.h.state['jobs_started']=1
        self.h.state['job']={'job_id':run['params']['job_id'],'state':'running','exit_code':None,'signal':None,'stdout_bytes':0,'stderr_bytes':0,'output_complete':False}
        self.h.emit(run['request_id'],'accepted',{'op':'run'})
        self.assertTrue(handle.wait_accepted(1));self.h.ack_control(body);self.h.finish('stop');handle.result(1)
        self.h.state.update(phase='stopped',ownership='released');self.h.emit(body['request_id'],'stopped',{'native_absent':True});stop.result(1)

    def test_unknown_can_reconcile_explicit_stop_without_replaying_run(self):
        self.h.create();handle=self.h.start();self.h.state['phase']='uncertain';self.h.state['job']['state']='unknown'
        self.h.emit(self.h.run_body['request_id'],'outcome_unknown',{'op':'run','code':'TRANSPORT'})
        with self.assertRaises(GuestCommandUnknown):handle.result(1)
        stop=self.h.pool.submit(self.h.sdk.stop,timeout_ms=1000);body=self.h.request();self.assertEqual(body['op'],'stop');self.h.ack_control(body)
        self.h.state.update(phase='stopped',ownership='released');self.h.emit(body['request_id'],'stopped',{'native_absent':True});self.assertEqual(stop.result(1)['ownership'],'released')

    def test_bad_hash_is_unknown_not_completion(self):
        self.h.create();h=self.h.start();self.h.output('stdout',b'ok');self.h.finish(bad_hash=True)
        with self.assertRaises(GuestCommandUnknown):h.result(1)
        self.assertIsNone(self.h.sdk.last_result);self.assertTrue(self.h.sdk.uncertain)

    def test_idle_create_correlated_unknown(self):
        self.h.create();rid=self.h.sdk._create.request_id
        self.h.state['phase']='uncertain';self.h.emit(rid,'outcome_unknown',{'op':'create','code':'TRANSPORT'})
        deadline=time.monotonic()+1
        while not self.h.sdk.uncertain and time.monotonic()<deadline:time.sleep(.005)
        self.assertTrue(self.h.sdk.uncertain);self.assertFalse(self.h.sdk.closed)

    def test_foreign_owner_and_event_replay_refuse(self):
        self.h.create();h=self.h.start();self.h.emit(self.h.run_body['request_id'],'outcome_unknown',{'op':'run','code':'TRANSPORT'},owner_id='actor-foreign')
        with self.assertRaises(GuestCommandUnknown):h.result(1)

    def test_run_deadline_no_retry(self):
        self.h.create();h=self.h.start(timeout_ms=1)
        with self.h.sdk._lock:h.deadline=time.monotonic()-1
        with self.assertRaises(GuestCommandUnknown):h.result(1)
        self.assertTrue(self.h.core.out.empty())

    def test_late_stopped_discharge_does_not_rewrite_unknown_stop(self):
        self.h.create();stop=self.h.pool.submit(self.h.sdk.stop,timeout_ms=1000);body=self.h.request();self.h.ack_control(body)
        with self.h.sdk._lock:self.h.sdk._ops[body['request_id']].deadline=time.monotonic()-1
        with self.assertRaises(GuestCommandUnknown):stop.result(1)
        self.h.state.update(phase='stopped',ownership='released');self.h.emit(body['request_id'],'stopped',{'native_absent':True})
        end=time.monotonic()+1
        while not self.h.sdk.closed and time.monotonic()<end:time.sleep(.005)
        self.assertTrue(self.h.sdk.closed)
        with self.assertRaises(GuestCommandUnknown):stop.result()

    def test_invalid_acceptance_does_not_publish_accepted_flag(self):
        self.h.create();handle=self.h.sdk.start('pwd');body=self.h.request()
        self.h.state.update(phase='running',jobs_started=1)
        self.h.state['job']={'job_id':body['params']['job_id'],'state':'running','exit_code':None,'signal':None,'stdout_bytes':0,'stderr_bytes':0,'output_complete':False}
        self.h.state['controls']['stop']={'request_id':'request-foreign','ack':'accepted'}
        self.h.emit(body['request_id'],'accepted',{'op':'run'})
        with self.assertRaises(GuestCommandUnknown):handle.result(1)
        self.assertFalse(handle.accepted)

    def test_terminal_cannot_invent_cancel_acceptance(self):
        self.h.create();handle=self.h.start();cancel=self.h.pool.submit(self.h.sdk.cancel,timeout_ms=1000);body=self.h.request()
        self.h.state['controls']['cancel']={'request_id':body['request_id'],'ack':'accepted'};self.h.finish('cancel')
        with self.assertRaises(GuestCommandUnknown):handle.result(1)
        with self.assertRaises(GuestCommandUnknown):cancel.result(1)
        self.assertIsNone(self.h.sdk.last_result)

    def test_output_sequence_gap_and_readonly_handle(self):
        self.h.create();handle=self.h.start();snapshot=handle.body;snapshot['params']['command_utf8']='changed';self.assertNotEqual(snapshot,handle.body)
        with self.assertRaises(AttributeError):handle.request_id='request-changed'
        self.h.state['job']['stdout_bytes']=1
        self.h.emit(self.h.run_body['request_id'],'output',{'job_id':handle.job_id,'stream':'stdout','chunk_index':1,'data_b64':'YQ=='})
        with self.assertRaises(GuestCommandUnknown):handle.result(1)

    def test_refused_run_before_ack_is_not_unknown(self):
        self.h.create();handle=self.h.sdk.start('pwd');body=self.h.request();self.h.emit(body['request_id'],'refused',{'op':'run','code':'CAPACITY'})
        with self.assertRaises(GuestCommandError):handle.result(1)
        self.assertFalse(self.h.sdk.uncertain);self.assertIsNone(self.h.sdk._run)

    def test_invalid_local_parameters_never_send(self):
        self.h.create()
        for command,cwd,stdin in [('x','../x',b''),('bad\0','',b''),('x','a'*256,b''),('x','',b'x'*49153)]:
            with self.assertRaises(ValueError):self.h.sdk.start(command,cwd=cwd,stdin=stdin)
        self.assertTrue(self.h.core.out.empty())


class WirePumpTests(unittest.TestCase):
    def make_client(self):
        a,b=socket.socketpair();self.addCleanup(a.close);self.addCleanup(b.close)
        c=CoreClient('/unused',timeout_s=.05,max_line_bytes=200000,max_reply_bytes=200000);c._sock=a;c._io_owner=threading.get_ident();self.addCleanup(c.close)
        return c,b
    def frame(self):
        return make_envelope(msg_id='hello',from_component='core',from_instance='core-one',to_component='agent',to_instance='agent-one',session_id='session-one',seq=1,body={'schema':'surface_request/v0.2','op':'list','params':{}})
    def test_fragmented_actual_frames_and_duplicate_json(self):
        c,b=self.make_client();raw=dumps_envelope(self.frame(),max_bytes=200000);b.sendall(raw[:17]);self.assertIsNone(c.recv_nowait());b.sendall(raw[17:]);self.assertEqual(c.recv_nowait()['seq'],1)
        raw=raw.replace(b'{',b'{"seq":1,',1);b.sendall(raw)
        with self.assertRaises(ClientError):c.recv_nowait()
    def test_partial_deadline_not_renewed(self):
        c,b=self.make_client();b.sendall(b'{');self.assertIsNone(c.recv_nowait());time.sleep(.06)
        with self.assertRaises(ClientError):c.recv_nowait()
    def test_keepalive_actual_socketpair_uses_the_single_owner(self):
        left,right=socket.socketpair();right.settimeout(1)
        client=ToolClient('/unused',session_id='session-one',local={'endpoint':{'component':'agent','instance':'agent-one'}},core={'endpoint':{'component':'core','instance':'core-one'}},dependency_pins=[],sequence_path='/unused',timeout_s=1,max_line_bytes=200000,max_reply_bytes=200000)
        client.active._sock=left;client.active._next_seq=7;client.active._last_received_seq=3;client._ready=True
        reservations=[];client._reserve=lambda:reservations.append(client.active.next_seq)
        sdk=GuestCommandSession.claim(client)
        try:
            with sdk._lock:sdk._last_send=time.monotonic()-10
            sdk._wake.set();raw=bytearray()
            while not raw.endswith(b'\n'):raw.extend(right.recv(4096))
            frame=loads_envelope(bytes(raw),max_bytes=200000)
            self.assertEqual(frame['seq'],7);self.assertEqual(reservations,[7])
            self.assertEqual(frame['body'],{'schema':'surface_request/v0.2','op':'list','params':{}})
            self.assertEqual(client.active._io_owner,sdk._thread.ident)
            with self.assertRaises(ClientError):client.active.recv_nowait()
        finally:
            sdk.close();right.close()

    def test_foreign_thread_cannot_read(self):
        c,b=self.make_client();result=[]
        def attempt():
            try:c.recv_nowait()
            except ClientError:result.append(True)
        t=threading.Thread(target=attempt);t.start();t.join();self.assertEqual(result,[True])
