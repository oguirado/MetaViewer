"""Synthetic backend/transport only. Never starts a VMM or calls KVM."""
import copy
import threading
import unittest
from unittest.mock import Mock
from .controller import Controller

CONFIG={'owner_id':'actor-test'}
BIND={'owner_id':'actor-test','workload_id':'workload-test','reservation_id':'reservation-one','generation':1,'authority_epoch':1,'session_id':'session-one'}
def following():return {**BIND,'generation':2,'authority_epoch':2,'reservation_id':'reservation-two','session_id':'session-two'}
def req(op,**params):return {'schema':'rewind_request/v0.2','request_id':'request-'+op,'op':op,'params':{k:BIND[k] for k in ('workload_id','generation','authority_epoch')}|params}
def runreq():return {'schema':'guest_command_request/v0.2','request_id':'request-run','op':'run','params':{'workload_id':'workload-test','generation':1,'job_id':'job-test','command_utf8':'printf hi','cwd':'','stdin_b64':'','timeout_ms':100}}

class Fake:
    def __init__(self):self.points={};self.stream=None;self.calls=[]
    def record(self,*args):self.calls.append(args)
    def allocate(self):self.calls.append('allocate')
    def reset(self,binding):self.calls.append('reset');return 1
    def pause(self):self.calls.append('pause')
    def snapshot(self,p):self.points[p]={'point_id':p};return self.points[p]
    def finalize_mark(self,p):pass
    def rollback_mark(self,p):pass
    def verify_point(self,p):
        if p not in self.points:raise RuntimeError('unknown point')
    def quiesce(self):self.calls.append('quiesce')
    def restore(self,p):self.calls.append('restore')
    def resume_native(self):self.calls.append('resume')
    def stop(self):self.calls.append('stop');return {'closed':True}

