"""Hosted-safe unit tests for tools/assembly_smoke.py (unit CI-ASSEMBLY)."""

from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = REPO_ROOT / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import assembly_smoke  # noqa: E402


def _valid_lock_dict() -> dict:
    return {
        "components": [
            {
                "name": "vision-engine",
                "kind": "python_package",
                "repo": "oguirado/vision-engine",
                "version": "v0.2.0",
                "commit": "9bbb49f220837388e1ab90c34ae0eedee27a66eb",
            },
            {
                "name": "wender-agent",
                "kind": "python_package",
                "repo": "oguirado/wender-agent",
                "version": "v0.3.0",
                "commit": "7648b258d1d04953bacffe8627de5acd7c75d817",
            },
            {
                "name": "opensuperficies",
                "kind": "go_binary",
                "repo": "oguirado/OpenSuperficies",
                "version": "os-cu-w9-mv1",
                "commit": "a9ac1ac8543872b428990ea23fa2629cd0a6d1d5",
            },
        ],
    }


def _valid_proposal_body() -> dict:
    return {
        "schema": "action_proposal/v0.2",
        "proposal_id": "prop-assembly-smoke-01",
        "surface_id": "cap-assembly-smoke01",
        "based_on_frame": {
            "sha256": "a" * 64,
            "generation": 1,
        },
        "action": {
            "type": "wait",
            "ms": 100,
        },
        "expectation": {
            "type": "changed_region",
            "bbox": {"x": 16, "y": 32, "w": 144, "h": 48},
        },
        "budget": {
            "max_ms": 1000,
            "max_retries": 0,
        },
    }


