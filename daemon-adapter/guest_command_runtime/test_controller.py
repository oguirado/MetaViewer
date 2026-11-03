import base64
import copy
import hashlib
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from guest_command_runtime.controller import Controller
from guest_command_runtime.schema import Invalid


def config():
    return {'schema':'guest-command-host-config/v1','owner_id':'actor-unit','generation':1,
            'runtime_admitted':True,'runtime_root':'/dev/shm/unit','external_cgroup':'/sys/fs/cgroup/unit',
            'startup_seconds':15,'stop_seconds':5,'artifacts':{
                key:{'path':'/unit/'+key,'sha256':'a'*64} for key in ('engine','kernel','broker','busybox')}}


class FakeNative:
    def __init__(self,config,record):
        self.record=record;self.nonce='a'*64;self.lifetime=time.monotonic()+55;self.closed=False
    def open(self):return self
    def close(self,*,graceful):self.closed=True;return {'closed':True}


class FakeWire:
    def __init__(self,sock,validate):self.validate=validate;self.sent=[]
    def send(self,kind,meta,payload=b'',*,deadline):
        self.validate(kind,meta,len(payload));self.sent.append((kind,copy.deepcopy(meta),payload))
    def receive(self,*,lifetime_deadline):
        hello=self.sent[0][1]
        return 5,{'kind':'ready',**{key:hello[key] for key in ('workload_id','generation','reservation_id')}},b''


