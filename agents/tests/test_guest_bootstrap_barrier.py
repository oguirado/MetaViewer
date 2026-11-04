"""Mock-only causal bootstrap fence; no guest, daemon or native process."""
import copy
import hashlib
import queue
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

from test_guest_command import FakeCore, Harness
from test_rewind_sdk import RewindHarness
from metaviewer_agents.client import ToolClient
from metaviewer_agents.envelope import make_envelope
from metaviewer_agents.guest_command import GuestCommandSession, GuestCommandError, _reservation
from metaviewer_agents.rewind import RewindError


class ObserverHarness(Harness):
    def __init__(self):
        self.client = ToolClient('/unused', session_id='session-one', local={'endpoint': {'component':'agent','instance':'agent-one'}}, core={'endpoint':{'component':'core','instance':'core-one'}}, dependency_pins=[],sequence_path='/unused',timeout_s=1,max_line_bytes=200000,max_reply_bytes=200000)
        self.core = self.client.active = FakeCore()
        self.client._ready = True
        self.client._reserve = lambda: setattr(self.core,'reserved',self.core.next_seq)
        self.sdk = GuestCommandSession.claim(self.client, observe_owned=True)
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.seq = 0
        self.state = None
        self.rid = None
        self.run_body = None
        self.buffers = {'stdout':b'', 'stderr':b''}
        self.rewind = self.sdk.rewind
        self.rstate = None

    emit_rewind = RewindHarness.emit_rewind

    def history_ready(self):
        self.rid = _reservation('session-one','request-history-create')
        self.state = {'schema':'guest_command_session/v0.2','workload_id':'workload-one','generation':1,'owner_id':self.sdk._owner,'profile_id':'guest-command-arm64-v1','backend':'firecracker','isa':'aarch64','phase':'starting','ownership':'held','jobs_started':0,'job':None,'controls':{'cancel':None,'stop':None}}
        self.emit('request-history-create','accepted',{'op':'create'})
        self.state['phase']='ready'
        self.emit('request-history-create','ready',{})
        until(lambda:self.sdk._session is not None and self.sdk._session['phase']=='ready')

    def fence(self, request, mutate=None):
        self.seq += 1
        body={'schema':'mv_tool_result/v0.2','request_id':request['request_id'],'op':'list','status':'ok','surfaces':[],'next_cursor':None}
        envelope=make_envelope(msg_id='message-'+str(self.seq),from_component='core',from_instance='core-one',to_component='agent',to_instance='agent-one',session_id='session-one',seq=self.seq,body=body)
        if mutate:mutate(envelope)
        self.core.incoming.put(envelope)


def until(predicate):
    deadline=time.monotonic()+1
    while not predicate() and time.monotonic()<deadline:time.sleep(.001)
    if not predicate():raise AssertionError('mock condition timed out')


