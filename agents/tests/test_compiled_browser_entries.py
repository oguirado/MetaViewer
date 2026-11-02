"""Public compiled browser IPC; synthetic executable, never private inference."""
import hashlib
import builtins
import importlib.machinery
import json
import os
from pathlib import Path
import ssl
import sys
import tempfile
from types import SimpleNamespace
import unittest
from types import ModuleType
from unittest.mock import patch

from metaviewer_agents.observe import ObservationError
from metaviewer_agents.perception import compiled
from metaviewer_agents.perception.deps_lock import DependencyLockError
from metaviewer_agents.mw_handoff import HandoffLatch


class CompiledBrowserEntryTests(unittest.TestCase):
    @staticmethod
    def request(mode):
        return (dict(element_table={},tree={}) if mode=='state' else
                dict(state={},url=None,frame_urls=None,headers=None))

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.dist = self.root / 'runtime'
        self.dist.mkdir()
        self.exe = self.dist / 'wender-runtime'
        self.exe.write_text('#!' + sys.executable + '\nimport json,os,sys\n'
            'request=json.load(sys.stdin)\n'
            'assert "PYTHONPATH" not in os.environ and "PYTHONHOME" not in os.environ\n'
            'print(json.dumps({"mode":sys.argv[1],"request":request}))\n')
        self.exe.chmod(0o755)
        # A host import path insertion would expose this invalid native module.
        self.collision = self.dist / ('_ssl' + importlib.machinery.EXTENSION_SUFFIXES[0])
        self.collision.write_bytes(b'not a host extension')
        self.lock = self.root / 'compiled.lock.json'
        self.deps = self.root / 'deps.lock'
        self.deps.write_text(json.dumps(dict(components=[dict(name='wender-agent',commit='a'*40)])))
        self.lock.write_text(json.dumps(dict(components={'wender-agent':dict(commit='a'*40,
            executable='wender-runtime',files={p.name:hashlib.sha256(p.read_bytes()).hexdigest()
                for p in (self.exe,self.collision)})})))
        for context in (patch.object(compiled,'LOCK',self.lock),
                        patch.object(compiled.platform,'system',return_value='Linux'),
                        patch.object(compiled.platform,'machine',return_value='x86_64'),
                        patch.object(compiled,'_locked_commit',return_value='a'*40),
                        patch.dict(os.environ,{'MV_WENDER_EXECUTABLE':str(self.exe),
                                              'PYTHONPATH':'must-not-enter-child','PYTHONHOME':'must-not-enter-child'})):
            context.start();self.addCleanup(context.stop)

    def test_absolute_entry_json_and_host_ssl_resolution_remain_separate(self):
        before=list(sys.path);native_ssl=sys.modules['_ssl']
        for mode in ('state','stopstate'):
            with self.subTest(mode=mode):
                request=self.request(mode)
                response=compiled.compiled_browser_entry(mode,request,root=self.dist)
                self.assertEqual(response,dict(mode=mode,request=request))
        self.assertEqual(sys.path,before)
        self.assertIs(sys.modules['_ssl'],native_ssl)
        self.assertNotIn(str(self.dist),sys.path)
        self.assertTrue(ssl.OPENSSL_VERSION)

    def test_explicit_invalid_distribution_refuses_before_launch(self):
        self.collision.write_bytes(b'drift')
        with patch('metaviewer_agents.wender_bridge._run_bounded') as launch:
            with self.assertRaises(DependencyLockError):
                    compiled.compiled_browser_entry('state',self.request('state'))
            launch.assert_not_called()

    def test_source_selection_does_not_launch_or_modify_import_paths(self):
        with patch.dict(os.environ,{},clear=True),patch('metaviewer_agents.wender_bridge._run_bounded') as launch:
            self.assertIsNone(compiled.compiled_browser_entry('state',{}))
        launch.assert_not_called()

    def test_invalid_json_receipts_never_become_an_empty_success(self):
        cases=[b'[]',b'null',b'{"x":1,"x":2}',b'{"x":NaN}',b'{"x":Infinity}',
               b'{"x":1e309}',b'{} {}',b'\xff',b'']
        for stdout in cases:
            with self.subTest(stdout=stdout),patch('metaviewer_agents.wender_bridge._run_bounded',
                    return_value=SimpleNamespace(returncode=0,stdout=stdout,stderr=b'')):
                with self.assertRaises(ObservationError):
                    compiled.compiled_browser_entry('stopstate',self.request('stopstate'))

    def test_child_error_is_private_and_request_and_timeout_are_bounded(self):
        with patch('metaviewer_agents.wender_bridge._run_bounded',
                return_value=SimpleNamespace(returncode=6,stdout=b'',stderr=b'private URL and traceback')):
            with self.assertRaises(ObservationError) as caught:
                compiled.compiled_browser_entry('stopstate',self.request('stopstate'))
        self.assertNotIn('private URL',str(caught.exception))
        with patch('metaviewer_agents.wender_bridge._run_bounded') as launch:
            for item in (float('nan'),'\ud800','x'*(1024*1024)):
                request=dict(element_table={'x':item},tree={})
                with self.assertRaises(ObservationError):compiled.compiled_browser_entry('state',request)
            launch.assert_not_called()
        with patch('metaviewer_agents.wender_bridge._run_bounded',
                return_value=SimpleNamespace(returncode=0,stdout=b'{}',stderr=b'')) as launch:
            compiled.compiled_browser_entry('state',self.request('state'),timeout=0.25)
            self.assertEqual(launch.call_args.kwargs['timeout'],0.25)
            self.assertEqual(launch.call_args.args[0],[str(self.exe),'state'])
            self.assertNotIn('PYTHONPATH',launch.call_args.kwargs['env'])

    def test_real_child_timeout_and_output_ceiling_are_enforced(self):
        for body, timeout, code in (('import time;time.sleep(2)',0.05,'timeout'),
                ('import sys;sys.stdout.write("x"*(1024*1024+1))',2,'bad_shape')):
            with self.subTest(code=code):
                self.exe.write_text('#!'+sys.executable+'\n'+body+'\n')
                lock=json.loads(self.lock.read_text())
                lock['components']['wender-agent']['files'][self.exe.name]=hashlib.sha256(self.exe.read_bytes()).hexdigest()
                self.lock.write_text(json.dumps(lock))
                with self.assertRaises(ObservationError) as caught:
                    compiled.compiled_browser_entry('state',self.request('state'),timeout=timeout)
                self.assertEqual(caught.exception.code,code)

    def test_compiled_handoff_uses_original_observation_and_absorbs_write_failure(self):
        latch=HandoffLatch(self.root/'handoff.json')
        sensed=dict(frame=dict(surface_id='owned'),state=dict(nodes=[]),
            observed=dict(url=None,frame_urls=None,headers=None))
        receipt=dict(is_stop=True,reason='captcha_wall',confidence=100,
                     evidence=[dict(kind='ax_role_name',value='private detector evidence',opaque={'future':True})])
        original=builtins.__import__
        def no_private(name,*args,**kwargs):
            if name=='wender' or name.startswith('wender.'):
                raise AssertionError('compiled mode imported private Python')
            return original(name,*args,**kwargs)
        write=unittest.mock.Mock(side_effect=OSError('output unavailable'))
        with patch.object(compiled,'compiled_browser_entry',return_value=receipt) as invoke, \
             patch.object(builtins,'__import__',side_effect=no_private):
            with self.assertRaises(OSError):latch.inspect(sensed,2,write)
            self.assertTrue(latch.inspect(sensed,3,write))
        invoke.assert_called_once_with('stopstate',dict(state=sensed['state'],url=None,frame_urls=None,headers=None))
        write.assert_called_once()
        record=json.loads(write.call_args.args[1])
        self.assertEqual(record['evidence_kinds'],['ax_role_name'])
        self.assertNotIn('private detector evidence',write.call_args.args[1].decode())

    def test_malformed_detector_receipts_refuse_instead_of_reporting_no_wall(self):
        valid=dict(is_stop=False,reason=None,confidence=0,evidence=[])
        cases=[dict(valid,is_stop=0),dict(valid,confidence=False),dict(valid,reason=[]),
               dict(valid,evidence={}),dict(valid,evidence=[{}]),
               dict(valid,evidence=[dict(kind='ax_role_name',value=42)]),dict(valid,extra=True)]
        for receipt in cases:
            with self.subTest(receipt=receipt),patch.object(compiled,'compiled_browser_entry',return_value=receipt):
                write=unittest.mock.Mock()
                with self.assertRaises(ObservationError):
                    HandoffLatch(self.root/'handoff.json').inspect(dict(frame={},state={}),0,write)
                write.assert_not_called()

    def test_compiled_no_stop_still_honors_explicit_observed_wall(self):
        receipt=dict(is_stop=False,reason=None,confidence=0,evidence=[])
        with patch.object(compiled,'compiled_browser_entry',return_value=receipt):
            sensed=dict(frame=dict(surface_id='owned'),state=dict(nodes=[]))
            write=unittest.mock.Mock()
            self.assertFalse(HandoffLatch(self.root/'ordinary.json').inspect(sensed,0,write))
            write.assert_not_called()
            sensed['observed']=dict(observed_wall=dict(kind='login_wall',observed=True))
            self.assertTrue(HandoffLatch(self.root/'wall.json').inspect(sensed,0,write))
        self.assertEqual(json.loads(write.call_args.args[1])['reason'],'login_wall')

    def test_source_detector_receives_unchanged_tuple_defaults_without_compiled_import(self):
        receipt=dict(is_stop=False,reason=None,confidence=0,evidence=[])
        detector=unittest.mock.Mock(return_value=receipt)
        module=ModuleType('wender.perceive.stopstate');module.detect=detector
        with patch.object(compiled,'compiled_browser_entry',return_value=None), \
             patch.dict(sys.modules,{'wender.perceive.stopstate':module}):
            self.assertFalse(HandoffLatch(self.root/'source.json').inspect(dict(frame={},state={}),0,lambda *args:None))
        detector.assert_called_once_with({},url='',frame_urls=(),headers=None)


if __name__ == '__main__':
    unittest.main()
