#!/usr/bin/env python3
"""CI per-gate counts-as-artifacts, JS leg sharding, and red-blocks-main probes.

[TARGET, unit decision] E2E-U16 / E2E-U27 (AC-13):
1. Under the W0-CI-MATRIX workflow contract (.github/workflows/ci.yml), external
   upload/download artifact actions are forbidden; per-gate counts are emitted as
   gate_receipt/v1 JSON artifact files (${EVDIR}/<gate>.receipt.json with
   scope.artifact == "<gate>.receipt.json" and counts.{passed,failed,skipped,source})
   and mirrored into $GITHUB_STEP_SUMMARY exactly once per gate execution, while
   the package job also exports receipt_x64/receipt_arm64 outputs to ci-required.
2. The js leg is sharded across both required architectures (x64 on ubuntu-24.04
   and arm64 on ubuntu-24.04-arm with fail-fast: false) and decomposed into six
   ordered gate shards (js-kit, js-install, js-electron, js-test, js-check,
   js-build), each publishing its own receipt artifact exactly once per leg.
3. The red-blocks-main in-tree probe verifies LAWS.md L4.2 (main only moves by
   fast-forward from a green branch; nothing is pushed with a red gate), the
   ci.yml branch-protection header, the ci-required aggregator job's needs list
   and Aggregate required results script, the ci-policy F4 aggregate() oracle,
   and git merge --ff-only refusal on diverged or red branches.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]
CI_YML = ROOT / ".github" / "workflows" / "ci.yml"
LAWS_MD = ROOT / "LAWS.md"

EXPECTED_REQUIRED_JOBS = (
    "ci-policy",
    "laws-contracts",
    "router",
    "rust",
    "go",
    "python",
    "js",
    "e2e",
    "novac",
    "package",
)

EXPECTED_OPTIONAL_JOBS = (
    "build-macos",
    "build-windows",
)

EXPECTED_JS_SHARDS = (
    "js-kit",
    "js-install",
    "js-electron",
    "js-test",
    "js-check",
    "js-build",
)

EXPECTED_JS_MATRIX = (
    {"runner": "ubuntu-24.04", "platform": "x64", "arch": "x86_64"},
    {"runner": "ubuntu-24.04-arm", "platform": "arm64", "arch": "aarch64"},
)

EXPECTED_JOB_GATES = {
    "ci-policy": ("ci-policy",),
    "laws-contracts": ("laws-range", "laws-version", "contracts", "unittest-root"),
    "router": ("router-check",),
    "rust": ("rust-fmt", "rust-clippy", "rust-test"),
    "go": ("go-vet", "go-test"),
    "python": ("python-agents",),
    "js": EXPECTED_JS_SHARDS,
    "e2e": ("e2e-xvfb",),
    "novac": ("novac",),
    "package": ("package",),
    "build-macos": ("build-macos",),
    "build-windows": ("build-windows",),
}

RECEIPT_KEYS = {
    "schema",
    "gate_id",
    "leg",
    "profile",
    "owner",
    "issuer",
    "scope",
    "argv",
    "cwd",
    "rc",
    "outcome",
    "reason",
    "identities",
    "product_identity",
    "assertions",
    "counts",
}

COUNT_KEYS = {"passed", "failed", "skipped", "source"}


def _extract_finish_gate_calls(script: str) -> list[tuple[str, str, str]]:
    """Return (gate_id, count_source, parseut_flag) for non-definition calls."""
    calls: list[tuple[str, str, str]] = []
    pattern = re.compile(
        r"^\s*finish_gate\s+([\w-]+)\s+(\S+)\s+(\S+)\s+\"([^\"]*)\"\s+"
        r"(\S+)\s+(\S+)\s+\"([^\"]*)\"\s+(\d+)\s+--",
        re.M,
    )
    for match in pattern.finditer(script):
        gate_id = match.group(1)
        count_src = match.group(7)
        parseut = match.group(8)
        if gate_id == "$gate":
            continue
        calls.append((gate_id, count_src, parseut))
    return calls


def _extract_blocked_calls(script: str) -> list[str]:
    """Return gate_ids invoked via blocked <gate_id> in a step script."""
    calls: list[str] = []
    for match in re.finditer(r"^\s*blocked\s+([\w-]+)\s+", script, re.M):
        gate_id = match.group(1)
        if gate_id != "$gate":
            calls.append(gate_id)
    return calls


def _extract_shell_functions(step_script: str) -> str:
    """Extract sanitize(), finish_gate(), and blocked() from a CI step script."""
    start = step_script.find("sanitize() {")
    if start < 0:
        raise ValueError("sanitize() definition missing from step script")
    blocked_idx = step_script.find("blocked() {", start)
    if blocked_idx < 0:
        match = re.search(r"\n\}\n", step_script[start:])
        if not match:
            raise ValueError("finish_gate() closing brace missing")
        return step_script[start : start + match.end()]
    match = re.search(r"return 2\s*\n\}", step_script[blocked_idx:])
    if not match:
        raise ValueError("blocked() closing brace missing")
    return step_script[start : blocked_idx + match.end()]


def validate_receipt_artifact(receipt: dict, expected_gate_id: str, expected_platform: str) -> list[str]:
    """Validate a gate_receipt/v1 artifact and its per-gate counts payload."""
    errors: list[str] = []
    if not isinstance(receipt, dict):
        return ["receipt-not-dict"]
    if set(receipt.keys()) != RECEIPT_KEYS:
        errors.append(f"receipt-keys:{sorted(receipt.keys())}")
        return errors
    if receipt.get("schema") != "gate_receipt/v1":
        errors.append("schema")
    if receipt.get("gate_id") != expected_gate_id:
        errors.append(f"gate_id:{receipt.get('gate_id')}!={expected_gate_id}")
    if receipt.get("leg") != expected_gate_id:
        errors.append(f"leg:{receipt.get('leg')}!={expected_gate_id}")
    scope = receipt.get("scope")
    if not isinstance(scope, dict) or set(scope.keys()) != {"unit", "platform", "feature", "artifact"}:
        errors.append("scope-keys")
    else:
        if scope.get("platform") != expected_platform:
            errors.append(f"scope-platform:{scope.get('platform')}!={expected_platform}")
        if scope.get("feature") != expected_gate_id:
            errors.append(f"scope-feature:{scope.get('feature')}!={expected_gate_id}")
        if scope.get("artifact") != f"{expected_gate_id}.receipt.json":
            errors.append(f"scope-artifact:{scope.get('artifact')}")
    counts = receipt.get("counts")
    if not isinstance(counts, dict) or set(counts.keys()) != COUNT_KEYS:
        errors.append("counts-keys")
    else:
        source = counts.get("source")
        if not isinstance(source, str) or not source.strip():
            errors.append("counts-source")
        for key in ("passed", "failed", "skipped"):
            val = counts.get(key)
            if val is not None and (type(val) is not int or val < 0):
                errors.append(f"counts-{key}:{val!r}")
        if source and source.startswith("parsed:"):
            for key in ("passed", "failed", "skipped"):
                if type(counts.get(key)) is not int:
                    errors.append(f"parsed-counts-missing-{key}")
    return errors


def validate_ci_counts_and_js_sharding(ci_text: str) -> None:
    """Assert E2E-U16: per-gate counts as CI artifacts exactly-once and js leg sharded."""
    doc = yaml.safe_load(ci_text)
    if not isinstance(doc, dict) or "jobs" not in doc:
        raise AssertionError("ci.yml missing top-level jobs mapping")
    jobs = doc["jobs"]

    # 1. Verify every gate-producing job emits its expected gate receipt artifacts
    #    with no duplicate finish_gate emissions.
    for job_id, expected_gates in EXPECTED_JOB_GATES.items():
        if job_id not in jobs:
            raise AssertionError(f"missing job {job_id} in ci.yml")
        steps = jobs[job_id].get("steps") or []
        run_scripts = [s.get("run", "") for s in steps if isinstance(s, dict) and s.get("run")]
        combined = "\n".join(run_scripts)
        if "'schema': 'gate_receipt/v1'" not in combined:
            raise AssertionError(f"job {job_id} does not emit gate_receipt/v1 artifact")
        if "'artifact': e['GATE'] + '.receipt.json'" not in combined:
            raise AssertionError(f"job {job_id} does not bind scope.artifact to <gate>.receipt.json")
        if "'counts': {'passed': passed, 'failed': failed, 'skipped': skipped, 'source': e['COUNTSRC']}" not in combined:
            raise AssertionError(f"job {job_id} does not publish counts.{passed,failed,skipped,source}")
        if '>> "$GITHUB_STEP_SUMMARY"' not in combined:
            raise AssertionError(f"job {job_id} does not mirror gate receipt into GITHUB_STEP_SUMMARY")

        calls = _extract_finish_gate_calls(combined)
        seen_gates = [g for g, _, _ in calls]
        if job_id == "ci-policy":
            # ci-policy has mutually exclusive if/else branches for PASS vs FAIL.
            if seen_gates != ["ci-policy", "ci-policy"]:
                raise AssertionError(f"ci-policy expected mutually exclusive PASS/FAIL finish_gate calls, got {seen_gates}")
            if not re.search(
                r"if \[ \$r -eq 0 \]; then\s+finish_gate ci-policy 0 PASS .*?\s+else\s+finish_gate ci-policy \"\$r\" FAIL",
                combined,
                re.S,
            ):
                raise AssertionError("ci-policy finish_gate calls are not mutually exclusive if/else branches")
        else:
            if tuple(seen_gates) != expected_gates:
                raise AssertionError(
                    f"job {job_id} finish_gate sequence mismatch: expected {expected_gates}, got {tuple(seen_gates)}"
                )
            if len(seen_gates) != len(set(seen_gates)):
                raise AssertionError(f"job {job_id} emits duplicate gate receipt artifacts: {seen_gates}")

        for gate_id, count_src, parseut in calls:
            if not count_src:
                raise AssertionError(f"job {job_id} gate {gate_id} has empty count source")
            if gate_id in ("unittest-root", "python-agents"):
                if parseut != "1" or count_src != "parsed:unittest":
                    raise AssertionError(
                        f"job {job_id} gate {gate_id} must parse unittest counts (got source={count_src}, parseut={parseut})"
                    )

    # 2. Verify package job exports receipt_x64 and receipt_arm64 outputs for ci-required.
    pkg_job = jobs["package"]
    pkg_outputs = pkg_job.get("outputs") or {}
    if set(pkg_outputs.keys()) != {"receipt_x64", "receipt_arm64"}:
        raise AssertionError(f"package job must export receipt_x64 and receipt_arm64 outputs, got {set(pkg_outputs.keys())}")

    # 3. Verify js leg is sharded across both architectures (x64, arm64) with fail-fast: false
    #    and decomposed into the 6 ordered gate shards.
    js_job = jobs["js"]
    strategy = js_job.get("strategy") or {}
    if strategy.get("fail-fast") is not False:
        raise AssertionError(f"js job strategy.fail-fast must be False, got {strategy.get('fail-fast')!r}")
    matrix_include = (strategy.get("matrix") or {}).get("include") or []
    if tuple(matrix_include) != EXPECTED_JS_MATRIX:
        raise AssertionError(f"js job matrix shards mismatch: expected {EXPECTED_JS_MATRIX}, got {tuple(matrix_include)}")
    if js_job.get("runs-on") != "${{ matrix.runner }}":
        raise AssertionError(f"js job runs-on must use matrix.runner, got {js_job.get('runs-on')!r}")

    js_steps = [s for s in (js_job.get("steps") or []) if isinstance(s, dict) and s.get("name") == "Run JS gates"]
    if len(js_steps) != 1:
        raise AssertionError(f"js job must have exactly one 'Run JS gates' step, found {len(js_steps)}")
    js_run = js_steps[0].get("run", "")
    js_calls = _extract_finish_gate_calls(js_run)
    js_gate_ids = tuple(g for g, _, _ in js_calls)
    if js_gate_ids != EXPECTED_JS_SHARDS:
        raise AssertionError(f"js job gate shards mismatch: expected {EXPECTED_JS_SHARDS}, got {js_gate_ids}")
    if len(set(js_gate_ids)) != len(EXPECTED_JS_SHARDS):
        raise AssertionError(f"js job contains duplicate gate shards: {js_gate_ids}")

    # Verify blocked fallback coverage when js-kit or js-install fails.
    blocked_calls = _extract_blocked_calls(js_run)
    for downstream in ("js-install", "js-test", "js-check", "js-build"):
        if downstream not in blocked_calls:
            raise AssertionError(f"js job missing blocked fallback receipt for shard {downstream}")


def validate_red_blocks_main(ci_text: str, laws_text: str) -> None:
    """Assert E2E-U27: in-tree ff-only-from-green setting and red-blocks-main enforcement."""
    # 1. Verify LAWS.md L4.2 fast-forward from a green branch law.
    if "`main` only moves by fast-forward from a green branch. Nothing is pushed with a red gate." not in laws_text:
        raise AssertionError("LAWS.md missing L4.2 fast-forward from a green branch invariant")

    # 2. Verify ci.yml header documents ci-required + fast-forward merges only from green.
    header_lines = "\n".join(
        line for line in ci_text.splitlines()[:30] if line.startswith("#")
    )
    if "require the `ci-required` status" not in header_lines:
        raise AssertionError("ci.yml header missing required status `ci-required` declaration")
    if "fast-forward merges only from green" not in header_lines:
        raise AssertionError("ci.yml header missing `fast-forward merges only from green` declaration")
    if "build-macos, build-windows" not in header_lines or "never required statuses" not in header_lines:
        raise AssertionError("ci.yml header missing optional build-only non-required declaration")

    # 3. Verify ci-required job structure in ci.yml.
    doc = yaml.safe_load(ci_text)
    jobs = doc.get("jobs") or {}
    if "ci-required" not in jobs:
        raise AssertionError("ci.yml missing ci-required job")
    ci_req = jobs["ci-required"]
    if ci_req.get("if") != "always()":
        raise AssertionError(f"ci-required must run with if: always(), got {ci_req.get('if')!r}")
    strategy = ci_req.get("strategy") or {}
    if strategy.get("fail-fast") is not False:
        raise AssertionError("ci-required must set strategy.fail-fast: false")
    matrix_include = (strategy.get("matrix") or {}).get("include") or []
    expected_req_matrix = (
        {"runner": "ubuntu-24.04", "platform": "x64"},
        {"runner": "ubuntu-24.04-arm", "platform": "arm64"},
    )
    if tuple(matrix_include) != expected_req_matrix:
        raise AssertionError(f"ci-required matrix mismatch: {matrix_include}")

    needs = ci_req.get("needs") or []
    if tuple(needs) != EXPECTED_REQUIRED_JOBS:
        raise AssertionError(
            f"ci-required needs mismatch: expected {EXPECTED_REQUIRED_JOBS}, got {tuple(needs)}"
        )
    for optional_job in EXPECTED_OPTIONAL_JOBS:
        if optional_job in needs:
            raise AssertionError(f"optional job {optional_job} must not be in ci-required.needs")

    # 4. Verify Aggregate required results step checks distribution status and every required job.
    steps = ci_req.get("steps") or []
    agg_steps = [s for s in steps if isinstance(s, dict) and s.get("name") == "Aggregate required results"]
    if len(agg_steps) != 1:
        raise AssertionError("ci-required must contain exactly one 'Aggregate required results' step")
    agg_step = agg_steps[0]
    if agg_step.get("if") != "always()":
        raise AssertionError("Aggregate required results step must have if: always()")
    agg_run = agg_step.get("run", "")
    if '[ "$check_distribution" = success ] || fail=1' not in agg_run:
        raise AssertionError("Aggregate required results must gate on check_distribution = success")
    checked_jobs = re.findall(r'^\s*check\s+([\w-]+)\s+"\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}"', agg_run, re.M)
    checked_names = tuple(job for job, need_job in checked_jobs if job == need_job)
    if checked_names != EXPECTED_REQUIRED_JOBS:
        raise AssertionError(
            f"Aggregate required results check calls mismatch: expected {EXPECTED_REQUIRED_JOBS}, got {checked_names}"
        )
    if "exit $fail" not in agg_run:
        raise AssertionError("Aggregate required results must terminate with `exit $fail`")

    # 5. Also verify counts-as-artifacts compliance as part of U27 + U16.
    validate_ci_counts_and_js_sharding(ci_text)


class CiCountsAndRedBlocksMainTests(unittest.TestCase):
    """Tests for E2E-U16 and E2E-U27."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.ci_text = CI_YML.read_text(encoding="utf-8")
        cls.laws_text = LAWS_MD.read_text(encoding="utf-8")
        cls.ci_doc = yaml.safe_load(cls.ci_text)

    def _run_finish_gate_sandbox(
        self,
        *,
        step_script: str,
        gate: str,
        rc: str,
        outcome: str,
        reason: str,
        log_content: str,
        countsrc: str,
        parseut: str,
        platform: str = "x64",
    ) -> tuple[Path, Path, int]:
        """Execute the real finish_gate shell function from ci.yml in a temp dir."""
        funcs = _extract_shell_functions(step_script)
        td = Path(tempfile.mkdtemp(prefix="mv-ci-counts-"))
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", str(td)], check=False))
        evdir = td / "evdir"
        evdir.mkdir(parents=True, exist_ok=True)
        raw_log = evdir / f"{gate}.log"
        raw_log.write_text(log_content, encoding="utf-8")
        fixture = td / "fixture.txt"
        fixture.write_text("fixture-bytes\n", encoding="utf-8")
        summary = td / "summary.md"
        summary.write_text("", encoding="utf-8")
        wf_sha = hashlib.sha256(self.ci_text.encode("utf-8")).hexdigest()

        runner = td / "run_finish_gate.sh"
        runner.write_text(
            "set +e\n"
            "set -u -o pipefail\n"
            f'EVDIR="{evdir}"\n'
            f'PLATFORM="{platform}"\n'
            f'WF_SHA="{wf_sha}"\n'
            'ISSUER="CI/test/1 [VM]"\n'
            f'GITHUB_SHA="{"a" * 40}"\n'
            f'GITHUB_STEP_SUMMARY="{summary}"\n'
            f"{funcs}\n"
            f'finish_gate "{gate}" "{rc}" "{outcome}" "{reason}" "{raw_log}" "{fixture}" "{countsrc}" "{parseut}" -- python3 -m unittest\n',
            encoding="utf-8",
        )
        proc = subprocess.run(["bash", str(runner)], cwd=str(td), capture_output=True, text=True, timeout=30)
        return evdir / f"{gate}.receipt.json", summary, proc.returncode

    def test_u16_per_gate_counts_and_js_sharding_positive(self) -> None:
        """E2E-U16 positive: per-gate counts emitted as artifacts once and js leg is sharded."""
        validate_ci_counts_and_js_sharding(self.ci_text)

        # Execute the real finish_gate function from the python job on both OK and FAILED logs.
        py_run = self.ci_doc["jobs"]["python"]["steps"][-1]["run"]
        receipt_path, summary_path, rc = self._run_finish_gate_sandbox(
            step_script=py_run,
            gate="python-agents",
            rc="0",
            outcome="PASS",
            reason="unittest green",
            log_content="test_a (test_x.T) ... ok\n\n----------------------------------------------------------------------\nRan 9 tests in 0.015s\n\nOK (skipped=2)\n",
            countsrc="parsed:unittest",
            parseut="1",
        )
        self.assertEqual(rc, 0)
        self.assertTrue(receipt_path.is_file())
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        self.assertEqual(validate_receipt_artifact(receipt, "python-agents", "x64"), [])
        self.assertEqual(
            receipt["counts"],
            {"passed": 7, "failed": 0, "skipped": 2, "source": "parsed:unittest"},
        )
        summary_text = summary_path.read_text(encoding="utf-8")
        self.assertEqual(summary_text.count("## python-agents [VM] rc 0"), 1)

        # Also verify FAILED unittest count parsing in finish_gate.
        fail_receipt_path, _, fail_rc = self._run_finish_gate_sandbox(
            step_script=py_run,
            gate="python-agents",
            rc="1",
            outcome="FAIL",
            reason="unittest failed",
            log_content="Ran 10 tests in 0.020s\n\nFAILED (failures=2, errors=1, skipped=3)\n",
            countsrc="parsed:unittest",
            parseut="1",
        )
        self.assertEqual(fail_rc, 0)
        fail_receipt = json.loads(fail_receipt_path.read_text(encoding="utf-8"))
        self.assertEqual(validate_receipt_artifact(fail_receipt, "python-agents", "x64"), [])
        self.assertEqual(
            fail_receipt["counts"],
            {"passed": 4, "failed": 3, "skipped": 3, "source": "parsed:unittest"},
        )

    def test_u16_js_sharded_execution_emits_each_shard_receipt_once(self) -> None:
        """E2E-U16 positive execution: Run JS gates emits all 6 shard receipts exactly once."""
        js_steps = [
            s for s in self.ci_doc["jobs"]["js"]["steps"] if s.get("name") == "Run JS gates"
        ]
        self.assertEqual(len(js_steps), 1)
        js_run = js_steps[0]["run"]

        with tempfile.TemporaryDirectory(prefix="mv-js-shards-") as tmp:
            td = Path(tmp)
            ws = td / "ws"
            (ws / ".github" / "workflows").mkdir(parents=True)
            (ws / "ui" / "test").mkdir(parents=True)
            (ws / "tools").mkdir(parents=True)
            (ws / ".github" / "workflows" / "ci.yml").write_text(self.ci_text, encoding="utf-8")
            (ws / ".github" / "workflows" / "install_electron.cjs").write_text("// stub\n", encoding="utf-8")
            offline_sh = ws / ".github" / "workflows" / "offline.sh"
            offline_sh.write_text('#!/usr/bin/env bash\nexec "$@"\n', encoding="utf-8")
            offline_sh.chmod(0o755)
            (ws / "ui" / "kit.lock.json").write_text('{"version":"0.2.1"}\n', encoding="utf-8")
            (ws / "ui" / "package.json").write_text('{"name":"mv-ui","version":"0.1.0"}\n', encoding="utf-8")
            (ws / "ui" / "tsconfig.json").write_text("{}\n", encoding="utf-8")
            (ws / "ui" / "index.html").write_text("<!doctype html>\n", encoding="utf-8")
            (ws / "ui" / "test" / "smoke.test.js").write_text("// test\n", encoding="utf-8")
            (ws / "tools" / "sync_kit.mjs").write_text("// sync_kit\n", encoding="utf-8")

            bindir = td / "bin"
            bindir.mkdir()
            for tool in ("node", "npm"):
                shim = bindir / tool
                shim.write_text('#!/usr/bin/env bash\necho "ok $*"\nexit 0\n', encoding="utf-8")
                shim.chmod(0o755)

            runner_temp = td / "runner_temp"
            runner_temp.mkdir()
            summary = td / "summary.md"
            summary.write_text("", encoding="utf-8")
            host_arch = subprocess.check_output(["uname", "-m"], text=True).strip()

            env = {
                "PATH": f"{bindir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
                "HOME": str(td),
                "GITHUB_WORKSPACE": str(ws),
                "RUNNER_TEMP": str(runner_temp),
                "JOB_ID": "js",
                "PLATFORM": "x64",
                "EXPECT_ARCH": host_arch,
                "GITHUB_RUN_ID": "101",
                "GITHUB_SHA": "b" * 40,
                "GITHUB_STEP_SUMMARY": str(summary),
                "MV_KIT_CHECKOUT": str(td / "kit-checkout"),
            }
            proc = subprocess.run(
                ["bash", "-c", js_run],
                cwd=str(ws),
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

            evdir = runner_temp / "metaviewer-ci" / "js" / "x64"
            emitted_files = sorted(p.name for p in evdir.glob("*.receipt.json"))
            expected_files = sorted(f"{shard}.receipt.json" for shard in EXPECTED_JS_SHARDS)
            self.assertEqual(emitted_files, expected_files)

            summary_text = summary.read_text(encoding="utf-8")
            for shard in EXPECTED_JS_SHARDS:
                receipt_file = evdir / f"{shard}.receipt.json"
                receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
                self.assertEqual(validate_receipt_artifact(receipt, shard, "x64"), [])
                self.assertEqual(receipt["outcome"], "PASS")
                self.assertEqual(receipt["rc"], 0)
                self.assertEqual(
                    summary_text.count(f"## {shard} [VM] rc 0"),
                    1,
                    f"shard {shard} must appear exactly once in GITHUB_STEP_SUMMARY",
                )

    def test_u16_negative_controls_missing_artifact_duplicate_or_unsharded_fails(self) -> None:
        """E2E-U16 negative: missing artifact, duplicate emission, or unsharded js leg fails."""
        # Negative 1: missing finish_gate artifact emission for a js shard (e.g. js-check omitted).
        missing_shard_ci = self.ci_text.replace(
            'finish_gate js-check "$r" "$oc" "$rsn" "$LOG" ui/tsconfig.json "unparsed:vue-tsc" 0 -- npm run check || rc=2',
            'echo "skipped finish_gate for js-check"',
            1,
        )
        self.assertNotEqual(missing_shard_ci, self.ci_text)
        with self.assertRaisesRegex(AssertionError, "js-check|sequence mismatch"):
            validate_ci_counts_and_js_sharding(missing_shard_ci)

        # Negative 2: duplicate finish_gate emission for the same shard (violates exactly-once).
        dup_target = 'finish_gate js-test "$r" "$oc" "$rsn" "$LOG" ui/package.json "unparsed:npm-test" 0 -- npm test || rc=2'
        dup_ci = self.ci_text.replace(dup_target, dup_target + "\n            " + dup_target, 1)
        self.assertNotEqual(dup_ci, self.ci_text)
        with self.assertRaisesRegex(AssertionError, "sequence mismatch|duplicate"):
            validate_ci_counts_and_js_sharding(dup_ci)

        # Negative 3: unsharded js matrix (removing arm64 matrix shard).
        unsharded_matrix_ci = re.sub(
            r"(  js:\n    strategy:\n      fail-fast: false\n      matrix:\n        include:\n          - runner: ubuntu-24\.04\n            platform: x64\n            arch: x86_64\n)          - runner: ubuntu-24\.04-arm\n            platform: arm64\n            arch: aarch64\n",
            r"\1",
            self.ci_text,
            count=1,
        )
        self.assertNotEqual(unsharded_matrix_ci, self.ci_text)
        with self.assertRaisesRegex(AssertionError, "js job matrix shards mismatch"):
            validate_ci_counts_and_js_sharding(unsharded_matrix_ci)

        # Negative 4: js fail-fast enabled (breaks independent shard evidence).
        failfast_ci = re.sub(
            r"(  js:\n    strategy:\n      fail-fast: )false",
            r"\1true",
            self.ci_text,
            count=1,
        )
        self.assertNotEqual(failfast_ci, self.ci_text)
        with self.assertRaisesRegex(AssertionError, "fail-fast must be False"):
            validate_ci_counts_and_js_sharding(failfast_ci)

        # Negative 5: missing counts payload or missing scope.artifact in receipt fails validator.
        broken_receipt = {
            "schema": "gate_receipt/v1",
            "gate_id": "js-test",
            "leg": "js-test",
            "profile": "W0",
            "owner": "W0-CI-MATRIX",
            "issuer": "CI/js/1 [VM]",
            "scope": {"unit": "W0-CI-MATRIX", "platform": "x64", "feature": "js-test", "artifact": "wrong.json"},
            "argv": ["npm", "test"],
            "cwd": "/tmp",
            "rc": 0,
            "outcome": "PASS",
            "reason": "ok",
            "identities": {},
            "product_identity": None,
            "assertions": [],
            "counts": {"passed": 1, "failed": 0, "skipped": 0, "source": ""},
        }
        errs = validate_receipt_artifact(broken_receipt, "js-test", "x64")
        self.assertIn("scope-artifact:wrong.json", errs)
        self.assertIn("counts-source", errs)

    def test_u27_red_blocks_main_in_tree_probe_positive(self) -> None:
        """E2E-U27 positive: ff-only-from-green setting, ci-required aggregator, and git ff-only probe."""
        validate_red_blocks_main(self.ci_text, self.laws_text)

        # Execute the real Aggregate required results script from ci-required.
        agg_steps = [
            s
            for s in self.ci_doc["jobs"]["ci-required"]["steps"]
            if s.get("name") == "Aggregate required results"
        ]
        self.assertEqual(len(agg_steps), 1)
        raw_script = agg_steps[0]["run"]

        def run_aggregator(results: dict[str, str], distribution_status: str = "success") -> tuple[int, str, str]:
            rendered = raw_script.replace("${{ job.status }}", distribution_status)
            for job in EXPECTED_REQUIRED_JOBS:
                rendered = rendered.replace(f"${{{{ needs.{job}.result }}}}", results[job])
            with tempfile.TemporaryDirectory(prefix="mv-ci-req-") as tmp:
                summary = Path(tmp) / "summary.md"
                summary.write_text("", encoding="utf-8")
                env = dict(os.environ, GITHUB_STEP_SUMMARY=str(summary))
                proc = subprocess.run(
                    ["bash", "-e", "-u", "-o", "pipefail", "-c", rendered],
                    capture_output=True,
                    text=True,
                    env=env,
                    timeout=30,
                )
                return proc.returncode, proc.stdout + proc.stderr, summary.read_text(encoding="utf-8")

        all_green = {job: "success" for job in EXPECTED_REQUIRED_JOBS}
        rc, out, summary = run_aggregator(all_green, "success")
        self.assertEqual(rc, 0, out)
        self.assertIn("outcome PASS: every required job succeeded", summary)

        # Negative probe across every required job: any red/cancelled/skipped required job blocks ci-required.
        for failing_job in EXPECTED_REQUIRED_JOBS:
            for bad_state in ("failure", "cancelled", "skipped"):
                mutated = dict(all_green, **{failing_job: bad_state})
                bad_rc, bad_out, bad_summary = run_aggregator(mutated, "success")
                self.assertNotEqual(
                    bad_rc,
                    0,
                    f"ci-required must block main when {failing_job} is {bad_state}",
                )
                self.assertIn(f"FAIL required job {failing_job}: {bad_state}", bad_out)
                self.assertIn("outcome FAIL: a required job failed", bad_summary)

        # Distribution verification failure in ci-required also blocks main even if needs succeeded.
        dist_rc, _, dist_summary = run_aggregator(all_green, "failure")
        self.assertNotEqual(dist_rc, 0)
        self.assertIn("outcome FAIL: a required job failed", dist_summary)

        # Git fast-forward-only from green probe in a scratch repository:
        with tempfile.TemporaryDirectory(prefix="mv-ff-probe-") as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()
            git_env = {
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": str(tmp),
                "GIT_AUTHOR_NAME": "Maintainer",
                "GIT_AUTHOR_EMAIL": "maintainer@example.invalid",
                "GIT_COMMITTER_NAME": "Maintainer",
                "GIT_COMMITTER_EMAIL": "maintainer@example.invalid",
            }

            def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
                return subprocess.run(
                    ["git", *args],
                    cwd=str(repo),
                    env=git_env,
                    capture_output=True,
                    text=True,
                    check=check,
                    timeout=30,
                )

            git("init", "-b", "main")
            git("config", "merge.ff", "only")
            (repo / "state.txt").write_text("base\n", encoding="utf-8")
            git("add", "state.txt")
            git("commit", "-m", "core: initialize base")
            base_sha = git("rev-parse", "HEAD").stdout.strip()

            # Create a diverged branch and advance main so merge is non-ff.
            git("checkout", "-b", "diverged")
            (repo / "diverged.txt").write_text("side\n", encoding="utf-8")
            git("add", "diverged.txt")
            git("commit", "-m", "core: add side commit")

            git("checkout", "main")
            (repo / "main.txt").write_text("mainline\n", encoding="utf-8")
            git("add", "main.txt")
            git("commit", "-m", "core: advance mainline")
            main_sha = git("rev-parse", "HEAD").stdout.strip()
            self.assertNotEqual(base_sha, main_sha)

            # Non-fast-forward merge into main is refused by --ff-only.
            non_ff = git("merge", "--ff-only", "diverged", check=False)
            self.assertNotEqual(non_ff.returncode, 0)
            self.assertEqual(git("rev-parse", "HEAD").stdout.strip(), main_sha)

            # Fast-forward candidate branch: blocked when ci-required is red, admitted only when green.
            git("checkout", "-b", "green-candidate", "main")
            (repo / "candidate.txt").write_text("green\n", encoding="utf-8")
            git("add", "candidate.txt")
            git("commit", "-m", "core: add candidate change")
            candidate_sha = git("rev-parse", "HEAD").stdout.strip()
            git("checkout", "main")

            red_rc, _, _ = run_aggregator(dict(all_green, js="failure"), "success")
            self.assertNotEqual(red_rc, 0)
            # Gate enforcement: when red_rc != 0, main does not advance.
            if red_rc == 0:
                git("merge", "--ff-only", "green-candidate")
            self.assertEqual(git("rev-parse", "HEAD").stdout.strip(), main_sha)

            # When all required gates are green (rc == 0), fast-forward succeeds cleanly.
            green_rc, _, _ = run_aggregator(all_green, "success")
            self.assertEqual(green_rc, 0)
            ff_ok = git("merge", "--ff-only", "green-candidate", check=True)
            self.assertEqual(ff_ok.returncode, 0)
            self.assertEqual(git("rev-parse", "HEAD").stdout.strip(), candidate_sha)

    def test_u27_negative_controls_broken_ff_setting_or_missing_required_gate_fails(self) -> None:
        """E2E-U27 negative: broken LAWS.md/ci.yml ff-only-from-green setting or omitted job fails."""
        # Negative 1: LAWS.md missing fast-forward from a green branch law.
        broken_laws = self.laws_text.replace(
            "`main` only moves by fast-forward from a green branch. Nothing is pushed with a red gate.",
            "`main` accepts direct merges.",
        )
        self.assertNotEqual(broken_laws, self.laws_text)
        with self.assertRaisesRegex(AssertionError, "fast-forward from a green branch"):
            validate_red_blocks_main(self.ci_text, broken_laws)

        # Negative 2: ci.yml header missing fast-forward merges only from green.
        broken_header_ci = self.ci_text.replace(
            "fast-forward merges only from green",
            "merge commits allowed",
            1,
        )
        self.assertNotEqual(broken_header_ci, self.ci_text)
        with self.assertRaisesRegex(AssertionError, "fast-forward merges only from green"):
            validate_red_blocks_main(broken_header_ci, self.laws_text)

        # Negative 3: ci-required.needs omits a required job (e.g. e2e).
        missing_need_ci = self.ci_text.replace(
            "needs: [ci-policy, laws-contracts, router, rust, go, python, js, e2e, novac, package]",
            "needs: [ci-policy, laws-contracts, router, rust, go, python, js, novac, package]",
            1,
        )
        self.assertNotEqual(missing_need_ci, self.ci_text)
        with self.assertRaisesRegex(AssertionError, "ci-required needs mismatch"):
            validate_red_blocks_main(missing_need_ci, self.laws_text)

        # Negative 4: Aggregate required results omits checking a required job (e.g. check js).
        missing_check_ci = self.ci_text.replace(
            '          check js "${{ needs.js.result }}"\n',
            "",
            1,
        )
        self.assertNotEqual(missing_check_ci, self.ci_text)
        with self.assertRaisesRegex(AssertionError, "Aggregate required results check calls mismatch"):
            validate_red_blocks_main(missing_check_ci, self.laws_text)


if __name__ == "__main__":
    unittest.main()
