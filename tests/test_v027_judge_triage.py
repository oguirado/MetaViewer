"""V027 U6 regression sequences; all native inventories and launches are faked."""
import hashlib
import importlib.util
import os
import re
import shlex
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests' / 'judge'))
from judge_sandbox import Sandbox

SPEC = importlib.util.spec_from_file_location('ram_u6', ROOT / 'tools/mv_ram_admission.py')
ram = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ram)


class ReservationProof(unittest.TestCase):
    def test_incomplete_inventory_never_removes_dead_owner(self):
        for profile, native in [('mv-live', 'srf-id-random-123'),
                                ('', 'srf-pg-legacy'), ('', 'srf-vm-legacy')]:
            with self.subTest(profile=profile, native=native), tempfile.TemporaryDirectory() as d:
                path = Path(d) / ('12345-' + 'a' * 32 + '-' +
                    hashlib.sha256(profile.encode()).hexdigest() + ('--' + profile if profile else ''))
                path.touch(mode=0o600)
                def run(argv):
                    return '"unix:///fake/docker.sock"' if argv[1] == 'context' else native + '\n'
                with patch.dict(os.environ, {}, clear=True):
                    rows = ram.reclaim(d, True, ram.NativeInventory(run), lambda pid: True)
                self.assertEqual(rows[0]['action'], 'keep')
                self.assertTrue(path.exists())

    def test_host_process_or_unreadable_inventory_is_not_absence(self):
        with tempfile.TemporaryDirectory() as d:
            proc = Path(d)
            (proc / '123').mkdir()
            (proc / '123' / 'comm').write_text('Xvfb\n')
            with patch.object(ram, 'HOST_PROC', proc, create=True):
                self.assertIsNot(ram.NativeInventory(lambda argv: '"unix:///fake/docker.sock"'
                    if argv[1] == 'context' else '').absent('mv-live'), True)


