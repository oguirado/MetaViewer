"""Real pipe subprocess fixtures; private checkouts are never needed."""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.executor import SurfaceError, SurfaceRefused
from metaviewer_agents.observe import ObservationError, compute_battery_state_sha256
from metaviewer_agents.wender_bridge import (
    DEFAULT_WENDER_PLANNER_CMD,
    WenderModelBackend,
    WenderSubprocessAdapter,
    resolve_planner_command,
    validate_state,
)


def observation():
    return {"schema": "observation/v0.2", "frame_ref": {
        "schema": "frame_ref/v0.2", "surface_id": "test", "generation": 1,
        "tick": 0, "ts_ns": 0, "width": 100, "height": 80, "format": "rgb24",
        "ramws_path": "/dev/shm/test-frame", "sha256": "a" * 64, "capture_us": 0,
    }}


def table():
    return dict(schema="vqa.element-table/v1", frame_sha256="a" * 64,
                width=100, height=80, elements=[])


def reply():
    target = dict(id="0123456789abcdef", role="button", name="Continue",
                  depth=0, parent=None, ordinal=0, states={}, actionable=True,
                  box=[10, 20, 30, 20])
    state = dict(schema="wender.state/v1", source=dict(kind="vision", url=None, title="café"),
                 prune=dict(name="test", version=1), ax_sha256="b" * 64,
                 ax_stable_sha256="c" * 64, viewport=dict(w=100, h=80),
                 nodes=[target], actionable=[target["id"]],
                 counts=dict(raw=1, nodes=1, actionable=1))
    return dict(action=dict(type="click", x=20, y=30, button="left"),
                expectation=dict(type="text_present", text="Ready"),
                state=state, target_node=copy.deepcopy(target))


class WenderBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wender-café-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.cli = self.root / "fake_planner.py"

    def adapter(self, payload=None, *, raw=None, prelude="", timeout=2):
        if raw is None:
            raw = json.dumps(reply() if payload is None else payload, ensure_ascii=False)
        self.cli.write_text(
            "import json, os, sys\n"
            "request = json.load(sys.stdin)\n"
            "assert request['goal'] == 'Continue'\n"
            "assert request['observation']['schema'] == 'observation/v0.2'\n"
            "assert request['element_table']['schema'] == 'vqa.element-table/v1'\n"
            "assert os.getcwd() == os.environ['PYTHONPATH']\n"
            "assert set(os.environ) <= {'PATH','LANG','LC_CTYPE','PYTHONPATH','PYTHONDONTWRITEBYTECODE'}\n"
            "assert os.environ['PYTHONDONTWRITEBYTECODE'] == '1'\n"
            + prelude + "\nsys.stdout.write(" + repr(raw) + ")\n", encoding="utf-8")
        return WenderSubprocessAdapter(wender_root=self.root,
                                       command=[sys.executable, str(self.cli)], timeout=timeout)

    def run_plan(self, adapter):
        return adapter.plan_step(observation(), table(), "Continue")

    def test_click_roundtrip_isolated_environment_no_files_or_private_import(self):
        adapter = self.adapter()
        before = set(self.root.rglob("*"))
        with patch.dict(os.environ, {"SECRET_TOKEN": "must-not-leak", "PYTHONPATH": "/bad"}):
            action, expectation, state, target = self.run_plan(adapter)
        self.assertEqual(action, reply()["action"])
        self.assertEqual(expectation, reply()["expectation"])
        self.assertEqual(target, state["nodes"][0])
        self.assertEqual(adapter.battery_state_sha256, compute_battery_state_sha256(state))
        self.assertEqual(before, set(self.root.rglob("*")))
        self.assertFalse(any(name == "wender" or name.startswith("wender.") for name in sys.modules))
        # Negative control: the same successful transport cannot bless stale custody.
        bad = reply(); bad["target_node"]["role"] = "link"
        with self.assertRaisesRegex(ValueError, "target custody"):
            self.run_plan(self.adapter(bad))

    def test_canonical_digest_and_float_negative_controls(self):
        state = reply()["state"]
        original = copy.deepcopy(state)
        digest = validate_state(state)
        self.assertEqual(state, original)
        moved = copy.deepcopy(state); moved["nodes"][0]["box"][0] += 1
        self.assertEqual(digest, validate_state(moved))
        renamed = copy.deepcopy(state); renamed["nodes"][0]["name"] = "Changed"
        self.assertNotEqual(digest, validate_state(renamed))
        for mutate in (
            lambda s: s["nodes"][0]["box"].__setitem__(0, 10.0),
            lambda s: s["source"].__setitem__("extra", 1.0),
            lambda s: s["prune"].__setitem__("version", True),
        ):
            bad = reply(); mutate(bad["state"])
            with self.subTest(state=bad["state"]), self.assertRaises(ObservationError):
                self.run_plan(self.adapter(bad))

    def test_stop_and_alignment_have_typed_failures(self):
        self.run_plan(self.adapter())
        for name in ("Stop", "Stop generation", "Detener generación"):
            bad = reply()
            bad["state"]["nodes"][0]["name"] = name
            bad["target_node"]["name"] = name
            with self.subTest(name=name), self.assertRaises(SurfaceRefused) as caught:
                self.run_plan(self.adapter(bad))
            self.assertEqual(caught.exception.code, "generation_control")
            self.assertEqual(str(caught.exception), "generation_control: click")
        for box in ([99, 20, 2, 20], [-1, 20, 30, 20], [10, 20, 0, 20], None):
            bad = reply()
            bad["target_node"]["box"] = box
            bad["state"]["nodes"][0]["box"] = box
            if box == [10, 20, 0, 20]:
                # Invalid state geometry now fails at the earlier wire gate.
                with self.subTest(box=box), self.assertRaises(ObservationError) as caught:
                    self.run_plan(self.adapter(bad))
                self.assertEqual(caught.exception.code, "bad_shape")
                self.assertIn("state node box invalid", str(caught.exception))
            else:
                with self.subTest(box=box), self.assertRaises(SurfaceError) as caught:
                    self.run_plan(self.adapter(bad))
                self.assertEqual(str(caught.exception), "alignment: click")

    def test_nonactionable_target_and_click_outside_target(self):
        self.run_plan(self.adapter())
        bad = reply()
        bad["state"]["nodes"][0]["actionable"] = False
        bad["target_node"]["actionable"] = False
        bad["state"]["actionable"] = []
        bad["state"]["counts"]["actionable"] = 0
        with self.assertRaisesRegex(ObservationError, "not actionable"):
            self.run_plan(self.adapter(bad))
        bad = reply(); bad["action"]["x"] = 40
        with self.assertRaisesRegex(SurfaceError, "alignment"):
            self.run_plan(self.adapter(bad))

    def test_malformed_state_controls(self):
        validate_state(reply()["state"])
        mutations = [
            lambda s: s.pop("ax_sha256"),
            lambda s: s.update(schema="foreign/v1"),
            lambda s: s.update(ax_sha256="A" * 64),
            lambda s: s.update(ax_stable_sha256="bad"),
            lambda s: s.update(nodes={}),
            lambda s: s["nodes"].append(copy.deepcopy(s["nodes"][0])),
            lambda s: s["nodes"][0].update(parent="missing"),
            lambda s: s["nodes"][0].update(states={"disabled": True}),
            lambda s: s["nodes"][0].update(box=[True, 0, 1, 1]),
            lambda s: s.update(actionable=["missing"]),
            lambda s: s.update(counts={"raw": 1, "nodes": True, "actionable": 1}),
            lambda s: s.update(viewport={"w": True}),
            lambda s: s.update(source={"kind": "foreign"}),
            lambda s: s.update(prune={}),
        ]
        for mutate in mutations:
            bad = reply(); mutate(bad["state"])
            with self.subTest(mutation=mutations.index(mutate)), self.assertRaises(ObservationError):
                self.run_plan(self.adapter(bad))

    def test_transport_failure_controls_and_digest_reset(self):
        adapter = self.adapter()
        self.run_plan(adapter)
        self.assertIsNotNone(adapter.battery_state_sha256)
        self.adapter(prelude="sys.exit(7)")
        with self.assertRaises(ObservationError) as caught:
            self.run_plan(adapter)
        self.assertEqual(caught.exception.code, "subprocess_failed")
        self.assertIsNone(adapter.battery_state_sha256)
        with self.assertRaises(ObservationError) as caught:
            self.run_plan(self.adapter(prelude="import time; time.sleep(1)", timeout=0.05))
        self.assertEqual(caught.exception.code, "timeout")
        missing = WenderSubprocessAdapter(wender_root=self.root,
                                         command=[str(self.root / "absent")])
        with self.assertRaises(ObservationError) as caught:
            self.run_plan(missing)
        self.assertEqual(caught.exception.code, "unavailable")

    def test_response_decoding_and_contract_controls(self):
        self.run_plan(self.adapter())
        for raw in ("not json", "[]", "{}", '{"state":{},"state":{}}',
                    json.dumps(dict(reply(), extra=True)),
                    json.dumps(dict(reply(), action=dict(type="wait", ms=1))),
                    json.dumps(dict(reply(), action=dict(type="invented"))),
                    json.dumps(dict(reply(), action=dict(type="click", x=-1, y=30, button="left"))),
                    json.dumps(dict(reply(), expectation={"type": "invented"}))):
            with self.subTest(raw=raw), self.assertRaises(ObservationError) as caught:
                self.run_plan(self.adapter(raw=raw))
            self.assertEqual(caught.exception.code, "bad_shape")

    def test_input_controls_reject_before_spawn(self):
        adapter = self.adapter()
        self.run_plan(adapter)
        self.cli.write_text("raise AssertionError('must never spawn')\n")
        for delta in ({"width": 99}, {"width": True}, {"frame_sha256": "b" * 64},
                      {"schema": "foreign/v1"}, {"elements": None}, {"extra": 1.0}):
            bad = table(); bad.update(delta)
            with self.subTest(delta=delta), self.assertRaises(ObservationError):
                adapter.plan_step(observation(), bad, "Continue")
        for obs, goal in (({}, "Continue"), (observation(), "")):
            with self.assertRaises(ObservationError):
                adapter.plan_step(obs, table(), goal)

    def test_configuration_controls(self):
        lock = json.loads((Path(__file__).resolve().parents[2] / "deps.lock").read_text(encoding="utf-8"))
        wender_commit = next(
            c["commit"] for c in lock["components"] if c["name"] == "wender-agent"
        )
        dist_info = self.root / "wender_agent-0.0.dist-info"
        dist_info.mkdir(exist_ok=True)
        (dist_info / "direct_url.json").write_text(
            json.dumps({"vcs_info": {"vcs": "git", "commit_id": wender_commit}}),
            encoding="utf-8",
        )
        with patch.dict(os.environ, {"MV_WENDER_ROOT": str(self.root)}):
            adapter = WenderSubprocessAdapter(command=[sys.executable])
            self.assertEqual(adapter.wender_root, self.root)
            self.assertTrue(adapter.verify_lock)
            default_adapter = WenderSubprocessAdapter()
            self.assertEqual(default_adapter.command, DEFAULT_WENDER_PLANNER_CMD)
            self.assertTrue(default_adapter.verify_lock)
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ObservationError):
                WenderSubprocessAdapter(command=[sys.executable])
        for command in ("shell command", [], [""]):
            with self.assertRaises(ValueError):
                WenderSubprocessAdapter(wender_root=self.root, command=command)
        for timeout in (True, 0, -1, float("inf"), float("nan"), 10**400, -(10**400), 1e20):
            with self.assertRaises(ValueError):
                WenderSubprocessAdapter(wender_root=self.root, command=[sys.executable], timeout=timeout)
        with self.assertRaises(ObservationError):
            WenderSubprocessAdapter(wender_root=self.root / "absent", command=[sys.executable])

    def test_default_command_precedence_and_git_lock_controls(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                resolve_planner_command(),
                (sys.executable, "-m", "wender.plan.cli"),
            )
        with patch.dict(
            os.environ,
            {"MV_WENDER_PLANNER_CMD": json.dumps([sys.executable, "-m", "override.cli"])},
        ):
            self.assertEqual(
                resolve_planner_command(),
                (sys.executable, "-m", "override.cli"),
            )
            self.assertEqual(
                resolve_planner_command([sys.executable, "-m", "explicit.cli"]),
                (sys.executable, "-m", "explicit.cli"),
            )

        with tempfile.TemporaryDirectory(prefix="wender-git-") as git_tmp:
            repo = Path(git_tmp).resolve()
            pkg = repo / "wender" / "plan"
            pkg.mkdir(parents=True)
            (repo / "wender" / "__init__.py").write_text("", encoding="utf-8")
            (pkg / "__init__.py").write_text("", encoding="utf-8")
            (pkg / "cli.py").write_text(
                "import sys\nsys.stdout.write(" + repr(json.dumps(reply())) + ")\n",
                encoding="utf-8",
            )
            git_env = {
                "PATH": os.environ.get("PATH", os.defpath),
                "HOME": os.devnull,
                "LANG": "C",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_AUTHOR_NAME": "Test",
                "GIT_AUTHOR_EMAIL": "test@example.invalid",
                "GIT_COMMITTER_NAME": "Test",
                "GIT_COMMITTER_EMAIL": "test@example.invalid",
            }
            for args in (
                ["init", "-q"],
                ["add", "."],
                ["commit", "-q", "-m", "init"],
            ):
                subprocess.run(["git", "-C", str(repo), *args], env=git_env, check=True)
            head = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                env=git_env,
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()

            lock_file = Path(self.temp.name) / "custom-deps.lock"
            lock_data = {
                "components": [
                    {"name": "vision-engine", "commit": "a" * 40},
                    {"name": "wender-agent", "commit": head},
                ]
            }
            lock_file.write_text(json.dumps(lock_data), encoding="utf-8")

            with patch.dict(os.environ, {"MV_WENDER_ROOT": str(repo)}, clear=False):
                os.environ.pop("MV_WENDER_PLANNER_CMD", None)
                adapter = WenderSubprocessAdapter(lock_path=lock_file)
                self.assertEqual(adapter.command, (sys.executable, "-m", "wender.plan.cli"))
                action, expectation, _, _ = self.run_plan(adapter)
                self.assertEqual(action, reply()["action"])
                self.assertEqual(expectation, reply()["expectation"])

                # Pin mismatch blocks before spawn
                bad_lock = Path(self.temp.name) / "bad-deps.lock"
                bad_lock.write_text(
                    json.dumps(
                        {
                            "components": [
                                {"name": "vision-engine", "commit": "a" * 40},
                                {"name": "wender-agent", "commit": "0" * 40},
                            ]
                        }
                    ),
                    encoding="utf-8",
                )
                with self.assertRaises(ObservationError) as caught:
                    WenderSubprocessAdapter(lock_path=bad_lock)
                self.assertEqual(caught.exception.code, "commit_mismatch")

                # Dirty tree blocks before spawn
                (pkg / "untracked_payload.py").write_text("x = 1\n", encoding="utf-8")
                with self.assertRaises(ObservationError) as caught:
                    WenderSubprocessAdapter(lock_path=lock_file)
                self.assertEqual(caught.exception.code, "dirty_tree")

    def test_model_backend_runtime_credential_and_redaction_controls(self):
        muse = WenderModelBackend("muse_cli")
        self.assertEqual(muse.provider, "muse_cli")
        self.assertEqual(muse.kind, "muse_cli")
        self.assertFalse(muse.has_credential)
        self.assertEqual(muse.redact()["credential"], None)

        seen_calls = []

        def fake_transport(req, *, provider, endpoint, credential):
            seen_calls.append((req, provider, endpoint, bytes(credential)))
            return {"status": "ok", "action": "click"}

        secret = b"rt-baseten-token-do-not-leak"
        baseten = WenderModelBackend(
            "baseten",
            credential=secret,
            endpoint="https://model.example.invalid/v1/predict",
            transport=fake_transport,
            require_credential=True,
        )
        self.assertTrue(baseten.has_credential)
        self.assertNotIn("rt-baseten-token-do-not-leak", repr(baseten))
        self.assertNotIn("rt-baseten-token-do-not-leak", str(baseten))
        self.assertEqual(baseten.redact()["credential"], "<redacted>")
        resp = baseten.invoke({"goal": "Continue"})
        self.assertEqual(resp, {"status": "ok", "action": "click"})
        self.assertEqual(len(seen_calls), 1)
        self.assertEqual(seen_calls[0][3], secret)

        baseten.clear_credential()
        self.assertFalse(baseten.has_credential)
        with self.assertRaises(ObservationError) as caught:
            baseten.invoke({"goal": "Continue"})
        self.assertEqual(caught.exception.code, "unavailable")

        for bad_cred in (".env", "auth.json", "secret.key", Path("auth.json"), b"", b"   ", b"a\x00b"):
            with self.subTest(bad_cred=bad_cred), self.assertRaises(ObservationError) as caught:
                WenderModelBackend("baseten", credential=bad_cred)
            self.assertEqual(caught.exception.code, "bad_shape")

        with self.assertRaises(ObservationError) as caught:
            WenderModelBackend("unsupported_provider")
        self.assertEqual(caught.exception.code, "bad_shape")

    def test_timeout_kills_and_reaps_planner_child(self):
        # Mutation: skip process.kill() or process.wait() in _run_bounded finally.
        real_popen = subprocess.Popen
        children = []

        def spawn(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child

        pid_file = self.root / "child.pid"
        with patch("subprocess.Popen", side_effect=spawn):
            action, expectation, state, target = self.run_plan(
                self.adapter(prelude="import pathlib\npathlib.Path('child.pid').write_text(str(os.getpid()))\n")
            )
        self.assertEqual(action, reply()["action"])
        self.assertEqual(expectation, reply()["expectation"])
        self.assertEqual(target, state["nodes"][0])
        self.assertEqual(len(children), 1)
        quick = children.pop()
        self.assertEqual(int(pid_file.read_text(encoding="utf-8")), quick.pid)
        self.assertEqual(quick.returncode, 0)
        with self.assertRaises(ChildProcessError):
            os.waitpid(quick.pid, os.WNOHANG)

        pid_file.unlink()
        with patch("subprocess.Popen", side_effect=spawn):
            with self.assertRaises(ObservationError) as caught:
                self.run_plan(
                    self.adapter(
                        prelude="import pathlib, time\npathlib.Path('child.pid').write_text(str(os.getpid()))\ntime.sleep(0.5)\n",
                        timeout=0.05,
                    )
                )
        self.assertEqual(caught.exception.code, "timeout")
        self.assertEqual(len(children), 1)
        child = children.pop()
        self.assertEqual(int(pid_file.read_text(encoding="utf-8")), child.pid)
        self.assertIsNotNone(child.returncode)
        self.assertLess(child.returncode, 0)
        with self.assertRaises(ChildProcessError):
            os.waitpid(child.pid, os.WNOHANG)


if __name__ == "__main__":
    unittest.main()
