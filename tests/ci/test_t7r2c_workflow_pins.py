"""T7 round-2: workflow SHA pinning, permissions, YAML anchor/merge rejection, and toolchain version pinning."""
import pathlib
import re
import unittest
import sys
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / ".github" / "workflows"))
import workflow_pins  # noqa: E402


class TestT7R2CWorkflowPins(unittest.TestCase):
    def setUp(self):
        self.wf_dir = ROOT / ".github" / "workflows"
        self.workflows = sorted(self.wf_dir.glob("*.yml"))
        self.assertGreaterEqual(len(self.workflows), 5)

    def test_o1_all_workflows_pass_pin_errors(self):
        for wf in self.workflows:
            with self.subTest(workflow=wf.name):
                text = wf.read_text(encoding="utf-8")
                self.assertEqual(workflow_pins.pin_errors(text, ROOT), [])

    def test_o1_tag_or_branch_ref_rejected(self):
        sample = (self.wf_dir / "ci.yml").read_text(encoding="utf-8")
        mutated = sample.replace(
            "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
            "actions/checkout@v4",
            1,
        )
        errs = workflow_pins.pin_errors(mutated, ROOT)
        self.assertTrue(any("unpinned action: actions/checkout@v4" in e for e in errs), errs)

    def test_o1_short_sha_rejected(self):
        sample = (self.wf_dir / "ci.yml").read_text(encoding="utf-8")
        mutated = sample.replace(
            "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
            "actions/checkout@11bd719",
            1,
        )
        errs = workflow_pins.pin_errors(mutated, ROOT)
        self.assertTrue(any("unpinned action" in e for e in errs), errs)

    def test_o1_uppercase_hex_sha_rejected(self):
        sample = (self.wf_dir / "ci.yml").read_text(encoding="utf-8")
        mutated = sample.replace(
            "11bd71901bbe5b1630ceea73d27597364c9af683",
            "11BD71901BBE5B1630CEEA73D27597364C9AF683",
            1,
        )
        errs = workflow_pins.pin_errors(mutated, ROOT)
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
        errs = workflow_pins.pin_errors(adversarial, ROOT)
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
        errs = workflow_pins.pin_errors(adversarial, ROOT)
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
        errs = workflow_pins.pin_errors(adversarial, ROOT)
        self.assertTrue(any("missing local action metadata" in e for e in errs), errs)

    def test_o1_workflow_permissions_least_privilege(self):
        for wf in self.workflows:
            with self.subTest(workflow=wf.name):
                doc = yaml.safe_load(wf.read_text(encoding="utf-8"))
                perms = doc.get("permissions")
                self.assertEqual(perms, {"contents": "read"}, f"{wf.name} top-level permissions drift")
                for job_name, job in (doc.get("jobs") or {}).items():
                    if "permissions" in job:
                        self.assertEqual(job["permissions"], {"contents": "read"}, f"{wf.name}:{job_name}")

    def test_o1_pull_request_target_forbidden(self):
        for wf in self.workflows:
            with self.subTest(workflow=wf.name):
                doc = yaml.safe_load(wf.read_text(encoding="utf-8"))
                on_block = doc.get("on") or doc.get(True) or {}
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
