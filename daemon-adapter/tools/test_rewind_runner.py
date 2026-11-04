"""No native calls: schema-backed adapter projections and fake backend."""
import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
import threading
from unittest.mock import Mock,patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from guest_command_runtime.schema import Contracts
spec=importlib.util.spec_from_file_location('rewind_runner',Path(__file__).with_name('rewind_runner.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
B={'owner_id':'actor-test','workload_id':'workload-test','generation':1,'authority_epoch':1,'session_id':'session-test','reservation_id':'reservation-test'}
class Backend:
    owner='actor-test';phase='new';recoverable=False;counter=7
    def __init__(self):self.current=None;self.native=type('Native',(),{'compatibility':'a'*64,'mapped':None,'points':{},'finalize_mark':lambda self,p:None,'rollback_mark':lambda self,p:None})()
    def create(self,b):self.current=copy.deepcopy(b);self.phase='ready'
    def run(self,r):return {'stdout':b'hello\n','stderr':b'err\n','terminal':{'cause':'exit','exit_code':7,'signal':None,'output_complete':True}}
    def request(self,r,next_binding=None,point_id=None,defer_publication=False):
        if r['op']=='pause':self.phase='paused'
        elif r['op']=='mark':self.native.points[point_id]={'created_order':1,'created_mono_ns':123,'compatibility_hash':'a'*64,'counter':7,'state':{'sha256':'b'*64,'bytes':1},'memory':{'sha256':'c'*64,'bytes':256}}
        elif r['op'] in ('resume','restore'):self.current=copy.deepcopy(next_binding);self.phase='ready'
    def stop(self):self.phase='stopped'
class Tests(unittest.TestCase):
    def packet(self,request):return {'request':request,'binding':B,'point_id':'','public_reservation':'reservation-public'}
    def test_real_schema_general_command_events(self):
        events=[]
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            adapter=m.Adapter(Backend(),'session-core',d,Contracts(),events.append)
            try:
                adapter.submit(self.packet({'schema':'guest_command_request/v0.2','request_id':'request-create','op':'create','params':{'profile_id':'guest-command-arm64-v1'}}))
                request={'schema':'guest_command_request/v0.2','request_id':'request-run','op':'run','params':{'workload_id':'workload-test','generation':1,'job_id':'job-test','command_utf8':'printf hi','cwd':'','stdin_b64':'','timeout_ms':500}}
                adapter.submit(self.packet(request))
                self.assertEqual([e['event'] for e in events],['accepted','ready','accepted','output','output','job_finished'])
                self.assertEqual(events[-1]['session']['job']['exit_code'],7)
                self.assertEqual(events[-1]['data']['stderr_sent_bytes'],4)
            finally:m.os.close(adapter.journal)
    def test_ready_mark_composite_emits_schema_valid_new_target(self):
        events=[]
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            adapter=m.Adapter(Backend(),'session-core',d,Contracts(),events.append)
            try:
                adapter.submit(self.packet({'schema':'guest_command_request/v0.2','request_id':'request-create','op':'create','params':{'profile_id':'guest-command-arm64-v1'}}))
                packet=self.packet({'schema':'rewind_request/v0.2','request_id':'request-mark','op':'mark','params':{'workload_id':'workload-test','generation':1,'authority_epoch':1,'label':'one'}})
                packet['binding']={**B,'generation':2,'authority_epoch':2,'session_id':'session-next','reservation_id':'reservation-next'};packet['point_id']='point-one'
                adapter.submit(packet)
                checker=ROOT.parent/'tools/check_contracts.py';spec=importlib.util.spec_from_file_location('public_contract_check',checker);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
                validator=module.Validator(ROOT.parent/'contracts/v0.2');schema=validator.load('rewind_event.schema.json')
                for value in events[2:]:validator.validate(value,schema)
                self.assertEqual(events[-1]['session']['generation'],2);self.assertEqual(events[-1]['session']['phase'],'ready')
                self.assertEqual(adapter.backend.current['generation'],2)
            finally:m.os.close(adapter.journal)
    def test_failed_ready_mark_does_not_publish_new_point(self):
        class FailedResume(Backend):
            def request(self,r,**kwargs):
                if r['op']=='resume':raise OSError('synthetic resume failure')
                return super().request(r,**kwargs)
        events=[]
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            backend=FailedResume();adapter=m.Adapter(backend,'session-core',d,Contracts(),events.append)
            try:
                adapter.submit(self.packet({'schema':'guest_command_request/v0.2','request_id':'request-create','op':'create','params':{'profile_id':'guest-command-arm64-v1'}}))
                packet=self.packet({'schema':'rewind_request/v0.2','request_id':'request-mark','op':'mark','params':{'workload_id':'workload-test','generation':1,'authority_epoch':1,'label':'one'}})
                packet['binding']={**B,'generation':2,'authority_epoch':2,'session_id':'session-next','reservation_id':'reservation-next'};packet['point_id']='point-one'
                adapter.submit(packet)
                self.assertEqual(events[-1]['event'],'outcome_unknown');self.assertEqual(events[-1]['session']['points'],[])
                self.assertEqual(adapter.points,{})
            finally:m.os.close(adapter.journal)
    def test_stop_journal_failure_still_closes_and_holds(self):
        events=[]
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            backend=Backend();adapter=m.Adapter(backend,'session-core',d,Contracts(),events.append)
            try:
                adapter.submit(self.packet({'schema':'guest_command_request/v0.2','request_id':'request-create','op':'create','params':{'profile_id':'guest-command-arm64-v1'}}))
                backend.stop=Mock()
                with patch.object(adapter,'persist',side_effect=OSError('synthetic journal failure')):
                    with self.assertRaises(OSError):adapter.stop({'schema':'guest_command_request/v0.2','request_id':'request-stop','op':'stop','params':{'workload_id':'workload-test','generation':1}})
                backend.stop.assert_called_once();self.assertEqual(adapter.gc['phase'],'uncertain');self.assertEqual(adapter.gc['ownership'],'held')
                self.assertNotIn('stopped',[event['event'] for event in events])
            finally:m.os.close(adapter.journal)
    def test_stop_request_journal_failure_closes_before_runner_guard(self):
        events=[]
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            backend=Backend();adapter=m.Adapter(backend,'session-core',d,Contracts(),events.append)
            try:
                adapter.submit(self.packet({'schema':'guest_command_request/v0.2','request_id':'request-create','op':'create','params':{'profile_id':'guest-command-arm64-v1'}}))
                backend.stop=Mock();done=threading.Event();failure=[]
                packet=self.packet({'schema':'guest_command_request/v0.2','request_id':'request-stop','op':'stop','params':{'workload_id':'workload-test','generation':1}})
                with patch.object(adapter,'persist',side_effect=OSError('intent journal failure')):m.dispatch_stop(adapter,packet,done,failure)
                backend.stop.assert_called_once();self.assertTrue(done.is_set());self.assertEqual(adapter.gc['ownership'],'held')
            finally:m.os.close(adapter.journal)
    def test_stop_thread_failure_sets_runner_guard(self):
        adapter=Mock();adapter.stop_attempted=False;adapter.gc=None;adapter.submit.side_effect=OSError('synthetic failure');done=threading.Event();failure=[]
        m.dispatch_stop(adapter,{},done,failure)
        self.assertTrue(done.is_set());self.assertEqual(failure,['OSError']);adapter.backend.stop.assert_called_once()
    def test_duplicate_request_never_runs_backend(self):
        events=[]
        with tempfile.TemporaryDirectory(dir='/dev/shm') as d:
            adapter=m.Adapter(Backend(),'session-core',d,Contracts(),events.append)
            packet=self.packet({'schema':'guest_command_request/v0.2','request_id':'request-create','op':'create','params':{'profile_id':'guest-command-arm64-v1'}})
            try:
                adapter.submit(packet)
                with self.assertRaises(ValueError):adapter.submit(packet)
                self.assertEqual(len(events),2)
            finally:m.os.close(adapter.journal)
