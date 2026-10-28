"""Kill surviving mutants in verify provider routing, planner argv validation, and deps_lock."""

import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.executor import AdmittedExecutor
from metaviewer_agents.observe import ObservationError
from metaviewer_agents.perception.deps_lock import (
    DependencyLockError,
    resolve_locked_component,
)
from metaviewer_agents.perception.vcore import VCorePerceptionAdapter
from metaviewer_agents.verify import run_loop
from metaviewer_agents.wender_bridge import (
    has_configured_wender_root,
    resolve_planner_command,
)


def _local_plan_pair():
    return (
        dict(type="click", x=1, y=1, button="left"),
        dict(type="text_present", text="Ready"),
    )


class _CoreFixture:
    def __init__(self, frame):
        self.frame = frame
        self.ops = []
        self.dispatched = []
        self.executor = AdmittedExecutor(transport=self.execute)

    def execute(self, proposal):
        self.dispatched.append(copy.deepcopy(proposal))
        return dict(focus_verified=True, input_mono_ns=10)

    def request(self, call, expect, *, timeout_ms):
        assert call["schema"] == "mv_tool_call/v0.2"
        assert expect == "mv_tool_result/v0.2" and timeout_ms > 0
        op = call["op"]
        self.ops.append(op)
        result = dict(schema=expect, request_id=call["request_id"], op=op)
        if op == "observe":
            result.update(
                status="ok",
                observation=dict(
                    schema="observation/v0.2",
                    frame_ref=copy.deepcopy(self.frame),
                ),
            )
        elif op == "propose":
            self.proposal = call["args"]["proposal"]
            verdict = dict(
                schema="action_verdict/v0.2",
                proposal_id="p1",
                decision="admitted",
                core_seq=1,
            )
            self.execution = self.executor.dispatch(self.proposal, verdict)
            result.update(status="admitted", verdict=verdict)
        else:
            assert op == "wait_verify" and self.dispatched
            after = dict(self.frame, generation=2, tick=2, sha256="d" * 64)
            native = dict(
                surface_id="fixture",
                native_surface_id="native-1",
                kind="click",
                input_mono_ns=10,
                input_ts_ns=5,
                result="ok",
            )
            self.receipt = dict(
                schema="action_receipt/v0.2",
                proposal_id="p1",
                executed_at_ns=5,
                after_frame=after,
                verified=True,
                verification=dict(method="pixel", detail="core witness"),
                error="",
                native_evidence=native,
            )
            result.update(
                status="verified",
                receipt=self.receipt,
                **self.execution,
                frame_sha256=after["sha256"],
            )
        return result


