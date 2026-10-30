"""[TARGET, unit decision] Hosted owner tests consume the assembly Wender pin."""
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import unittest

from tests.ci.test_ci_counts import _load_workflow_doc
from tools.assembly_smoke import parse_deps_lock

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / '.github/workflows/ci.yml'
ASSEMBLY = ROOT / '.github/workflows/assembly.yml'


def steps(text):
    items = _load_workflow_doc(text)['jobs']['python']['steps']
    # The existing stdlib workflow reader exposes run/env but not action inputs.
    for item in items:
        if item.get('name') == 'Checkout wender-agent at pinned commit':
            block = text.split('      - name: ' + item['name'] + '\n', 1)[1].split('      - ', 1)[0]
            item['with'] = dict(re.findall(r'^          ([\w-]+): (.+)$', block, re.M))
    return items


def validate_wender(text):
    items = steps(text)
    named = {s.get('name'): s for s in items}
    checkout = named['Checkout wender-agent at pinned commit']
    expected = {
        'repository': '${{ steps.pins.outputs.wender_agent_repo }}',
        'ref': '${{ steps.pins.outputs.wender_agent_commit }}',
        'token': '${{ secrets.ASSEMBLY_READ_TOKEN }}',
        'path': '_deps/wender-agent',
        'persist-credentials': 'false',
    }
    assert checkout['with'] == expected, 'checkout must consume assembly lock outputs'
    assert checkout['uses'] == 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683'
    pins = next(s for s in items if s.get('id') == 'pins')
    assert '--lock deps.lock' in pins['run'] and '--print-pins' in pins['run']
    assert '--github-output "${GITHUB_OUTPUT}"' in pins['run']
    access = named['Require Wender access']
    assert access['env']['ASSEMBLY_READ_TOKEN'] == '${{ secrets.ASSEMBLY_READ_TOKEN }}'
    verify = named['Verify Wender HEAD matches deps.lock']
    assert verify['env']['PIN_WENDER_AGENT'] == '${{ steps.pins.outputs.wender_agent_commit }}'
    suite = named['Run Python agent gates']
    assert suite['env'].get('MV_MW_WENDER_ROOT') == '${{ github.workspace }}/_deps/wender-agent', 'missing owner root export'
    assert 'MV_WENDER_ROOT' not in text, 'legacy planner root must remain unset'
    order = [items.index(s) for s in (access, pins, checkout, verify, suite)]
    assert order == sorted(order)
    assert all('if' not in s and not s.get('continue-on-error') for s in (access, pins, checkout, verify, suite))


class WenderAgentsWorkflowTests(unittest.TestCase):
    def test_pinned_checkout_and_scoped_export_with_mutations(self):
        text = CI.read_text()
        validate_wender(text)
        for old, new in (
            ('          MV_MW_WENDER_ROOT: ${{ github.workspace }}/_deps/wender-agent\n', ''),
            ('ref: ${{ steps.pins.outputs.wender_agent_commit }}', 'ref: main'),
            ('--lock deps.lock', '--lock other.lock'),
            ('MV_MW_WENDER_ROOT:', 'MV_WENDER_ROOT:'),
            ('path: _deps/wender-agent', 'path: _deps/other'),
        ):
            with self.subTest(mutation=old), self.assertRaises(AssertionError):
                validate_wender(text.replace(old, new))

    def test_pin_parser_matches_assembly_and_lock(self):
        workflow = steps(CI.read_text())
        pins = next(s for s in workflow if s.get('id') == 'pins')
        assembly = _load_workflow_doc(ASSEMBLY.read_text())
        assembly_pins = next(s for s in assembly['jobs']['pinned-assembly']['steps'] if s.get('id') == 'pins')
        self.assertEqual(pins['run'], assembly_pins['run'])
        with tempfile.TemporaryDirectory() as td:
            output = Path(td) / 'outputs'
            result = subprocess.run(['bash', '-c', pins['run']], cwd=ROOT,
                                    env=dict(os.environ, GITHUB_OUTPUT=str(output)),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            values = dict(line.split('=', 1) for line in output.read_text().splitlines())
            pin = parse_deps_lock(ROOT / 'deps.lock')['wender-agent']
            self.assertEqual(values['wender_agent_repo'], pin.repo)
            self.assertEqual(values['wender_agent_commit'], pin.commit)

    def test_missing_token_emits_blocked_receipt(self):
        script = next(s['run'] for s in steps(CI.read_text()) if s.get('name') == 'Require Wender access')
        with tempfile.TemporaryDirectory(prefix='wender Música ') as td:
            root = Path(td)
            env = dict(os.environ, RUNNER_TEMP=td, JOB_ID='python', PLATFORM='x64',
                       GITHUB_RUN_ID='fixture', GITHUB_SHA='fixture',
                       GITHUB_STEP_SUMMARY=str(root / 'summary'), ASSEMBLY_READ_TOKEN='')
            result = subprocess.run(['bash', '-c', script], cwd=ROOT, env=env,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            receipt = json.loads((root / 'metaviewer-ci/python/x64/python-agents.receipt.json').read_text())
            self.assertEqual(receipt['outcome'], 'BLOCKED')
            self.assertIsNone(receipt['rc'])
            self.assertIn('ASSEMBLY_READ_TOKEN_MISSING', receipt['reason'])
            self.assertIsNone(receipt['counts']['passed'])
            # Nonempty synthetic token passes without disclosing it or emitting a receipt.
            env['ASSEMBLY_READ_TOKEN'] = 'private-fixture-value'
            result = subprocess.run(['bash', '-c', script], cwd=ROOT, env=env,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn(env['ASSEMBLY_READ_TOKEN'], result.stdout + result.stderr)

    def test_head_verifier_rejects_mismatch(self):
        script = next(s['run'] for s in steps(CI.read_text()) if s.get('name') == 'Verify Wender HEAD matches deps.lock')
        pin = parse_deps_lock(ROOT / 'deps.lock')['wender-agent'].commit
        with tempfile.TemporaryDirectory(prefix='wender Música ') as td:
            binary = Path(td) / 'git'
            binary.write_text('#!/bin/sh\n[ "$*" = "-C _deps/wender-agent rev-parse HEAD" ] || exit 2\nprintf "%s\\n" "$FIXTURE_HEAD"\n')
            binary.chmod(0o700)
            for actual, expected_rc in ((pin, 0), ('0' * len(pin), 1)):
                env = dict(os.environ, PATH=td + os.pathsep + os.environ['PATH'],
                           PIN_WENDER_AGENT=pin, FIXTURE_HEAD=actual)
                result = subprocess.run(['bash', '-c', script], cwd=td, env=env,
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, expected_rc, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