class DepsLockParserTest(unittest.TestCase):
    def test_parse_real_repo_deps_lock(self) -> None:
        pins = assembly_smoke.parse_deps_lock(REPO_ROOT / "deps.lock")
        self.assertEqual(
            set(pins.keys()),
            {"vision-engine", "wender-agent", "opensuperficies"},
        )
        for name, pin in pins.items():
            self.assertEqual(pin.name, name)
            self.assertRegex(pin.commit, r"^[0-9a-f]{40}$")
            self.assertIn("/", pin.repo)

    def test_parse_valid_lock_data(self) -> None:
        pins = assembly_smoke.parse_deps_lock_data(_valid_lock_dict())
        self.assertEqual(pins["vision-engine"].repo, "oguirado/vision-engine")
        self.assertEqual(
            pins["vision-engine"].commit,
            "9bbb49f220837388e1ab90c34ae0eedee27a66eb",
        )
        self.assertEqual(pins["opensuperficies"].repo_basename, "OpenSuperficies")

    def test_refuses_wrong_hex_commits(self) -> None:
        bad_commits = [
            "9bbb49f",  # short sha
            "9bbb49f220837388e1ab90c34ae0eedee27a66eb00",  # 42 chars
            "9BBB49F220837388E1AB90C34AE0EEDEE27A66EB",  # uppercase hex
            "gbbb49f220837388e1ab90c34ae0eedee27a66eb",  # non-hex char
            "main",  # branch name
            "v0.2.0",  # tag name
            "",  # empty
        ]
        for bad in bad_commits:
            with self.subTest(commit=bad):
                data = _valid_lock_dict()
                data["components"][0]["commit"] = bad
                with self.assertRaisesRegex(ValueError, "40 lowercase hex"):
                    assembly_smoke.parse_deps_lock_data(data)

    def test_refuses_missing_required_component(self) -> None:
        for missing_idx, missing_name in enumerate(
            ("vision-engine", "wender-agent", "opensuperficies")
        ):
            with self.subTest(missing=missing_name):
                data = _valid_lock_dict()
                del data["components"][missing_idx]
                with self.assertRaisesRegex(
                    ValueError, f"missing required component.*{missing_name}"
                ):
                    assembly_smoke.parse_deps_lock_data(data)

    def test_refuses_duplicate_component(self) -> None:
        data = _valid_lock_dict()
        data["components"].append(copy.deepcopy(data["components"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate component"):
            assembly_smoke.parse_deps_lock_data(data)

    def test_refuses_unexpected_top_key_or_bad_repo(self) -> None:
        bad_top = _valid_lock_dict()
        bad_top["unexpected"] = True
        with self.assertRaisesRegex(ValueError, "unexpected top-level keys"):
            assembly_smoke.parse_deps_lock_data(bad_top)

        bad_repo = _valid_lock_dict()
        bad_repo["components"][1]["repo"] = "invalid-repo-slug"
        with self.assertRaisesRegex(ValueError, "owner/name"):
            assembly_smoke.parse_deps_lock_data(bad_repo)

    def test_schema_version_validation_and_duplicate_json_keys(self) -> None:
        valid_with_schema = _valid_lock_dict()
        valid_with_schema["schema_version"] = "metaviewer.deps.lock/v1"
        pins = assembly_smoke.parse_deps_lock_data(valid_with_schema)
        self.assertEqual(len(pins), 3)

        for bad_ver in ("metaviewer.deps.lock/v0", "metaviewer.deps.lock/v2", "", None, 1):
            with self.subTest(schema_version=bad_ver):
                bad_schema = _valid_lock_dict()
                bad_schema["schema_version"] = bad_ver
                with self.assertRaisesRegex(
                    ValueError, "schema_version must be 'metaviewer.deps.lock/v1'"
                ):
                    assembly_smoke.parse_deps_lock_data(bad_schema)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            dup_top = tmp_path / "dup_top.lock"
            dup_top.write_text(
                '{"schema_version":"metaviewer.deps.lock/v1",'
                '"schema_version":"metaviewer.deps.lock/v1","components":[]}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
                assembly_smoke.parse_deps_lock(dup_top)

            dup_inner = tmp_path / "dup_inner.lock"
            dup_inner.write_text(
                '{"components":[{"name":"vision-engine","name":"vision-engine",'
                '"kind":"python_package","repo":"oguirado/vision-engine",'
                '"version":"v0.2.0","commit":"9bbb49f220837388e1ab90c34ae0eedee27a66eb"}]}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
                assembly_smoke.parse_deps_lock(dup_inner)

    def test_cli_github_output_and_invalid_lock_rc(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            out_file = tmp_path / "github_output.txt"
            pins = assembly_smoke.parse_deps_lock(REPO_ROOT / "deps.lock")
            rc = assembly_smoke.main(
                [
                    "--lock",
                    str(REPO_ROOT / "deps.lock"),
                    "--github-output",
                    str(out_file),
                ]
            )
            self.assertEqual(rc, 0)
            text = out_file.read_text(encoding="utf-8")
            prefix_map = {
                "vision-engine": "vision_engine",
                "wender-agent": "wender_agent",
                "opensuperficies": "opensuperficies",
            }
            for comp_name, prefix in prefix_map.items():
                pin = pins[comp_name]
                self.assertIn(f"{prefix}_repo={pin.repo}\n", text)
                self.assertIn(f"{prefix}_commit={pin.commit}\n", text)
                self.assertIn(f"{prefix}_dir={pin.repo_basename}\n", text)

            bad_lock = tmp_path / "bad.lock"
            bad_data = _valid_lock_dict()
            bad_data["components"][2]["commit"] = "not-a-40-hex-sha"
            bad_lock.write_text(json.dumps(bad_data), encoding="utf-8")
            rc_bad = assembly_smoke.main(
                ["--lock", str(bad_lock), "--print-pins"]
            )
            self.assertEqual(rc_bad, 1)


def _init_two_commit_repo(repo_dir: Path) -> tuple[str, str]:
    repo_dir.mkdir(parents=True, exist_ok=True)
    git_env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "oguirado",
        "GIT_AUTHOR_EMAIL": "247666607+oguirado@users.noreply.github.com",
        "GIT_COMMITTER_NAME": "oguirado",
        "GIT_COMMITTER_EMAIL": "247666607+oguirado@users.noreply.github.com",
    }

    def run_git(*args: str) -> str:
        proc = subprocess.run(
            ["git", "-C", str(repo_dir), *args],
            env=git_env,
            capture_output=True,
            text=True,
            timeout=10.0,
            check=True,
        )
        return proc.stdout.strip()

    run_git("init", "-q")
    (repo_dir / "marker.txt").write_text("v1\n", encoding="utf-8")
    (repo_dir / "only_v1.txt").write_text("pinned\n", encoding="utf-8")
    run_git("add", "marker.txt", "only_v1.txt")
    run_git("commit", "-q", "-m", "ci: initialize v1")
    commit1 = run_git("rev-parse", "HEAD")

    (repo_dir / "marker.txt").write_text("v2\n", encoding="utf-8")
    (repo_dir / "only_v1.txt").unlink()
    (repo_dir / "only_v2.txt").write_text("head\n", encoding="utf-8")
    run_git("add", "-A")
    run_git("commit", "-q", "-m", "ci: update to v2")
    commit2 = run_git("rev-parse", "HEAD")
    return commit1, commit2


class PinnedTreeEnforcementTest(unittest.TestCase):
    def test_resolve_component_dir_found_and_missing(self) -> None:
        pin = assembly_smoke.PinnedComponent(
            name="opensuperficies",
            kind="go_binary",
            repo="oguirado/OpenSuperficies",
            version="os-cu-w9-mv1",
            commit="a" * 40,
        )
        with tempfile.TemporaryDirectory() as tmp:
            deps_root = Path(tmp)
            with self.assertRaisesRegex(
                FileNotFoundError, "component 'opensuperficies' directory not found"
            ):
                assembly_smoke.resolve_component_dir(deps_root, pin)

            by_name_dir = deps_root / "opensuperficies"
            by_name_dir.mkdir()
            self.assertEqual(
                assembly_smoke.resolve_component_dir(deps_root, pin),
                by_name_dir,
            )

            by_basename_dir = deps_root / "OpenSuperficies"
            by_basename_dir.mkdir()
            self.assertEqual(
                assembly_smoke.resolve_component_dir(deps_root, pin),
                by_basename_dir,
            )

    def test_prepare_pinned_tree_strict_head_match_and_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            repo_dir = tmp_path / "vision-engine"
            scratch = tmp_path / "scratch"
            scratch.mkdir()
            commit1, commit2 = _init_two_commit_repo(repo_dir)

            pin_head = assembly_smoke.PinnedComponent(
                name="vision-engine",
                kind="python_package",
                repo="oguirado/vision-engine",
                version="v0.2.0",
                commit=commit2,
            )
            tree_dir, resolved = assembly_smoke.prepare_pinned_tree(
                repo_dir,
                pin_head,
                strict_head=True,
                scratch_root=scratch,
                timeout_s=10.0,
            )
            self.assertEqual(tree_dir, repo_dir)
            self.assertEqual(resolved, commit2)

            pin_older = assembly_smoke.PinnedComponent(
                name="vision-engine",
                kind="python_package",
                repo="oguirado/vision-engine",
                version="v0.2.0",
                commit=commit1,
            )
            with self.assertRaisesRegex(
                RuntimeError,
                f"vision-engine HEAD mismatch: expected {commit1}, got {commit2}",
            ):
                assembly_smoke.prepare_pinned_tree(
                    repo_dir,
                    pin_older,
                    strict_head=True,
                    scratch_root=scratch,
                    timeout_s=10.0,
                )

    def test_prepare_pinned_tree_non_strict_archive_fallback_and_missing_commit(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            repo_dir = tmp_path / "vision-engine"
            scratch = tmp_path / "scratch"
            scratch.mkdir()
            commit1, _commit2 = _init_two_commit_repo(repo_dir)

            pin_older = assembly_smoke.PinnedComponent(
                name="vision-engine",
                kind="python_package",
                repo="oguirado/vision-engine",
                version="v0.2.0",
                commit=commit1,
            )
            archive_dir, resolved = assembly_smoke.prepare_pinned_tree(
                repo_dir,
                pin_older,
                strict_head=False,
                scratch_root=scratch,
                timeout_s=10.0,
            )
            self.assertNotEqual(archive_dir, repo_dir)
            self.assertEqual(resolved, commit1)
            self.assertEqual(
                (archive_dir / "marker.txt").read_text(encoding="utf-8"),
                "v1\n",
            )
            self.assertTrue((archive_dir / "only_v1.txt").is_file())
            self.assertFalse((archive_dir / "only_v2.txt").exists())

            missing_commit = "f" * 40
            pin_missing = assembly_smoke.PinnedComponent(
                name="vision-engine",
                kind="python_package",
                repo="oguirado/vision-engine",
                version="v0.2.0",
                commit=missing_commit,
            )
            with self.assertRaisesRegex(
                RuntimeError,
                f"vision-engine pinned commit {missing_commit} not present",
            ):
                assembly_smoke.prepare_pinned_tree(
                    repo_dir,
                    pin_missing,
                    strict_head=False,
                    scratch_root=scratch,
                    timeout_s=10.0,
                )


class SmokeResultAggregationTest(unittest.TestCase):
    def test_all_pass_aggregation(self) -> None:
        results = [
            assembly_smoke.SmokeResult(
                component="vision-engine",
                status="PASS",
                detail="commit=9bbb49f22083 changed_regions=[...]",
            ),
            assembly_smoke.SmokeResult(
                component="wender-agent",
                status="PASS",
                detail="commit=7648b258d1d0 entrypoints=7 planner=SKIP (planner not pinned yet)",
                planner_note="SKIP (planner not pinned yet)",
            ),
            assembly_smoke.SmokeResult(
                component="opensuperficies",
                status="PASS",
                detail="commit=a9ac1ac85438 built=[srf-identity-surface,srf-holdings-capsule] daemon-adapter=ok",
            ),
        ]
        ok, lines = assembly_smoke.aggregate_results(results)
        self.assertTrue(ok)
        self.assertIn("SKIP (planner not pinned yet)", lines)
        self.assertTrue(any(line.startswith("PASS vision-engine:") for line in lines))
        self.assertTrue(any(line.startswith("PASS wender-agent:") for line in lines))
        self.assertTrue(any(line.startswith("PASS opensuperficies:") for line in lines))

    def test_single_failure_marks_aggregate_failed(self) -> None:
        results = [
            assembly_smoke.SmokeResult(
                component="vision-engine",
                status="PASS",
                detail="ok",
            ),
            assembly_smoke.SmokeResult(
                component="wender-agent",
                status="FAIL",
                detail="entrypoint import failed",
            ),
            assembly_smoke.SmokeResult(
                component="opensuperficies",
                status="PASS",
                detail="ok",
            ),
        ]
        ok, lines = assembly_smoke.aggregate_results(results)
        self.assertFalse(ok)
        self.assertIn("FAIL wender-agent: entrypoint import failed", lines)

    def test_missing_component_in_results_fails_aggregation(self) -> None:
        results = [
            assembly_smoke.SmokeResult(
                component="vision-engine",
                status="PASS",
                detail="ok",
            ),
            assembly_smoke.SmokeResult(
                component="wender-agent",
                status="PASS",
                detail="ok",
            ),
        ]
        ok, lines = assembly_smoke.aggregate_results(results)
        self.assertFalse(ok)
        self.assertIn("FAIL opensuperficies: missing smoke result", lines)

    def test_duplicate_component_in_results_fails_aggregation(self) -> None:
        results = [
            assembly_smoke.SmokeResult(
                component="vision-engine",
                status="PASS",
                detail="first pass",
            ),
            assembly_smoke.SmokeResult(
                component="vision-engine",
                status="PASS",
                detail="duplicate pass",
            ),
            assembly_smoke.SmokeResult(
                component="wender-agent",
                status="PASS",
                detail="ok",
            ),
            assembly_smoke.SmokeResult(
                component="opensuperficies",
                status="PASS",
                detail="ok",
            ),
        ]
        ok, _lines = assembly_smoke.aggregate_results(results)
        self.assertFalse(ok)


def _synthetic_vision_frame_sha256() -> str:
    width, height = 320, 200
    buf = bytearray(width * height * 3)
    for y in range(40, 80):
        for x in range(30, 150):
            idx = (y * width + x) * 3
            buf[idx : idx + 3] = b"\xff\xff\xff"
    for y in range(120, 150):
        for x in range(200, 300):
            idx = (y * width + x) * 3
            buf[idx : idx + 3] = b"\xff\xff\xff"
    return hashlib.sha256(bytes(buf)).hexdigest()


def _write_vision_engine_stub(
    tree_dir: Path,
    changed_regions: list[dict[str, object]],
) -> None:
    vadapt_dir = tree_dir / "vadapt"
    vadapt_dir.mkdir(parents=True, exist_ok=True)
    (vadapt_dir / "__init__.py").write_text("", encoding="utf-8")
    payload = {
        "schema": "ve.cu_describe/v1",
        "frame_sha256": _synthetic_vision_frame_sha256(),
        "width": 320,
        "height": 200,
        "changed": True,
        "changed_regions": changed_regions,
        "crops": [],
        "timing_us": 25,
    }
    (vadapt_dir / "cu_describe.py").write_text(
        "import json\n"
        f"print(json.dumps({payload!r}))\n",
        encoding="utf-8",
    )


CANONICAL_WENDER_ENTRYPOINTS: tuple[str, ...] = (
    "wender",
    "wender.state.schema",
    "wender.state.handles",
    "wender.perceive.element_table",
    "wender.perceive.vision_bridge",
    "wender.learn.cu_loop",
    "wender.act.actor",
)


def _write_wender_stub_tree(
    tree_dir: Path,
    *,
    omit_module: str | None = None,
) -> None:
    if omit_module == "wender":
        tree_dir.mkdir(parents=True, exist_ok=True)
        return
    for pkg in ("wender", "wender/state", "wender/perceive", "wender/learn", "wender/act"):
        pkg_dir = tree_dir / pkg
        pkg_dir.mkdir(parents=True, exist_ok=True)
        init_file = pkg_dir / "__init__.py"
        init_file.write_text("", encoding="utf-8")

    schema_code = """
def build_state(
    raw_nodes,
    *,
    kind,
    url,
    title,
    ax_sha256,
    ax_stable_sha256,
    prune,
    raw_count,
    boxes,
    viewport,
    actionable_roles,
):
    nodes = []
    actionable = []
    for item in raw_nodes:
        nid = item["id"]
        role = item["role"]
        is_act = role in actionable_roles
        if is_act:
            actionable.append(nid)
        nodes.append(
            {
                "id": nid,
                "role": role,
                "name": item["name"],
                "depth": item["depth"],
                "parent": None,
                "ordinal": item["ordinal"],
                "states": {},
                "actionable": is_act,
                "box": list(boxes.get(nid, [0, 0, 1, 1])),
            }
        )
    return {
        "schema": "wender.state/v1",
        "source": {"kind": kind, "url": url, "title": title},
        "prune": dict(prune),
        "ax_sha256": ax_sha256,
        "ax_stable_sha256": ax_stable_sha256,
        "viewport": dict(viewport),
        "nodes": nodes,
        "actionable": actionable,
        "counts": {
            "raw": raw_count,
            "nodes": len(nodes),
            "actionable": len(actionable),
        },
    }
"""
    module_files = {
        "wender.state.schema": (tree_dir / "wender/state/schema.py", schema_code),
        "wender.state.handles": (tree_dir / "wender/state/handles.py", "HANDLES = True\n"),
        "wender.perceive.element_table": (
            tree_dir / "wender/perceive/element_table.py",
            "ELEMENT_TABLE = True\n",
        ),
        "wender.perceive.vision_bridge": (
            tree_dir / "wender/perceive/vision_bridge.py",
            "VISION_BRIDGE = True\n",
        ),
        "wender.learn.cu_loop": (tree_dir / "wender/learn/cu_loop.py", "CU_LOOP = True\n"),
        "wender.act.actor": (tree_dir / "wender/act/actor.py", "ACTOR = True\n"),
    }
    for mod_name, (mod_path, code) in module_files.items():
        if mod_name == omit_module:
            continue
        mod_path.write_text(code, encoding="utf-8")


class VisionAndWenderContractTest(unittest.TestCase):
    def test_smoke_vision_engine_region_match_passes_and_mismatch_fails(self) -> None:
        pin = assembly_smoke.PinnedComponent(
            name="vision-engine",
            kind="python_package",
            repo="oguirado/vision-engine",
            version="v0.2.0",
            commit="9bbb49f220837388e1ab90c34ae0eedee27a66eb",
        )
        with tempfile.TemporaryDirectory() as tmp:
            match_dir = Path(tmp) / "ve-match"
            _write_vision_engine_stub(
                match_dir,
                [
                    {"x": 16, "y": 32, "w": 144, "h": 48, "score": 0.95},
                    {"x": 192, "y": 112, "w": 112, "h": 48, "score": 0.85},
                ],
            )
            res_ok = assembly_smoke.smoke_vision_engine(
                match_dir,
                pin,
                timeout_s=10.0,
            )
            self.assertEqual(res_ok.status, "PASS", res_ok.detail)
            self.assertIn(
                "changed_regions="
                + json.dumps(
                    assembly_smoke.EXPECTED_VISION_REGIONS,
                    separators=(",", ":"),
                    sort_keys=True,
                ),
                res_ok.detail,
            )

            mismatch_dir = Path(tmp) / "ve-mismatch"
            _write_vision_engine_stub(
                mismatch_dir,
                [
                    {"x": 16, "y": 32, "w": 100, "h": 48, "score": 0.95},
                ],
            )
            res_bad = assembly_smoke.smoke_vision_engine(
                mismatch_dir,
                pin,
                timeout_s=10.0,
            )
            self.assertEqual(res_bad.status, "FAIL", res_bad.detail)
            self.assertIn("changed_regions=", res_bad.detail)
            self.assertIn("!= expected", res_bad.detail)

    def test_wender_entrypoints_contract_and_dropped_entrypoint_fails(self) -> None:
        self.assertEqual(
            assembly_smoke.WENDER_PUBLIC_ENTRYPOINTS,
            CANONICAL_WENDER_ENTRYPOINTS,
        )
        pin = assembly_smoke.PinnedComponent(
            name="wender-agent",
            kind="python_package",
            repo="oguirado/wender-agent",
            version="v0.3.0",
            commit="7648b258d1d04953bacffe8627de5acd7c75d817",
        )
        with tempfile.TemporaryDirectory() as tmp:
            full_dir = Path(tmp) / "wender-full"
            _write_wender_stub_tree(full_dir)
            res_ok = assembly_smoke.smoke_wender_agent(
                full_dir,
                pin,
                timeout_s=10.0,
            )
            self.assertEqual(res_ok.status, "PASS", res_ok.detail)
            self.assertIn("entrypoints=7", res_ok.detail)

            for idx, omitted in enumerate(CANONICAL_WENDER_ENTRYPOINTS):
                with self.subTest(omitted=omitted):
                    drop_dir = Path(tmp) / f"wender-drop-{idx}"
                    _write_wender_stub_tree(drop_dir, omit_module=omitted)
                    res_drop = assembly_smoke.smoke_wender_agent(
                        drop_dir,
                        pin,
                        timeout_s=10.0,
                    )
                    self.assertEqual(res_drop.status, "FAIL", res_drop.detail)
                    self.assertIn(
                        "entrypoint import/state check failed",
                        res_drop.detail,
                    )


class WenderPlannerSmokeTest(unittest.TestCase):
    def test_planner_skip_when_cli_module_absent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tree_dir = Path(tmp)
            (tree_dir / "wender").mkdir(parents=True)
            ok, note = assembly_smoke.run_wender_planner_check(
                tree_dir,
                timeout_s=5.0,
            )
            self.assertTrue(ok)
            self.assertEqual(note, "SKIP (planner not pinned yet)")

    def test_planner_cli_valid_and_invalid_proposal_validation(self) -> None:
        valid_proposal = _valid_proposal_body()
        parsed = assembly_smoke.validate_planner_proposal_output(
            json.dumps(valid_proposal)
        )
        self.assertEqual(parsed["proposal_id"], valid_proposal["proposal_id"])

        with tempfile.TemporaryDirectory() as tmp:
            tree_dir = Path(tmp)
            plan_dir = tree_dir / "wender" / "plan"
            plan_dir.mkdir(parents=True)
            (plan_dir / "cli.py").write_text("# stub\n", encoding="utf-8")

            def fake_ok_runner(*_args, **_kwargs) -> subprocess.CompletedProcess[str]:
                return subprocess.CompletedProcess(
                    args=["python3", "-m", "wender.plan.cli"],
                    returncode=0,
                    stdout=json.dumps(valid_proposal) + "\n",
                    stderr="",
                )

            ok, note = assembly_smoke.run_wender_planner_check(
                tree_dir,
                timeout_s=5.0,
                runner=fake_ok_runner,
            )
            self.assertTrue(ok)
            self.assertIn("wender.plan.cli verified proposal_id=", note)

            def fake_bad_runner(*_args, **_kwargs) -> subprocess.CompletedProcess[str]:
                return subprocess.CompletedProcess(
                    args=["python3", "-m", "wender.plan.cli"],
                    returncode=0,
                    stdout=json.dumps({"schema": "wrong/v0"}) + "\n",
                    stderr="",
                )

            ok_bad, note_bad = assembly_smoke.run_wender_planner_check(
                tree_dir,
                timeout_s=5.0,
                runner=fake_bad_runner,
            )
            self.assertFalse(ok_bad)
            self.assertIn("invalid action_proposal/v0.2", note_bad)

    def test_planner_envelope_wrapped_proposal_and_empty_or_multiline_rejection(
        self,
    ) -> None:
        agents_root = str(REPO_ROOT / "agents")
        if agents_root not in sys.path:
            sys.path.insert(0, agents_root)
        from metaviewer_agents.envelope import make_envelope

        valid_proposal = _valid_proposal_body()
        wrapped_envelope = make_envelope(
            msg_id="msg-assembly-smoke-env-01",
            from_component="wender",
            from_instance="wender-01",
            to_component="core",
            to_instance="core-01",
            session_id="sess-assembly-smoke-01",
            seq=1,
            nonce="2" * 32,
            ts_ns=2000,
            body=valid_proposal,
        )
        parsed = assembly_smoke.validate_planner_proposal_output(
            json.dumps(wrapped_envelope)
        )
        self.assertEqual(parsed["proposal_id"], valid_proposal["proposal_id"])
        self.assertEqual(parsed["schema"], "action_proposal/v0.2")

        for empty_out in ("", "   \n\t  "):
            with self.subTest(empty_out=empty_out):
                with self.assertRaisesRegex(
                    ValueError, "wender.plan.cli produced empty stdout"
                ):
                    assembly_smoke.validate_planner_proposal_output(empty_out)

        multiline_out = (
            json.dumps(valid_proposal) + "\n" + json.dumps(valid_proposal) + "\n"
        )
        with self.assertRaisesRegex(
            ValueError, "wender.plan.cli must emit exactly one JSON line"
        ):
            assembly_smoke.validate_planner_proposal_output(multiline_out)

        obs_env = assembly_smoke.build_minimal_observation_envelope()
        with self.assertRaisesRegex(
            ValueError, "envelope body must be action_proposal/v0.2"
        ):
            assembly_smoke.validate_planner_proposal_output(json.dumps(obs_env))


class OpenSuperficiesSmokeTest(unittest.TestCase):
    def _pin(self) -> assembly_smoke.PinnedComponent:
        return assembly_smoke.PinnedComponent(
            name="opensuperficies",
            kind="go_binary",
            repo="oguirado/OpenSuperficies",
            version="os-cu-w9-mv1",
            commit="a9ac1ac8543872b428990ea23fa2629cd0a6d1d5",
        )

    def test_missing_go_toolchain_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            with mock.patch.object(assembly_smoke.shutil, "which", return_value=None):
                res = assembly_smoke.smoke_opensuperficies(
                    tmp_path,
                    self._pin(),
                    scratch_root=tmp_path / "scratch",
                    timeout_s=5.0,
                )
            self.assertEqual(res.status, "FAIL")
            self.assertIn("go toolchain not found on PATH", res.detail)

    def test_stub_go_build_error_banner_mismatch_and_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            tree_dir = tmp_path / "os-tree"
            tree_dir.mkdir()
            fake_bin = tmp_path / "fake-bin"
            fake_bin.mkdir()
            fake_go = fake_bin / "go"

            go_script = f"""#!{sys.executable}
import os
from pathlib import Path
import sys

args = sys.argv[1:]
mode = os.environ.get("MV_TEST_FAKE_GO_MODE", "ok")

if args and args[0] == "build":
    if mode == "build_fail":
        print("stub go build compile error", file=sys.stderr)
        sys.exit(1)
    out_idx = args.index("-o") + 1
    out_bin = Path(args[out_idx])
    out_bin.parent.mkdir(parents=True, exist_ok=True)
    banner = (
        "srf-identity-surface capabilities v0-mismatch"
        if mode == "bad_banner"
        else "srf-identity-surface capabilities v1"
    )
    out_bin.write_text(
        "#!{sys.executable}\\n"
        "import sys\\n"
        f"print({{banner!r}})\\n"
        "sys.exit(0)\\n",
        encoding="utf-8",
    )
    out_bin.chmod(0o755)
    sys.exit(0)

if args and args[0] == "test":
    if mode == "test_fail":
        print("stub daemon-adapter test failure", file=sys.stderr)
        sys.exit(1)
    if os.environ.get("MV_E2E_LIVE") != "1":
        print("missing MV_E2E_LIVE=1", file=sys.stderr)
        sys.exit(1)
    sys.exit(0)

sys.exit(2)
"""
            fake_go.write_text(go_script, encoding="utf-8")
            fake_go.chmod(0o755)

            with mock.patch.object(
                assembly_smoke.shutil, "which", return_value=str(fake_go)
            ):
                with mock.patch.dict(
                    os.environ, {"MV_TEST_FAKE_GO_MODE": "build_fail"}
                ):
                    res_build_fail = assembly_smoke.smoke_opensuperficies(
                        tree_dir,
                        self._pin(),
                        scratch_root=tmp_path / "scratch-build-fail",
                        timeout_s=10.0,
                    )
                self.assertEqual(res_build_fail.status, "FAIL", res_build_fail.detail)
                self.assertIn(
                    "go build srf-identity-surface failed", res_build_fail.detail
                )

                with mock.patch.dict(
                    os.environ, {"MV_TEST_FAKE_GO_MODE": "bad_banner"}
                ):
                    res_bad_banner = assembly_smoke.smoke_opensuperficies(
                        tree_dir,
                        self._pin(),
                        scratch_root=tmp_path / "scratch-bad-banner",
                        timeout_s=10.0,
                    )
                self.assertEqual(res_bad_banner.status, "FAIL", res_bad_banner.detail)
                self.assertIn(
                    "srf-identity-surface capabilities unexpected output",
                    res_bad_banner.detail,
                )

                with mock.patch.dict(os.environ, {"MV_TEST_FAKE_GO_MODE": "ok"}):
                    res_ok = assembly_smoke.smoke_opensuperficies(
                        tree_dir,
                        self._pin(),
                        scratch_root=tmp_path / "scratch-ok",
                        timeout_s=10.0,
                    )
                self.assertEqual(res_ok.status, "PASS", res_ok.detail)
                self.assertIn(
                    "built=[srf-identity-surface,srf-holdings-capsule] daemon-adapter=ok",
                    res_ok.detail,
                )


if __name__ == "__main__":
    unittest.main()
