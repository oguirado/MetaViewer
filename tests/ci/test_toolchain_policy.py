"""[TARGET, unit decision] Gate hosted helper prerequisites before execution."""
from pathlib import Path
import re
import shlex
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / '.github/workflows/ci.yml'
GO_PIN = 'actions/setup-go@d35c59abb061a4a6fb18e82ac0862c26744d6ab5'
FORMATTER = 'rustup toolchain install 1.92.0 --profile minimal --component rustfmt'
USERNS = 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0'


def strip_shell_comment(line):
    quote = None
    escaped = False
    for index, char in enumerate(line):
        if escaped:
            escaped = False
        elif char == '\\' and quote != "'":
            escaped = True
        elif quote:
            if char == quote:
                quote = None
        elif char in ("'", '"'):
            quote = char
        elif char == '#' and (index == 0 or line[index - 1].isspace() or
                              line[index - 1] in ';&|()<>'):
            return line[:index]
    return line


def shell_commands(run):
    """Tokenize shell lines so quoted hashes survive and comments cannot prime caches."""
    commands = []
    heredoc = None
    for line in run.replace('\\\n', ' ').splitlines():
        if heredoc:
            if line.strip() == heredoc:
                heredoc = None
            continue
        lexer = shlex.shlex(strip_shell_comment(line), posix=True, punctuation_chars=';&|()<>')
        lexer.whitespace_split = True
        lexer.commenters = ''
        try:
            tokens = list(lexer)
        except ValueError:
            continue
        command = []
        for index, token in enumerate(tokens):
            if token == '<<' and index + 1 < len(tokens):
                heredoc = tokens[index + 1]
                break
            if token and all(char in ';&|()<>' for char in token):
                if command:
                    commands.append(command)
                command = []
            else:
                command.append(token)
        if command:
            commands.append(command)
    normalized = []
    for command in commands:
        while command:
            if (command[0] in ('then', 'do', '{', 'if', 'offline', 'env') or
                    re.match(r'^[A-Za-z_][A-Za-z_0-9]*=', command[0])):
                command = command[1:]
            elif command[:2] == ['set', '--']:
                command = command[2:]
            elif command[0] == 'timeout' and len(command) > 2:
                command = command[2:]
            elif command[:2] == ['rustup', 'run'] and len(command) > 3:
                command = command[3:]
            elif command[0] == 'xvfb-run':
                command = command[1:]
                while command and command[0].startswith('-'):
                    command = command[2:] if command[0] == '-s' else command[1:]
            elif (command[0] == 'bash' and len(command) > 2 and
                  command[1].endswith('.github/workflows/offline.sh')):
                # Keep the wrapper visible to the namespace readiness check too.
                normalized.append(command[:2])
                command = command[2:]
            else:
                break
        if command:
            normalized.append(command)
    return normalized


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
            commands = shell_commands(step.get('run') or '')
            run = '\n'.join(' '.join(command) for command in commands)
            # Root tests exercise the aggregate gate and its Rust/Go helpers;
            # E2E and cargo tests also compile the adapter helper indirectly.
            root_suite = bool(re.search(r'^python3 -m unittest discover -s tests -v(?: |$)', run, re.M))
            gate_rust = bool(re.search(r'^(?:bash\s+)?tools/gate\.sh(?:\s|$)', run, re.M)) and (
                '--leg' not in run or '--leg rust' in run)
            gate_go = bool(re.search(r'^(?:bash\s+)?tools/gate\.sh --leg go(?: |$)', run, re.M))
            package = bool(re.search(r'^python3 tests/ci/test_package_identity\.py .*--build(?: |$)', run, re.M))
            helper = package or gate_go or root_suite or gate_rust or bool(re.search(
                r'^cargo (?:test|clippy)|^node --test .*tests/e2e|^python3 tests/e2e/run\.py', run, re.M))
            direct_go = bool(re.search(r'^go (?:build|test|vet)\b', run, re.M))
            if (helper or direct_go) and not go_ready:
                errors.append(f'{job}: Go consumer before pinned setup')
            priming = step.get('name') == 'Prime Go module and build caches'
            if (helper or (direct_go and not priming)) and not (modules and builds):
                errors.append(f'{job}: Go helper before cache priming')
            if (root_suite or gate_rust or re.search(r'^cargo fmt(?: |$)', run, re.M)) and not formatter:
                errors.append(f'{job}: Rust gate before pinned formatter')
            for command in commands:
                if command == shlex.split(USERNS) and not step.get('if'):
                    userns = True
                if any(token.endswith('.github/workflows/offline.sh') for token in command) and not userns:
                    errors.append(f'{job}: offline namespace before userns setup')
            if not step.get('if'):
                formatter |= shlex.split(FORMATTER) in commands
                # Cache priming must run online for download only, then lock Go build/test offline.
                if (step.get('working-directory') == 'daemon-adapter' and
                        step.get('env', {}).get('GOTOOLCHAIN') == 'local' and
                        'offline.sh' not in run and go_ready):
                    modules |= ['go', 'mod', 'download'] in commands
                    exports = {}
                    for command in commands:
                        if command[0] == 'export':
                            exports.update(token.split('=', 1) for token in command[1:] if '=' in token)
                        if command == ['go', 'build', './...']:
                            builds |= all(exports.get(key) == value for key, value in (
                                ('GOPROXY', 'off'), ('GOSUMDB', 'off'), ('GOFLAGS', '-mod=readonly')))
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
                ('GOPROXY=off', 'GOPROXY=https://proxy.golang.org'),
                ('GOSUMDB=off', 'GOSUMDB=sum.golang.org'),
                ('GOFLAGS=-mod=readonly', 'GOFLAGS=-mod=mod'),
                ('GOTOOLCHAIN: local', 'GOTOOLCHAIN: auto'),
                (USERNS, 'true # namespace preparation omitted'),
            ):
                with self.subTest(job=job, mutation=before):
                    changed = block.replace(before, after)
                    self.assertNotEqual(changed, block)
                    mutant = yaml.safe_dump({'jobs': yaml.safe_load(changed)})
                    self.assertTrue(policy_errors(mutant))
        for job in ('laws-contracts', 'rust'):
            pattern = r'(?ms)^  ' + job + r':\n.*?(?=^  [\w-]+:\n|\Z)'
            for replacement in ('echo formatter omitted', FORMATTER.replace('1.92.0', '1.97.0'),
                                FORMATTER.replace(' --component rustfmt', '')):
                block = re.search(pattern, original)[0].replace(FORMATTER, replacement)
                mutant = yaml.safe_dump({'jobs': yaml.safe_load(block)})
                self.assertTrue(policy_errors(mutant), (job, replacement))

    def test_new_consumers_require_setup(self):
        for command in ('go build ./...', 'go test ./...', 'cargo test --offline',
                        'node --test tests/e2e/*.test.js',
                        'bash tools/gate.sh --leg rust', 'bash tools/gate.sh',
                        'bash tools/gate.sh --leg go',
                        'python3 tests/ci/test_package_identity.py --build'):
            with self.subTest(command=command):
                text = yaml.safe_dump({'jobs': {'new-job': {'steps': [{'run': command}]}}})
                self.assertTrue(policy_errors(text))

    def test_comments_and_quoted_arguments_are_not_commands(self):
        for command in ('# go build ./...', '# bash tools/gate.sh --leg go',
                        'echo "go build ./... # quoted hash"',
                        'echo "https://example.invalid/#fragment"'):
            text = yaml.safe_dump({'jobs': {'fixture': {'steps': [{'run': command}]}}})
            self.assertEqual(policy_errors(text), [], command)
        self.assertEqual(shell_commands('echo "a#b" # trailing comment'), [['echo', 'a#b']])
        self.assertEqual(shell_commands('echo https://example.invalid/#fragment'),
                         [['echo', 'https://example.invalid/#fragment']])
        # Use a valid job to prove each comment mutation independently removes readiness.
        job = yaml.safe_load(CI.read_text())['jobs']['laws-contracts']
        self.assertEqual(policy_errors(yaml.safe_dump({'jobs': {'fixture': job}})), [])
        for setup in (FORMATTER, USERNS, 'go mod download', 'go build ./...'):
            changed = yaml.safe_dump({'jobs': {'fixture': job}})
            doc = yaml.safe_load(changed)
            for step in doc['jobs']['fixture']['steps']:
                if 'run' in step:
                    step['run'] = step['run'].replace(setup, '# ' + setup)
            self.assertTrue(policy_errors(yaml.safe_dump(doc)), setup)

    def test_preparation_must_precede_consumers(self):
        for job in ('laws-contracts', 'rust', 'go', 'e2e'):
            body = yaml.safe_load(CI.read_text())['jobs'][job]
            mutant = {'jobs': {job: body}}
            self.assertEqual(policy_errors(yaml.safe_dump(mutant)), [])
            steps = body['steps']
            setup = next(step for step in steps if step.get('uses') == GO_PIN)
            steps.remove(setup)
            steps.append(setup)
            self.assertTrue(policy_errors(yaml.safe_dump(mutant)))
        self.assertIn(GO_PIN, (ROOT / '.github/workflows/volume.yml').read_text())


if __name__ == '__main__':
    unittest.main()
