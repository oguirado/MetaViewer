"""CI-PACKAGED-DISPLAY: packaged DISPLAY regression runs in hosted package job and fails on skip."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
CI_YML = ROOT / ".github" / "workflows" / "ci.yml"
DISPLAY_TEST = ROOT / "ui" / "test" / "display-electron.test.js"
TEST_TITLE = "packaged wall paints UnixNano DISPLAY generations after VERIFIED create; reverted guards fail"


def _extract_step_run(ci_text: str, job_name: str, step_name: str) -> str:
    job_sec = re.split(r"\n  [a-z][\w-]*:\n", ci_text.split(f"  {job_name}:\n", 1)[1], 1)[0]
    step_sec = re.split(r"\n      - (?:name|uses):", job_sec.split(f"      - name: {step_name}\n", 1)[1], 1)[0]
    after_header = re.split(r"        run: \|-?\n", step_sec, maxsplit=1)[1]
    run_lines: list[str] = []
    for line in after_header.splitlines():
        if not line.strip():
            run_lines.append("")
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent < 10:
            break
        run_lines.append(line)
    while run_lines and not run_lines[-1]:
        run_lines.pop()
    return textwrap.dedent("\n".join(run_lines) + "\n")


class PackagedDisplayCiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.ci_text = CI_YML.read_text(encoding="utf-8")
        cls.display_step = _extract_step_run(cls.ci_text, "package", "Run packaged DISPLAY regression")
        cls.witness_step = _extract_step_run(cls.ci_text, "package", "Build and witness package")
        cls.agg_step = _extract_step_run(cls.ci_text, "ci-required", "Aggregate required results")

    def test_workflow_wiring_and_js_skip_guard_preserved(self) -> None:
        pkg_sec = re.split(r"\n  [a-z][\w-]*:\n", self.ci_text.split("  package:\n", 1)[1], 1)[0]
        self.assertIn("runner: ubuntu-24.04", pkg_sec)
        self.assertIn("runner: ubuntu-24.04-arm", pkg_sec)
        disp_idx = pkg_sec.find("- name: Run packaged DISPLAY regression")
        witness_idx = pkg_sec.find("- name: Build and witness package")
        self.assertNotEqual(disp_idx, -1)
        self.assertNotEqual(witness_idx, -1)
        self.assertLess(disp_idx, witness_idx, "Run packaged DISPLAY regression must precede Build and witness package")

        self.assertIn("bash .github/workflows/offline.sh", self.display_step)
        self.assertIn("xvfb-run -a", self.display_step)
        self.assertIn("ui/test/display-electron.test.js", self.display_step)
        self.assertIn(f"✔ {TEST_TITLE}", self.display_step)
        self.assertIn("# SKIP", self.display_step)

        # Goal 3: js skip guard and test assertions in ui/test/display-electron.test.js remain intact.
        test_src = DISPLAY_TEST.read_text(encoding="utf-8")
        self.assertIn(
            "const PACKAGED_PREREQS = (process.env.CAPSULE_UI_KIT_REPO || process.env.MV_KIT_CHECKOUT) && process.env.CARGO_TARGET_DIR;",
            test_src,
        )
        self.assertIn(
            "skip: PACKAGED_PREREQS ? false : 'needs the pinned kit checkout and CARGO_TARGET_DIR with built core/adapter (packaged leg)'",
            test_src,
        )
        for marker in (
            "DISPLAY_E2E_OK",
            "DISPLAY_PACKAGED_MUTANT_REJECTED",
            "DISPLAY_U64_GENERATION_MUTANT_REJECTED",
            "DISPLAY_UNBIND_MUTANT_REJECTED",
            "DISPLAY_READY_LOSS_RECOVERED",
        ):
            self.assertIn(marker, test_src)

    def _run_pipeline(self, log_text: str, fixture_rc: int = 0) -> tuple[int, dict, int, dict, int]:
        with tempfile.TemporaryDirectory(prefix="mv-cipkgdisp-") as tmp:
            tmp_path = pathlib.Path(tmp)
            fixture_log = tmp_path / "display-fixture.log"
            fixture_log.write_text(log_text, encoding="utf-8")
            summary = tmp_path / "summary.md"
            summary.write_text("", encoding="utf-8")
            gh_output = tmp_path / "github_output.txt"
            gh_output.write_text("", encoding="utf-8")
            pkg_out = tmp_path / "products"
            pkg_out.mkdir()
            evidence = {
                "artifact": "MetaViewer-linux-x64.tar",
                "artifact_sha256": "a" * 64,
                "manifest_sha256": "b" * 64,
                "architecture": "x64",
                "smoke_marker": "METAVIEWER_MAIN_SMOKE_OK",
            }
            (pkg_out / "product-evidence.json").write_text(json.dumps(evidence), encoding="utf-8")
            rev = "1" * 40

            base_env = dict(
                os.environ,
                RUNNER_TEMP=str(tmp_path),
                JOB_ID="package",
                PLATFORM="x64",
                GITHUB_RUN_ID="999",
                GITHUB_SHA=rev,
                GITHUB_STEP_SUMMARY=str(summary),
                GITHUB_OUTPUT=str(gh_output),
                MV_PKG_OUT=str(pkg_out),
                MV_PACKAGE_DISPLAY_LOG_FIXTURE=str(fixture_log),
                MV_PACKAGE_DISPLAY_FIXTURE_RC=str(fixture_rc),
            )
            disp_res = subprocess.run(
                ["bash", "-c", self.display_step],
                cwd=ROOT,
                env=base_env,
                capture_output=True,
                text=True,
                timeout=20,
            )
            evdir = tmp_path / "metaviewer-ci" / "package" / "x64"
            disp_receipt = json.loads((evdir / "package-display.receipt.json").read_text(encoding="utf-8"))

            witness_script = self.witness_step.replace(
                'python3 tests/ci/test_package_identity.py --build > "$LOG" 2>&1',
                '(exit 0) > "$LOG" 2>&1',
            )
            witness_env = dict(
                base_env,
                SETUP_RESULT="success" if disp_res.returncode == 0 else "failure",
            )
            witness_res = subprocess.run(
                ["bash", "-c", witness_script],
                cwd=ROOT,
                env=witness_env,
                capture_output=True,
                text=True,
                timeout=20,
            )
            pkg_receipt = json.loads((evdir / "package.receipt.json").read_text(encoding="utf-8"))

            # Also test that even if SETUP_RESULT were forced to "success", Build and witness package
            # still fails closed from package-display.receipt.json when the display test was skipped/failed.
            if disp_res.returncode != 0:
                forced_res = subprocess.run(
                    ["bash", "-c", witness_script],
                    cwd=ROOT,
                    env=dict(base_env, SETUP_RESULT="success"),
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                self.assertNotEqual(forced_res.returncode, 0)

            wf_sha = hashlib.sha256(CI_YML.read_bytes()).hexdigest()
            req_dir = tmp_path / "req-receipts"
            req_dir.mkdir()
            budgets_receipt = {
                "schema": "gate_receipt/v1",
                "gate_id": "budgets",
                "leg": "budgets",
                "profile": "W0",
                "owner": "W0-CI-MATRIX",
                "issuer": "CI/ci-required/999 [VM]",
                "scope": {
                    "unit": "W0-CI-MATRIX",
                    "platform": "x64",
                    "feature": "budgets",
                    "artifact": "budgets.receipt.json",
                },
                "argv": ["node", "--test"],
                "cwd": str(ROOT),
                "rc": 0,
                "outcome": "PASS",
                "reason": "ok",
                "identities": {
                    "gate_revision": rev,
                    "instrument_sha256": "c" * 64,
                    "sanitized_log_sha256": "d" * 64,
                    "configuration_sha256": wf_sha,
                    "log_sha256": "e" * 64,
                    "fixture_sha256": ["c" * 64],
                },
                "product_identity": None,
                "assertions": [{"id": "exit-status", "expected": "rc 0", "observed": "rc 0", "accepted": True}],
                "counts": {"passed": None, "failed": None, "skipped": None, "source": "unparsed:budget-gate"},
            }
            (req_dir / "budgets.receipt.json").write_text(json.dumps(budgets_receipt), encoding="utf-8")

            rendered_agg = re.sub(r"\$\{\{\s*job\.status\s*\}\}", "success", self.agg_step)
            rendered_agg = re.sub(
                r"\$\{\{\s*needs\.package\.result\s*\}\}",
                "success" if witness_res.returncode == 0 else "failure",
                rendered_agg,
            )
            rendered_agg = re.sub(r"\$\{\{\s*needs\.[\w-]+\.result\s*\}\}", "success", rendered_agg)
            agg_res = subprocess.run(
                ["bash", "-e", "-u", "-o", "pipefail", "-c", rendered_agg],
                cwd=ROOT,
                env=dict(
                    base_env,
                    PACKAGE_RECEIPT=json.dumps(pkg_receipt),
                    MV_REQUIRED_RECEIPTS_DIR=str(req_dir),
                    MV_REQUIRED_RECEIPTS="budgets,package",
                    MV_EXPECTED_GATE_REVISION=rev,
                ),
                capture_output=True,
                text=True,
                timeout=20,
            )
            return disp_res.returncode, disp_receipt, witness_res.returncode, pkg_receipt, agg_res.returncode

    def test_pass_output_passes_step_and_ci_required(self) -> None:
        pass_log = (
            "METAVIEWER_DISPLAY_STAGE surface=display-e2e stage=FIRST_PAINT detail=OK\n"
            "DISPLAY_E2E_OK fps=23\n"
            "DISPLAY_PACKAGED_MUTANT_REJECTED\n"
            "DISPLAY_U64_GENERATION_MUTANT_REJECTED\n"
            "DISPLAY_UNBIND_MUTANT_REJECTED\n"
            "DISPLAY_READY_LOSS_RECOVERED\n"
            f"✔ {TEST_TITLE} (64200.12ms)\n"
            "ℹ tests 1\n"
            "ℹ suites 0\n"
            "ℹ pass 1\n"
            "ℹ fail 0\n"
            "ℹ cancelled 0\n"
            "ℹ skipped 0\n"
            "ℹ todo 0\n"
        )
        disp_rc, disp_rec, witness_rc, pkg_rec, agg_rc = self._run_pipeline(pass_log, fixture_rc=0)
        self.assertEqual(disp_rc, 0)
        self.assertEqual(disp_rec["outcome"], "PASS")
        self.assertEqual(disp_rec["counts"], {"passed": 1, "failed": 0, "skipped": 0, "source": "parsed:node-test"})
        self.assertTrue(all(a["accepted"] for a in disp_rec["assertions"]))
        self.assertEqual(witness_rc, 0)
        self.assertEqual(pkg_rec["outcome"], "PASS")
        self.assertTrue(any(a["id"] == "packaged-display-regression" and a["accepted"] for a in pkg_rec["assertions"]))
        self.assertEqual(agg_rc, 0)

    def test_skip_outputs_fail_step_and_ci_required(self) -> None:
        tap_skip_log = (
            "TAP version 13\n"
            f"ok 1 - {TEST_TITLE} # SKIP needs the pinned kit checkout and CARGO_TARGET_DIR\n"
            "# tests 1\n"
            "# pass 0\n"
            "# fail 0\n"
            "# skipped 1\n"
        )
        spec_hash_skip_log = (
            f"﹣ {TEST_TITLE} (0.31ms) # SKIP\n"
            "ℹ tests 1\n"
            "ℹ pass 0\n"
            "ℹ fail 0\n"
            "ℹ skipped 1\n"
        )
        spec_reason_skip_log = (
            f"﹣ {TEST_TITLE} (0.33ms) # needs the pinned kit checkout and CARGO_TARGET_DIR with built core/adapter (packaged leg)\n"
            "ℹ tests 1\n"
            "ℹ pass 0\n"
            "ℹ fail 0\n"
            "ℹ skipped 1\n"
        )
        absent_log = (
            "✔ unrelated test (1.0ms)\n"
            "ℹ tests 1\n"
            "ℹ pass 1\n"
            "ℹ fail 0\n"
            "ℹ skipped 0\n"
        )
        failed_log = (
            f"✖ {TEST_TITLE} (120.0ms)\n"
            "ℹ tests 1\n"
            "ℹ pass 0\n"
            "ℹ fail 1\n"
            "ℹ skipped 0\n"
        )
        for label, log_text, rc_in in (
            ("tap-skip", tap_skip_log, 0),
            ("spec-hash-skip", spec_hash_skip_log, 0),
            ("spec-reason-skip", spec_reason_skip_log, 0),
            ("absent-check-line", absent_log, 0),
            ("test-failure", failed_log, 1),
        ):
            with self.subTest(case=label):
                disp_rc, disp_rec, witness_rc, pkg_rec, agg_rc = self._run_pipeline(log_text, fixture_rc=rc_in)
                self.assertNotEqual(disp_rc, 0, label)
                self.assertEqual(disp_rec["outcome"], "FAIL", label)
                self.assertFalse(all(a["accepted"] for a in disp_rec["assertions"]), label)
                self.assertNotEqual(witness_rc, 0, label)
                self.assertEqual(pkg_rec["outcome"], "FAIL", label)
                self.assertNotEqual(agg_rc, 0, label)

    def test_real_node_skip_output_fails_check(self) -> None:
        env = dict(os.environ)
        env.pop("CARGO_TARGET_DIR", None)
        proc = subprocess.run(
            ["node", "--test", "--test-reporter=spec", str(DISPLAY_TEST)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, "js-style skip returns 0 from node --test itself")
        disp_rc, disp_rec, witness_rc, pkg_rec, agg_rc = self._run_pipeline(
            proc.stdout + proc.stderr,
            fixture_rc=proc.returncode,
        )
        self.assertNotEqual(disp_rc, 0)
        self.assertEqual(disp_rec["outcome"], "FAIL")
        self.assertEqual(disp_rec["counts"]["skipped"], 1)
        self.assertNotEqual(witness_rc, 0)
        self.assertEqual(pkg_rec["outcome"], "FAIL")
        self.assertNotEqual(agg_rc, 0)


if __name__ == "__main__":
    unittest.main()
