"""AC-01 process boundary, using the real offline-built core and Unix socket.

[TARGET, unit decision] U02 adapts the obsolete deps.lock-startup spec to the
admitted MV_CORE_CONFIG registration pin. deps.lock admission already has its
own gate; the executable consumes a trusted registration, not deps.lock.
Budget: 10 s [TARGET], excluding compilation, including spawn/socket/hello.
Mutations (one line each):
* startup_pin: replace the compiled-version inequality in metaviewer-core.rs
  with `if false {` -> skew publishes a socket instead of exiting.
* peer_pin: replace `if *hello != policy.hello {` in transport/mod.rs with
  `if false {` -> a foreign component version receives an authenticated hello.
"""

from contextlib import contextmanager
import copy
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
BUDGET_SECONDS = 10


def registration(component):
    return {"endpoint": {"component": component, "instance": component + "-e2e"},
            "hello": {"schema": "hello/v0.2", "contract_version": "v0.2",
                      "component": component,
                      "component_version": (ROOT / "VERSION").read_text().strip(),
                      "component_commit": "0123456789abcdef0123456789abcdef01234567",
                      "dependencies": []}}


def build_core():
    cargo = shutil.which(os.environ.get("CARGO", "cargo"))
    if cargo is None:
        raise RuntimeError("E2E_PREREQ: cargo absent")
    result = subprocess.run(
        [cargo, "build", "--offline", "--bin", "metaviewer-core", "--message-format=json"],
        cwd=ROOT, capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError("E2E_PREREQ: offline core build failed: " + result.stderr)
    executables = [row["executable"] for line in result.stdout.splitlines()
                   if (row := json.loads(line)).get("reason") == "compiler-artifact"
                   and row.get("target", {}).get("name") == "metaviewer-core"
                   and row.get("executable")]
    if len(executables) != 1:
        raise RuntimeError("E2E_PREREQ: executable missing from Cargo receipt")
    return executables[0]


class CoreProcess:
    def __init__(self, binary, directory, version=None):
        self.directory = directory
        self.runtime = directory / "runtime"
        self.runtime.mkdir(mode=0o700)
        self.path = self.runtime / "metaviewer/core.sock"
        self.state = directory / "state"
        self.config = {"session_id": "startup-e2e", "core": registration("core"),
                       "peers": [registration("daemon"), registration("agent")]}
        if version is not None:
            self.config["core"]["hello"]["component_version"] = version
        config_path = directory / "config.json"
        config_path.write_text(json.dumps(self.config))
        self.log = tempfile.TemporaryFile()
        self.started = time.monotonic()
        try:
            self.process = subprocess.Popen(
                [binary], cwd=directory,
                env=dict(os.environ, MV_CORE_CONFIG=str(config_path),
                         XDG_RUNTIME_DIR=str(self.runtime), XDG_STATE_HOME=str(self.state)),
                stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
        except BaseException:
            self.log.close()
            raise

    def diagnostics(self):
        self.log.seek(0)
        return self.log.read().decode(errors="replace")

    def ready(self):
        while not self.path.exists():
            if self.process.poll() is not None:
                raise AssertionError("E2E_STARTUP: " + self.diagnostics())
            if time.monotonic() - self.started >= BUDGET_SECONDS:
                raise AssertionError("E2E_STARTUP: socket deadline exceeded")
            time.sleep(0.005)

    def envelope(self, body=None, nonce="hello-e2e"):
        peer = self.config["peers"][1]
        return {"schema": "envelope/v0.2", "msg_id": nonce, "ts_ns": 0,
                "from": peer["endpoint"], "to": self.config["core"]["endpoint"],
                "session_id": self.config["session_id"], "seq": 1, "nonce": nonce,
                "body": copy.deepcopy(peer["hello"] if body is None else body)}

    def exchange(self, envelope):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
            peer.settimeout(BUDGET_SECONDS)
            peer.connect(str(self.path))
            peer.sendall((json.dumps(envelope) + "\n").encode())
            with peer.makefile("rb") as reader:
                try:
                    raw = reader.readline((1 << 20) + 1)
                except ConnectionResetError:
                    return b""
            return raw

    def close(self):
        try:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
        finally:
            self.log.close()


@contextmanager
def core_process(binary, version=None):
    # Non-ASCII fixture paths also guard clone/path encoding portability.
    with tempfile.TemporaryDirectory(prefix="mv-start-tést-") as directory:
        core = CoreProcess(binary, Path(directory), version)
        try:
            yield core
        finally:
            core.close()


class StartupEndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = build_core()

    def assert_hello(self, core, nonce):
        reply = json.loads(core.exchange(core.envelope(nonce=nonce)))
        self.assertEqual(reply["body"], core.config["core"]["hello"])
        self.assertEqual(reply["from"], core.config["core"]["endpoint"])
        self.assertEqual(reply["to"], core.config["peers"][1]["endpoint"])
        self.assertEqual(reply["session_id"], core.config["session_id"])

    def test_spawn_to_authenticated_hello_budget_and_peer_pin_negative(self):
        """Mutation peer_pin; positive startup followed by skew and recovery."""
        with core_process(self.binary) as core:
            core.ready()
            self.assert_hello(core, "valid-start")
            elapsed = time.monotonic() - core.started
            self.assertLess(elapsed, BUDGET_SECONDS)
            print(f"startup to authenticated hello [MEASURED]: {elapsed:.6f} s")
            self.assertEqual(stat.S_IMODE(core.path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(core.path.parent.stat().st_mode), 0o700)
            for field, value in (("component_version", "foreign-pin"),
                                 ("contract_version", "v9.9")):
                with self.subTest(field=field):
                    envelope = core.envelope(nonce="skew-" + field)
                    envelope["body"][field] = value
                    self.assertEqual(core.exchange(envelope), b"",
                                     "skewed peer must close before core hello")
            self.assert_hello(core, "valid-recovery")
            self.assertIsNone(core.process.poll())

    def test_startup_pin_refusal_precedes_socket_and_journal_publication(self):
        """Mutation startup_pin; matching launch is the positive control."""
        with core_process(self.binary) as matching:
            matching.ready()
            self.assert_hello(matching, "matching-pin")
            journal = matching.state / "metaviewer/sessions/startup-e2e/journal.jsonl"
            self.assertTrue(journal.is_file())
        with core_process(self.binary, version="foreign-startup-pin") as skewed:
            self.assertEqual(skewed.process.wait(timeout=BUDGET_SECONDS), 2)
            self.assertRegex(skewed.diagnostics(), "version pin mismatch")
            self.assertFalse(skewed.path.exists())
            self.assertFalse(skewed.state.exists())


if __name__ == "__main__":
    unittest.main()
