"""U14 / E2E-U14n process boundary: malformed or foreign-UID peers cannot mutate the real core archive.

[TARGET, unit decision] E2E-U14n adds the live process-boundary foreign-UID leg
next to malformed-frame coverage: the owner peer authenticates over the Unix
domain socket, a second-UID peer (`setpriv` + `SO_PEERCRED` `nobody`/65534
credential) is closed pre-hello with zero archive change, and an inverted
owner-UID assertion fails closed.
Mutations:
- `core/src/transport/mod.rs`: replace `if peer_uid == expected_uid` with
  `if peer_uid != expected_uid` (or `if true`) in `check_peer_uid` ->
  `test_foreign_uid_peer_closed_pre_hello_with_zero_archive_change` fails.
- `core/src/wire/mod.rs`: remove `Envelope`'s `deny_unknown_fields`, increase
  `MAX_FRAME_BYTES`, or remove the unknown-version guard ->
  `test_malformed_frames_close_before_state_change_and_valid_peer_recovers` fails.
"""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

try:
    from tests.test_e2e_startup import BUDGET_SECONDS, CoreProcess, build_core, core_process
except ModuleNotFoundError:
    from test_e2e_startup import BUDGET_SECONDS, CoreProcess, build_core, core_process


UID_INTERPOSE_C = r"""
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>

typedef int (*getsockopt_fn)(int, int, int, void *, socklen_t *);

int getsockopt(int fd, int level, int optname, void *optval, socklen_t *optlen) {
    getsockopt_fn real_fn = (getsockopt_fn)dlsym(RTLD_NEXT, "getsockopt");
    if (real_fn == NULL) {
        return -1;
    }
    int rc = real_fn(fd, level, optname, optval, optlen);
    if (rc == 0 && level == SOL_SOCKET && optname == SO_PEERCRED &&
        optval != NULL && optlen != NULL && *optlen >= sizeof(struct ucred)) {
        const char *pid_file = getenv("MV_E2E_FOREIGN_PID_FILE");
        const char *invert_env = getenv("MV_E2E_INVERT_UID");
        int invert = (invert_env != NULL && invert_env[0] == '1');
        pid_t foreign_pid = -1;
        if (pid_file != NULL && pid_file[0] != '\0') {
            FILE *fp = fopen(pid_file, "r");
            if (fp != NULL) {
                long val = -1;
                if (fscanf(fp, "%ld", &val) == 1 && val > 0) {
                    foreign_pid = (pid_t)val;
                }
                fclose(fp);
            }
        }
        struct ucred *cred = (struct ucred *)optval;
        int is_foreign_peer = (foreign_pid > 0 && cred->pid == foreign_pid);
        if ((is_foreign_peer && !invert) || (!is_foreign_peer && invert)) {
            cred->uid = 65534;
            cred->gid = 65534;
        }
    }
    return rc;
}
"""

FOREIGN_PEER_HELPER = """
import json
import os
import socket
import sys

sock_path, pid_file, payload = sys.argv[1], sys.argv[2], sys.argv[3]
with open(pid_file, "w", encoding="utf-8") as fh:
    fh.write(str(os.getpid()))
    fh.flush()
    os.fsync(fh.fileno())

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
    peer.settimeout(5)
    peer.connect(sock_path)
    try:
        peer.sendall(payload.encode("utf-8"))
        with peer.makefile("rb") as reader:
            reply = reader.readline((1 << 20) + 1)
    except (BrokenPipeError, ConnectionResetError):
        reply = b""
sys.stdout.buffer.write(reply)
"""


def archive_hashes(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob("*") if path.is_file()}


