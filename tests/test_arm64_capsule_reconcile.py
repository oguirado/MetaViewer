"""Retained custody fixtures only; no native, systemd, Docker or application queries."""
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('reconcile', Path(__file__).resolve().parents[1] / 'tools/arm64_capsule_reconcile.py')
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='arm64-reconcile-fixture-', dir='/dev/shm')
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.registry = self.directory / 'registry'
        self.registry.mkdir(mode=0o700)
        self.run = 'a' * 24
        self.root = self.directory / ('metaviewer-arm64-' + self.run + '-fixture')
        self.root.mkdir(mode=0o700)
        self.unit = 'metaviewer-arm64-' + self.run + '.scope'
        self.marker = self.registry / 'held-session.json'
        self.lock = self.registry / 'session.lock'
        self.lock.write_bytes(b'')
        self.lock.chmod(0o600)
        self.held = {'root': str(self.root), 'unit': self.unit, 'status': 'closure-unproven'}
        self.plan = {'schema': 'metaviewer-arm64-session/v1', 'run_id': self.run, 'unit': self.unit,
                     'app': '/fixture/app', 'source_root': '/fixture/source', 'expected_commit': 'b' * 40,
                     'registry_sha256': 'c' * 64, 'script_sha256': 'd' * 64,
                     'setup_helper_sha256': 'e' * 64, 'ui_transport': {},
                     'ui_xauthority_identity': None, 'ui_bus_identity': [1, 2, 3, 4], 'hosted': True}
        self.write(self.marker, self.held)
        self.write(self.root / 'PLAN.json', self.plan)

    def write(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def event(self, number, kind, **data):
        self.write(self.root / ('event-%04d.json' % number), {'event': kind, **data})

    def test_app_exit_does_not_release_or_modify_custody(self):
        self.event(0, 'app_spawned', pid=12345)
        self.event(1, 'app_exited_closure_unproven', returncode=0)
        before = self.marker.read_bytes()
        result = r.inspect_held(self.marker)
        self.assertEqual(result['status'], 'held')
        self.assertFalse(result['release_supported'])
        self.assertFalse(result['closure_proven'])
        self.assertTrue(result['missing_proofs'])
        self.assertEqual(self.marker.read_bytes(), before)
        self.assertEqual(result['held_marker_sha256'], hashlib.sha256(before).hexdigest())

    def test_empty_directory_is_not_complete_inventory(self):
        result = r.inspect_held(self.marker)
        self.assertEqual(result['events'], [])
        self.assertFalse(result['closure_proven'])
        self.assertIn('durable_complete_graphical_allocation_inventory', result['missing_proofs'])
        self.assertTrue(self.marker.exists())

    def test_caller_closed_receipt_cannot_supply_missing_source_proof(self):
        self.write(self.root / 'caller-closure.json', {'closed': True, 'all_allocations': [], 'complete': True})
        self.assertFalse(r.inspect_held(self.marker)['closure_proven'])
        self.event(0, 'all_resources_closed', closed=True)
        with self.assertRaises(r.Refused):
            r.inspect_held(self.marker)
        self.assertTrue(self.marker.exists())

    def test_foreign_unit_and_actor_refuse(self):
        wrong = dict(self.held, unit='foreign.scope')
        self.write(self.marker, wrong)
        with self.assertRaises(r.Refused):
            r.inspect_held(self.marker)
        self.write(self.marker, self.held)
        self.event(0, 'app_spawn_pending', agent_instance='foreign', actor='actor-' + '0' * 64)
        with self.assertRaises(r.Refused):
            r.inspect_held(self.marker)

    def test_event_gap_unknown_shape_and_boolean_pid_refuse(self):
        self.event(1, 'app_spawned', pid=1)
        with self.assertRaises(r.Refused):
            r.inspect_held(self.marker)
        (self.root / 'event-0001.json').unlink()
        self.event(0, 'app_spawned', pid=True)
        with self.assertRaises(r.Refused):
            r.inspect_held(self.marker)
        self.event(0, 'app_spawned', pid=1, start_ticks=2)
        with self.assertRaises(r.Refused):
            r.inspect_held(self.marker)

    def test_marker_custody_symlink_hardlink_and_writable_refuse(self):
        alias = self.registry / 'alias'
        alias.symlink_to(self.marker)
        with self.assertRaises(r.Refused):
            r.inspect_held(alias)
        alias.unlink()
        os.link(self.marker, alias)
        with self.assertRaises(r.Refused):
            r.inspect_held(self.marker)
        alias.unlink()
        self.marker.chmod(0o620)
        with self.assertRaises(r.Refused):
            r.inspect_held(self.marker)

    def test_held_session_lock_is_required_and_never_created(self):
        self.lock.unlink()
        with self.assertRaises(OSError):
            r.inspect_held(self.marker)
        self.assertFalse(self.lock.exists())
        self.lock.write_bytes(b'')
        self.lock.chmod(0o600)
        with self.lock.open('rb') as guard:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                r.inspect_held(self.marker)

    def test_guardian_binding_uses_exact_uid_and_unit(self):
        prefix = '/user.slice/user-%d.slice/user@%d.service/newton-ia.slice/' % (os.getuid(), os.getuid())
        self.event(0, 'session_admitted', guardian=self.unit, cgroup=prefix + self.unit)
        self.assertFalse(r.inspect_held(self.marker)['closure_proven'])
        self.event(0, 'session_admitted', guardian=self.unit, cgroup='/user.slice/foreign/' + self.unit)
        with self.assertRaises(r.Refused):
            r.inspect_held(self.marker)

    def test_known_helper_receipts_do_not_close_graphical_resources(self):
        profile = 'mv-arm64-' + self.run
        self.event(0, 'identity_create_pending', profile=profile)
        self.event(1, 'helper_create_pending', name='mv-arm64-payload-vm-' + self.run,
                   payload=str(self.root / 'store' / 'profiles' / profile), inode=[1, 2])
        self.event(2, 'helper_bound', cid='f' * 64)
        self.event(3, 'helper_start_pending', cid='f' * 64)
        self.event(4, 'identity_ready', profile=profile, helper_removed=True)
        self.assertFalse(r.inspect_held(self.marker)['closure_proven'])
        self.assertTrue(self.marker.exists())

    def test_changed_event_snapshot_refuses(self):
        self.event(0, 'app_spawned', pid=1)
        original = r.event_inventory
        calls = []
        def changing(root, plan):
            value = original(root, plan)
            calls.append(None)
            if len(calls) == 1:
                self.event(1, 'app_exited_closure_unproven', returncode=0)
            return value
        with patch.object(r, 'event_inventory', side_effect=changing):
            with self.assertRaises(r.Refused):
                r.inspect_held(self.marker)

    def test_duplicate_keys_and_extra_plan_claim_refuse(self):
        self.marker.write_text('{"root":"x","root":"y"}')
        with self.assertRaises(r.Refused):
            r.inspect_held(self.marker)
        self.write(self.marker, self.held)
        self.write(self.root / 'PLAN.json', dict(self.plan, allocation_inventory_complete=True))
        with self.assertRaises(r.Refused):
            r.inspect_held(self.marker)

    def test_cli_never_returns_successful_release_gate(self):
        output = io.StringIO()
        with patch('sys.argv', ['reconcile', '--held-session', str(self.marker)]), contextlib.redirect_stdout(output):
            self.assertEqual(r.main(), 2)
        self.assertFalse(json.loads(output.getvalue())['closure_proven'])
        self.assertTrue(self.marker.exists())

class InventoryTests(ReconcileTests):
    def setUp(self):
        super().setUp()
        def pin(name, raw=b'protected synthetic bytes'):
            p = self.directory / name
            p.write_bytes(raw)
            p.chmod(0o600)
            return {'path': str(p), 'sha256': hashlib.sha256(raw).hexdigest()}
        self.setup_pin = pin('arm64_capsule_session.py')
        setup_helper = pin('arm64_capsules.py')
        asar = pin('app.asar')
        producer = pin('adapter')
        current = Path(r.__file__)
        reconciler = {'path': str(current), 'sha256': hashlib.sha256(current.read_bytes()).hexdigest()}
        artifact = pin('artifact')
        source = str(self.directory)
        self.descriptor = {'schema':'metaviewer-arm64-setup/v1','source_commit':'b'*40,
            'source_root':source,'package':{'app':pin('app'),'asar':asar},'python':pin('python'),'python_prefix':source,
            'runner':pin('runner'),'native':{n:artifact for n in ('srf-identity-admin','srf-identity-surface','srf-holdings-capsule')},
            'artifacts':{n:artifact for n in ('engine','kernel','broker','busybox')},
            'files':[{'relative':'guest_command_runtime/'+n+'.py',**artifact} for n in ('__init__','_schemas','wire','schema','config','image','native_checks','native','protocol','storage','controller')],
            'vm_image':'sha256:'+'f'*64,'legal':{},'producer_pins':{'setup':self.setup_pin,'graphical':producer,'guestcommand':producer},
            'package_manifest':pin('manifest'),'reconciler':reconciler}
        self.write(self.root/'setup.json',self.descriptor)
        registry_hash=hashlib.sha256((self.root/'setup.json').read_bytes()).hexdigest()
        self.config={'schema':'arm64-resource-inventory-config/v1','journal':str(self.root/'allocations.jsonl'),
            'root':str(self.root),'run_id':self.run,'actor':'actor-'+hashlib.sha256(('agent:agent-arm64-'+self.run).encode()).hexdigest(),
            'source_commit':'b'*40,'asar_sha256':asar['sha256'],'session_helper_sha256':self.setup_pin['sha256'],
            'setup_helper_sha256':setup_helper['sha256'],'producer_pins':self.descriptor['producer_pins'],
            'package_manifest':self.descriptor['package_manifest'],'registry_sha256':registry_hash,'images':{'vm':self.descriptor['vm_image']}}
        self.plan.update(registry_sha256=registry_hash,script_sha256=self.setup_pin['sha256'],setup_helper_sha256=setup_helper['sha256'])
        self.write(self.root/'PLAN.json',self.plan)
        self.config_path=self.root/'inventory-config.json'
        self.write(self.config_path,self.config)
        for name in ('allocations.jsonl','allocations.lock'):
            (self.root/name).write_bytes(b'');(self.root/name).chmod(0o600)
        statroot=self.root.stat()
        body={k:self.config[k] for k in ('run_id','actor','source_commit','asar_sha256','session_helper_sha256','setup_helper_sha256','producer_pins','package_manifest','registry_sha256')}
        body.update(stage='session',producer='setup',unit=self.unit,root_device=statroot.st_dev,root_inode=statroot.st_ino)
        self.append('setup',body)
        self.group='/user.slice/user-%d.slice/user@%d.service/newton-ia.slice/'%(os.getuid(),os.getuid())+self.unit
        self.append('setup',{'stage':'guardian_bound','producer':'setup','id':'guardian','unit':self.unit,'invocation':'a'*32,'cgroup':self.group,'device':1,'inode':2})
        self.append('setup',{'stage':'app_pending','producer':'setup','id':'app'})
        self.append('setup',{'stage':'app_bound','producer':'setup','id':'app','pid':12345,'start_ticks':123,'cgroup':self.group})

    def append(self,producer,body):
        return r.append_inventory(self.config_path,producer,body,self.config['producer_pins'][producer]['path'])

    def seal(self):
        for producer in ('graphical','guestcommand','setup'):
            r.seal_inventory(self.config_path,producer,self.config['producer_pins'][producer]['path'])
        r.seal_coordinator(self.config_path,self.setup_pin['path'])

    class Absent:
        def docker_ids(self):return set()
        def pid_start(self,pid):return None
        def unit(self,unit):return {'LoadState':'not-found','ActiveState':'inactive','ControlGroup':'','InvocationID':'','MainPID':'0'}
        def cgroup(self,group):return None

    def test_new_contract_clean_proof_releases_only_exact_marker(self):
        self.seal()
        before=(self.root/'allocations.jsonl').read_bytes()
        result=r.reconcile_held(self.marker,release=True,observer=self.Absent())
        self.assertEqual(result['status'],'released')
        self.assertFalse(self.marker.exists())
        self.assertEqual((self.root/'allocations.jsonl').read_bytes(),before)
        self.assertTrue(Path(result['proof']).exists())
        self.assertTrue((self.root/'PLAN.json').exists())

    def test_pending_unknown_and_unsealed_keep_marker(self):
        with self.assertRaises(r.Refused):r.reconcile_held(self.marker,release=True,observer=self.Absent())
        self.append('graphical',{'stage':'unknown','producer':'graphical','id':'missing-native','reason':'capture failed'})
        self.seal()
        with self.assertRaises(r.Refused):r.reconcile_held(self.marker,release=True,observer=self.Absent())
        self.assertTrue(self.marker.exists())

    def test_each_producer_is_fenced_and_required(self):
        r.seal_inventory(self.config_path,'graphical',self.config['producer_pins']['graphical']['path'])
        with self.assertRaises(r.Refused):self.append('graphical',{'stage':'unknown','producer':'graphical','id':'late','reason':'late effect'})
        with self.assertRaises(r.Refused):r.seal_coordinator(self.config_path,self.setup_pin['path'])

    def test_bad_chain_or_partial_tail_keeps_marker(self):
        self.seal()
        p=self.root/'allocations.jsonl';raw=p.read_bytes();p.write_bytes(raw[:-1])
        with self.assertRaises(r.Refused):r.reconcile_held(self.marker,release=True,observer=self.Absent())
        p.write_bytes(raw.replace(b'"seq":1,',b'"seq":2,',1))
        with self.assertRaises(r.Refused):r.reconcile_held(self.marker,release=True,observer=self.Absent())
        self.assertTrue(self.marker.exists())

    def test_active_or_replaced_runtime_keeps_marker(self):
        self.seal()
        class Live(self.Absent):
            def pid_start(self,pid):return 123
        with self.assertRaises(r.Refused):r.reconcile_held(self.marker,release=True,observer=Live())
        class Foreign(self.Absent):
            def unit(self,unit):return {'LoadState':'loaded','ActiveState':'inactive','ControlGroup':'','InvocationID':'b'*32,'MainPID':'0'}
        with self.assertRaises(r.Refused):r.reconcile_held(self.marker,release=True,observer=Foreign())
        self.assertTrue(self.marker.exists())

    def test_query_failure_is_not_absence(self):
        self.seal()
        class Unknown(self.Absent):
            def docker_ids(self):raise OSError('Docker unavailable')
        with self.assertRaises(OSError):r.reconcile_held(self.marker,release=True,observer=Unknown())
        self.assertTrue(self.marker.exists())

    def test_changed_producer_pin_or_source_snapshot_cannot_release(self):
        self.seal()
        Path(self.setup_pin['path']).write_bytes(b'changed')
        with self.assertRaises(r.Refused):r.reconcile_held(self.marker,release=True,observer=self.Absent())
        self.assertTrue(self.marker.exists())

    def test_omitted_existing_helper_event_cannot_release(self):
        self.event(0,'helper_create_pending',name='mv-arm64-payload-vm-'+self.run,
            payload=str(self.root/'store'/'profiles'/('mv-arm64-'+self.run)),inode=[1,2])
        self.seal()
        with self.assertRaises(r.Refused):r.reconcile_held(self.marker,release=True,observer=self.Absent())
        self.assertTrue(self.marker.exists())

    def test_changed_inventory_during_queries_keeps_marker(self):
        self.seal();journal=self.root/'allocations.jsonl'
        class Racing(self.Absent):
            def docker_ids(self):
                journal.write_bytes(journal.read_bytes()+b'\n')
                return set()
        with self.assertRaises(r.Refused):r.reconcile_held(self.marker,release=True,observer=Racing())
        self.assertTrue(self.marker.exists())

    def native_resource(self):
        profile='mv-arm64-'+self.run
        payload=self.root/'store'/'profiles'/profile
        payload.mkdir(mode=0o700,parents=True)
        st=payload.stat()
        self.payload=payload
        self.cid='c'*64
        name='srf-vm-'+profile
        self.append('graphical',{'stage':'native_pending','producer':'graphical','id':'surface-one','generation':'surface-one',
            'profile_id':profile,'native_kind':'vm','container_name':name,'image_id':self.config['images']['vm'],
            'payload':str(payload),'payload_device':st.st_dev,'payload_inode':st.st_ino})
        self.append('graphical',{'stage':'native_bound','producer':'graphical','id':'surface-one','container_name':name,
            'run_id':name,'cid':self.cid,'native_pid':{'pid':9999,'start':77},
            'native_state_path':str(self.root/'native-state'/(name+'.json')),'native_state_sha256':'f'*64})
        self.append('graphical',{'stage':'native_closed','producer':'graphical','id':'surface-one'})
        return payload

    def payload_metadata(self):
        from types import SimpleNamespace
        original=r.canonical
        payload=self.payload
        def canonical(path):
            p=original(path)
            if p==payload:
                s=p.lstat()
                return SimpleNamespace(lstat=lambda:SimpleNamespace(st_dev=s.st_dev,st_ino=s.st_ino,
                    st_mode=s.st_mode,st_uid=10001,st_gid=10001))
            return p
        return patch.object(r,'canonical',side_effect=canonical)

    def test_native_closed_boolean_alone_does_not_hide_live_container(self):
        self.native_resource();self.seal()
        cid=self.cid
        class Present(self.Absent):
            def docker_ids(self):return {cid}
        with self.payload_metadata(),self.assertRaises(r.Refused):
            r.reconcile_held(self.marker,release=True,observer=Present())
        self.assertTrue(self.marker.exists())

    def test_exact_native_pid_and_id_absence_allows_clean_resource_release(self):
        self.native_resource();self.seal()
        with self.payload_metadata():
            result=r.reconcile_held(self.marker,release=True,observer=self.Absent())
        self.assertEqual(result['status'],'released')
        proof=json.loads(Path(result['proof']).read_text())
        self.assertEqual(proof['absent_container_ids'],[self.cid])
        self.assertTrue(any(x.get('pid')==9999 and x.get('start')==77 for x in proof['proofs']))

    def test_native_pid_start_missing_or_still_live_refuses(self):
        self.native_resource();self.seal()
        class Present(self.Absent):
            def pid_start(self,pid):return 77 if pid==9999 else None
        with self.payload_metadata(),self.assertRaises(r.Refused):
            r.reconcile_held(self.marker,release=True,observer=Present())
        self.assertTrue(self.marker.exists())

    def test_service_requires_original_unit_and_pid_closure(self):
        unit='mv-guest-command-'+'d'*32+'.service'
        group=self.group.rsplit('/',1)[0]+'/'+unit
        self.append('guestcommand',{'stage':'service_pending','producer':'guestcommand','id':unit,'unit':unit})
        self.append('guestcommand',{'stage':'service_bound','producer':'guestcommand','id':unit,'unit':unit,
            'invocation':'e'*32,'cgroup':group,'device':3,'inode':4,'pid':7654,'start_ticks':88})
        self.append('guestcommand',{'stage':'service_closed','producer':'guestcommand','id':unit})
        self.seal()
        class Present(self.Absent):
            def unit(self,queried):
                if queried==unit:return {'LoadState':'loaded','ActiveState':'active','ControlGroup':group,'InvocationID':'e'*32,'MainPID':'7654'}
                return super().unit(queried)
        with self.assertRaises(r.Refused):r.reconcile_held(self.marker,release=True,observer=Present())
        result=r.reconcile_held(self.marker,release=True,observer=self.Absent())
        self.assertEqual(result['status'],'released')


    def test_dynamic_program_exact_tuple_and_foreign_negatives(self):
        self.config['images']['program'] = 'sha256:' + 'e' * 64
        self.write(self.config_path, self.config)
        profile = 'xterm-2'
        body = {'stage':'native_pending','producer':'graphical','id':'program-one','generation':'program-one',
                'profile_id':profile,'native_kind':'program','container_name':'srf-pg-'+profile,
                'image_id':self.config['images']['program'],'payload':str(self.root/'store'/'profiles'/profile),
                'payload_device':1,'payload_inode':2}
        before = (self.root/'allocations.jsonl').read_bytes()
        for changed in ({'profile_id':'../foreign'}, {'profile_id':'srf-pg-foreign'},
                        {'container_name':'srf-pg-other'}, {'image_id':'sha256:'+'d'*64},
                        {'payload':'/foreign/profiles/xterm-2'}, {'generation':'other'}):
            with self.subTest(changed=changed), self.assertRaises(r.Refused):
                self.append('graphical', dict(body, **changed))
            self.assertEqual((self.root/'allocations.jsonl').read_bytes(), before)
        self.append('graphical', body)
        state=r.inventory_state(self.config,(self.root/'allocations.jsonl').read_bytes())
        self.assertEqual(state['resources']['graphical:program-one']['pending']['profile_id'],profile)

    def test_legacy_helper_complete_tuple_correlation(self):
        pending={'stage':'helper_pending','name':'mv-arm64-payload-vm-'+self.run,
                 'payload':str(self.root/'store'/'profiles'/('mv-arm64-'+self.run)),
                 'payload_device':1,'payload_inode':2}
        state={'resources':{'setup:helper':{'pending':pending,'bound':{'cid':'c'*64},'closed':{}}},
               'app':{'bound':{'pid':12345}},'guardian':{'unit':self.unit,'cgroup':self.group}}
        events=[{'event':'helper_create_pending','name':pending['name'],'payload':pending['payload'],'inode':[1,2]},
                {'event':'helper_bound','cid':'c'*64},{'event':'helper_start_pending','cid':'c'*64},
                {'event':'identity_ready','profile':'mv-arm64-'+self.run,'helper_removed':True}]
        r.correlate_legacy_allocations(events,state)
        for index,change in ((0,{'payload':'/foreign'}),(0,{'inode':[1,3]}),(1,{'cid':'d'*64}),
                             (2,{'cid':'d'*64}),(3,{'profile':'foreign'})):
            changed=[dict(v) for v in events];changed[index].update(change)
            with self.subTest(index=index,change=change),self.assertRaises(r.Refused):
                r.correlate_legacy_allocations(changed,state)
        for changed in (events[:1],events[:2],events+events,events[1:]):
            with self.assertRaises(r.Refused):r.correlate_legacy_allocations(changed,state)

    def test_legacy_app_and_guardian_cannot_be_substituted(self):
        state={'resources':{},'app':{'bound':{'pid':12345}},
               'guardian':{'unit':self.unit,'cgroup':self.group}}
        events=[{'event':'session_admitted','guardian':self.unit,'cgroup':self.group},
                {'event':'app_spawned','pid':12345}]
        r.correlate_legacy_allocations(events,state)
        for changed in ([dict(events[0]),{'event':'app_spawned','pid':54321}],
                        [{'event':'session_admitted','guardian':'foreign.scope','cgroup':self.group},dict(events[1])],
                        [{'event':'session_admitted','guardian':self.unit,'cgroup':'/foreign'},dict(events[1])],
                        events+[dict(events[1])]):
            with self.assertRaises(r.Refused):r.correlate_legacy_allocations(changed,state)


    def enable_auxiliary(self):
        source=self.directory/'mv_identity.py'
        source.write_bytes(b'owned inert identity source fixture');source.chmod(0o600)
        pin={'path':str(source),'sha256':hashlib.sha256(source.read_bytes()).hexdigest()}
        self.descriptor['identity_provisioner']=pin
        self.descriptor['normal_profiles']={'browser':{'image_id':'sha256:'+'e'*64,'domains':['example.test'],'legal':{}}}
        self.write(self.root/'setup.json',self.descriptor)
        self.config.update(identity_provisioner=pin,registry_sha256=hashlib.sha256((self.root/'setup.json').read_bytes()).hexdigest())
        self.config['images']['browser']='sha256:'+'e'*64
        self.plan['registry_sha256']=self.config['registry_sha256']
        self.write(self.root/'PLAN.json',self.plan);self.write(self.config_path,self.config)
        # Fixture-only rewrite of the initial source header before any effects.
        bodies=[json.loads(json.loads(line)['payload']) for line in (self.root/'allocations.jsonl').read_text().splitlines()]
        bodies[0]['registry_sha256']=self.config['registry_sha256']
        raw=b'';prev='0'*64
        for seq,body in enumerate(bodies,1):
            text=json.dumps(body,separators=(',',':'),ensure_ascii=False)
            row={'schema':'capsule_resource_inventory/v0.2','seq':seq,'prev':prev,'payload':text,'sha256':r.row_digest(seq,prev,text)}
            raw+=(json.dumps(row,separators=(',',':'))+'\n').encode();prev=row['sha256']
        (self.root/'allocations.jsonl').write_bytes(raw)
        return pin

    def auxiliary_pending(self):
        name='mv-provision-xterm-'+'a'*12
        return {'stage':'helper_pending','producer':'setup','id':name,'name':name,
                'image_id':self.config['images']['browser'],'payload':str(self.root/'store'/'profiles'/'xterm'),
                'payload_device':1,'payload_inode':2}

    def test_auxiliary_is_source_pinned_narrow_and_seal_fenced(self):
        pin=self.enable_auxiliary();body=self.auxiliary_pending()
        with self.assertRaises(r.Refused):r.append_inventory(self.config_path,'setup',body,pin['path'])
        for stage in ('app_pending','native_pending','producer_sealed','coordinator_sealed'):
            with self.subTest(stage=stage),self.assertRaises(r.Refused):
                r.append_identity_helper(self.config_path,{'stage':stage,'producer':'setup','id':'app'},pin['path'])
        r.append_identity_helper(self.config_path,body,pin['path'])
        r.append_identity_helper(self.config_path,{'stage':'helper_bound','producer':'setup','id':body['id'],'cid':'c'*64},pin['path'])
        r.append_identity_helper(self.config_path,{'stage':'helper_removed','producer':'setup','id':body['id']},pin['path'])
        self.seal()
        with self.assertRaises(r.Refused):r.append_identity_helper(self.config_path,body,pin['path'])

    def test_auxiliary_foreign_tuple_and_source_refuse_before_append(self):
        pin=self.enable_auxiliary();body=self.auxiliary_pending();before=(self.root/'allocations.jsonl').read_bytes()
        for changed in ({'name':'mv-provision-other-'+'a'*12},{'image_id':self.config['images']['vm']},
                        {'payload':'/foreign/xterm'},{'id':'foreign'},{'name':'mv-provision-../escape-'+'a'*12}):
            with self.subTest(changed=changed),self.assertRaises(r.Refused):
                r.append_identity_helper(self.config_path,dict(body,**changed),pin['path'])
            self.assertEqual((self.root/'allocations.jsonl').read_bytes(),before)
        Path(pin['path']).write_bytes(b'changed')
        with self.assertRaises(r.Refused):r.append_identity_helper(self.config_path,body,pin['path'])
        self.assertEqual((self.root/'allocations.jsonl').read_bytes(),before)

    def test_auxiliary_mutation_unknown_is_durable_never_releasable(self):
        pin=self.enable_auxiliary();body={'stage':'unknown','producer':'setup',
            'id':'identity-mutation-'+'a'*24,'reason':'native login mutation may have effects'}
        r.append_identity_helper(self.config_path,body,pin['path'])
        with self.assertRaises(r.Refused):r.append_identity_helper(self.config_path,body,pin['path'])
        self.seal()
        with self.assertRaises(r.Refused):r.reconcile_held(self.marker,release=True,observer=self.Absent())
        self.assertTrue(self.marker.exists())


if __name__ == '__main__':
    unittest.main()
