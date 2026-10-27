"""T7 round-2: workflow SHA pinning, permissions, YAML anchor/merge rejection, and toolchain version pinning."""
import json
import os
import pathlib
import re
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
CHECKER = ROOT / ".github" / "workflows" / "workflow_pins.py"
_YAML_PYTHON: str | None = None


def _resolve_yaml_python() -> str:
    global _YAML_PYTHON
    if _YAML_PYTHON is not None:
        return _YAML_PYTHON
    candidates: list[str] = []
    env_cand = os.environ.get("MV_YAML_PYTHON")
    if env_cand:
        candidates.append(env_cand)
    if sys.executable:
        candidates.append(sys.executable)
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if d:
            p = pathlib.Path(d) / "python3"
            if p.is_file():
                candidates.append(str(p))
    base_py = pathlib.Path(sys.base_prefix) / "bin" / "python3"
    if base_py.is_file():
        candidates.append(str(base_py))
    seen: set[str] = set()
    for cand in candidates:
        if cand in seen:
            continue
        seen.add(cand)
        res = subprocess.run([cand, "-c", "import yaml"], capture_output=True, text=True, timeout=10)
        if res.returncode == 0:
            _YAML_PYTHON = cand
            return cand
    raise RuntimeError("PyYAML runner prerequisite absent")


def _pin_errors(text: str, root: pathlib.Path) -> list[str]:
    res = subprocess.run(
        [_resolve_yaml_python(), str(CHECKER), str(root)],
        input=text,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if res.returncode != 0:
        return ["YAML checker unavailable: " + res.stderr]
    errors = json.loads(res.stdout)
    if not isinstance(errors, list):
        return ["invalid checker result"]
    return errors


def _yaml_safe_load(text: str) -> dict:
    res = subprocess.run(
        [
            _resolve_yaml_python(),
            "-c",
            "import json, sys, yaml; doc = yaml.safe_load(sys.stdin.read()); "
            "print(json.dumps({str(k): v for k, v in (doc or {}).items()}))",
        ],
        input=text,
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    return json.loads(res.stdout)


class TestT7R2CWorkflowPins(unittest.TestCase):
    def setUp(self):
        self.wf_dir = ROOT / ".github" / "workflows"
        self.workflows = sorted(self.wf_dir.glob("*.yml"))
        self.assertGreaterEqual(len(self.workflows), 5)

    def test_o1_all_workflows_pass_pin_errors(self):
        for wf in self.workflows:
            with self.subTest(workflow=wf.name):
                text = wf.read_text(encoding="utf-8")
                self.assertEqual(_pin_errors(text, ROOT), [])

    def test_o1_tag_or_branch_ref_rejected(self):
        sample = (self.wf_dir / "ci.yml").read_text(encoding="utf-8")
        mutated = sample.replace(
            "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
            "actions/checkout@v4",
            1,
        )
        errs = _pin_errors(mutated, ROOT)
        self.assertTrue(any("unpinned action: actions/checkout@v4" in e for e in errs), errs)

    def test_o1_short_sha_rejected(self):
        sample = (self.wf_dir / "ci.yml").read_text(encoding="utf-8")
        mutated = sample.replace(
            "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
            "actions/checkout@11bd719",
            1,
        )
        errs = _pin_errors(mutated, ROOT)
        self.assertTrue(any("unpinned action" in e for e in errs), errs)

    def test_o1_uppercase_hex_sha_rejected(self):
        sample = (self.wf_dir / "ci.yml").read_text(encoding="utf-8")
        mutated = sample.replace(
            "11bd71901bbe5b1630ceea73d27597364c9af683",
            "11BD71901BBE5B1630CEEA73D27597364C9AF683",
            1,
        )
        errs = _pin_errors(mutated, ROOT)
        self.assertTrue(any("unpinned action" in e for e in errs), errs)

    def test_o1_yaml_merge_key_rejected(self):
        adversarial = """
name: test
on: push
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - &base
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - <<: *base
"""
        errs = _pin_errors(adversarial, ROOT)
        self.assertIn("YAML merge keys are not admitted", errs)

    def test_o1_duplicate_key_rejected(self):
        adversarial = """
name: test
on: push
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        uses: actions/checkout@v4
"""
        errs = _pin_errors(adversarial, ROOT)
        self.assertIn("duplicate key: uses", errs)

    def test_o1_path_traversal_local_action_rejected(self):
        adversarial = """
name: test
on: push
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: ./../../outside-action
"""
        errs = _pin_errors(adversarial, ROOT)
        self.assertTrue(any("missing local action metadata" in e for e in errs), errs)

    def test_o1_workflow_permissions_least_privilege(self):
        for wf in self.workflows:
            with self.subTest(workflow=wf.name):
                doc = _yaml_safe_load(wf.read_text(encoding="utf-8"))
                perms = doc.get("permissions")
                self.assertEqual(perms, {"contents": "read"}, f"{wf.name} top-level permissions drift")
                for job_name, job in (doc.get("jobs") or {}).items():
                    if "permissions" in job:
                        self.assertEqual(job["permissions"], {"contents": "read"}, f"{wf.name}:{job_name}")

    def test_o1_pull_request_target_forbidden(self):
        for wf in self.workflows:
            with self.subTest(workflow=wf.name):
                doc = _yaml_safe_load(wf.read_text(encoding="utf-8"))
                on_block = doc.get("on") or doc.get(True) or doc.get("True") or {}
                if isinstance(on_block, dict):
                    self.assertNotIn("pull_request_target", on_block)

    def test_r1_099_toolchain_versions_exact_semver_pinned_and_negative_controls(self):
        semver = re.compile(r"^\d+\.\d+\.\d+$")

        def version_errors(text):
            errors = []
            for key in ("python-version", "node-version"):
                for match in re.finditer(rf"^\s*{key}:\s*[\"']?([^\"'\s#]+)[\"']?", text, re.M):
                    val = match.group(1)
                    if not semver.fullmatch(val):
                        errors.append(f"{key}={val}")
            return errors

        for wf in self.workflows:
            with self.subTest(workflow=wf.name):
                text = wf.read_text(encoding="utf-8")
                self.assertEqual(version_errors(text), [], f"floating toolchain selector in {wf.name}")

        ci_text = (self.wf_dir / "ci.yml").read_text(encoding="utf-8")
        for floating in (
            ci_text.replace('python-version: "3.12.3"', 'python-version: "3.12"', 1),
            ci_text.replace('node-version: "24.14.0"', 'node-version: "24"', 1),
        ):
            self.assertTrue(version_errors(floating))


if __name__ == "__main__":
    unittest.main()
