"""[TARGET, unit decision] Ordered kit journey; native tools remain disposable.

Reuse the judge mutant-pair harness, but put real backpressure between partial
proxy startup and its outcome. Install, run and stop consume the same sandbox.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_sandbox import SRF_FAKE, Sandbox, make_tar
from test_mutants import run_pair


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