class Tests(unittest.TestCase):
    def owner(self):
        native=Fake();owner=Controller(CONFIG,native);owner.create(BIND);return owner,native
    def test_pause_mark_resume(self):
        owner,native=self.owner();owner.request(req('pause'))
        owner.request(req('mark',label='first'),point_id='point-one')
        self.assertEqual(owner.phase,'paused');owner.request(req('resume'),next_binding=following())
        self.assertEqual(owner.current['authority_epoch'],2);self.assertEqual(owner.phase,'ready')
    def test_foreign_and_malformed_binding_before_allocation(self):
        for bad in ({**BIND,'owner_id':'actor-foreign'},{**BIND,'generation':True}):
            native=Fake();owner=Controller(CONFIG,native)
            with self.assertRaises(RuntimeError):owner.create(bad)
            self.assertNotIn('allocate',native.calls)
    def test_stale_resume_before_effect(self):
        owner,native=self.owner();owner.request(req('pause'))
        with self.assertRaises(RuntimeError):owner.request(req('resume'),next_binding=BIND)
        self.assertNotIn('resume',native.calls);self.assertEqual(owner.phase,'paused')
    def test_missing_point_before_old_close(self):
        owner,native=self.owner()
        with self.assertRaises(RuntimeError):owner.request(req('restore',point_id='point-missing'),next_binding=following())
        self.assertNotIn('restore',native.calls);self.assertNotIn('quiesce',native.calls)
    def test_failed_pause_unknown_and_stop(self):
        owner,native=self.owner();native.pause=Mock(side_effect=OSError('synthetic'))
        with self.assertRaises(OSError):owner.request(req('pause'))
        self.assertEqual(owner.phase,'uncertain')
        with self.assertRaises(RuntimeError):owner.request(req('mark',label='x'),point_id='point-one')
        self.assertEqual(owner.stop()['ownership'],'released')
    def test_request_replay(self):
        owner,native=self.owner();owner.request(req('pause'))
        repeated=req('mark',label='x');repeated['request_id']='request-pause'
        with self.assertRaises(RuntimeError):owner.request(repeated,point_id='point-one')
        self.assertFalse(native.points)
    def test_bounded_command_output(self):
        owner,native=self.owner();binding={k:BIND[k] for k in ('workload_id','generation','reservation_id')}
        rows=[(5,{'kind':'accepted',**binding,'request_id':'request-run','op':'exec'},b''),
            (5,{'kind':'output',**binding,'request_id':'request-run','job_id':'job-test','stream':'stderr','chunk_index':0},b'err'),
            (5,{'kind':'job_finished',**binding,'request_id':'request-run','job_id':'job-test','job_empty':True,'stdout_sent_bytes':0,'stderr_sent_bytes':3,'exit_code':7},b'')]
        wire=Mock();wire.receive.side_effect=rows;native.stream=wire
        value=owner.run(runreq());self.assertEqual(value['stderr'],b'err');self.assertEqual(value['terminal']['exit_code'],7)
        self.assertEqual(owner.phase,'ready')
    def test_stop_unblocks_single_reader_and_cannot_publish_ready(self):
        owner,native=self.owner();entered=threading.Event();closed=threading.Event();errors=[]
        class Wire:
            def send(self,*args,**kwargs):pass
            def receive(self,**kwargs):entered.set();closed.wait(1);raise OSError('closed synthetic transport')
        native.stream=Wire()
        native.stop=lambda:(closed.set() or {'closed':True})
        def execute():
            try:owner.run(runreq())
            except BaseException as error:errors.append(error)
        thread=threading.Thread(target=execute);thread.start();self.assertTrue(entered.wait(1))
        with self.assertRaises(RuntimeError):owner.request(req('pause'))
        owner.stop();thread.join(1);self.assertFalse(thread.is_alive());self.assertEqual(owner.phase,'stopped');self.assertEqual(len(errors),1)
    def test_output_accounting_failure_retains_unknown(self):
        owner,native=self.owner();wire=Mock();native.stream=wire
        target={k:BIND[k] for k in ('workload_id','generation','reservation_id')}
        wire.receive.side_effect=[(5,{'kind':'accepted',**target,'request_id':'request-run','op':'exec'},b''),
            (5,{'kind':'job_finished',**target,'request_id':'request-run','job_id':'job-test','job_empty':True,'stdout_sent_bytes':5,'stderr_sent_bytes':0},b'')]
        with self.assertRaises(RuntimeError):owner.run(runreq())
        self.assertEqual(owner.phase,'uncertain');self.assertIn('request-run',owner.ids)
        with self.assertRaises(RuntimeError):owner.run(runreq())
    def test_bad_command_before_send(self):
        owner,native=self.owner();native.stream=Mock();request=runreq();request['params']['stdin_b64']='~~~'
        with self.assertRaises(ValueError):owner.run(request)
        native.stream.send.assert_not_called();self.assertEqual(owner.phase,'ready')
    def test_manual_restore_after_failed_load_requires_closed_native(self):
        owner,native=self.owner();native.points['point-one']={};native.process=None;native.poisoned=False
        native.close_process=Mock();native.restore=Mock(side_effect=[OSError('failed load'),None])
        with self.assertRaises(OSError):owner.request(req('restore',point_id='point-one'),next_binding=following())
        self.assertEqual(native.restore.call_count,1);self.assertTrue(owner.recoverable);self.assertEqual(owner.phase,'uncertain')
        request=req('restore',point_id='point-one');request['request_id']='request-manual';request['params'].update(generation=2,authority_epoch=2)
        third={**following(),'generation':3,'authority_epoch':3,'session_id':'session-third','reservation_id':'reservation-third'}
        owner.request(request,next_binding=third);self.assertEqual(native.restore.call_count,2);self.assertEqual(owner.phase,'ready')
    def test_unknown_native_close_blocks_restore(self):
        owner,native=self.owner();native.points['point-one']={};native.restore=Mock(side_effect=OSError('load failure'));native.close_process=Mock(side_effect=OSError('closure unknown'))
        with self.assertRaises(OSError):owner.request(req('restore',point_id='point-one'),next_binding=following())
        self.assertFalse(owner.recoverable)
        with self.assertRaises(RuntimeError):owner.request(req('restore',point_id='point-one'),next_binding=following())
        self.assertEqual(native.restore.call_count,1)
    def test_cancel_is_explicitly_unavailable(self):
        owner,_=self.owner()
        with self.assertRaises(NotImplementedError):owner.cancel()