class JudgeLaunch(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.sb = Sandbox(tmp.name)
        self.addCleanup(self.sb.cleanup)
        self.sb.full_kit()
        result = self.sb.judge('install')
        self.assertEqual(result.rc, 0, result.text)

    def test_already_exited_child_preserves_wait_status(self):
        app = self.sb.jh / 'app' / ('MetaViewer-linux-' + self.sb.archn) / 'metaviewer'
        self.sb.write_exec(app, '#!/bin/bash\nexit 37\n')
        script = self.sb.kit / 'judge' / 'metaviewer-judge.sh'
        script.write_text(script.read_text().replace('    rc=0\n', '    sleep 0.1\n    rc=0\n'))
        result = self.sb.judge('run')
        self.assertEqual(result.rc, 37, result.text)
        self.assertFalse((self.sb.jh / 'run' / 'metaviewer.pid').exists())

    def test_docker_refusal_precedes_legacy_network_repair(self):
        self.sb.full_kit(t2=True)
        result = self.sb.judge('install', '--capsules', '--no-firewall')
        self.assertEqual(result.rc, 0, result.text)
        self.sb.put('docker_info_rc', '1\n')
        cli = self.sb.jh / 'deps' / 'opensuperficies' / 'bin' / 'srf-identity-surface'
        self.sb.write_exec(cli, '#!/bin/bash\necho called >> "' + str(self.sb.fake / 'repair') + '"\nexit 1\n')
        result = self.sb.judge('run')
        self.assertEqual(result.rc, 2, result.text)
        self.assertIn('JUDGE_DOCKER', result.codes)
        self.assertNotIn('JUDGE_NET', result.codes)
        self.assertFalse((self.sb.fake / 'repair').exists())

    def test_printed_recovery_can_clear_record_then_stop(self):
        admission = self.sb.root / 'admission'
        admission.mkdir(mode=0o700)
        record = admission / ('12345-' + 'a' * 32 + '-' + hashlib.sha256(b'mv-live').hexdigest() + '--mv-live')
        record.touch(mode=0o600)
        # Fake native absence and dead-owner proof, while exercising the real reclaim CLI.
        proc = self.sb.root / 'empty-proc'
        proc.mkdir()
        wrapper = self.sb.kit / 'tools' / 'mv_ram_admission.py'
        wrapper.write_text('import runpy\nfrom pathlib import Path\n'
            + 'm = runpy.run_path(' + repr(str(ROOT / 'tools' / 'mv_ram_admission.py')) + ')\n'
            + 'g = m["NativeInventory"].absent.__globals__\n'
            + 'g["HOST_PROC"] = Path(' + repr(str(proc)) + ')\n'
            + 'g["pid_dead"].__globals__["os"].kill = lambda *a: (_ for _ in ()).throw(ProcessLookupError())\n'
            + 'raise SystemExit(m["main"]())\n')
        self.sb.write_exec(self.sb.bin / 'python3', '#!/bin/bash\nexec ' + sys.executable + ' "$@"\n')
        self.sb.write_exec(self.sb.bin / 'docker', '#!/bin/bash\ncase "$1" in context) echo ' + shlex.quote('"unix:///fake/docker.sock"') + ';; esac\n')
        env = {'MV_RAM_ADMISSION_DIR': str(admission)}
        result = self.sb.judge('stop', env=env)
        self.assertEqual(result.rc, 2, result.text)
        commands = re.findall(r'admission record .* -- fix: (.*)', result.err)
        self.assertEqual(len(commands), 1, result.text)
        recovered = subprocess.run(['bash', '-c', commands[0]], env=self.sb.env(env),
            cwd=self.sb.root, capture_output=True, text=True, timeout=10)
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        self.assertFalse(record.exists(), recovered.stdout)
        clean = self.sb.judge('stop', env=env)
        self.assertEqual(clean.rc, 0, clean.text)

    def test_pidfile_publication_failure_unwinds_child(self):
        pidfile = self.sb.jh / 'run' / 'metaviewer.pid'
        pidfile.mkdir(parents=True)
        self.addCleanup(pidfile.rmdir)
        app = self.sb.jh / 'app' / ('MetaViewer-linux-' + self.sb.archn) / 'metaviewer'
        terminated = self.sb.root / 'terminated'
        self.sb.write_exec(app, '#!/bin/bash\ntrap ' + shlex.quote('touch ' + shlex.quote(str(terminated)) + '; exit 0')
            + ' TERM\nsleep 0.5\n')
        script = self.sb.kit / 'judge' / 'metaviewer-judge.sh'
        script.write_text(script.read_text().replace('    child=$!\n', '    child=$!\n    sleep 0.1\n'))
        result = self.sb.judge('run')
        self.assertEqual(result.rc, 2, result.text)
        self.assertIn('JUDGE_PIDFILE', result.codes)
        self.assertTrue(terminated.exists(), result.text)

    def test_doctor_refuses_missing_auxiliary_profile_by_identity(self):
        self.sb.full_kit(t2=True)
        result = self.sb.judge('install', '--capsules', '--no-firewall')
        self.assertEqual(result.rc, 0, result.text)
        (self.sb.home / 'store' / 'profiles' / 'mv-live-3').rmdir()
        result = self.sb.judge('doctor', '--capsules')
        self.assertEqual(result.rc, 2, result.text)
        self.assertIn('JUDGE_PROFILE', result.codes)
        self.assertIn('mv-live-3', result.err)

    def test_doctor_checks_custom_pool_and_rejects_invalid_json(self):
        self.sb.full_kit(t2=True)
        result = self.sb.judge('install', '--capsules', '--no-firewall')
        self.assertEqual(result.rc, 0, result.text)
        for pool in ('{"judge":{"Kind":"browser"},"missing-extra":{"Kind":"browser"}}', 'broken'):
            with self.subTest(pool=pool):
                result = self.sb.judge('doctor', '--capsules', env={'MV_SRF_PROFILES': pool})
                self.assertEqual(result.rc, 2, result.text)
                self.assertIn('JUDGE_PROFILE', result.codes)


class InstallDocumentation(unittest.TestCase):
    def test_documented_image_load_precedes_firewall_selection(self):
        doc = (ROOT / 'docs' / 'JUDGE_QUICKSTART.md').read_text()
        step = doc.split('4. With `--capsules`', 1)[1].split('5. Writes', 1)[0]
        self.assertLess(step.index('loads `images-linux-<arch>.tar`'), step.index('firewall'))
        script = (ROOT / 'scripts' / 'judge' / 'metaviewer-judge.sh').read_text()
        install = script.split('cmd_install() {', 1)[1].split('# ----------------------------------------------------------------------- run', 1)[0]
        self.assertLess(install.index('step_images'), install.index('step_firewall'))


if __name__ == '__main__':
    unittest.main()