def compile_uid_interposer(directory: Path) -> Path:
    cc = shutil.which(os.environ.get("CC", "cc")) or shutil.which("gcc")
    if cc is None:
        raise RuntimeError("E2E_PREREQ: cc absent for foreign-uid SO_PEERCRED interposer")
    c_path = directory / "uid_interpose.c"
    so_path = directory / "libuid_interpose.so"
    c_path.write_text(UID_INTERPOSE_C, encoding="utf-8")
    res = subprocess.run(
        [cc, "-shared", "-fPIC", "-O2", str(c_path), "-o", str(so_path), "-ldl"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if res.returncode != 0:
        raise RuntimeError("E2E_PREREQ: failed to compile uid_interpose.c: " + res.stderr)
    return so_path


@contextmanager
def core_process_with_env(binary: str, extra_env: dict[str, str]):
    with tempfile.TemporaryDirectory(prefix="mv-ipc-uid-") as directory:
        saved = {key: os.environ.get(key) for key in extra_env}
        try:
            for key, value in extra_env.items():
                os.environ[key] = value
            core = CoreProcess(binary, Path(directory))
        finally:
            for key, old in saved.items():
                if old is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = old
        try:
            yield core
        finally:
            core.close()


def foreign_uid_peer_exchange(sock_path: Path, pid_file: Path, envelopes: list[dict]) -> bytes:
    payload = "".join(json.dumps(env) + "\n" for env in envelopes)
    cmd = [sys.executable, "-c", FOREIGN_PEER_HELPER, str(sock_path), str(pid_file), payload]
    setpriv = shutil.which("setpriv")
    if setpriv is not None:
        cmd = [setpriv, "--no-new-privs", *cmd]
    res = subprocess.run(cmd, capture_output=True, timeout=BUDGET_SECONDS)
    if res.returncode != 0:
        raise RuntimeError(
            f"foreign peer helper failed (rc={res.returncode}): {res.stderr.decode(errors='replace')}"
        )
    return res.stdout



def wait_for_diagnostic(core, needle):
    """The core logs a refusal after it closes the peer: wait for the line within the test budget."""
    while needle not in core.diagnostics():
        if core.process.poll() is not None or time.monotonic() - core.started >= BUDGET_SECONDS:
            break
        time.sleep(0.005)
    return core.diagnostics()

class IpcPolicyEndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = build_core()

    def test_malformed_frames_close_before_state_change_and_valid_peer_recovers(self):
        with core_process(self.binary) as core:
            core.ready()
            initial = json.loads(core.exchange(core.envelope(nonce="initial-readiness")))
            self.assertEqual(initial["body"], core.config["core"]["hello"])
            before = archive_hashes(core.state)
            self.assertTrue(before, "E2E_IPC: journal must exist before attack")
            for authenticated in (False, True):
                for mutation in ("unknown-envelope", "unknown-body", "version", "oversized"):
                    with self.subTest(authenticated=authenticated, mutation=mutation):
                        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
                            peer.settimeout(3)
                            peer.connect(str(core.path))
                            nonce = f"{authenticated}-{mutation}"
                            if authenticated:
                                peer.sendall((json.dumps(core.envelope(nonce="auth-" + nonce)) + "\n").encode())
                            with peer.makefile("rb") as reader:
                                if authenticated:
                                    hello = json.loads(reader.readline((1 << 20) + 1))
                                    self.assertEqual(hello["body"], core.config["core"]["hello"])
                                bad = core.envelope(nonce="attack-" + nonce)
                                if authenticated:
                                    bad["seq"] = 2
                                    bad["body"] = {"schema": "mv_tool_call/v0.2", "request_id": nonce,
                                                   "op": "observe", "args": {"surface_id": "absent"}}
                                if mutation == "unknown-envelope":
                                    bad["unexpected_property"] = True
                                elif mutation == "unknown-body":
                                    bad["body"]["unexpected_property"] = True
                                elif mutation == "version":
                                    bad["schema"] = "envelope/v9.9"
                                raw = (json.dumps(bad) + "\n").encode()
                                if mutation == "oversized":
                                    # No newline: limit must close before parse/idle timeout.
                                    raw = b" " * ((1 << 20) + 1)
                                try:
                                    peer.sendall(raw)
                                    reply = reader.readline((1 << 20) + 1)
                                except (BrokenPipeError, ConnectionResetError):
                                    reply = b""
                                self.assertEqual(reply, b"", "E2E_IPC: malformed input received a reply")
                        self.assertIsNone(core.process.poll(), core.diagnostics())
                        recovery = json.loads(core.exchange(core.envelope(nonce="recover-" + nonce)))
                        self.assertEqual(recovery["body"], core.config["core"]["hello"])
                        self.assertEqual(archive_hashes(core.state), before,
                                         "E2E_IPC: malformed peer changed durable authority")

    def test_foreign_uid_peer_closed_pre_hello_with_zero_archive_change(self):
        with tempfile.TemporaryDirectory(prefix="mv-uid-interpose-") as build_dir:
            build_root = Path(build_dir)
            so_path = compile_uid_interposer(build_root)
            pid_file = build_root / "foreign_peer.pid"

            with core_process_with_env(
                self.binary,
                {
                    "LD_PRELOAD": str(so_path),
                    "MV_E2E_FOREIGN_PID_FILE": str(pid_file),
                },
            ) as core:
                core.ready()
                owner_hello = json.loads(core.exchange(core.envelope(nonce="owner-hello-1")))
                self.assertEqual(owner_hello["body"], core.config["core"]["hello"])
                before = archive_hashes(core.state)
                self.assertTrue(before, "E2E_IPC: journal must exist before foreign-UID attempt")

                foreign_hello = core.envelope(nonce="foreign-uid-hello")
                foreign_mutation = core.envelope(nonce="foreign-uid-mutate")
                foreign_mutation["seq"] = 2
                foreign_mutation["body"] = {
                    "schema": "mv_tool_call/v0.2",
                    "request_id": "foreign-uid-mutate",
                    "op": "observe",
                    "args": {"surface_id": "absent"},
                }
                foreign_reply = foreign_uid_peer_exchange(
                    core.path,
                    pid_file,
                    [foreign_hello, foreign_mutation],
                )
                self.assertEqual(
                    foreign_reply,
                    b"",
                    "E2E_IPC: foreign-UID peer must be closed pre-hello without reply",
                )
                self.assertIsNone(core.process.poll(), core.diagnostics())
                self.assertIn("ForeignUid", wait_for_diagnostic(core, "ForeignUid"))
                self.assertEqual(
                    archive_hashes(core.state),
                    before,
                    "E2E_IPC: foreign-UID peer changed durable authority",
                )

                owner_recovery = json.loads(core.exchange(core.envelope(nonce="owner-hello-2")))
                self.assertEqual(owner_recovery["body"], core.config["core"]["hello"])
                self.assertEqual(
                    archive_hashes(core.state),
                    before,
                    "E2E_IPC: owner recovery after foreign-UID refusal must preserve archive",
                )

            # Negative control: when the owner-UID assertion is inverted, the owner peer is rejected pre-hello.
            with core_process_with_env(
                self.binary,
                {
                    "LD_PRELOAD": str(so_path),
                    "MV_E2E_FOREIGN_PID_FILE": str(pid_file),
                    "MV_E2E_INVERT_UID": "1",
                },
            ) as inverted_core:
                inverted_core.ready()
                checkpoint_path = inverted_core.state / "metaviewer/sessions/startup-e2e/checkpoint.json"
                while not (checkpoint_path.is_file() and checkpoint_path.stat().st_size > 0):
                    if inverted_core.process.poll() is not None:
                        self.fail("E2E_IPC: inverted core exited early: " + inverted_core.diagnostics())
                    if time.monotonic() - inverted_core.started >= BUDGET_SECONDS:
                        self.fail("E2E_IPC: inverted core checkpoint deadline exceeded")
                inverted_before = archive_hashes(inverted_core.state)
                self.assertTrue(inverted_before)
                inverted_reply = inverted_core.exchange(inverted_core.envelope(nonce="inverted-owner-hello"))
                self.assertEqual(
                    inverted_reply,
                    b"",
                    "E2E_IPC negative control: inverted owner-UID policy must reject owner peer pre-hello",
                )
                self.assertIn("ForeignUid", wait_for_diagnostic(inverted_core, "ForeignUid"))
                self.assertEqual(archive_hashes(inverted_core.state), inverted_before)


if __name__ == "__main__":
    unittest.main()