class GuestBootstrapBarrierTests(unittest.TestCase):
    def fixture(self):
        h=ObserverHarness();self.addCleanup(h.close)
        request=h.request()
        self.assertEqual(request['schema'],'mv_tool_call/v0.2')
        self.assertEqual(request['op'],'list')
        self.assertEqual(request['args'],{'limit':1,'cursor':None})
        return h,request

    def test_initial_ready_cannot_send_before_complete_history_and_exact_fence(self):
        h,fence=self.fixture();h.history_ready()
        self.assertIsNotNone(h.sdk._rewind)
        self.assertIsNone(h.sdk.session)
        self.assertFalse(h.client.rewind.wait_ready(timeout=.01))
        self.assertIsNone(h.client.rewind.target)
        for operation in (lambda:h.sdk.start('printf new-task'),lambda:h.sdk.create(),lambda:h.sdk.stop(),lambda:h.client.rewind.mark('before'),lambda:h.client.rewind.restore('point-fixture')):
            with self.assertRaises((GuestCommandError,RewindError)):operation()
        self.assertTrue(h.core.out.empty())
        h.state.update(phase='running',jobs_started=1,job={'job_id':'job-history','state':'running','exit_code':None,'signal':None,'stdout_bytes':0,'stderr_bytes':0,'output_complete':False})
        h.emit('request-history-run','accepted',{'op':'run'})
        h.state['phase']='ready';h.state['job'].update(state='exited',exit_code=0,output_complete=True)
        digest=hashlib.sha256(b'').hexdigest()
        h.emit('request-history-run','job_finished',{'job_id':'job-history','cause':'exit','guest_job_empty':True,'stdout_sent_bytes':0,'stderr_sent_bytes':0,'stdout_sha256':digest,'stderr_sha256':digest,'cancel_request_id':None,'stop_request_id':None})
        h.fence(fence)
        self.assertTrue(h.client.rewind.wait_ready(timeout=1))
        self.assertFalse(h.sdk.uncertain)
        self.assertEqual(h.sdk.session['jobs_started'],1)
        handle=h.sdk.start('printf new-task')
        request=h.request();self.assertEqual(request['params']['command_utf8'],'printf new-task')
        h.run_body=request
        h.state.update(phase='running',jobs_started=2,job={'job_id':request['params']['job_id'],'state':'running','exit_code':None,'signal':None,'stdout_bytes':0,'stderr_bytes':0,'output_complete':False})
        h.emit(request['request_id'],'accepted',{'op':'run'})
        self.assertTrue(handle.wait_accepted(timeout=1))
        h.output('stdout',b'new-task');h.finish()
        self.assertEqual(handle.result(timeout=1)['stdout'],b'new-task')
        self.assertFalse(h.sdk.uncertain)

    def test_rewind_history_is_consumed_before_exposing_advanced_generation(self):
        h,fence=self.fixture();h.history_ready()
        mark={'request_id':'request-history-mark','op':'mark','params':{'workload_id':'workload-one','generation':1,'authority_epoch':1,'label':'Historical point'}}
        RewindHarness.accept(h,mark);RewindHarness.complete(h,mark)
        until(lambda:h.sdk._session['generation']==2)
        self.assertIsNone(h.sdk.session)
        self.assertIsNone(h.client.rewind.status)
        self.assertIsNone(h.client.rewind.target)
        self.assertFalse(h.client.rewind.wait_ready(timeout=.01))
        self.assertTrue(h.core.out.empty())
        h.fence(fence)
        self.assertTrue(h.client.rewind.wait_ready(timeout=1))
        self.assertEqual(h.sdk.session['generation'],2)
        self.assertEqual(h.client.rewind.target['generation'],2)
        self.assertEqual(len(h.client.rewind.status['points']),1)
        h.client.rewind.start('mark',label='Next point')
        self.assertEqual(h.request()['params']['generation'],2)

    def test_wrong_malformed_foreign_duplicate_and_early_fence_fail_closed(self):
        mutations=[lambda e:e['body'].update(request_id='foreign-request'),lambda e:e['body'].update(op='observe'),lambda e:e['body'].update(extra=True),lambda e:e['from'].update(instance='foreign-core'),lambda e:e['body'].update(status='error'),lambda e:e.update(seq=1)]
        for mutate in mutations:
            with self.subTest(mutation=mutations.index(mutate)):
                h,fence=self.fixture();h.history_ready();h.fence(fence,mutate)
                until(lambda:h.sdk.uncertain)
                self.assertFalse(h.client.rewind.wait_ready(timeout=.01))
                self.assertIsNone(h.sdk.session)
                self.assertTrue(h.core.out.empty())
        h,fence=self.fixture();h.fence(fence)
        until(lambda:h.sdk.uncertain)
        self.assertFalse(h.client.rewind.wait_ready(timeout=.01))
        self.assertTrue(h.core.out.empty())

    def test_timeout_disconnect_and_duplicate_result_never_retry(self):
        for mode in ('timeout','disconnect','duplicate'):
            with self.subTest(mode=mode):
                h,fence=self.fixture();h.history_ready()
                if mode=='timeout':h.sdk._bootstrap_deadline=time.monotonic()-1;h.sdk._wake.set()
                elif mode=='disconnect':h.core.close()
                else:
                    h.fence(fence);self.assertTrue(h.client.rewind.wait_ready(timeout=1));h.fence(fence)
                until(lambda:h.sdk.uncertain)
                with self.assertRaises(GuestCommandError):h.sdk.start('printf no-retry')
                self.assertTrue(h.core.out.empty())

    def test_non_observer_create_path_keeps_original_first_request(self):
        h=Harness();self.addCleanup(h.close)
        h.create()
        self.assertEqual(h.sdk.session['phase'],'ready')
        self.assertTrue(h.core.out.empty())
