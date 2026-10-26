"""Execute both workflow staging snippets against local provenance fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('kit_fixture', ROOT / 'tests/test_kit_source.py')
kit_fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kit_fixture)


class KitStageTests(unittest.TestCase):
    def setUp(self):
        kit_fixture.KitTests.setUp(self)
        self.repo.rename(self.root / 'kit-checkout')
        self.repo = self.root / 'kit-checkout'
        (self.root / 'ui').mkdir()
        self.pin.rename(self.root / 'ui/kit.lock.json')
        self.pin = self.root / 'ui/kit.lock.json'
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        self.stages = [textwrap.dedent(body) for body in re.findall(
            r'      - name: Stage pinned kit checkout\n        run: \|\n'
            r'((?:          .*\n|\n)+)', workflow)]
        self.assertEqual(len(self.stages), 2, 'must exercise js and e2e staging')

    def stage(self, body):
        return subprocess.run(['bash', '-c', body], cwd=self.root, text=True,
                              capture_output=True, timeout=20,
                              env=dict(os.environ, GITHUB_WORKSPACE=str(self.root),
                                       GITHUB_ENV=str(self.root / 'github-env')))

    def sync(self, check=False):
        return kit_fixture.KitTests.invoke(self, check)

    def origin(self):
        return subprocess.check_output(['git', '-C', str(self.repo), 'remote',
                                        'get-url', 'origin'], text=True).strip()

    def test_wrong_lock_repo_rejected_without_rewriting_origin(self):
        pin = json.loads(self.pin.read_text())
        pin['repo'] = 'https://example.invalid/wrong.git'
        self.pin.write_text(json.dumps(pin))
        original = self.origin()
        for body in self.stages:
            with self.subTest(stage=body):
                result = self.stage(body)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('Kit repository mismatch', result.stderr)
                self.assertEqual(self.origin(), original)
                result = self.sync()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Kit repository/commit mismatch', result.stderr)
                self.assertFalse(self.dest.exists())

    def test_unmodified_lock_passes_stage_sync_and_check(self):
        for body in self.stages:
            with self.subTest(stage=body):
                result = self.stage(body)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.sync().returncode, 0)
                self.assertEqual(self.sync(True).returncode, 0)

    def test_checkout_url_without_git_suffix_passes_sync(self):
        for body in self.stages:
            subprocess.run(['git', '-C', str(self.repo), 'remote', 'set-url',
                            'origin', 'https://example.invalid/kit'], check=True)
            result = self.stage(body)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.sync().returncode, 0)
            self.assertEqual(self.sync(True).returncode, 0)

    def test_fork_origin_rejected_even_with_same_head(self):
        subprocess.run(['git', '-C', str(self.repo), 'remote', 'set-url',
                        'origin', 'https://example.invalid/fork.git'], check=True)
        for body in self.stages:
            result = self.stage(body)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Kit repository mismatch', result.stderr)
            self.assertEqual(self.origin(), 'https://example.invalid/fork.git')
            self.assertNotEqual(self.sync().returncode, 0)

    def test_wrong_head_still_rejected_by_sync(self):
        pin = json.loads(self.pin.read_text())
        pin['commit'] = '0' * 40
        self.pin.write_text(json.dumps(pin))
        for body in self.stages:
            result = self.stage(body)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = self.sync()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Kit repository/commit mismatch', result.stderr)
            self.assertFalse(self.dest.exists())


if __name__ == '__main__':
    unittest.main()
