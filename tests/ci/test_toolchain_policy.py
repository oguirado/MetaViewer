"""[TARGET, unit decision] Gate hosted helper prerequisites before execution."""
from pathlib import Path
import re
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / '.github/workflows/ci.yml'
GO_PIN = 'actions/setup-go@d35c59abb061a4a6fb18e82ac0862c26744d6ab5'
FORMATTER = 'rustup toolchain install 1.92.0 --profile minimal --component rustfmt'
USERNS = 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0'


def policy_errors(text):
    errors = []
    for job, body in yaml.safe_load(text)['jobs'].items():
        go_ready = modules = builds = formatter = userns = False
        for step in body.get('steps', []):
            uses = step.get('uses', '')
            if uses.startswith('actions/setup-go@'):
                go_ready = (uses == GO_PIN and
                            step.get('with', {}).get('go-version-file') ==
                            'daemon-adapter/go.mod' and not step.get('if'))
                if not go_ready:
                    errors.append(f'{job}: invalid Go setup')
            run = step.get('run', '')
            # Root tests exercise the aggregate gate and its Rust/Go helpers;
            # E2E and cargo tests also compile the adapter helper indirectly.
            root_suite = 'unittest discover -s tests -v' in run
            gate_rust = bool(re.search(r'(?:bash\s+)?tools/gate\.sh(?:\s|$)', run)) and (
                '--leg' not in run or '--leg rust' in run)
            helper = root_suite or gate_rust or bool(re.search(
                r'cargo (?:test|clippy)|node --test .*tests/e2e|python3 tests/e2e/run\.py', run))
            direct_go = bool(re.search(r'\bgo (?:build|test|vet)\b', run))
            if (helper or direct_go) and not go_ready:
                errors.append(f'{job}: Go consumer before pinned setup')
            priming = step.get('name') == 'Prime Go module and build caches'
            if (helper or (direct_go and not priming)) and not (modules and builds):
                errors.append(f'{job}: Go helper before cache priming')
            if (root_suite or gate_rust or 'cargo fmt' in run) and not formatter:
                errors.append(f'{job}: Rust gate before pinned formatter')
            for line in run.splitlines():
                if USERNS in line and not step.get('if'):
                    userns = True
                if '.github/workflows/offline.sh' in line and not userns:
                    errors.append(f'{job}: offline namespace before userns setup')
            if not step.get('if'):
                formatter |= FORMATTER in run
                # Cache priming must run online with automatic toolchain fetches off.
                if (step.get('working-directory') == 'daemon-adapter' and
                        step.get('env', {}).get('GOTOOLCHAIN') == 'local' and
                        'offline.sh' not in run and go_ready):
                    modules |= 'go mod download' in run
                    builds |= 'go build ./...' in run
    return errors


class ToolchainPolicyTests(unittest.TestCase):
    def test_workflow(self):
        self.assertEqual(policy_errors(CI.read_text()), [])

    def test_negative_controls(self):
        original = CI.read_text()
        for job in ('laws-contracts', 'rust', 'go', 'e2e'):
            pattern = r'(?ms)^  ' + job + r':\n.*?(?=^  [\w-]+:\n|\Z)'
            block = re.search(pattern, original)[0]
            for before, after in (
                (GO_PIN, 'actions/setup-go@' + '0' * 40),
                ('go-version-file: daemon-adapter/go.mod', 'go-version: "1.24"'),
                ('go mod download', 'true # module cache omitted'),
                ('go build ./...', 'true # build cache omitted'),
                ('GOTOOLCHAIN: local', 'GOTOOLCHAIN: auto'),
                (USERNS, 'true # namespace preparation omitted'),
            ):
                with self.subTest(job=job, mutation=before):
                    changed = block.replace(before, after)
                    self.assertNotEqual(changed, block)
                    mutant = re.sub(pattern, lambda _: changed, original)
                    self.assertTrue(policy_errors(mutant))
        for job in ('laws-contracts', 'rust'):
            pattern = r'(?ms)^  ' + job + r':\n.*?(?=^  [\w-]+:\n|\Z)'
            for replacement in ('echo formatter omitted', FORMATTER.replace('1.92.0', '1.97.0'),
                                FORMATTER.replace(' --component rustfmt', '')):
                mutant = re.sub(pattern, lambda m: m[0].replace(FORMATTER, replacement), original)
                self.assertTrue(policy_errors(mutant), (job, replacement))

    def test_new_consumers_require_setup(self):
        for command in ('go build ./...', 'go test ./...', 'cargo test --offline',
                        'node --test tests/e2e/*.test.js',
                        'bash tools/gate.sh --leg rust', 'bash tools/gate.sh'):
            with self.subTest(command=command):
                text = yaml.safe_dump({'jobs': {'new-job': {'steps': [{'run': command}]}}})
                self.assertTrue(policy_errors(text))

    def test_preparation_must_precede_consumers(self):
        for job in ('laws-contracts', 'rust', 'go', 'e2e'):
            mutant = yaml.safe_load(CI.read_text())
            steps = mutant['jobs'][job]['steps']
            setup = next(step for step in steps if step.get('uses') == GO_PIN)
            steps.remove(setup)
            steps.append(setup)
            self.assertTrue(policy_errors(yaml.safe_dump(mutant)))
        self.assertIn(GO_PIN, (ROOT / '.github/workflows/volume.yml').read_text())


if __name__ == '__main__':
    unittest.main()
