"""Hermetic regression controls for frame binding and bounded child lifecycle."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.perception.base import Frame, PerceptionError
from metaviewer_agents.perception import vcore
from metaviewer_agents.perception.meta_muse import MetaMusePerceptionAdapter


PIXELS = b'AAA'
SHA = hashlib.sha256(PIXELS).hexdigest()


def ref(path='/dev/shm/unused.rgb'):
    return dict(schema='frame_ref/v0.2', width=1, height=1, sha256=SHA,
                ramws_path=str(path))


def c2(sha=SHA):
    return dict(schema=vcore.C2_SCHEMA, width=1, height=1, frame_sha256=sha,
                changed=None, changed_regions=[], crops=[], timing_us=1)


class PerceptionRegressionTests(unittest.TestCase):
    def assert_code(self, code, action):
        with self.assertRaises(PerceptionError) as caught:
            action()
        self.assertEqual(caught.exception.code, code)

    def test_inline_binding_before_any_engine_call(self):
        with tempfile.TemporaryDirectory() as root:
            transport = mock.Mock(return_value=json.dumps(dict(
                schema='muse.vision/v1', vision=dict(summary='ok', elements=[],
                                                   changed_regions=[]))).encode())
            muse = MetaMusePerceptionAdapter(transport=transport, credential=b'secret')
            adapter = vcore.VCorePerceptionAdapter(root)
            with mock.patch.object(subprocess, 'Popen') as spawn:
                for engine in (adapter, muse):
                    self.assert_code('identity_mismatch', lambda: engine.perceive(
                        ref(), Frame(1, 1, b'BBB')))
                spawn.assert_not_called()
                transport.assert_not_called()
            completed = subprocess.CompletedProcess([], 0, json.dumps(c2()).encode(), b'')
            with mock.patch.object(subprocess, 'run', return_value=completed):
                vision = adapter.perceive(ref(), Frame(1, 1, PIXELS))
                self.assertEqual(vcore.project_element_table(ref(), vision)['frame_sha256'], SHA)
                self.assert_code('identity_mismatch', lambda: vcore.project_element_table(
                    {**ref(), 'sha256': 'b' * 64}, vision))
                self.assert_code('identity_mismatch', lambda: vcore.project_element_table(
                    ref(), dict(vision)))
            self.assertEqual(muse.perceive(ref(), Frame(1, 1, PIXELS))['summary'], 'ok')
            completed.stdout = json.dumps(c2('b' * 64)).encode()
            with mock.patch.object(subprocess, 'run', return_value=completed):
                self.assert_code('identity_mismatch', lambda: adapter.perceive(
                    ref(), Frame(1, 1, PIXELS)))

    def test_regular_ram_binding(self):
        with tempfile.TemporaryDirectory(dir='/dev/shm') as ram, tempfile.TemporaryDirectory() as root:
            path = Path(ram) / 'frame.rgb'
            path.write_bytes(PIXELS)
            adapter = vcore.VCorePerceptionAdapter(root)
            completed = subprocess.CompletedProcess([], 0, json.dumps(c2()).encode(), b'')
            with mock.patch.object(subprocess, 'run', return_value=completed) as run:
                adapter.perceive(ref(path))
                self.assertEqual(run.call_count, 1)
                path.write_bytes(b'BBB')
                self.assert_code('identity_mismatch', lambda: adapter.perceive(ref(path)))
                self.assertEqual(run.call_count, 1)

    def test_fifo_has_external_watchdog(self):
        with tempfile.TemporaryDirectory(dir='/dev/shm') as ram:
            fifo = Path(ram) / 'frame.rgb'
            os.mkfifo(fifo)
            script = '''import sys
from metaviewer_agents.perception.vcore import _ramws_frame
from metaviewer_agents.perception.base import PerceptionError
try:
    _ramws_frame({'ramws_path': sys.argv[1]}, 1, 1)
except PerceptionError as error:
    assert error.code == 'bad_shape'
else:
    raise AssertionError('FIFO admitted')
'''
            env = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1])}
            result = subprocess.run([sys.executable, '-c', script, str(fifo)],
                                    env=env, capture_output=True, timeout=2)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_typed_boundaries_and_timeout_before_spawn(self):
        with tempfile.TemporaryDirectory() as root:
            with mock.patch.object(subprocess, 'Popen') as spawn:
                for timeout in (1e20, float('inf'), 0, True, 10**1000):
                    self.assert_code('bad_shape', lambda: vcore.VCorePerceptionAdapter(
                        root, timeout=timeout))
                for timeout in (.001, 1, 60):
                    vcore.VCorePerceptionAdapter(root, timeout=timeout)
                adapter = vcore.VCorePerceptionAdapter(root)
                self.assert_code('bad_shape', lambda: adapter.run_vcore('selftest', ['a\0b']))
                self.assert_code('bad_shape', lambda: vcore._ram_marks_path('/dev/shm/vqa-cu/a\0b'))
                self.assert_code('bad_shape', lambda: vcore._parse_json_object(
                    b'[' * 100000 + b']' * 100000, what='test'))
                payload = c2()
                payload['crops'] = [dict(x=0, y=0, w=1, h=1, reason=[])]
                self.assert_code('bad_shape', lambda: vcore._parse_c2_payload(
                    json.dumps(payload).encode(), width=1, height=1,
                    prev_given=False, marks_out=None, ocr_requested=False))
                spawn.assert_not_called()

    def test_ram_acquisition_consumes_call_deadline(self):
        with tempfile.TemporaryDirectory(dir='/dev/shm') as ram, tempfile.TemporaryDirectory() as root:
            path = Path(ram) / 'frame.rgb'
            path.write_bytes(PIXELS)
            adapter = vcore.VCorePerceptionAdapter(root, timeout=.001)
            original_read = os.read
            def slow_read(*args):
                time.sleep(.01)
                return original_read(*args)
            with mock.patch.object(os, 'read', side_effect=slow_read), mock.patch.object(
                    subprocess, 'Popen') as spawn:
                self.assert_code('timeout', lambda: adapter.perceive(ref(path)))
                spawn.assert_not_called()

    def test_real_timeout_reaps_child(self):
        real_popen = subprocess.Popen
        children = []
        def spawn(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
                subprocess, 'Popen', side_effect=spawn):
            with self.assertRaises(subprocess.TimeoutExpired):
                vcore._run_bounded([sys.executable, '-c', 'import time; time.sleep(10)'],
                    cwd=root, env=dict(os.environ), stdin=subprocess.DEVNULL, timeout=.05)
        self.assertIsNotNone(children[0].returncode)
        with self.assertRaises(ChildProcessError):
            os.waitpid(children[0].pid, os.WNOHANG)

    def test_real_stderr_cap_boundaries_reap_child(self):
        real_popen = subprocess.Popen
        for size in ((1 << 20) - 1, 1 << 20, (1 << 20) + 1):
            with self.subTest(size=size), tempfile.TemporaryDirectory() as root:
                children = []
                def spawn(*args, **kwargs):
                    child = real_popen(*args, **kwargs)
                    children.append(child)
                    return child
                script = ("import os,time; data=b'x'*" + str(size) +
                          ";\nwhile data:\n n=os.write(2,data); data=data[n:]\n" +
                          ("time.sleep(10)\n" if size > 1 << 20 else "print('{}')\n"))
                started = time.monotonic()
                with mock.patch.object(subprocess, 'Popen', side_effect=spawn):
                    def run():
                        return vcore._run_bounded([sys.executable, '-c', script],
                            cwd=root, env=dict(os.environ), stdin=subprocess.DEVNULL, timeout=2)
                    if size > 1 << 20:
                        self.assert_code('bad_shape', run)
                    else:
                        self.assertEqual(len(run().stderr), size)
                self.assertLess(time.monotonic() - started, 2)
                self.assertEqual(len(children), 1)
                self.assertIsNotNone(children[0].returncode)
                with self.assertRaises(ChildProcessError):
                    os.waitpid(children[0].pid, os.WNOHANG)


if __name__ == '__main__':
    unittest.main()