class VerifyProviderRoutingTests(unittest.TestCase):
    """B4: verify.py provider allowlist and explicit wender/local routing."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mut-rec-verify-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ram = tempfile.TemporaryDirectory(prefix="mv-rec-", dir="/dev/shm")
        self.addCleanup(self.ram.cleanup)
        pixels = bytes(48)
        path = Path(self.ram.name) / "frame.rgb"
        path.write_bytes(pixels)
        self.frame = dict(
            schema="frame_ref/v0.2",
            surface_id="fixture",
            generation=1,
            tick=1,
            ts_ns=1,
            width=4,
            height=4,
            format="rgb24",
            ramws_path=str(path),
            sha256=hashlib.sha256(pixels).hexdigest(),
            capture_us=1,
        )
        self.core = _CoreFixture(self.frame)
        lock = json.loads(
            (Path(__file__).resolve().parents[2] / "deps.lock").read_text()
        )
        for entry in lock["components"]:
            if entry["name"] not in ("vision-engine", "wender-agent"):
                continue
            metadata = self.root / (
                entry["name"].replace("-", "_") + "-0.0.dist-info"
            )
            metadata.mkdir()
            record = metadata / "direct_url.json"
            record.write_text(
                json.dumps(
                    dict(vcs_info=dict(vcs="git", commit_id=entry["commit"]))
                )
            )
        package = self.root / "vadapt"
        package.mkdir()
        (package / "__init__.py").write_text("")
        c2 = dict(
            schema="ve.cu_describe/v1",
            frame_sha256=self.frame["sha256"],
            width=4,
            height=4,
            changed=None,
            changed_regions=[],
            crops=[dict(x=0, y=0, w=2, h=2, reason="salient")],
            timing_us=1,
        )
        (package / "cu_describe.py").write_text(
            "import sys\nprint(" + repr(json.dumps(c2)) + ")\n"
        )

    def test_bogus_provider_rejected_before_any_tool_call(self):
        for bad_provider in ("bogus", "", "WENDER", 123):
            with self.subTest(provider=bad_provider):
                with self.assertRaises(ObservationError) as caught:
                    run_loop(
                        client=self.core,
                        surface_id="fixture",
                        proposal_id="p1",
                        timeout_ms=5000,
                        provider=bad_provider,
                        planner=lambda _obs: _local_plan_pair(),
                    )
                self.assertEqual(caught.exception.code, "bad_shape")
                self.assertEqual(self.core.ops, [])

    def test_explicit_wender_provider_forces_wender_and_requires_vision(self):
        # Clear MV_WENDER_PLANNER_CMD and MV_WENDER_ROOT and pass a local planner
        # so only `provider == 'wender'` can select the Wender branch.
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ObservationError) as caught:
                run_loop(
                    client=self.core,
                    surface_id="fixture",
                    proposal_id="p1",
                    timeout_ms=5000,
                    provider="wender",
                    perception_adapter=None,
                    planner=lambda _obs: _local_plan_pair(),
                    goal="Continue",
                )
            self.assertEqual(caught.exception.code, "unavailable")
            self.assertIn(
                "Wender requires perception evidence", str(caught.exception)
            )
            self.assertEqual(self.core.ops, ["observe"])

    def test_explicit_local_provider_without_env_uses_local_planner(self):
        with patch.dict(
            os.environ,
            {"MV_WENDER_ROOT": str(self.root), "VQA_VE_ROOT": str(self.root)},
            clear=True,
        ):
            called = []

            def local_planner(obs):
                called.append(obs["frame_ref"]["surface_id"])
                return _local_plan_pair()

            receipt = run_loop(
                client=self.core,
                surface_id="fixture",
                proposal_id="p1",
                timeout_ms=5000,
                provider="local",
                perception_adapter=None,
                planner=local_planner,
                wender_root=self.root,
            )
            self.assertEqual(called, ["fixture"])
            self.assertEqual(
                self.core.ops, ["observe", "propose", "wait_verify"]
            )
            self.assertEqual(receipt, self.core.receipt)


class BridgePlannerArgvValidationTests(unittest.TestCase):
    """B5: wender_bridge.py NUL/surrogate argv validation and root whitespace."""

    def test_nul_and_surrogate_argv_tokens_raise_bad_shape_without_spawn(self):
        bad_envs = [
            '["/bin/echo", "a\\u0000b"]',
            '["/bin/echo\\u0000"]',
            '["/bin/echo", "bad\\ud800arg"]',
            '["/bin/echo", "bad\\udfffarg"]',
        ]
        for raw_env in bad_envs:
            with self.subTest(configured_env=raw_env):
                with self.assertRaises(ObservationError) as caught:
                    resolve_planner_command(
                        configured_env=raw_env, use_env=False
                    )
                self.assertEqual(caught.exception.code, "bad_shape")

        bad_explicit = [
            ["/bin/echo", "a\x00b"],
            ["/bin/echo", "bad\ud800arg"],
            ["/bin/echo", "bad\udfffarg"],
        ]
        for cmd in bad_explicit:
            with self.subTest(command=cmd):
                with self.assertRaises(ObservationError) as caught:
                    resolve_planner_command(cmd, use_env=False)
                self.assertEqual(caught.exception.code, "bad_shape")

        # Paired positive control: valid argv resolves unchanged.
        self.assertEqual(
            resolve_planner_command(["/bin/echo", "clean-arg"], use_env=False),
            ("/bin/echo", "clean-arg"),
        )

    def test_whitespace_wender_root_reports_unconfigured(self):
        with patch.dict(os.environ, {"MV_WENDER_ROOT": "   "}, clear=True):
            self.assertFalse(has_configured_wender_root())
            self.assertFalse(has_configured_wender_root(" \t\n "))
            self.assertTrue(has_configured_wender_root("/opt/wender"))


class DepsLockUntrackedPayloadTests(unittest.TestCase):
    """B6: deps_lock.py refuses untracked executable (+x) and payload-suffix files."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix="mv-mut-lock-", dir="/dev/shm"
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "checkout"
        self.repo.mkdir()
        self.git = shutil.which("git")
        self.assertIsNotNone(self.git, "git is required for checkout fixture")
        self.git_env = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": str(self.root),
            "LANG": "C",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Fixture",
            "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        }
        self._git("init", "--quiet")
        tracked = self.repo / "tracked.txt"
        tracked.write_text("clean\n", encoding="utf-8")
        blob = self._git("hash-object", "-w", "tracked.txt")
        self._git(
            "update-index", "--add", "--cacheinfo", "100644", blob, "tracked.txt"
        )
        tree = self._git("write-tree")
        commit = self._git("commit-tree", tree, "-m", "fixture")
        self._git("update-ref", "HEAD", commit)
        self.lock = self.root / "deps.lock"
        self.lock.write_text(
            json.dumps(
                {
                    "components": [
                        {"name": "vision-engine", "commit": commit},
                        {"name": "wender-agent", "commit": commit},
                    ]
                }
            ),
            encoding="utf-8",
        )
        self.env_patch = patch.dict(
            os.environ,
            {
                "VQA_VE_ROOT": str(self.repo),
                "MV_WENDER_ROOT": str(self.repo),
            },
        )
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    def _git(self, *args):
        return subprocess.run(
            [self.git, "-C", str(self.repo), *args],
            env=self.git_env,
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()

    def test_untracked_payload_suffix_and_executable_bit_refused_as_dirty_tree(self):
        # Paired positive control: untracked non-executable notes.txt resolves.
        notes = self.repo / "notes.txt"
        notes.write_text("benign notes\n", encoding="utf-8")
        notes.chmod(0o644)
        self.assertEqual(
            resolve_locked_component("wender-agent", lock_path=self.lock),
            self.repo.resolve(),
        )

        # 1. Untracked non-executable .py payload suffix must fail closed with dirty_tree.
        payload_py = self.repo / "payload.py"
        payload_py.write_text("print('untracked payload')\n", encoding="utf-8")
        payload_py.chmod(0o644)
        with self.assertRaises(DependencyLockError) as caught_py:
            resolve_locked_component("wender-agent", lock_path=self.lock)
        self.assertEqual(caught_py.exception.code, "dirty_tree")
        payload_py.unlink()

        # 2. Untracked +x run.sh must fail closed with dirty_tree.
        run_sh = self.repo / "run.sh"
        run_sh.write_text("#!/bin/sh\necho hi\n", encoding="utf-8")
        run_sh.chmod(0o755)
        with self.assertRaises(DependencyLockError) as caught_sh:
            resolve_locked_component("wender-agent", lock_path=self.lock)
        self.assertEqual(caught_sh.exception.code, "dirty_tree")
        run_sh.unlink()

        # 3. Untracked +x file with non-payload suffix must also fail closed via 0o111 check.
        exec_data = self.repo / "exec_blob.dat"
        exec_data.write_text("#!/bin/sh\n", encoding="utf-8")
        exec_data.chmod(0o755)
        with self.assertRaises(DependencyLockError) as caught_exec:
            resolve_locked_component("wender-agent", lock_path=self.lock)
        self.assertEqual(caught_exec.exception.code, "dirty_tree")
        exec_data.unlink()

        # Restoring clean state with only notes.txt resolves again.
        self.assertEqual(
            resolve_locked_component("wender-agent", lock_path=self.lock),
            self.repo.resolve(),
        )


if __name__ == "__main__":
    unittest.main()