class LocalController(Controller):
    def _receive(self):pass  # Tests drive actual actor state with synthetic transport.


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.events=[]
        self.c=LocalController(config(),'session-unit',self.tmp.name,self.events.append,FakeNative,FakeWire)
        self.c.request({'schema':'guest_command_request/v0.2','request_id':'request-create','op':'create',
                        'params':{'profile_id':'guest-command-arm64-v1'}})
    def tearDown(self):self.c.store.close();self.tmp.cleanup()
    def request(self,op,rid,**params):
        return {'schema':'guest_command_request/v0.2','request_id':rid,'op':op,
                'params':{key:self.c.state[key] for key in ('workload_id','generation')}|params}
    def event(self,kind,**fields):
        self.c.guest_event(5,{'kind':kind,**self.c._binding(),**fields},b'')
    def start(self,rid='request-run',job='job-one'):
        self.c.request(self.request('run',rid,job_id=job,command_utf8='printf ok',cwd='',stdin_b64='',timeout_ms=1000))
        self.event('accepted',request_id=rid,op='exec',job_id=job)
    def terminal(self,rid='request-run',job='job-one',cause='exit',cancel=None,stop=None,count=0,complete=True):
        self.event('job_finished',request_id=rid,job_id=job,cancel_request_id=cancel,stop_request_id=stop,
                   cause=cause,exit_code=0 if cause=='exit' else None,signal=None if cause=='exit' else 9,
                   output_complete=complete,job_empty=True,stdout_sent_bytes=count,stderr_sent_bytes=0)

    def test_multiple_commands_and_exact_output(self):
        self.start()
        self.c.guest_event(5,{'kind':'output',**self.c._binding(),'request_id':'request-run',
                              'job_id':'job-one','stream':'stdout','chunk_index':0},b'ok')
        self.terminal(count=2)
        result=self.events[-1]
        self.assertEqual(result['data']['stdout_sha256'],hashlib.sha256(b'ok').hexdigest())
        self.assertEqual(self.c.state['phase'],'ready')
        self.start('request-next','job-two');self.terminal('request-next','job-two')
        self.assertEqual(self.c.state['jobs_started'],2)
        self.assertEqual(self.c.wire.sent[1][2],b'printf ok')

    def test_cancel_is_separate_and_requires_ack(self):
        self.start();self.c.request(self.request('cancel','request-cancel',job_id='job-one'))
        self.event('accepted',request_id='request-cancel',op='cancel',job_id='job-one')
        self.terminal(cause='cancel',cancel='request-cancel')
        self.assertEqual(self.events[-1]['request_id'],'request-run')
        self.assertEqual(self.c.state['phase'],'ready')
        self.assertEqual(self.c.state['job']['state'],'cancelled')

    def test_exit_before_cancel_ack_fences_new_job(self):
        self.start();self.c.request(self.request('cancel','request-cancel',job_id='job-one'))
        self.terminal()
        self.assertEqual(self.c.state['phase'],'awaiting_control')
        self.event('error',request_id='request-cancel',code='INVALID')
        self.assertEqual(self.c.state['phase'],'ready')
        self.assertEqual(self.c.state['job']['state'],'exited')

    def test_stop_needs_job_drain_and_native_close(self):
        self.start();self.c.request(self.request('stop','request-stop'))
        self.event('accepted',request_id='request-stop',op='stop',job_id=None)
        with self.assertRaises(Invalid):self.event('stopping',request_id='request-stop')
        self.assertFalse(self.c.native.closed)
        self.terminal(cause='stop',stop='request-stop')
        self.event('stopping',request_id='request-stop')
        self.assertTrue(self.c.native.closed)
        self.assertEqual(self.c.state['ownership'],'released')

    def test_unknown_keeps_reservation_and_known_finished_job(self):
        self.start();self.c.request(self.request('cancel','request-cancel',job_id='job-one'))
        self.terminal();self.c._unknown('request-cancel','TRANSPORT')
        self.assertTrue(self.c.native.closed)
        self.assertEqual(self.c.state['ownership'],'held')
        self.assertEqual(self.c.state['job']['state'],'exited')
        self.c.request(self.request('stop','request-stop'))
        self.assertEqual(self.c.state['ownership'],'released')
        self.assertEqual(self.c.state['job']['state'],'exited')

    def test_output_loss_and_forged_control_rejected(self):
        self.start()
        with self.assertRaises(Invalid):self.terminal(count=1)
        with self.assertRaises(Invalid):self.terminal(cause='cancel',cancel='request-forged')
        self.assertNotEqual(self.c.state['phase'],'ready')

    def test_idle_lifetime_failure_emits_original_create_resource_update(self):
        self.start();self.terminal()
        self.c._unknown('request-run','DEADLINE')
        event=self.events[-1]
        self.assertEqual(event['event'],'outcome_unknown')
        self.assertEqual(event['request_id'],'request-create')
        self.assertEqual(event['data']['op'],'create')
        self.assertEqual(event['session']['job']['state'],'exited')
        self.assertEqual(event['session']['ownership'],'held')
        self.assertTrue(self.c.native.closed)

    def test_one_global_unknown_fences_run_and_control(self):
        self.start();self.c.request(self.request('cancel','request-cancel',job_id='job-one'))
        count=len(self.events)
        self.c._unknown('request-cancel','TRANSPORT')
        self.assertEqual(len(self.events),count+1)
        self.assertEqual(self.events[-1]['request_id'],'request-run')
        self.assertTrue(self.c.requests['request-run']['done'])
        self.assertTrue(self.c.requests['request-cancel']['done'])

    def test_queued_stop_survives_run_acceptance(self):
        self.c.request(self.request('run','request-run',job_id='job-one',command_utf8='sleep 1',cwd='',stdin_b64='',timeout_ms=1000))
        self.c.request(self.request('stop','request-stop'))
        self.event('accepted',request_id='request-run',op='exec',job_id='job-one')
        self.assertEqual(self.events[-1]['session']['phase'],'stopping')
        self.assertEqual(self.events[-1]['session']['controls']['stop'],{'request_id':'request-stop','ack':'pending'})
        self.event('accepted',request_id='request-stop',op='stop',job_id=None)
        self.terminal(cause='stop',stop='request-stop')
        self.event('stopping',request_id='request-stop')
        self.assertTrue(self.c.native.closed)

    def test_byte_semantics_fail_before_dispatch(self):
        previous=len(self.c.wire.sent)
        for command,cwd,stdin in [('echo\0bad','',''),('echo','../escape',''),('echo','','Zh==')]:
            self.c.request(self.request('run','request-'+str(previous)+str(len(self.events)),job_id='job-bad',
                                        command_utf8=command,cwd=cwd,stdin_b64=stdin,timeout_ms=1))
            self.assertEqual(self.events[-1]['event'],'refused')
        self.assertEqual(len(self.c.wire.sent),previous)


if __name__=='__main__':unittest.main()
