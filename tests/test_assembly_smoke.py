"""Hosted-safe unit tests for tools/assembly_smoke.py (unit CI-ASSEMBLY)."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

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

    def test_cli_github_output_and_invalid_lock_rc(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            out_file = tmp_path / "github_output.txt"
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
            self.assertIn("vision_engine_repo=oguirado/vision-engine\n", text)
            self.assertIn("wender_agent_repo=oguirado/wender-agent\n", text)
            self.assertIn("opensuperficies_repo=oguirado/OpenSuperficies\n", text)

            bad_lock = tmp_path / "bad.lock"
            bad_data = _valid_lock_dict()
            bad_data["components"][2]["commit"] = "not-a-40-hex-sha"
            bad_lock.write_text(json.dumps(bad_data), encoding="utf-8")
            rc_bad = assembly_smoke.main(
                ["--lock", str(bad_lock), "--print-pins"]
            )
            self.assertEqual(rc_bad, 1)


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


if __name__ == "__main__":
    unittest.main()
