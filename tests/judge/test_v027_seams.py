"""[TARGET, unit decision] Ordered kit journey; native tools remain disposable.

Reuse the judge mutant-pair harness, but put real backpressure between partial
proxy startup and its outcome. Install, run and stop consume the same sandbox.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import os
import shutil
import signal
import subprocess
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_sandbox import SRF_FAKE, Sandbox, make_tar
from test_mutants import run_pair


def stop_recorded_child(pid):
    if type(pid) is not int or pid <= 1:
        raise ValueError('unsafe child pid')
    if os.getpgid(pid) == os.getpgrp():
        raise ValueError('child shares caller process group')
    os.kill(pid, signal.SIGTERM)


class LauncherFlowRegressions(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.sb = Sandbox(self.temporary.name)
        self.addCleanup(self.sb.cleanup)

    def install(self):
        self.sb.full_kit()
        result = self.sb.judge('install')
        self.assertEqual(result.rc, 0, result.text)

    def wait_for(self, path, process):
        deadline = time.monotonic() + 20  # [TARGET] bounded barrier wait.
        while not path.exists():
            self.assertIsNone(process.poll(), 'launcher ended before barrier')
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)

    def start(self, command):
        process = subprocess.Popen([self.sb._bash(), str(self.sb.kit / 'judge/metaviewer-judge.sh'), command],
                                   env=self.sb.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, start_new_session=True)
        self.sb.children.append(process)
        return process

    def pause_tool(self, name, predicate):
        tool = self.sb.bin / name
        original = self.sb.bin / (name + '-original')
        tool.rename(original)
        self.sb.write_exec(tool, '#!/bin/bash\n' + predicate + '\n'
            '  touch "$MV_FAKE_DIR/barrier"\n'
            '  while [ ! -f "$MV_FAKE_DIR/barrier-release" ]; do sleep 0.01; done\nfi\n'
            f'exec "{original}" "$@"\n')

    def test_run_race_before_pid_publication(self):
        self.install()
        self.sb.put('app_hold', '1')
        # Both launchers used to pass running_pid before this preflight call.
        self.pause_tool('xdpyinfo', 'if [ ! -f "$MV_FAKE_DIR/barrier" ]; then')
        first = self.start('run')
        self.wait_for(self.sb.fake / 'barrier', first)
        loser = self.start('run')
        deadline = time.monotonic() + 2  # [TARGET] loser must refuse before release.
        while loser.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        self.sb.put('barrier-release', '1')
        self.assertEqual(loser.poll(), 2, 'concurrent run admitted before PID publication')
        self.assertIn('JUDGE_RUNNING', loser.communicate(timeout=20)[1])
        self.wait_for(self.sb.fake / 'app_env.txt', first)
        pidfile = self.sb.jh / 'run/metaviewer.pid'
        self.assertTrue(pidfile.exists())
        stopped = self.sb.judge('stop')
        self.assertEqual(stopped.rc, 0, stopped.text)
        first.communicate(timeout=20)
        self.assertEqual(first.returncode, 0)
        self.assertFalse(pidfile.exists())
        self.sb.put('app_hold', '')
        (self.sb.fake / 'app_hold').unlink()
        self.assertEqual(self.sb.judge('run').rc, 0)

    def test_install_race_at_final_move(self):
        self.install()
        receipt = (self.sb.jh / 'judge_receipt.json').read_bytes()
        self.pause_tool('mv', 'if [[ "$*" == *"/app.new "* ]] && [ ! -f "$MV_FAKE_DIR/barrier" ]; then')
        first = self.start('install')
        self.wait_for(self.sb.fake / 'barrier', first)
        loser = self.sb.judge('install')
        self.sb.put('barrier-release', '1')
        first.communicate(timeout=20)
        self.assertEqual(loser.rc, 2, loser.text)
        self.assertIn('JUDGE_RUNNING', loser.codes)
        self.assertEqual(first.returncode, 0)
        self.assertTrue((self.sb.jh / f'app/MetaViewer-linux-{self.sb.archn}/metaviewer').is_file())
        self.assertEqual((self.sb.jh / 'judge_receipt.json').read_bytes(), receipt)

    def test_exiting_launcher_preserves_replaced_pidfile(self):
        self.install()
        process = self.sb.spawn_run()
        pidfile = self.sb.jh / 'run/metaviewer.pid'
        child = int(pidfile.read_text())
        pidfile.write_text('replacement-owner\n')
        stop_recorded_child(child)
        process.communicate(timeout=20)
        self.assertEqual(process.returncode, 0)
        self.assertTrue(pidfile.exists(), 'exiting launcher removed replacement owner')
        self.assertEqual(pidfile.read_text(), 'replacement-owner\n')

    def test_final_move_failure_preserves_old_install(self):
        self.install()
        binary = self.sb.jh / f'app/MetaViewer-linux-{self.sb.archn}/metaviewer'
        original = binary.read_bytes()
        receipt = (self.sb.jh / 'judge_receipt.json').read_bytes()
        tool = self.sb.bin / 'mv'
        target = tool.resolve()
        tool.unlink()
        self.sb.write_exec(tool, '#!/bin/bash\n[[ "$*" == *"/app.new "* ]] && exit 1\n'
                           f'exec "{target}" "$@"\n')
        result = self.sb.judge('install')
        self.assertEqual(result.rc, 2, result.text)
        self.assertEqual(binary.read_bytes(), original)
        self.assertEqual((self.sb.jh / 'judge_receipt.json').read_bytes(), receipt)

    def test_low_memory_warns_about_ui_admission(self):
        self.sb.make_t2_ready()
        self.sb.set_meminfo(8 * 1024 * 1024, 5 * 1024 * 1024)
        result = self.sb.preflight('--tier', 'T2')
        self.assertEqual(result.rc, 0, result.text)
        self.assertIn('UI capsule creation is refused', result.err)
        self.assertNotIn('single capsule can run', result.err)
        self.assertIn('UI capsule creation is refused', self.sb.preflight('--tier', 'T1').err)
        self.sb.set_meminfo(8 * 1024 * 1024, 7 * 1024 * 1024)
        self.assertNotIn('UI capsule creation is refused', self.sb.preflight('--tier', 'T2').err)

    def test_docker_access_after_sysdep_install_before_load(self):
        self.sb.full_kit(t2=True)
        self.sb.drop_tool('docker')
        apt = self.sb.bin / 'apt-get'
        with apt.open('a') as stream:
            stream.write('\ncat > "$MV_FAKE_BIN/docker" <<\'EOF\'\n#!/bin/bash\n'
                         'echo "docker $*" >> "$MV_FAKE_DIR/docker.log"\nexit 1\nEOF\n'
                         'chmod +x "$MV_FAKE_BIN/docker"\n')
        result = self.sb.judge('install', '--capsules', '--yes')
        self.assertEqual(result.rc, 2, result.text)
        self.assertIn('JUDGE_DOCKER', result.codes)
        self.assertNotIn('docker load', self.sb.log('docker'))

    def test_custom_browser_pool_is_provisioned(self):
        self.sb.full_kit(t2=True)
        pool = json.dumps({'custom-browser': {'Kind': 'browser'}})
        result = self.sb.judge('install', '--capsules', '--no-firewall', env={'MV_SRF_PROFILES': pool})
        self.assertEqual(result.rc, 0, result.text)
        self.assertTrue((self.sb.home / 'store/profiles/custom-browser').is_dir())
        self.assertEqual(self.sb.preflight('--tier', 'T2', env={'MV_SRF_PROFILES': pool}).rc, 0)

    def test_stop_reports_private_runtime_and_host_ram_without_deletion(self):
        temporary = self.sb.root / 'tmp'
        private = temporary / 'mv-pkg-orphan/metaviewer'
        private.mkdir(parents=True)
        socket = private / 'core.sock'
        socket.touch()
        host = self.sb.shm / 'mv-host-xpra-orphan'
        display = self.sb.shm / f'metaviewer-display-{os.getuid()}'
        foreign = self.sb.shm / 'foreign'
        for path in (host, display, foreign):
            path.mkdir()
        ring = display / 'metaviewer/display/orphan.ring'
        ring.parent.mkdir(parents=True)
        ring.touch()
        result = self.sb.judge('stop', env={'TMPDIR': str(temporary)})
        self.assertEqual(result.rc, 2, result.text)
        for path in (socket, host, display):
            self.assertIn(str(path), result.err)
            self.assertTrue(path.exists())
        self.assertNotIn(str(foreign), result.err)
        shutil.rmtree(private.parent)
        shutil.rmtree(host)
        ring.unlink()
        # A clean publisher retains its empty display directory skeleton.
        self.assertEqual(self.sb.judge('stop', env={'TMPDIR': str(temporary)}).rc, 0)
        self.assertTrue(display.is_dir())

    def test_display_phase_requires_probe_and_display(self):
        self.sb.drop_tool('xdpyinfo')
        result = self.sb.preflight('--phase', 'display', env={'DISPLAY': None})
        self.assertEqual(result.rc, 2, result.text)
        self.assertIn('JUDGE_DISPLAY', result.codes)
        result = self.sb.preflight('--phase', 'display')
        self.assertEqual(result.rc, 2, result.text)
        self.assertIn('xdpyinfo', result.err)

    def test_quickstart_names_shipped_controls_and_separate_role_switch(self):
        from judge_sandbox import REPO
        quickstart = (REPO / 'docs/JUDGE_QUICKSTART.md').read_text()
        app = (REPO / 'ui/src/App.vue').read_text()
        for label in ('1 tile', '2 side by side', '2\u00d72', 'Focus + strip', 'Floating layout'):
            self.assertIn(f'`{label}`', quickstart)
            self.assertIn(f'label="{label}"', app)
        self.assertIn('**`Switch to agent mode`** separately', quickstart)
        self.assertNotIn('More \u25be -> Use MetaViewer', quickstart)
        self.assertNotIn('More \u25be -> Automate from a demo', quickstart)


class OrderedKitSeams(unittest.TestCase):
    def journey(self, sb, good):
        sb.full_kit(t2=True)
        # Replace only the native executable inside the fixture archive. The
        # installed judge, preflight, hashes and launch scripts remain real.
        import tarfile
        archive = sb.assets / f"opensuperficies-linux-{sb.archn}.tar.gz"
        anchor = '  "net up")\n'
        self.assertEqual(SRF_FAKE.count(anchor), 1)
        script = SRF_FAKE.replace(anchor, anchor +
            '    printf "partial\\n" > "$D/proxy-partial"\n'
            '    IFS= read -r result < "$D/proxy-release"\n'
            '    [ "$result" = ready ] || exit 4\n'
            '    printf "ready\\n" > "$D/proxy-ready"\n')
        with tarfile.open(archive) as source:
            members = [(m.name, source.extractfile(m).read() if m.isfile() else None, m.mode)
                       for m in source.getmembers()]
        make_tar(archive, [(name, script.encode() if name.endswith('/srf-identity-surface') else data, mode)
                           for name, data, mode in members])
        sb.write_sums()
        fifo = sb.fake / 'proxy-release'
        os.mkfifo(fifo, 0o600)
        # O_RDWR avoids cleanup depending on whether the child opened its end.
        descriptor = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
        receipt = sb.jh / 'judge_receipt.json'
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(sb.judge, 'install', '--capsules', '--no-firewall')
            try:
                deadline = time.monotonic() + 20  # [TARGET] event-wait ceiling.
                while not (sb.fake / 'proxy-partial').exists():
                    self.assertFalse(pending.done(), 'SEAM_INSTALL_ENDED_BEFORE_PROXY')
                    self.assertLess(time.monotonic(), deadline, 'SEAM_PROXY_START_TIMEOUT')
                    time.sleep(0.005)
                self.assertFalse(pending.done(), 'SEAM_INSTALL_MUST_WAIT')
                self.assertFalse(receipt.exists(), 'SEAM_NO_RECEIPT_BEFORE_PROXY_READY')
                self.assertFalse((sb.fake / 'app_env.txt').exists(), 'SEAM_NO_LAUNCH_DURING_INSTALL')
            finally:
                os.write(descriptor, b'ready\n' if good else b'failed\n')
                os.close(descriptor)
            installed = pending.result(timeout=90)
        if installed.rc:
            self.assertFalse(receipt.exists(), 'SEAM_FAILED_START_MUST_NOT_CERTIFY')
            self.assertFalse((sb.fake / 'app_env.txt').exists())
            return installed
        # A broken failure predicate can continue after the late native failure.
        self.assertTrue(good, 'SEAM_PARTIAL_PROXY_FAILURE_ACCEPTED')
        self.assertTrue((sb.fake / 'proxy-ready').exists())
        manifest = json.loads(receipt.read_text())
        self.assertEqual(manifest['tier'], 'T2')
        self.assertEqual(manifest['network_mode'], 'legacy')
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        seal = receipt.read_bytes()
        # Run calls net up again; leave a token for that ordered native call.
        descriptor = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
        try:
            os.write(descriptor, b'ready\n')
            proc = sb.spawn_run()
            environment = dict(line.split('=', 1) for line in
                               (sb.fake / 'app_env.txt').read_text().splitlines() if '=' in line)
            self.assertEqual(environment['MV_SRF_BIN_DIR'], str(sb.jh / 'deps/opensuperficies/bin'))
            self.assertEqual(environment['MV_SRF_STATE_DIR'], str(sb.home / 'state/metaviewer/srf'))
            self.assertNotIn('SECRET_PARENT_VAR', environment)
            stopped = sb.judge('stop')
            self.assertEqual(stopped.rc, 0, stopped.text)
            self.assertIn('JUDGE_STOP_CLEAN', stopped.out)
            proc.communicate(timeout=20)
            self.assertEqual(proc.returncode, 0)
            self.assertFalse((sb.jh / 'run/metaviewer.pid').exists())
            self.assertEqual(receipt.read_bytes(), seal, 'SEAM_RUN_STOP_MUST_PRESERVE_INSTALL_RECEIPT')
        finally:
            os.close(descriptor)
        return installed

    def test_original_late_failure_and_complete_install_run_stop(self):
        # Direct calls preserve preparation/assertion failures. run_pair wraps
        # those as SCENARIO_ERROR, which is useful for mutants but cannot prove
        # that a good full journey completed.
        for good in (False, True):
            with self.subTest(good=good), tempfile.TemporaryDirectory() as temporary:
                sb = Sandbox(temporary)
                try:
                    result = self.journey(sb, good)
                    self.assertEqual(result.rc, 0 if good else 2, result.text)
                    self.assertEqual('JUDGE_NET' in result.codes, not good)
                finally:
                    sb.cleanup()

    def test_native_start_predicate_mutant_is_killed(self):
        fires, silent, hits = run_pair('JUDGE_NET', self.journey, 'JUDGE_PROXY_UP')
        self.assertGreater(hits, 0, 'SEAM_MUTATION_MUST_HIT_SOURCE')
        self.assertFalse(fires and silent, 'SEAM_PROXY_PREDICATE_MUTANT_SURVIVED')


if __name__ == '__main__':
    unittest.main()
