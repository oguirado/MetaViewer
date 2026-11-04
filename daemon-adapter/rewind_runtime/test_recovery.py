"""Synthetic filesystem recovery checks; never starts or signals a VMM."""
import importlib
import os
from pathlib import Path
import tempfile
import unittest
from .native import Native
from .test_native import CONFIG

class RecoveryTests(unittest.TestCase):
    def test_existing_claim_refuses_retained_runtime(self):
        with tempfile.TemporaryDirectory(dir='/dev/shm') as directory:
            base=Path(directory); (base/'rewind-retained').mkdir(mode=0o700)
            native=Native(CONFIG)
            with self.assertRaisesRegex(RuntimeError,'prior runtime requires reconciliation'):
                native._claim_base(base)
            self.assertTrue((base/'rewind-retained').is_dir())

    def test_explicit_recovery_api_exists(self):
        module=importlib.import_module('rewind_runtime.recovery')
        self.assertTrue(callable(module.recover_owned))

import copy
import hashlib
import json
import fcntl
from unittest.mock import patch
from . import recovery

class SealedRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir='/dev/shm')
        self.addCleanup(self.tmp.cleanup)
        self.parent=Path(self.tmp.name); self.parent.chmod(0o700)
        self.base=self.parent/'base'; self.base.mkdir(mode=0o700)
        self.root=self.base/'rewind-test'; self.root.mkdir(mode=0o700)
        self.config=copy.deepcopy(CONFIG)
        self.config['runtime_root']=str(self.base)
        self.config['external_cgroup']='/sys/fs/cgroup/newton-ia.slice/recovery-synthetic-absent.scope'
        self.patch=patch.object(recovery,'validate',side_effect=lambda value:copy.deepcopy(value))
        self.patch.start(); self.addCleanup(self.patch.stop)
        for p in (self.base/'.rewind-owner.lock', self.root/'owner.lock'):
            p.touch(mode=0o600)
        assets={}
        for name, key, mode in [('fc','engine',0o500),('Image','kernel',0o400),('initrd.gz',None,0o400)]:
            p=self.root/name; p.write_bytes(('SYNTHETIC-'+name).encode()); p.chmod(mode)
            digest=hashlib.sha256(p.read_bytes()).hexdigest()
            assets[name]=dict(recovery.identity(p.stat()),bytes=p.stat().st_size,sha256=digest)
            if key:self.config['artifacts'][key]['sha256']=digest
        self.seal={'schema':'rewind-recovery-seal/v1','config_sha256':recovery.digest_config(self.config),
            'base':recovery.identity(self.base.stat()),'root':recovery.identity(self.root.stat()),
            'external_cgroup':self.config['external_cgroup'],'cgroup':{'device':1,'inode':123},
            'assets':assets,'owner':{'pid':99999990,'start_ticks':10}}
        raw=json.dumps(self.seal,sort_keys=True,separators=(',',':')).encode()
        (self.root/'recovery.json').write_bytes(raw); (self.root/'recovery.json').chmod(0o600)
        self.rows=[('allocate','intent',{}),('allocate','sealed',{'sha256':hashlib.sha256(raw).hexdigest()}),
            ('spawn','intent',{}),('spawn','returned',self.ev(99999991,None)),
            ('spawn','bound',self.ev(99999991,20))]
        self.write_ledger()
        self.proof=self.parent/'proof.json'
    @staticmethod
    def ev(pid,start):
        return dict(pid=pid,start_ticks=start,returncode=None,forced_cleanup=None,mapped_point=None,closed=False)
    def write_ledger(self):
        head='0'*64; out=[]
        for seq,(op,stage,data) in enumerate(self.rows,1):
            payload=json.dumps({'op':op,'stage':stage,'data':data},sort_keys=True,separators=(',',':'))
            digest=hashlib.sha256((str(seq)+'\n'+head+'\n'+payload).encode()).hexdigest()
            out.append(json.dumps({'seq':seq,'prev':head,'payload':payload,'sha256':digest})); head=digest
        p=self.root/'ledger.jsonl'; p.write_text('\n'.join(out)+'\n'); p.chmod(0o600)
        self.expected={'base':recovery.identity(self.base.stat()),'root':recovery.identity(self.root.stat()),
                       'ledger_sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
    def recover(self):
        return recovery.recover_owned(self.config,self.root,self.expected,self.proof)
    def rejected(self):
        before={p.name:p.lstat().st_ino for p in self.root.iterdir()}
        with self.assertRaises((RuntimeError,OSError,ValueError)):
            self.recover()
        self.assertEqual(before,{p.name:p.lstat().st_ino for p in self.root.iterdir()})
        self.assertFalse(self.proof.exists())
    def test_sealed_dead_owner_releases_only_child_then_claim_succeeds(self):
        proof=self.recover(); self.assertEqual(proof['pids'],[(99999990,10),(99999991,20)])
        self.assertFalse(self.root.exists()); self.assertTrue(self.proof.is_file())
        native=Native(CONFIG); native._claim_base(self.base)
        os.close(native.base_owner); native.base_owner=None
        self.assertEqual({p.name for p in self.base.iterdir()},{'.rewind-owner.lock'})
    def test_unsealed_legacy_refused(self):
        (self.root/'recovery.json').unlink(); self.rejected()
    def test_unknown_member_refused(self):
        (self.root/'foreign').touch(mode=0o600); self.rejected()
    def test_symlink_refused(self):
        (self.root/'Image').unlink(); (self.root/'Image').symlink_to('/dev/null'); self.rejected()
    def test_hardlink_refused(self):
        os.link(self.root/'Image',self.parent/'alias'); self.rejected()
    def test_asset_tamper_refused(self):
        (self.root/'fc').chmod(0o600); (self.root/'fc').write_bytes(b'CHANGED'); (self.root/'fc').chmod(0o500)
        self.rejected()
    def test_ledger_tamper_refused(self):
        with (self.root/'ledger.jsonl').open('ab') as stream:stream.write(b'{')
        self.rejected()
    def test_replaced_root_refused(self):
        self.expected['root']['inode']+=1; self.rejected()
    def test_incomplete_spawn_refused_even_when_cgroup_absent(self):
        self.rows.pop(); self.write_ledger(); self.rejected()
    def test_live_or_reused_pid_refused_without_signal(self):
        self.rows[-1][2]['pid']=os.getpid(); self.write_ledger(); self.rejected()
    def test_held_base_lock_refused(self):
        with (self.base/'.rewind-owner.lock').open('r+') as stream:
            fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB); self.rejected()
    def test_held_owner_lock_refused(self):
        with (self.root/'owner.lock').open('r+') as stream:
            fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB); self.rejected()
    def test_existing_cgroup_refused(self):
        original=recovery.os.path.lexists
        with patch.object(recovery.os.path,'lexists',side_effect=lambda path:True if str(path)==self.config['external_cgroup'] else original(path)):
            self.rejected()
    def test_forged_rehashed_operation_refused(self):
        self.rows.append(('unknown','complete',{})); self.write_ledger(); self.rejected()
    def test_fifo_refused_without_blocking(self):
        (self.root/'Image').unlink(); os.mkfifo(self.root/'Image',0o400); self.rejected()
    def test_proof_collision_prevents_purge(self):
        self.proof.write_text('existing'); self.proof.chmod(0o600)
        with self.assertRaises(FileExistsError):self.recover()
        self.assertTrue(self.root.is_dir());self.assertEqual(self.proof.read_text(),'existing')
    def test_rehashed_spawn_returned_bound_mismatch_refused(self):
        self.rows[-2][2]['pid']=99999992; self.write_ledger(); self.rejected()
    def test_live_matching_spawn_identity_refused(self):
        self.rows[-2][2]['pid']=os.getpid(); self.rows[-1][2]['pid']=os.getpid()
        self.write_ledger(); self.rejected()
    def test_seal_must_precede_spawn(self):
        seal=self.rows.pop(1);self.rows.append(seal);self.write_ledger();self.rejected()
    def test_directory_mode_changed_refused(self):
        self.root.chmod(0o755);self.rejected()
    def test_unknown_base_member_refused(self):
        (self.base/'foreign').mkdir();self.rejected()
    def test_fifo_lock_refused_without_blocking(self):
        (self.root/'owner.lock').unlink();os.mkfifo(self.root/'owner.lock',0o600);self.rejected()
    def test_allocation_seal_failure_prevents_first_native_effect(self):
        config=copy.deepcopy(CONFIG);config['runtime_admitted']=True;config['runtime_root']=str(self.base)
        native=Native(config)
        with patch('rewind_runtime.native.scope'), patch('rewind_runtime.native.platform.machine',return_value='aarch64'), \
             patch('rewind_runtime.native.checks.available_memory',return_value=32<<30), \
             patch('rewind_runtime.native.checks.check_kvm'), \
             patch('rewind_runtime.native.checks.runtime_root',return_value=self.base), \
             patch('rewind_runtime.native.checks.pinned_asset',return_value=b'synthetic'), \
             patch('rewind_runtime.native.build_initramfs',return_value=b'synthetic'), \
             patch('rewind_runtime.native.Path.read_text',return_value='Umask:\t0077'), \
             patch.object(native,'_claim_base'), \
             patch.object(native,'_seal_allocation',side_effect=RuntimeError('seal failed')), \
             patch('rewind_runtime.native.subprocess.Popen') as popen:
            try:
                with self.assertRaisesRegex(RuntimeError,'seal failed'):native.allocate()
                popen.assert_not_called()
            finally:
                for fd in (native.ledger,native.owner):
                    if fd is not None:os.close(fd)
    def used_history(self):
        bind={'owner_id':'actor-test','workload_id':'workload-test','reservation_id':'reservation-two','generation':2,'authority_epoch':2,'session_id':'session-two'}
        for suffix in ('.state','.mem'):
            path=self.root/('point-one'+suffix);path.write_bytes(b'SNAPSHOT');path.chmod(0o600)
        from .native import pin
        point=dict(point_id='point-one',created_order=1,created_mono_ns=1,compatibility_hash='a'*64,counter=3,state=pin(self.root/'point-one.state'),memory=pin(self.root/'point-one.mem'))
        self.rows.extend([
            ('run','intent',{'request_id':'request-run','job_id':'job-run'}),
            ('run','complete',{'request_id':'request-run','job_id':'job-run','stdout_bytes':3,'stderr_bytes':0}),
            ('pause','owner_intent',{'request_id':'request-pause','next_binding':None}),
            ('pause','intent',{}),('pause','complete',{}),('pause','owner_complete',{'request_id':'request-pause'}),
            ('mark','owner_intent',{'request_id':'request-mark','next_binding':None}),
            ('mark','intent',{'point_id':'point-one','victim':None}),
            ('mark','published',{'point':point,'victim':None}),
            ('mark','owner_complete',{'request_id':'request-mark'}),
            ('restore','owner_intent',{'request_id':'request-restore','next_binding':bind}),
            ('restore','intent',{'point_id':'point-one'}),
            ('spawn','intent',{}),('spawn','returned',self.ev(99999992,None)),
            ('spawn','bound',self.ev(99999992,30)),
            ('reset','intent',{'generation':2,'authority_epoch':2}),('reset','complete',{'counter':5}),
            ('restore','owner_complete',{'request_id':'request-restore'})])
        self.write_ledger()
    def test_real_producer_used_history_is_recoverable(self):
        self.used_history();self.recover();self.assertFalse(self.root.exists())
    def test_sealed_runner_has_no_new_module_dependency(self):
        import ast
        runner=Path(__file__).parents[1]/'tools'/'rewind_runner.py'
        tree=ast.parse(runner.read_text())
        names=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='REWIND' for t in n.targets))
        native_tree=ast.parse((Path(__file__).parent/'native.py').read_text())
        for node in ast.walk(native_tree):
            if isinstance(node,ast.ImportFrom) and node.level==1:
                self.assertIn(node.module,names, 'import unavailable in actual closed runner')
    def test_owner_uncertain_history_holds(self):
        self.rows.append(('owner','uncertain',{}));self.write_ledger();self.rejected()
    def test_run_complete_wrong_job_holds(self):
        self.used_history()
        for row in self.rows:
            if row[:2]==('run','complete'):row[2]['job_id']='job-foreign'
        self.write_ledger();self.rejected()
    def test_owner_complete_wrong_request_holds(self):
        self.used_history()
        for row in self.rows:
            if row[:2]==('mark','owner_complete'):row[2]['request_id']='request-foreign'
        self.write_ledger();self.rejected()
    def test_owner_extra_field_holds(self):
        self.used_history()
        for row in self.rows:
            if row[:2]==('pause','owner_intent'):row[2]['extra']=True
        self.write_ledger();self.rejected()
    def cli_module(self):
        import importlib.util
        path=Path(__file__).parents[1]/'tools'/'rewind_recover.py'
        spec=importlib.util.spec_from_file_location('synthetic_recovery_cli',path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module
    def test_explicit_cli_recovers_only_supplied_fixture(self):
        module=self.cli_module();expected=self.parent/'expected.json'
        expected.write_text(json.dumps(self.expected));expected.chmod(0o600)
        import contextlib,io
        with patch.object(module,'load',return_value=self.config),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(module.main(['--config','/synthetic/config','--root',str(self.root),'--expected',str(expected),'--proof',str(self.proof)]),0)
        self.assertFalse(self.root.exists())
    def test_cli_missing_retained_custody_never_recovers(self):
        module=self.cli_module()
        with patch.object(module,'load',return_value=self.config),patch.object(module,'recover_owned') as effect:
            with self.assertRaises(FileNotFoundError):module.main(['--config','/synthetic/config','--root',str(self.root),'--expected',str(self.parent/'missing'),'--proof',str(self.proof)])
            effect.assert_not_called()
        self.assertTrue(self.root.exists())
    def test_cli_unknown_force_argument_refused(self):
        module=self.cli_module()
        import contextlib,io
        with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):module.main(['--force'])
    def test_actual_closed_loader_allocates_inline_seal_before_mocked_spawn(self):
        import importlib.util,sys,shutil
        adapter=Path(__file__).parents[1]
        spec=importlib.util.spec_from_file_location('sealed_runner_fixture',adapter/'tools'/'rewind_runner.py')
        runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        bundle=self.parent/'loaded';bundle.mkdir(mode=0o700)
        specs=[]
        for package,names in (('guest_command_runtime',runner.NORMAL),('rewind_runtime',runner.REWIND)):
            folder=bundle/'bundle'/package;folder.mkdir(parents=True)
            for name in names:
                data=(adapter/package/(name+'.py')).read_bytes();path=folder/(name+'.py');path.write_bytes(data);path.chmod(0o600)
                specs.append({'path':str(path),'relative':package+'/'+name+'.py','sha256':hashlib.sha256(data).hexdigest()})
        saved={k:v for k,v in sys.modules.items() if k=='guest_command_runtime' or k.startswith('guest_command_runtime.') or k=='rewind_runtime' or k.startswith('rewind_runtime.')}
        native=None
        try:
            for key in saved:sys.modules.pop(key,None)
            runner.load_modules(bundle,specs)
            module=sys.modules['rewind_runtime.native']
            base=self.parent/'fresh-base';base.mkdir(mode=0o700)
            config=copy.deepcopy(CONFIG);config['runtime_admitted']=True;config['runtime_root']=str(base)
            config['external_cgroup']='/sys/fs/cgroup'+module.checks.self_cgroup()
            native=module.Native(config)
            original_read=module.Path.read_text
            def status_read(path,*args,**kwargs):
                return 'Umask:\t0077' if str(path)=='/proc/self/status' else original_read(path,*args,**kwargs)
            with patch.object(module,'scope'),patch.object(module.platform,'machine',return_value='aarch64'),patch.object(module.checks,'available_memory',return_value=32<<30),patch.object(module.checks,'check_kvm'),patch.object(module.checks,'runtime_root',return_value=base),patch.object(module.checks,'pinned_asset',return_value=b'synthetic'),patch.object(module,'build_initramfs',return_value=b'synthetic'),patch.object(module.Path,'read_text',status_read),patch.object(native,'_spawn',side_effect=RuntimeError('mocked before Popen')) as spawn,patch.object(module.subprocess,'Popen') as popen:
                with self.assertRaisesRegex(RuntimeError,'mocked before Popen'):native.allocate()
                spawn.assert_called_once();popen.assert_not_called()
            seal=json.loads((native.root/'recovery.json').read_text())
            self.assertEqual(seal['config_sha256'],recovery.digest_config(config))
            self.assertEqual(seal['root'],recovery.identity(native.root.stat()))
            self.assertEqual(seal['owner']['pid'],os.getpid())
            self.assertEqual(set(seal['assets']),{'fc','Image','initrd.gz'})
        finally:
            if native is not None:
                for fd in (native.ledger,native.owner,native.base_owner):
                    if fd is not None:os.close(fd)
            for key in list(sys.modules):
                if key=='guest_command_runtime' or key.startswith('guest_command_runtime.') or key=='rewind_runtime' or key.startswith('rewind_runtime.'):sys.modules.pop(key,None)
            sys.modules.update(saved)
    def test_actual_closed_loader_kills_old_recovery_import_mutant(self):
        original=Path.read_bytes
        def old_candidate(path):
            data=original(path)
            if path==Path(__file__).parent/'native.py':
                before=b"        self.record('allocate','sealed',{'sha256':self._seal_allocation()})"
                after=b"        from .recovery import seal_allocation\n        self.record('allocate','sealed',{'sha256':seal_allocation(self.config,self.root)})"
                self.assertIn(before,data);data=data.replace(before,after)
            return data
        with patch.object(Path,'read_bytes',old_candidate),self.assertRaises(ModuleNotFoundError):
            self.test_actual_closed_loader_allocates_inline_seal_before_mocked_spawn()
    def test_reordered_point_publication_holds(self):
        self.used_history()
        intent=next(i for i,r in enumerate(self.rows) if r[:2]==('mark','intent'))
        self.rows[intent],self.rows[intent+1]=self.rows[intent+1],self.rows[intent]
        self.write_ledger();self.rejected()
