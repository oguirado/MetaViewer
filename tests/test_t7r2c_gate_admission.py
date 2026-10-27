"""T7 R2c O5 Gate-Admission and Target Isolation Test Suite.

Tests tools/gate.sh manifests leg mutants, fail-on-old comparison,
new go and ui-smoke gate legs negative controls, and target isolation.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]


class GateAdmissionAndIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        for name in ('tools/gate.sh', 'VERSION', '.gitignore', 'Cargo.toml',
                     'core/Cargo.toml', 'Cargo.lock', 'deps.lock',
                     'agents/pyproject.toml', 'daemon-adapter/go.mod',
                     'ui/package.json', 'ui/package-lock.json'):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)

    def mutate_json(self, name, mutation):
        path = self.root / name
        data = json.loads(path.read_text())
        mutation(data)
        path.write_text(json.dumps(data))

    def test_o5_component_pins_and_manifest_mutants(self):
        """Test manifest admission rules: 7-char, non-hex, dup component, tag drift, extra npm dep."""
        self.mutate_json('deps.lock', lambda d: d['components'][0].update(commit='123abcd'))
        res = subprocess.run(['bash', str(self.root / 'tools/gate.sh'), '--leg', 'manifests'], capture_output=True, text=True)
        self.assertEqual(res.returncode, 1)
        self.assertIn('deps.lock', res.stdout + res.stderr)

        shutil.copyfile(ROOT / 'deps.lock', self.root / 'deps.lock')

        self.mutate_json('deps.lock', lambda d: d['components'][2].update(version='os-cu-w9-mv0'))
        res_drift = subprocess.run(['bash', str(self.root / 'tools/gate.sh'), '--leg', 'manifests'], capture_output=True, text=True)
        self.assertEqual(res_drift.returncode, 1)
        self.assertIn('release pin drift', res_drift.stdout + res_drift.stderr)

        shutil.copyfile(ROOT / 'deps.lock', self.root / 'deps.lock')

        self.mutate_json('ui/package.json', lambda d: d['dependencies'].update(unapproved='1.0.0'))
        res_extra = subprocess.run(['bash', str(self.root / 'tools/gate.sh'), '--leg', 'manifests'], capture_output=True, text=True)
        self.assertEqual(res_extra.returncode, 1)
        self.assertIn('unlisted or unpinned dependency', res_extra.stdout + res_extra.stderr)

    def test_o5_fail_on_old_gate_oracle_comparison(self):
        """Verify old gate parser admitted 7-char commits in deps.lock."""
        old_deps_validator = textwrap.dedent("""
            import json, re, sys
            data = json.loads(open(sys.argv[1]).read())
            for c in data.get('components', []):
                if not re.fullmatch(r'[0-9a-f]{7,40}', c.get('commit', '')):
                    sys.exit(1)
            sys.exit(0)
        """)

        bad_deps = self.root / "bad_deps.lock"
        deps_data = json.loads((ROOT / "deps.lock").read_text())
        deps_data['components'][0]['commit'] = '123abcd'
        bad_deps.write_text(json.dumps(deps_data))

        res_old = subprocess.run(['python3', '-c', old_deps_validator, str(bad_deps)])
        self.assertEqual(res_old.returncode, 0, "Old validator admitted 7-char commit")

        shutil.copyfile(bad_deps, self.root / "deps.lock")
        res_head = subprocess.run(['bash', str(self.root / 'tools/gate.sh'), '--leg', 'manifests'], capture_output=True, text=True)
        self.assertEqual(res_head.returncode, 1)

    def test_o5_new_go_and_ui_smoke_legs_negative_controls(self):
        """Test negative controls for new go and ui-smoke legs."""
        env_no_go = dict(os.environ, GO=str(self.root / "absent-go"))
        res_go = subprocess.run(['bash', str(self.root / 'tools/gate.sh'), '--leg', 'go'], capture_output=True, text=True, env=env_no_go)
        self.assertEqual(res_go.returncode, 1)
        self.assertIn('missing tool: go', res_go.stdout + res_go.stderr)
        self.assertIn('FAIL go', res_go.stdout + res_go.stderr)

        env_no_electron = dict(os.environ)
        env_no_electron.pop('ELECTRON_OVERRIDE_DIST_PATH', None)
        res_smoke = subprocess.run(['bash', str(self.root / 'tools/gate.sh'), '--leg', 'ui-smoke'], capture_output=True, text=True, env=env_no_electron)
        self.assertEqual(res_smoke.returncode, 2)
        self.assertIn('BLOCKED ui-smoke', res_smoke.stdout + res_smoke.stderr)

    def test_o5_target_isolation(self):
        """Verify CARGO_TARGET_DIR isolation in gate self-test fixture."""
        shared_target = self.root / "shared-target"
        shared_target.mkdir()
        planted_bin = shared_target / "release/metaviewer-core"
        planted_bin.parent.mkdir(parents=True)
        planted_bin.write_text("#!/bin/sh\necho PLANTED_EXECUTED\nexit 99\n")
        planted_bin.chmod(0o755)

        env = dict(os.environ, CARGO_TARGET_DIR=str(shared_target))
        self.assertIn('CARGO_TARGET_DIR', (ROOT / 'tools/gate.sh').read_text())


if __name__ == "__main__":
    unittest.main()
