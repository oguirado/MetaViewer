"""T7 R2c O1 Pin-Policy Regression Grid Test Suite.

Tests semantic workflow reference policy (.github/workflows/workflow_pins.py)
against pin-policy edge cases, package workflows, and compares against old regex oracle.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest

if '/usr/lib/python3/dist-packages' not in sys.path and os.path.exists('/usr/lib/python3/dist-packages'):
    sys.path.append('/usr/lib/python3/dist-packages')

ROOT = Path(__file__).resolve().parents[2]
PINS_SCRIPT = ROOT / '.github/workflows/workflow_pins.py'

spec = importlib.util.spec_from_file_location("workflow_pins", PINS_SCRIPT)
workflow_pins = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow_pins)
pin_errors = workflow_pins.pin_errors

SHA = '11bd71901bbe5b1630ceea73d27597364c9af683'


def old_f2_regex_oracle(text):
    """Old Round 1 F2 regex implementation before commit f270ca92."""
    errors = []
    for line in text.splitlines():
        match = re.search(r'^\s*-\s*uses:\s*([^\s@]+)@([^\s]+)', line)
        if match:
            ref, tag = match.group(1), match.group(2)
            if not re.fullmatch(r'[0-9a-f]{40}', tag):
                errors.append(f"unpinned: {line.strip()}")
    return errors


class WorkflowPinsRegressionGridTests(unittest.TestCase):
    def test_o1_pin_policy_regression_grid(self):
        valid_yaml = f"steps:\n - uses: actions/checkout@{SHA}\n"
        self.assertEqual(pin_errors(valid_yaml, ROOT), [])

        grid = [
            ("docker_ref", f"steps:\n - uses: docker://alpine@{SHA}\n", "unpinned action: docker://alpine@" + SHA),
            ("short_hex", f"steps:\n - uses: actions/checkout@{'a'*39}\n", "unpinned action: actions/checkout@" + 'a'*39),
            ("long_hex", f"steps:\n - uses: actions/checkout@{'a'*41}\n", "unpinned action: actions/checkout@" + 'a'*41),
            ("uppercase_hex", f"steps:\n - uses: actions/checkout@{SHA.upper()}\n", "unpinned action: actions/checkout@" + SHA.upper()),
            ("sha256_prefix", f"steps:\n - uses: actions/checkout@sha256:{SHA}\n", "unpinned action: actions/checkout@sha256:" + SHA),
            ("tag_comment", f"steps:\n - uses: actions/checkout@v4 # {SHA}\n", "unpinned action: actions/checkout@v4"),
            ("spaced_colon", f"steps:\n - uses : actions/checkout@v4\n", "unpinned action: actions/checkout@v4"),
            ("quoted_key", f'steps:\n - "uses": actions/checkout@v4\n', "unpinned action: actions/checkout@v4"),
            ("reusable_job", f"jobs:\n  call:\n    uses: owner/repo/.github/workflows/reusable.yml@v1\n", "unpinned action: owner/repo/.github/workflows/reusable.yml@v1"),
            ("yaml_alias_unpinned", f"x-ref: &ref actions/checkout@v4\nsteps:\n - uses: *ref\n", "unpinned action: actions/checkout@v4"),
            ("merge_key", f"steps:\n - <<: &base {{uses: actions/checkout@{SHA}}}\n", "YAML merge keys are not admitted"),
            ("duplicate_key", f"steps:\n - uses: actions/checkout@{SHA}\n   uses: actions/checkout@{SHA}\n", "duplicate key: uses"),
            ("non_string_uses", f"steps:\n - uses: 123\n", "uses must be a string"),
            ("expression_ref", f"steps:\n - uses: actions/checkout@${{{{ github.sha }}}}\n", "unpinned action: actions/checkout@${{ github.sha }}"),
            ("missing_local_dir", f"steps:\n - uses: ./missing-dir\n", "missing local action metadata: ./missing-dir"),
            ("path_escape_parent", f"steps:\n - uses: ../escape\n", "unpinned action: ../escape"),
            ("path_escape_abs", f"steps:\n - uses: /tmp/escape\n", "unpinned action: /tmp/escape"),
        ]

        for name, yaml_text, expected_err in grid:
            with self.subTest(grid_item=name):
                errs = pin_errors(yaml_text, ROOT)
                self.assertTrue(len(errs) > 0, f"Expected error for {name}, got {errs}")
                if expected_err:
                    self.assertTrue(any(expected_err in err for err in errs), f"{expected_err} not in {errs}")

    def test_o1_fail_on_old_oracle(self):
        """Verify that inputs missed by old regex oracle are caught by head workflow_pins.py."""
        spaced_yaml = "steps:\n - uses : actions/checkout@v4\n"
        quoted_yaml = 'steps:\n - "uses": actions/checkout@v4\n'
        docker_yaml = f"steps:\n - uses: docker://alpine@{SHA}\n"

        self.assertEqual(old_f2_regex_oracle(spaced_yaml), [])
        self.assertEqual(old_f2_regex_oracle(quoted_yaml), [])
        self.assertEqual(old_f2_regex_oracle(docker_yaml), [])

        self.assertTrue(len(pin_errors(spaced_yaml, ROOT)) > 0)
        self.assertTrue(len(pin_errors(quoted_yaml, ROOT)) > 0)
        self.assertTrue(len(pin_errors(docker_yaml, ROOT)) > 0)

    def test_o1_yaml_extension_glob(self):
        """Verify .yaml files are scanned by creating a temporary float.yaml file."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            wf_dir = tmp_root / '.github/workflows'
            wf_dir.mkdir(parents=True)
            float_yaml = wf_dir / 'float.yaml'
            float_yaml.write_text('steps:\n - uses: actions/checkout@v4\n')

            errs = pin_errors(float_yaml.read_text(), tmp_root)
            self.assertTrue(any('unpinned action: actions/checkout@v4' in e for e in errs))

    def test_o1_local_action_metadata_resolution(self):
        """Verify local action requiring action.yml or action.yaml metadata."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            action_dir = tmp_root / 'my-action'
            action_dir.mkdir()

            yaml_text = "steps:\n - uses: ./my-action\n"
            errs = pin_errors(yaml_text, tmp_root)
            self.assertIn("missing local action metadata: ./my-action", errs)

            (action_dir / 'action.yaml').write_text("name: local\nruns:\n  using: composite\n  steps: []\n")
            errs = pin_errors(yaml_text, tmp_root)
            self.assertEqual(errs, [])

    def test_o1_package_and_build_other_workflows_satisfy_policy(self):
        """Verify package.yml and build-other.yml satisfy workflow reference policy."""
        for name in ('package.yml', 'build-other.yml', 'ci.yml', 'volume.yml'):
            wf_path = ROOT / '.github/workflows' / name
            if wf_path.exists():
                errs = pin_errors(wf_path.read_text(), ROOT)
                self.assertEqual(errs, [], f"Workflow {name} has pin errors: {errs}")


if __name__ == '__main__':
    unittest.main()
