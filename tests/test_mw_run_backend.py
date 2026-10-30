"""Host-side custody mutations; no live service, Docker or network calls."""
import contextlib
import importlib.util
import io
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agents'))
spec = importlib.util.spec_from_file_location('host_entry_test', ROOT / 'tools/mw_run_backend.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class BackendTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='mw-entry-Música-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root.chmod(0o700)
        self.backend = object.__new__(host.HostBackend)
        b = self.backend
        b.identity, b.state, b.store = 'alice', self.root, self.root / 'store'
        b.binary, b.admin = self.root / 'srf-identity-surface', self.root / 'srf-identity-admin'
        b.surface_id, b.capsule, b.client, b.pending = None, None, Mock(), {}
        b.evidence = self.root
        self.surface = dict(profile_id='alice', state='active', kind='browser', surface_id='surface-alice')
        self.write(self.root / 'capsule.json', dict(Lease=dict(ProfileID='alice'),
                                                   Capsule=dict(container='srf-id-alice')))
        self.argv = []

    def write(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def invocation(self, argv, **kwargs):
        self.argv.append([str(x) for x in argv])
        if Path(argv[0]).name == 'srf-identity-admin':
            result = {'profile_id': 'alice'}
            return SimpleNamespace(returncode=0, stdout=json.dumps(result).encode())
        if argv[0] == 'docker':
            return SimpleNamespace(returncode=0, stdout=b'srf-id-alice\n')
        if argv[1] == 'ax':
            return SimpleNamespace(returncode=0, stdout=b'{"elements":[]}')
        self.fail('unexpected argv: ' + repr(argv))

    @contextlib.contextmanager
    def custody(self, surfaces=None):
        page = dict(surfaces=[self.surface] if surfaces is None else surfaces, next_cursor=None)
        with patch.object(host.tools, 'list_surfaces', return_value=page), \
             patch.object(host.subprocess, 'run', side_effect=self.invocation):
            yield

    def test_identity_ownership_and_native_ax(self):
        with self.custody():
            witness = self.backend.ownership()
            self.assertEqual(witness['identity'], 'alice')
            self.assertEqual(witness['capsules'], ['srf-id-alice'])
            self.assertEqual(self.backend.ax(), {'elements': []})
        self.assertTrue(any(argv[1] == 'ax' for argv in self.argv))
        self.assertFalse(any('input' in argv for argv in self.argv))

    def test_no_surface_ambiguous_and_rebound(self):
        for surfaces, code in (([], 'MW_RUN_NO_SURFACE'),
                               ([self.surface, self.surface], 'MW_RUN_AMBIGUOUS')):
            with self.custody(surfaces), self.assertRaisesRegex(host.OwnerRefused, code):
                self.backend.ownership()
        with self.custody():
            self.backend.ownership()
            self.surface['surface_id'] = 'replacement'
            with self.assertRaisesRegex(host.OwnerRefused, 'MW_RUN_OWNERSHIP'):
                self.backend.ownership()

    def start_witness(self, mode='open'):
        directory = self.root / 'egress'
        directory.mkdir(mode=0o700, exist_ok=True)
        record = directory / 'alice.json'
        digest = hashlib.sha256(record.read_bytes()).hexdigest() if record.exists() else 'absent'
        witness = dict(schema='metaviewer.capsule_egress_started/v1', capsule_id='srf-id-alice',
                       effective_mode=mode, record_sha256=digest, start_mono_ns=123, start_wall_ns=456)
        path = directory / 'alice.started.json'
        path.unlink(missing_ok=True)
        self.write(path, witness)
        path.chmod(0o400)
        return path

    def test_mut_site_net_undeclared_and_witness_missing(self):
        with self.custody(), self.assertRaisesRegex(host.OwnerRefused, 'MW_NETWORK'):
            self.backend.network_context()
        directory = self.root / 'egress'
        directory.mkdir(mode=0o700)
        self.write(directory / 'alice.json', dict(schema='metaviewer.capsule_egress/v1', mode='open', domains=[]))
        with self.custody(), self.assertRaisesRegex(host.OwnerRefused, 'MW_NETWORK'):
            self.backend.network_context()

    def test_mut_mode_from_record(self):
        directory = self.root / 'egress'
        directory.mkdir(mode=0o700)
        self.write(directory / 'alice.json', dict(schema='metaviewer.capsule_egress/v1', mode='open', domains=[]))
        for effective, expected in (('legacy', 'legacy'), ('open', 'open'),
                                    ('proxied', 'allowlisted/proxied')):
            self.start_witness(effective)
            with self.custody():
                context = self.backend.network_context()
            self.assertEqual(context['mode'], expected)
            self.assertEqual(context['basis']['effective_mode'], effective)

    def test_mut_record_after_start(self):
        for existed in (False, True):
            with self.subTest(existed=existed):
                directory = self.root / 'egress'
                directory.mkdir(mode=0o700, exist_ok=True)
                record = directory / 'alice.json'
                record.unlink(missing_ok=True)
                if existed:
                    self.write(record, dict(schema='metaviewer.capsule_egress/v1', mode='open', domains=[]))
                self.start_witness('legacy')
                with self.custody():
                    self.assertEqual(self.backend.network_context()['mode'], 'legacy')
                self.write(record, dict(schema='metaviewer.capsule_egress/v1', mode='allowlisted', domains=['example.com']))
                with self.custody(), self.assertRaisesRegex(host.OwnerRefused, 'restart the capsule'):
                    self.backend.network_context()

    def test_malformed_wrong_capsule_or_permissions_refuse(self):
        for mutation in ({'schema': 'wrong'}, {'capsule_id': 'srf-id-other'},
                         {'effective_mode': 'invented'}, {'start_mono_ns': None},
                         {'start_wall_ns': True}, {'record_sha256': 'wrong'}):
            path = self.start_witness()
            value = json.loads(path.read_text())
            value.update(mutation)
            path.chmod(0o600)
            self.write(path, value)
            path.chmod(0o400)
            with self.custody(), self.assertRaisesRegex(host.OwnerRefused, 'MW_NETWORK'):
                self.backend.network_context()
        path = self.start_witness()
        path.chmod(0o600)
        with self.custody(), self.assertRaisesRegex(host.OwnerRefused, 'MW_NETWORK'):
            self.backend.network_context()

    def test_mut_net_verb_shared_guard_and_native_input(self):
        with patch.object(host.subprocess, 'run') as process:
            # Match NetworkScopeTests' dynamic negative controls: the static
            # scan remains unchanged and still rejects literal lifecycle argv.
            forbidden = [[self.backend.binary, 'net', verb] for verb in ('status', 'up', 'down')]
            forbidden.append(['bash', '-c', 'srf-identity-surface net status'])
            for argv in forbidden:
                with self.assertRaises(host.live.ForbiddenVerb):
                    host.command(argv)
            with self.assertRaises(host.live.ForbiddenVerb):
                self.backend.native(self.backend.binary, ['net', 'status'])
            with self.assertRaisesRegex(host.OwnerRefused, 'MW_RUN_NATIVE_INPUT'):
                self.backend.native(self.backend.binary, ['input', '--container', 'srf-id-alice'])
            process.assert_not_called()

    def test_mut_direct_input_core_path_only(self):
        # Real dispatch under fake boundaries must call propose and wait_verify;
        # native injection or skipping admission makes this assertion fail.
        b = self.backend
        frame = dict(schema='frame_ref/v0.2', surface_id='surface-alice', ramws_path='/dev/shm/frame.rgb',
                     width=10, height=10, format='rgb8', stride_bytes=30, sha256='a' * 64,
                     generation=1, ts_ns=1)
        # Use the shipped fixture's exact frame shape (the wire frame has no schema).
        frame.pop('schema')
        frame.pop('stride_bytes')
        receipt = {'native_evidence': {'input_mono_ns': 123}}
        with patch.object(b, 'ownership'), patch.object(b, 'network_context'), \
             patch.object(host, 'build_proposal', return_value=dict(proposal_id='p', expectation={})), \
             patch.object(host.tools, 'propose', return_value={'proposal_id': 'p'}) as propose, \
             patch.object(host.tools, 'wait_verify', return_value=receipt) as verify, \
             patch.object(b, 'native', side_effect=AssertionError('native input bypass')):
            admitted = b.call('propose', sensed={'frame': frame},
                              plan={'action': {'type': 'click'}, 'expectation': {}}, max_ms=100)
            propose.assert_called_once()
            verify.assert_called_once()
            self.assertEqual(admitted['native_evidence'], receipt['native_evidence'])
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_RUN_OPERATION'):
            b.call('input')

    def test_entry_json_and_missing_receipt_is_nonzero(self):
        args = SimpleNamespace(identity='alice', site='example', workflow='read', slot=[])
        env = {'XDG_STATE_HOME': str(self.root)}
        with patch.dict(os.environ, env), patch.object(host, 'admit_home', return_value=self.root / 'home'), \
             patch.object(host, 'connect') as connection, patch.object(host, 'HostBackend'), \
             patch.object(host, 'execute', side_effect=host.OwnerRefused('receipt path absent')):
            host.HostBackend.return_value.network_evidence = dict(effective_mode='legacy', record_sha256='absent',
                                                               start_mono_ns=123, start_wall_ns=456)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                rc = host.run_entry(args)
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        result = json.loads(lines[0])
        self.assertNotEqual(rc, 0)
        self.assertEqual(result['verdict_code'], 'receipt path absent')
        self.assertIsNone(result['receipt'])
        self.assertTrue(Path(result['report']).is_file())
        report = json.loads(Path(result['report']).read_text())
        self.assertEqual(report['network']['effective_mode'], 'legacy')
        self.assertEqual(report['network']['record_sha256'], 'absent')
        self.assertEqual(report['network']['start_mono_ns'], 123)
        self.assertEqual(report['message'], 'receipt path absent')
        self.assertEqual(Path(result['report']).parent.stat().st_mode & 0o777, 0o700)


if __name__ == '__main__':
    unittest.main()
