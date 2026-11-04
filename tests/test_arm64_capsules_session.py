"""Pure session projections and refused native provisioning with fake commands."""
import importlib.util
import copy
import json
import os
import socket
from pathlib import Path
import unittest
from unittest.mock import patch, Mock
from test_arm64_capsules import Fixture

spec = importlib.util.spec_from_file_location('session', Path(__file__).resolve().parents[1] / 'tools/arm64_capsule_session.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
REAL_PROCESS_IDENTITY = s.process_identity
REAL_BIND_LAUNCHER = s.bind_launcher


class SessionTests(Fixture):
    def setUp(self):
        super().setUp()
        self.owner_tuple = {'pid': 111, 'start_ticks': 222, 'cgroup': '/synthetic-owner', 'state': 'S'}
        for target in ('bind_launcher', 'process_identity'):
            mocked = patch.object(s, target, return_value=self.owner_tuple)
            mocked.start()
            self.addCleanup(mocked.stop)

    def directories(self):
        for n in ('home', 'store', 'state', 'runtime', 'assets', 'frames', 'native-state'):
            (self.root / n).mkdir(mode=0o700)

    def test_shared_actor_protected_profile_and_asset_copy(self):
        self.directories()
        p = s.build_profile(self.value, self.root, 'agent-test', 'owned.scope', '/user.slice/owned.scope')
        self.assertEqual(p['owner_id'], 'actor-' + s.setup.digest(b'agent:agent-test'))
        self.assertEqual(p['guardian_unit'], 'owned.scope')
        self.assertEqual(p['config_template']['owner_id'], p['owner_id'])
        self.assertEqual(p['config_template']['external_cgroup'], '/sys/fs/cgroup/user.slice/owned.scope')
        for asset in p['config_template']['artifacts'].values():
            self.assertTrue(Path(asset['path']).is_relative_to(self.root / 'assets'))
            self.assertEqual(s.setup.digest(Path(asset['path']).read_bytes()), asset['sha256'])

    def test_normal_mode_environment_never_sets_exclusive_modes(self):
        self.directories()
        with patch.dict(os.environ, {'XDG_RUNTIME_DIR': str(self.root)}, clear=False):
            env = s.child_environment(self.value, self.root, 'agent-test', 'fresh-vm', {
                'display': ':9', 'xauthority': '/explicit/auth', 'dbus_session_bus_address': 'unix:path=/explicit/bus'}, hosted=True)
        self.assertEqual(env['MV_ARM64_CAPSULES'], '1')
        self.assertNotIn('MV_HEADLESS_ONLY', env)
        self.assertNotIn('MV_GUEST_COMMAND_ONLY', env)
        self.assertNotIn('MV_SESSION_ID', env)
        self.assertNotIn('NODE_OPTIONS', env)
        self.assertEqual(env['DISPLAY'], ':9')
        self.assertEqual(env['XDG_RUNTIME_DIR'], str(self.root / 'host-runtime'))
        self.assertEqual(env['MV_HOSTED'], '1')
        self.assertEqual(json.loads(env['MV_ARM64_CAPSULE_STATUS']), {
            'vm': {'available': True, 'reason': ''}, 'microvm': {'available': True, 'reason': ''}})
        self.assertEqual(json.loads(env['MV_SRF_PROFILES'])['fresh-vm']['Kind'], 'vm')

    def rewind_fixture(self):
        names = ['guest_command_runtime/' + n + '.py' for n in
                 ('__init__', '_schemas', 'wire', 'schema', 'config', 'image', 'native_checks', 'protocol')]
        names += ['rewind_runtime/' + n + '.py' for n in ('__init__', 'config', 'native', 'controller')]
        names += ['tools/rewind_runner.py']
        rows = []
        for name in names:
            item = self.file('source/daemon-adapter/' + name, b'# sealed rewind fixture\n')
            Path(item['path']).chmod(0o644)
            rows.append(item['sha256'] + '  source/daemon-adapter/' + name + '\n')
        self.value['package_manifest'] = self.file('package.sha256', ''.join(rows).encode())
        return names

    def test_rewind_profile_uses_manifest_sealed_closure_and_normal_inventory(self):
        self.directories()
        names = self.rewind_fixture()
        p = s.build_profile(self.value, self.root, 'agent-test', 'owned.scope', '/user.slice/owned.scope', rewind=True)
        self.assertEqual(p['schema'], 'mv-rewind-host/v1')
        self.assertEqual(p['controller_relative'], 'rewind_runtime/controller.py')
        self.assertEqual({x['relative'] for x in p['files']}, set(names) - {'tools/rewind_runner.py'})
        self.assertEqual(p['config_template']['schema'], 'rewind-host-config/v1')
        self.assertEqual(p['config_template']['startup_seconds'], 10)
        self.assertNotIn('generation', p['config_template'])
        self.assertEqual(p['runtime_root'], str(self.root / 'r'))
        self.assertEqual(p['runner']['path'], str(self.source / 'daemon-adapter/tools/rewind_runner.py'))

    def test_rewind_manifest_tamper_missing_duplicate_and_foreign_source_refuse(self):
        self.rewind_fixture()
        manifest = Path(self.value['package_manifest']['path'])
        good = manifest.read_bytes()
        target = self.source / 'daemon-adapter/rewind_runtime/controller.py'
        target.write_bytes(b'# altered\n')
        with self.assertRaises(s.setup.Refused):
            s.rewind_sources(self.value)
        target.write_bytes(b'# sealed rewind fixture\n')
        for raw in (b''.join(good.splitlines(keepends=True)[:-1]), good + good.splitlines(keepends=True)[0]):
            manifest.write_bytes(raw)
            self.value['package_manifest']['sha256'] = s.setup.digest(raw)
            with self.assertRaises(s.setup.Refused):
                s.rewind_sources(self.value)
        manifest.write_bytes(good)
        self.value['package_manifest']['sha256'] = s.setup.digest(good)
        self.value['source_root'] = '/foreign'
        with self.assertRaises((s.setup.Refused, OSError)):
            s.rewind_sources(self.value)

    def test_rewind_environment_keeps_normal_mode_and_binds_explicit_guardian(self):
        env = s.child_environment(self.value, self.root, 'agent-test', 'fresh-vm', {
            'display': ':9', 'xauthority': None, 'dbus_session_bus_address': 'unix:path=/explicit/bus'},
            rewind=True, guardian='owned.scope')
        self.assertEqual(env['MV_ARM64_CAPSULES'], '1')
        self.assertEqual(env['MV_REWIND_ENABLED'], '1')
        self.assertEqual(env['MV_REWIND_GUARDIAN_UNIT'], 'owned.scope')
        self.assertEqual(env['MV_REWIND_AGENT_INSTANCE'], 'agent-test')
        self.assertEqual(env['MV_REWIND_PROFILE'], str(self.root / 'guest-profile.json'))
        for key in ('MV_REWIND_ONLY', 'MV_HEADLESS_ONLY', 'MV_GUEST_COMMAND_ONLY'):
            self.assertNotIn(key, env)

    def test_rewind_root_preserves_legacy_prefix_and_unix_socket_budget(self):
        run = 'a' * 24
        self.assertEqual(s.session_root_prefix(run, False), 'metaviewer-arm64-' + run + '-')
        root = '/dev/shm/' + s.session_root_prefix(run, True)
        self.assertLessEqual(len((root + '/r/headless-4294967295/rewind-12345678/vsock.sock_52').encode()), 107)
        allocated = s.allocate_session_root(run, True, self.root)
        self.assertEqual(allocated, self.root / s.session_root_prefix(run, True))
        self.assertEqual(allocated.stat().st_mode & 0o777, 0o700)
        with self.assertRaises(FileExistsError):
            s.allocate_session_root(run, True, self.root)
        self.assertEqual(list(allocated.iterdir()), [])

    def test_fixed_scope_caps_no_shell(self):
        argv = s.scope_args('owned.scope', '/runtime/python', '/runtime/session.py', Path('/ram/root'))
        for field in ('MemoryHigh=6G', 'MemoryMax=8G', 'MemorySwapMax=0', 'CPUQuota=200%', 'TasksMax=256'):
            self.assertIn(field, argv)
        self.assertIn('--scope', argv)
        self.assertNotIn('sh', argv)

    def test_native_identity_refusal_precedes_helper_creation(self):
        self.directories()
        calls = []
        def fake(argv, **kwargs):
            calls.append(argv)
            return b'{}' if 'show' in argv else b''
        with patch.dict(os.environ, {'XDG_RUNTIME_DIR': str(self.root)}, clear=False):
            with self.assertRaises(s.setup.Refused):
                s.provision(self.value, self.root, 'synthetic', command=fake, guard=lambda: None)
        self.assertEqual(len(calls), 2)
        self.assertTrue(all('/usr/bin/docker' not in x for x in calls))
        self.assertNotIn('--domains', calls[0])
        self.assertIn('identity_create_pending', (self.root / 'event-0000.json').read_text())

    def test_browser_uses_established_chromium_metadata(self):
        # External shape: test_v027_program_provision native fixture and
        # test_mv_identity browser metadata use chromium, not the create kind.
        self.directories()
        self.value['normal_profiles'] = {'browser': {'image_id': 'sha256:' + 'c' * 64,
                                                     'domains': ['example.com']}}
        profile = 'arm64-browser-synthetic'
        payload = self.root / 'store/profiles' / profile
        calls = []
        class HelperReached(Exception):
            pass
        def fake(argv, **kwargs):
            calls.append(argv)
            if argv[0] == '/usr/bin/docker':
                raise HelperReached()
            if 'create' in argv:
                payload.mkdir(mode=0o700, parents=True)
                return b''
            return json.dumps({'profile_id': profile, 'browser': 'chromium',
                               'account_label': 'ARM64 browser', 'allowed_domains': ['example.com']}).encode()
        try:
            with self.assertRaises(HelperReached):
                s.provision(self.value, self.root, 'synthetic', command=fake, kind='browser', guard=lambda: None)
        except s.setup.Refused:
            self.fail('Established chromium metadata must pass identity admission')
        self.assertEqual(calls[0][-2:], ['--domains', 'example.com'])
        self.assertNotIn('--browser', calls[0])
        self.assertEqual(calls[-1][0:2], ['/usr/bin/docker', 'create'])

    def test_program_metadata_stays_program(self):
        self.directories()
        self.value['normal_profiles'] = {'program': {'image_id': 'sha256:' + 'c' * 64}}
        profile = 'arm64-program-synthetic'
        class HelperReached(Exception):
            pass
        def fake(argv, **kwargs):
            if argv[0] == '/usr/bin/docker':
                raise HelperReached()
            if 'create' in argv:
                self.assertEqual(argv[-2:], ['--browser', 'program'])
                self.assertNotIn('--domains', argv)
                (self.root / 'store/profiles' / profile).mkdir(mode=0o700, parents=True)
                return b''
            return json.dumps({'profile_id': profile, 'browser': 'program'}).encode()
        with self.assertRaises(HelperReached):
            s.provision(self.value, self.root, 'synthetic', command=fake, kind='program', guard=lambda: None)

    def test_exception_cleanup_loads_only_digest_bound_setup(self):
        raw = json.dumps(self.value).encode()
        s.setup.write_bytes_new(self.root / 'setup.json', raw)
        s.setup.write_new(self.root / 'PLAN.json', {'registry_sha256': s.setup.digest(raw)})
        guardian = {'unit': 'synthetic.scope', 'invocation': 'a' * 32,
                    'cgroup': '/synthetic', 'device': 1, 'inode': 2}
        s.setup.write_new(self.root / 'guardian.json', guardian)
        for changed in (True, False):
            with self.subTest(changed=changed):
                (self.root / 'setup.json').write_bytes(raw + (b' ' if changed else b''))
                with patch('sys.argv', ['session', '--internal-root', str(self.root)]), \
                        patch.object(s, 'internal', side_effect=s.setup.Refused('synthetic failure')), \
                        patch.object(s, 'inventory_module') as loader, \
                        patch.object(s, 'inventory_append') as append, \
                        patch.object(s, 'stop_guardian') as stop:
                    self.assertEqual(s.main(), 2)
                    stop.assert_called_once_with(guardian)
                    if changed:
                        loader.assert_not_called()
                        append.assert_not_called()
                    else:
                        loader.assert_called_once_with(self.value)
                        append.assert_called_once()

    def test_ui_bus_policy_hides_manager_but_keeps_portal_services(self):
        policy = s.ui_bus_policy()
        self.assertIn('--filter', policy)
        self.assertIn('--talk=org.gtk.vfs.*', policy)
        self.assertNotIn('--talk=org.freedesktop.portal.Desktop', policy)
        self.assertFalse(any('systemd' in x or x == '--talk=*' for x in policy))
        self.assertEqual(s.ui_bus_address(self.root), 'unix:path=' + str(self.root / 'host-runtime/ui-bus'))

    def test_replayed_internal_root_refused_before_effect(self):
        self.directories()
        (self.root / 'event-0000.json').write_text('{}')
        # A malformed/unbound plan never reaches scope/native/application work.
        s.setup.write_new(self.root / 'PLAN.json', {'schema': 'wrong'})
        with patch.object(s, 'verify_scope') as scope, patch.object(s.subprocess, 'Popen') as popen:
            with self.assertRaises(s.setup.Refused):
                s.internal(str(self.root))
            scope.assert_not_called()
            popen.assert_not_called()

    def test_foreign_helper_refuses(self):
        with self.assertRaises(s.setup.Refused):
            s.helper_identity({'Id': 'foreign'}, 'ours', 'own', 'image', self.root, 'run')

    def test_exact_helper_custody_and_isolation(self):
        obj = {'Id': 'ours', 'Name': '/own', 'Image': 'image',
               'Config': {'Labels': {'metaviewer.arm64-session': 'run'}, 'Entrypoint': ['/usr/bin/chown'],
                          'Cmd': ['10001:10001', '/payload'], 'User': '0:0'},
               'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'Memory': 128 * 1024**2,
                              'MemorySwap': 128 * 1024**2, 'PidsLimit': 16, 'NanoCpus': 250000000,
                              'CapAdd': ['CAP_CHOWN'], 'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'], 'Privileged': False,
                              'Mounts': [{'Source': str(self.root), 'Target': '/payload', 'Type': 'bind'}]},
               'Mounts': [{'Source': str(self.root), 'Destination': '/payload', 'Type': 'bind'}]}
        s.helper_identity(obj, 'ours', 'own', 'image', self.root, 'run')
        for changed in ('command', 'capability', 'extra_mount', 'foreign_label', 'nnp_false', 'privileged'):
            v = copy.deepcopy(obj)
            if changed == 'command':
                v['Config']['Cmd'] = ['-R', '10001:10001', '/payload']
            elif changed == 'capability':
                v['HostConfig']['CapAdd'].append('SYS_ADMIN')
            elif changed == 'extra_mount':
                v['Mounts'].append(v['Mounts'][0])
            elif changed == 'foreign_label':
                v['Config']['Labels']['metaviewer.arm64-session'] = 'foreign'
            elif changed == 'nnp_false':
                v['HostConfig']['SecurityOpt'] = ['no-new-privileges=false']
            else:
                v['HostConfig']['Privileged'] = True
            with self.subTest(changed=changed), self.assertRaises(s.setup.Refused):
                s.helper_identity(v, 'ours', 'own', 'image', self.root, 'run')

    def test_existing_held_session_blocks_new_scope(self):
        directory = self.root / 'registry'
        directory.mkdir(mode=0o700)
        (directory / 'held-session.json').write_text('{"status":"unknown"}')
        with patch.object(s.setup, 'load_registry', return_value=self.value), \
                patch.object(s.setup, 'host_check', return_value={}), \
                patch.object(s.setup, 'interpreter_check'), \
                patch.object(s, 'ui_transport', return_value={}), \
                patch.object(s.setup, 'read', return_value=b'{}'), \
                patch.object(s.setup, 'registry_path', return_value=directory / 'setup.json'), \
                patch.object(s.subprocess, 'call') as call:
            with self.assertRaises(s.setup.Refused):
                s.launch(self.value['package']['app']['path'], self.value['source_root'], str(self.root / 'ui.json'), self.value['source_commit'], 111, 222)
            call.assert_not_called()

    def test_invalid_scope_limits_block_admission(self):
        raw = b'ActiveState=active\nControlGroup=/user.slice/owned.scope\nMemoryHigh=1\nMemoryMax=8589934592\nMemorySwapMax=0\nTasksMax=256\nCPUQuotaPerSecUSec=2s\n'
        with patch.object(s.setup, 'run', return_value=raw), \
                patch.object(Path, 'read_text', return_value='0::/user.slice/owned.scope\n'):
            with self.assertRaises(s.setup.Refused):
                s.verify_scope('owned.scope')

    def test_foreign_slice_refuses_even_exact_self_and_limits(self):
        group = '/user.slice/foreign.slice/owned.scope'
        raw = ('ActiveState=active\nControlGroup=' + group + '\nMemoryHigh=6442450944\n'
               'MemoryMax=8589934592\nMemorySwapMax=0\nTasksMax=256\nCPUQuotaPerSecUSec=2s\nSlice=newton-ia.slice\n').encode()
        parent = ('ActiveState=active\nControlGroup=' + group.rsplit('/', 1)[0] + '\nMemoryMax=107374182400\nTasksMax=32768\n').encode()
        with patch.object(s.setup, 'run', side_effect=[raw, parent]), \
                patch.object(Path, 'read_text', return_value='0::' + group + '\n'):
            with self.assertRaises(s.setup.Refused):
                s.verify_scope('owned.scope')

    def test_exact_uid_slice_positive_and_user_bus_separation(self):
        group = '/user.slice/user-%d.slice/user@%d.service/newton.slice/newton-ia.slice/owned.scope' % (os.getuid(), os.getuid())
        raw = ('ActiveState=active\nControlGroup=' + group + '\nMemoryHigh=6442450944\n'
               'MemoryMax=8589934592\nMemorySwapMax=0\nTasksMax=256\nCPUQuotaPerSecUSec=2s\nSlice=newton-ia.slice\n').encode()
        parent = ('ActiveState=active\nControlGroup=' + group.rsplit('/', 1)[0] + '\nMemoryMax=107374182400\nTasksMax=32768\n').encode()
        calls = []
        def fake(argv, env, timeout):
            self.assertEqual(timeout, 5)
            self.assertEqual(env['DBUS_SESSION_BUS_ADDRESS'], 'unix:path=/run/user/%d/bus' % os.getuid())
            calls.append(argv)
            return raw if len(calls) == 1 else parent
        with patch.object(s.setup, 'run', side_effect=fake), \
                patch.object(Path, 'read_text', return_value='0::' + group + '\n'):
            self.assertEqual(s.verify_scope('owned.scope'), group)
        self.assertEqual(len(calls), 2)

    def test_explicit_ui_transport_metadata_without_credential_reads(self):
        auth = self.root / 'synthetic-authority'
        auth.write_bytes(b'synthetic-not-a-credential')
        auth.chmod(0o600)
        with socket.socket(socket.AF_UNIX) as bus:
            bus.bind(str(self.root / 'bus'))
            transport = {'schema': 'metaviewer-arm64-ui-transport/v1', 'mode': 'private-ui',
                         'display': ':9', 'xauthority': str(auth),
                         'dbus_session_bus_address': 'unix:path=' + str(self.root / 'bus')}
            with patch.object(s.setup, 'read', side_effect=AssertionError('credential read')):
                self.assertEqual(s.ui_transport(transport), transport)
            transport['xauthority'] = None
            with self.assertRaises((s.setup.Refused, TypeError)):
                s.ui_transport(transport)
            transport['mode'] = 'trusted-user-invocation'
            s.ui_transport(transport)

    def test_app_has_only_admitted_ui_and_private_runtime_paths(self):
        explicit = {'display': ':17', 'xauthority': None, 'dbus_session_bus_address': 'unix:path=/private/ui-bus'}
        with patch.dict(os.environ, {'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/operator/bus',
                                    'DISPLAY': ':0', 'XAUTHORITY': '/operator/auth',
                                    'XDG_RUNTIME_DIR': '/run/user/1000', 'XDG_DATA_HOME': '/operator/data'}):
            env = s.child_environment(self.value, self.root, 'agent', 'vm', explicit)
        self.assertNotIn('XAUTHORITY', env)
        self.assertEqual(env['DBUS_SESSION_BUS_ADDRESS'], explicit['dbus_session_bus_address'])
        self.assertEqual(env['DISPLAY'], ':17')
        for field in ('HOME', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
            self.assertTrue(Path(env[field]).is_relative_to(self.root))

    def test_interpreter_failure_precedes_held_marker_and_scope(self):
        with patch.object(s.setup, 'load_registry', return_value=self.value), \
                patch.object(s.setup, 'interpreter_check', side_effect=s.setup.Refused('bad interpreter')), \
                patch.object(s.setup, 'write_new') as write, patch.object(s.subprocess, 'call') as call:
            with self.assertRaises(s.setup.Refused):
                s.launch(self.value['package']['app']['path'], self.value['source_root'], '/synthetic/ui', self.value['source_commit'], 111, 222)
            write.assert_not_called()
            call.assert_not_called()

    def test_normal_browser_template_not_static_program(self):
        profiles = s.child_environment(self.value, self.root, 'agent', 'vm',
            {'display': ':9', 'xauthority': None, 'dbus_session_bus_address': 'unix:path=/synthetic'},
            {'browser': 'own-browser', 'program': 'own-program'})
        rows = json.loads(profiles['MV_SRF_PROFILES'])
        self.assertEqual(rows['own-browser']['Kind'], 'browser')
        self.assertNotIn('own-program', rows)

    def test_sealed_commit_mismatch_precedes_interpreter_and_held_marker(self):
        with patch.object(s.setup, 'load_registry', return_value=self.value), \
                patch.object(s.setup, 'interpreter_check') as probe, patch.object(s.setup, 'write_new') as write:
            with self.assertRaises(s.setup.Refused):
                s.launch(self.value['package']['app']['path'], self.value['source_root'], '/synthetic/ui', 'd' * 40, 111, 222)
            probe.assert_not_called()
            write.assert_not_called()

    def test_effective_app_native_execute_refuses_before_held_marker(self):
        directory = self.root / 'registry'
        directory.mkdir(mode=0o700)
        registry = directory / 'setup.json'
        s.setup.write_new(registry, self.value)
        for asset in (self.value['package']['app'], self.value['native']['srf-identity-admin']):
            p = Path(asset['path'])
            p.chmod(0o601)
            with patch.object(s.setup, 'registry_path', return_value=registry), \
                    patch.object(s.setup, 'interpreter_check') as probe, \
                    patch.object(s.subprocess, 'call') as call:
                with self.assertRaises(s.setup.Refused):
                    s.launch(self.value['package']['app']['path'], self.value['source_root'], '/unused-ui', self.value['source_commit'], 111, 222)
                probe.assert_not_called()
                call.assert_not_called()
            self.assertFalse((directory / 'held-session.json').exists())
            p.chmod(0o700)

    def test_process_observation_unknown_absent_and_reused(self):
        fields = ['S'] + ['1'] * 19
        fields[19] = '987'
        raw = '77 (synthetic process) ' + ' '.join(fields)
        with patch.object(Path, 'read_text', side_effect=[raw, '0::/synthetic', raw]):
            self.assertEqual(REAL_PROCESS_IDENTITY(77)['start_ticks'], 987)
        for failure, absent in ((FileNotFoundError(), True), (PermissionError(), False)):
            with patch.object(Path, 'read_text', side_effect=failure):
                if absent:
                    self.assertIsNone(REAL_PROCESS_IDENTITY(77))
                else:
                    with self.assertRaises(s.setup.Refused):
                        REAL_PROCESS_IDENTITY(77)
        with patch.object(Path, 'read_text', return_value='malformed'):
            with self.assertRaises(s.setup.Refused):
                REAL_PROCESS_IDENTITY(77)
        original = dict(self.owner_tuple)
        with patch.object(s, 'process_identity', return_value={**original, 'start_ticks': 999}):
            self.assertFalse(s.process_alive(original))

    def test_launcher_must_be_current_exact_parent(self):
        with patch.object(os, 'getppid', return_value=111):
            self.assertEqual(REAL_BIND_LAUNCHER(111, 222), self.owner_tuple)
            for pid, start in ((112, 222), (111, 223), (111, None), (True, 222)):
                with self.subTest(pid=pid, start=start), self.assertRaises(s.setup.Refused):
                    REAL_BIND_LAUNCHER(pid, start)

    def test_stop_record_and_parent_loss_fence_future_effects(self):
        plan = {'run_id': 'a' * 24, 'launcher': self.owner_tuple, 'outer': self.owner_tuple}
        s.request_stop(self.root, plan)
        before = (self.root / 'STOP_REQUESTED').read_bytes()
        s.request_stop(self.root, plan)
        self.assertEqual((self.root / 'STOP_REQUESTED').read_bytes(), before)
        self.assertFalse(s.custody_open(self.root, plan))
        command = Mock()
        with self.assertRaises(s.setup.Refused):
            s.provision(self.value, self.root, 'synthetic', command=command,
                        guard=lambda: s.effect_guard(self.root, plan))
        command.assert_not_called()
        self.assertFalse(list(self.root.glob('event-*')))

    def test_app_monitor_terminates_only_bound_process(self):
        app = Mock()
        app.poll.return_value = None
        app.wait.return_value = 0
        with patch.object(s, 'custody_open', return_value=False), patch.object(s, 'process_alive', return_value=True):
            self.assertEqual(s.wait_app(app, self.owner_tuple, self.root, {}, {}, Mock()), 0)
        app.terminate.assert_called_once_with()
        app.wait.assert_called_once_with(timeout=5)
        app.reset_mock()
        with patch.object(s, 'custody_open', return_value=False), patch.object(s, 'process_alive', return_value=False):
            with self.assertRaises(s.setup.Refused):
                s.wait_app(app, self.owner_tuple, self.root, {}, {}, Mock())
        app.terminate.assert_not_called()

    def test_timeout_retains_unknown_before_exact_guardian_fallback(self):
        app = Mock()
        app.poll.return_value = None
        app.wait.side_effect = s.subprocess.TimeoutExpired('synthetic', 5)
        inventory = Mock()
        guardian = {'unit': 'synthetic.scope'}
        with patch.object(s, 'custody_open', return_value=False), patch.object(s, 'process_alive', return_value=True), \
                patch.object(s, 'stop_guardian') as stop:
            with self.assertRaises(s.setup.Refused):
                s.wait_app(app, self.owner_tuple, self.root, {}, guardian, inventory)
        stop.assert_called_once_with(guardian)
        self.assertEqual(inventory.append_inventory.call_args.args[2]['stage'], 'unknown')
        self.assertIn('app_stop_unknown', (self.root / 'event-0001.json').read_text())

    def test_guardian_replacement_never_signalled(self):
        witness = {'unit': 'synthetic.scope', 'cgroup': '/synthetic', 'invocation': 'a' * 32,
                   'device': 1, 'inode': 2}
        with patch.object(s, 'verify_scope', return_value='/synthetic'), \
                patch.object(s, 'guardian_witness', return_value={**witness, 'inode': 3}), \
                patch.object(s.setup, 'run') as command:
            with self.assertRaises(s.setup.Refused):
                s.stop_guardian(witness)
        command.assert_not_called()

    def test_real_inventory_api_setup_header_and_helper_chain(self):
        # Exercise the real public ledger API in an isolated synthetic root.
        public = Path(s.__file__).with_name('arm64_capsule_reconcile.py')
        self.value['reconciler'] = self.file('source/tools/arm64_capsule_reconcile.py', public.read_bytes())
        module = s.inventory_module(self.value)
        run = 'a' * 24
        root = self.root / ('metaviewer-arm64-' + run + '-fixture')
        root.mkdir(mode=0o700)
        snapshot = (json.dumps(self.value, separators=(',', ':')) + '\n').encode()
        s.setup.write_bytes_new(root / 'setup.json', snapshot)
        plan = {'run_id': run, 'unit': 'metaviewer-arm64-' + run + '.scope',
                'expected_commit': self.value['source_commit'], 'script_sha256': self.value['producer_pins']['setup']['sha256'],
                'setup_helper_sha256': 'b' * 64, 'registry_sha256': s.setup.digest(snapshot)}
        with patch.object(s, '__file__', self.value['producer_pins']['setup']['path']):
            s.initialize_inventory(self.value, root, plan, module)
            cg = '/user.slice/user-%d.slice/user@%d.service/newton.slice/newton-ia.slice/' % (os.getuid(), os.getuid()) + plan['unit']
            s.inventory_append(root, module, 'guardian_bound', id='guardian', unit=plan['unit'],
                               invocation='d' * 32, cgroup=cg, device=0, inode=99)
            name = 'mv-arm64-payload-vm-' + run
            s.inventory_append(root, module, 'helper_pending', id=name, name=name, image_id=self.value['vm_image'],
                               payload=str(root / 'store/profiles' / ('mv-arm64-' + run)), payload_device=0, payload_inode=88)
            s.inventory_append(root, module, 'helper_bound', id=name, cid='e' * 64)
            s.inventory_append(root, module, 'helper_removed', id=name)
        rows = [json.loads(x) for x in (root / 'allocations.jsonl').read_text().splitlines()]
        self.assertEqual([json.loads(x['payload'])['stage'] for x in rows],
                         ['session', 'guardian_bound', 'helper_pending', 'helper_bound', 'helper_removed'])
        self.assertEqual([x['seq'] for x in rows], [1, 2, 3, 4, 5])
        self.assertEqual(rows[1]['prev'], rows[0]['sha256'])

    def test_outer_signals_write_stop_without_terminating_scope_process(self):
        for wanted in (s.signal.SIGTERM, s.signal.SIGINT, s.signal.SIGHUP):
            handlers, restored = {}, []
            def registration(sig, handler):
                if callable(handler):
                    handlers[sig] = handler
                else:
                    restored.append(sig)
                return s.signal.SIG_DFL
            child = Mock()
            child.returncode = 0
            polls = [False]
            def poll():
                if not polls[0]:
                    polls[0] = True
                    handlers[wanted](wanted, None)
                    return None
                return 0
            child.poll.side_effect = poll
            def start():
                self.assertEqual(len(handlers), 3)
                return child
            with self.subTest(signal=wanted), patch.object(s.signal, 'signal', side_effect=registration), \
                    patch.object(s, 'effect_guard'), patch.object(s, 'custody_open', return_value=True), \
                    patch.object(s, 'request_stop') as stop, patch.object(s.time, 'sleep'):
                self.assertEqual(s.monitor_scope(start, self.root, {}), 0)
                stop.assert_called_once()
            self.assertEqual(len(restored), 3)
            child.terminate.assert_not_called()

    def test_parent_or_outer_loss_requests_stop(self):
        plan = {'run_id': 'a' * 24, 'launcher': self.owner_tuple, 'outer': self.owner_tuple}
        with patch.object(s, 'process_alive', side_effect=[True, False]):
            self.assertFalse(s.custody_open(self.root, plan))
        with patch.object(s, 'process_alive', side_effect=s.setup.Refused('unknown')):
            with self.assertRaises(s.setup.Refused):
                s.effect_guard(self.root, plan)

    def test_helper_inventory_precedes_effect_and_removed_follows_absence(self):
        self.directories()
        profile, run = 'mv-arm64-synthetic', 'synthetic'
        payload = self.root / 'store/profiles' / profile
        cid = 'f' * 64
        helper = 'mv-arm64-payload-vm-' + run
        stages, commands = [], []
        flags = {'started': False, 'removed': False, 'guarded': False}
        inventory = Mock()
        def append(config, producer, body, producer_path):
            stages.append(body['stage'])
            return {'seq': len(stages)}
        inventory.append_inventory.side_effect = append
        def guard():
            flags['guarded'] = True
        def fake(argv, **kwargs):
            self.assertTrue(flags['guarded'])
            flags['guarded'] = False
            commands.append(argv)
            if argv[0] != '/usr/bin/docker':
                if 'create' in argv:
                    payload.mkdir(mode=0o700, parents=True)
                    return b''
                return json.dumps({'profile_id': profile, 'browser': 'program'}).encode()
            if argv[1] == 'create':
                self.assertEqual(stages[-1], 'helper_pending')
                return cid.encode()
            if argv[1] == 'start':
                self.assertEqual(stages[-1], 'helper_bound')
                flags['started'] = True
                return b''
            if argv[1] == 'rm':
                self.assertEqual(stages[-1], 'helper_bound')
                flags['removed'] = True
                return cid.encode()
            if argv[1:3] == ['container', 'ls']:
                self.assertTrue(flags['removed'])
                return b''
            obj = {'Id': cid, 'Name': '/' + helper, 'Image': self.value['vm_image'],
                'Config': {'Labels': {'metaviewer.arm64-session': run}, 'Entrypoint': ['/usr/bin/chown'],
                           'Cmd': ['10001:10001', '/payload'], 'User': '0:0'},
                'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'Privileged': False,
                    'Memory': 128 * 1024**2, 'MemorySwap': 128 * 1024**2, 'PidsLimit': 16,
                    'NanoCpus': 250000000, 'CapAdd': ['CHOWN'], 'CapDrop': ['ALL'],
                    'SecurityOpt': ['no-new-privileges=true'],
                    'Mounts': [{'Source': str(payload), 'Target': '/payload', 'Type': 'bind'}]},
                'Mounts': [{'Source': str(payload), 'Destination': '/payload', 'Type': 'bind'}],
                'State': {'Status': 'exited' if flags['started'] else 'created', 'ExitCode': 0}}
            return json.dumps([obj]).encode()
        original = os.fstat
        def observed(fd):
            row = original(fd)
            if flags['started'] and (row.st_dev, row.st_ino) == (payload.stat().st_dev, payload.stat().st_ino):
                values = list(row)
                values[4] = values[5] = 10001
                return os.stat_result(values)
            return row
        with patch.object(os, 'fstat', side_effect=observed):
            self.assertEqual(s.provision(self.value, self.root, run, command=fake, guard=guard,
                                         inventory=inventory), profile)
        self.assertEqual(stages, ['helper_pending', 'helper_bound', 'helper_removed'])


if __name__ == '__main__':
    unittest.main()
