"""Offline regressions for the published judge instructions; no live input."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agents'))
from metaviewer_agents import mvctl, mw_run


def doc(name):
    return (ROOT / name).read_text(encoding='utf-8')


def registration(component):
    return {'endpoint': {'component': component, 'instance': component + '-1'},
            'hello': {'component': component, 'dependencies': []}}


class JudgeInstructionsTests(unittest.TestCase):
    def test_b3_03_attachment_list_example_uses_actual_bindings(self):
        guide = doc('docs/AI_OPERATOR_GUIDE.md')
        section = guide.split('## 11.')[1].split('## 12.')[0]
        self.assertIn('metaviewer.attach/v1', section)
        self.assertNotRegex(section, r'MV_ATTACH_|capsule\.(list|act)|schema_version')
        snippet = re.search(r"python3 - <<'PY'\n(.*?)\nPY", section, re.S).group(1)
        # Source the published exports before running the documented Python.
        with tempfile.TemporaryDirectory(prefix='v027-j2-Música-') as directory:
            base = Path(directory)
            config = {'session_id': 'sess-1', 'core': registration('core'),
                      'peers': [registration('agent')]}
            path = base / 'core.json'
            path.write_text(json.dumps(config), encoding='utf-8')
            node = shutil.which('node')
            self.assertIsNotNone(node, 'Node is required for the attachment producer fixture')
            producer = subprocess.run([node, '--input-type=module', '-e',
                'import {buildAttachRecord, renderAttachEnv} from ' +
                json.dumps((ROOT / 'ui/tools/package.js').as_uri()) + ';' +
                'console.log(renderAttachEnv(buildAttachRecord(' + json.dumps({
                    'sessionId': 'pkg-12345678-1234-1234-1234-123456789abc',
                    'pid': os.getpid(), 'runtime': directory, 'configPath': str(path), 'env': {}}) + ')));'],
                capture_output=True, text=True, check=True)
            # Source exports verbatim: do not emulate POSIX quoting in Python.
            sourced = subprocess.run(['bash', '-c', producer.stdout +
                '\nexec ' + shlex.quote(sys.executable) + ' -c ' +
                shlex.quote('import json,os; print(json.dumps(dict(os.environ)))')],
                capture_output=True, text=True, check=True)
            env = json.loads(sourced.stdout)
            with patch.dict(os.environ, env, clear=True), \
                    patch('metaviewer_agents.client.ToolClient') as transport, \
                    patch('metaviewer_agents.tools.list_surfaces', return_value={}) as listing, \
                    redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as done:
                    exec(snippet, {})
                self.assertEqual(done.exception.code, 0)
                transport.assert_called_once()
                listing.assert_called_once()
                self.assertEqual(transport.call_args.args[0], str(base / 'metaviewer/core.sock'))
            with patch.dict(os.environ, {}, clear=True), self.assertRaises(KeyError):
                exec(snippet, {})
            config['peers'].append(registration('agent'))
            path.write_text(json.dumps(config), encoding='utf-8')
            with patch.dict(os.environ, env, clear=True), \
                    patch('metaviewer_agents.client.ToolClient') as transport, \
                    self.assertRaises(SystemExit):
                exec(snippet, {})
            transport.assert_not_called()
        clipboard = guide.split('## 8.')[1].split('## 9.')[0]
        self.assertIn('MetaViewer capsule', clipboard)
        self.assertNotIn('capsule_id=<uuid>', clipboard)

    def test_b3_07_identity_commands_share_attachment_store(self):
        section = doc('docs/AI_OPERATOR_GUIDE.md').split('### From the CLI')[1].split('## 11.')[0]
        self.assertIn('MV_SRF_BIN_DIR', section)
        self.assertIn('. "$METAVIEWER_ATTACH"', section)
        commands = re.findall(r'python3 tools/mv_identity.py .*?(?=\n\n|\n```)', section, re.S)
        self.assertEqual(len(commands), 3)
        from tools import mv_identity
        with tempfile.TemporaryDirectory(prefix='v027-j2-') as directory:
            env = {'SRF_IDENTITY_STORE_ROOT': directory + '/store',
                   'MV_MW_HOME': directory + '/home', 'MV_SRF_BIN_DIR': directory + '/bin'}
            with patch.dict(os.environ, env, clear=True):
                for command in commands:
                    args = [os.path.expandvars(x) for x in shlex.split(command.replace('\\\n', ' '))[2:]]
                    with patch.object(mv_identity, 'Identities') as identities, redirect_stdout(io.StringIO()):
                        identities.return_value.list.return_value = {}
                        identities.return_value.create.return_value = {}
                        identities.return_value.status.return_value = {}
                        identities.return_value.profile_state.return_value = 'ok'
                        self.assertEqual(mv_identity.main(args), 0)
                    self.assertEqual(identities.call_args.args[:3],
                                     (env['SRF_IDENTITY_STORE_ROOT'], env['MV_MW_HOME'], env['MV_SRF_BIN_DIR']))

    def test_b3_11_goal_docs_admit_compiled_keep_stored_restriction(self):
        for name in ('docs/JUDGE_TOUR.md', 'docs/JUDGE_QUICKSTART.md',
                     'docs/AI_OPERATOR_GUIDE.md', 'tools/mw_run_browser_goal.md'):
            with self.subTest(name=name):
                text = doc(name)
                self.assertNotRegex(text, r'Until (?:a |the )?compiled browser|wait for (?:that|a compatible|the compiled) build')
                self.assertIn('compiled', text)
                self.assertIn('browser goals', text)
        for name in ('docs/JUDGE_QUICKSTART.md', 'docs/AI_OPERATOR_GUIDE.md', 'tools/mw_run_browser_goal.md'):
            self.assertIn('MW_COMPILED_WORKFLOW_UNAVAILABLE', doc(name))
        self.assertIn('compiled_wender_ok = True', doc('tools/mw_run_browser_goal.py'))

    def test_b3_12_program_docs_text_key_and_uncertified_outcomes(self):
        for name in ('docs/AI_OPERATOR_GUIDE.md', 'tools/mw_run_program.md'):
            text = doc(name)
            with self.subTest(name=name):
                self.assertNotRegex(text, r'programs do not accept text|programs accept no text|Programs admit clicks only|Program and Host program runs admit clicks only|`--text` and `--key` refuse')
                self.assertIn('| `PROGRAM_TEXT_UNCERTIFIED_NOT_READABLE` / `0`', text)
                for outcome in ('exact', 'mismatch', 'not_readable'):
                    self.assertIn(outcome, text)
        for extra, expected in ((['--text', 'sample'], 0), (['--key', 'Enter'], 2)):
            calls = []
            with redirect_stderr(io.StringIO()):
                try:
                    mw_run.main(['--surface-kind', 'program', '--identity', 'editor',
                                 '--goal', 'focused', '--steps', '1', *extra],
                                runner=lambda args: calls.append(args))
                    code = 0
                except SystemExit as error:
                    code = error.code
            self.assertEqual(code, expected)
            self.assertEqual(bool(calls), expected == 0)

    def test_b3_13_manifest_commands_from_documented_directory(self):
        section = doc('docs/JUDGE_QUICKSTART.md').split('You can also verify')[1].split('## 2.')[0]
        command = re.search(r'```(?:bash|text)\n(.*?)\n```', section, re.S).group(1)
        with tempfile.TemporaryDirectory(prefix='v027-j2-') as directory:
            base = Path(directory)
            bundle = base / 'MetaViewer-linux-x64'
            bundle.mkdir()
            member = bundle / 'app'
            member.write_text('sealed', encoding='utf-8')
            import hashlib
            (base / 'MetaViewer-linux-x64.sha256').write_text(
                hashlib.sha256(member.read_bytes()).hexdigest() + '  app\n', encoding='utf-8')
            for modified in (False, True):
                if modified:
                    member.write_text('changed', encoding='utf-8')
                result = subprocess.run(['bash', '-e', '-c', command.replace('<arch>', 'x64')],
                                        cwd=base, capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, not modified, result.stderr)

    def test_b3_14_first_minute_preserves_capsule_tier(self):
        intro = doc('README.md').split('I build MetaViewer')[0]
        for command in ('doctor --before-install --capsules', 'install --capsules', 'doctor --capsules'):
            self.assertIn('bash scripts/judge/metaviewer-judge.sh ' + command, intro)

    def test_b3_15_documented_inventory_and_images(self):
        for name in ('README.md', 'docs/USER_GUIDE.md'):
            text = doc(name)
            self.assertNotIn('`holdings-app`', text)
            for kind in ('identity-browser', 'program', 'host-program', 'desktop-window'):
                self.assertIn('`' + kind + '`', text)
        quick = doc('docs/JUDGE_QUICKSTART.md')
        self.assertIn('opensuperficies-program-host-<arch>:0.1.0', quick)
        self.assertIn('Host program', quick)
        self.assertIn('not isolated', quick)

    def test_b3_16_readme_probe_reaches_stub_transport(self):
        text = doc('README.md')
        match = re.search(r'PYTHONPATH=agents python3 -m metaviewer_agents.mvctl propose .*?(?=\n#)', text, re.S)
        self.assertIsNotNone(match, 'The public CLI must run as a package for its relative imports')
        args = shlex.split(match.group(0).replace('\\\n', ' '))[4:]
        replacements = {'FILE': str(ROOT / 'contracts/examples/v0.2/action_proposal.valid.json'),
                        '$MV_SESSION_ID': 'sess-1', '$MV_AGENT_INSTANCE': 'agent-1',
                        '$MV_CORE_INSTANCE': 'core-1', '$MV_CORE_SOCKET': '/tmp/core.sock'}
        args = [replacements.get(x, x) for x in args]
        parsed = mvctl.build_parser().parse_args(args)
        config = {'session_id': 'sess-1', 'core': registration('core'), 'peers': [registration('agent')]}
        proposal = json.loads(Path(parsed.json_arg).read_text(encoding='utf-8'))
        with patch.object(mvctl, '_read_request', side_effect=[proposal, config]), \
                patch.object(mvctl, '_resolve_endpoint', return_value=('/tmp/core.sock', None)), \
                patch.dict(os.environ, {'MV_CORE_CONFIG': '/tmp/core.json'}), \
                patch('metaviewer_agents.client.ToolClient') as transport, \
                patch('metaviewer_agents.tools.propose', return_value={}) as propose, \
                redirect_stdout(io.StringIO()):
            self.assertEqual(mvctl.run(args), 0)
            transport.assert_called_once()
            propose.assert_called_once()
        self.assertNotIn('use `mvctl --v02 observe`', text)
        with patch.object(mvctl, '_run_v02', return_value=0) as current:
            mvctl.run(['observe'])
            mvctl.run(['--v02', 'observe'])
            self.assertEqual(current.call_args_list[0], current.call_args_list[1])

    def test_b3_17_prompt_buttons_never_submit(self):
        section = doc('docs/AI_OPERATOR_GUIDE.md').split('### Launching Terminals')[1].split('## 10.')[0]
        self.assertIn('The app never sends Enter', section)
        self.assertIn('never pastes', section)
        self.assertNotIn('Bootstrap', section)
        self.assertNotIn('METAVIEWER_AGENT_ENTRY', section)

    def test_b3_22_release_provenance_plain_english(self):
        section = doc('docs/JUDGE_QUICKSTART.md').split('Set these variables')[1].split('Fetch maps')[0]
        self.assertNotIn('AUSENTE', section)
        self.assertIn('Do not assume', section)
        self.assertIn('maintainer', section)


if __name__ == '__main__':
    unittest.main()
