"""[TARGET, unit decision] Regressions for hosted dependency provisioning."""
from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]


def policy_errors(text, secrets):
    jobs = yaml.safe_load(text)['jobs']
    steps = jobs['laws-contracts']['steps']
    reference = next(step['run'] for step in yaml.safe_load(secrets)['jobs']['secrets']['steps']
                     if step.get('name', '').startswith('Download pinned gitleaks'))
    provision = next((i for i, step in enumerate(steps)
                      if reference in step.get('run', '') and
                      'echo "GITLEAKS_BIN=$RUNNER_TEMP/gitleaks" >> "$GITHUB_ENV"'
                      in step['run'] and not step.get('if')), None)
    consumers = [i for i, step in enumerate(steps)
                 if 'unittest discover -s tests -v' in step.get('run', '')]
    errors = []
    if provision is None or not consumers or provision >= min(consumers):
        errors.append('laws: checksum-verified secrets pin must precede root tests')
    install = next(step['run'] for step in jobs['e2e']['steps']
                   if step.get('name') == 'Install E2E dependencies')
    required = [
        'npm ci --offline --ignore-scripts --no-audit --no-fund',
        "require('./node_modules/node-pty/package.json').version, '1.1.0'",
        'offline.sh" npm --prefix node_modules/node-pty run install',
        'offline.sh" npm --prefix node_modules/node-pty run postinstall',
        'offline.sh" node -e "require(\'node-pty\')"',
    ]
    positions = [install.find(value) for value in required]
    if min(positions) < 0 or positions != sorted(positions) or 'set -euo pipefail' not in install:
        errors.append('e2e: explicit pinned native build and load must follow frozen install')
    return errors


class HostedRun3PolicyTests(unittest.TestCase):
    def setUp(self):
        self.ci = (ROOT / '.github/workflows/ci.yml').read_text()
        self.secrets = (ROOT / '.github/workflows/secrets.yml').read_text()

    def test_workflow(self):
        self.assertEqual(policy_errors(self.ci, self.secrets), [])

    def test_failure_excerpt_uses_sanitized_log_and_includes_earlier_failures(self):
        e2e = self.ci.split('  e2e:\n', 1)[1].split('  novac:\n', 1)[0]
        self.assertIn("grep -n -A 20 -E '^[[:space:]]*✖|^not ok' \"$sane\" | head -n 160", e2e)

    def test_negative_controls(self):
        for before, after in [
            ('ba6dbb656933921c775ee5a2d1c13a91046e7952e9d919f9bac4cec61d628e7d', '0' * 64),
            ('echo "GITLEAKS_BIN=$RUNNER_TEMP/gitleaks" >> "$GITHUB_ENV"', 'true'),
            ('npm --prefix node_modules/node-pty run install', 'true'),
            ('npm --prefix node_modules/node-pty run postinstall', 'true'),
            ("require('./node_modules/node-pty/package.json').version, '1.1.0'", 'true'),
            ('offline.sh" node -e "require(\'node-pty\')"', 'offline.sh" true'),
        ]:
            with self.subTest(mutation=before):
                self.assertIn(before, self.ci)
                self.assertTrue(policy_errors(self.ci.replace(before, after), self.secrets))
