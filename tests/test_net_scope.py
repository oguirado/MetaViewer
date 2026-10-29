"""Offline regression guard for operator-only native network lifecycle."""
import ast
import importlib.util
from pathlib import Path
import re
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SLICE = ROOT / 'tests/e2e/e2e1_slice'


def forbidden_lines(source):
    # Scan all tracked text sources, including multiline Python/JS/Go argv.
    # Broad token matching also catches a binary stored in a variable.
    adjacent = re.compile(r'''["']net["']\s*,\s*["'](?:down|up)["']''')
    shell = re.compile(r'\bsrf-identity-surface\s+net\s+(?:down|up)\b')
    return [source.count('\n', 0, match.start()) + 1
            for pattern in (adjacent, shell) for match in pattern.finditer(source)]


class NetworkScopeTests(unittest.TestCase):
    def runners(self):
        import sys
        with patch.object(sys, 'path', [str(SLICE), *sys.path]):
            import live
            import stack
        return live, stack

    def test_live_run_net_refuses_before_spawn(self):
        live, stack = self.runners()
        self.assertIs(stack.ForbiddenVerb, live.ForbiddenVerb)
        report = {'commands': []}
        subcommand = 'down'
        with patch.object(live.subprocess, 'run') as spawn:
            with self.assertRaises(live.ForbiddenVerb) as caught:
                live.run(report, ['srf-identity-surface', 'net', subcommand])
            self.assertEqual(caught.exception.code, 'E2E_FORBIDDEN_VERB')
            spawn.assert_not_called()
        self.assertEqual(report, {'commands': []})
        result = subprocess.CompletedProcess([], 0, 'ok', '')
        with patch.object(live.subprocess, 'run', return_value=result) as spawn:
            self.assertIs(live.run(report, ['srf-identity-surface', 'stop']), result)
            spawn.assert_called_once()

    def test_demo_net_mutation_refuses_before_spawn(self):
        live, _ = self.runners()
        source = (SLICE / 'demo_agent_drive.py').read_text()
        tree = ast.parse(source)
        native_tree = next(n for n in ast.walk(tree)
                           if isinstance(n, ast.FunctionDef) and n.name == 'native_tree')
        namespace = {'live': live, 'subprocess': subprocess, 'Path': Path,
                     'os': SimpleNamespace(environ={'MV_SRF_BIN_DIR': 'bin',
                                                   'MV_SRF_STATE_DIR': 'state'}),
                     'json': __import__('json')}
        session = SimpleNamespace(capsule='fixture')
        module = ast.Module(body=[native_tree], type_ignores=[])
        exec(compile(module, str(SLICE / 'demo_agent_drive.py'), 'exec'), namespace)
        with patch.object(subprocess, 'check_output', return_value='{}') as spawn:
            self.assertEqual(namespace['native_tree'](session), {})
            self.assertEqual(spawn.call_args.args[0][1], 'ax')
            spawn.assert_called_once()
        for node in ast.walk(native_tree):
            if isinstance(node, ast.Constant) and node.value == 'ax':
                node.value = 'net'
        exec(compile(module, str(SLICE / 'demo_agent_drive.py'), 'exec'), namespace)
        with patch.object(subprocess, 'check_output', return_value='{}') as spawn:
            with self.assertRaises(live.ForbiddenVerb) as caught:
                namespace['native_tree'](session)
            self.assertEqual(caught.exception.code, 'E2E_FORBIDDEN_VERB')
            spawn.assert_not_called()

    def test_symlink_and_shell_net_refuse_in_both_runners(self):
        live, stack = self.runners()
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'srf-identity-surface'
            binary.touch()
            alias = Path(directory) / 'different-name'
            alias.symlink_to(binary)
            shell_command = 'srf-identity-surface' + ' net ' + 'down'
            subcommand = 'down'
            argvs = [[alias, 'net', subcommand],
                     ['sh', '-c', shell_command],
                     ['/bin/bash', '-c', shell_command]]
            for argv in argvs:
                for runner in (stack.checked, lambda args: live.run({'commands': []}, args)):
                    with self.subTest(argv=argv, runner=runner):
                        with patch.object(subprocess, 'run') as spawn:
                            with self.assertRaises(live.ForbiddenVerb) as caught:
                                runner(argv)
                            self.assertEqual(caught.exception.code, 'E2E_FORBIDDEN_VERB')
                            spawn.assert_not_called()

    def test_tracked_sources_never_build_global_lifecycle(self):
        files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).split(b'\0')
        hits = []
        for name in files:
            if not name:
                continue
            path = ROOT / name.decode()
            if path.suffix.lower() in {'.md', '.rst', '.txt', '.html', '.json', '.svg', '.lock'}:
                continue  # Documentation/data are not executable source.
            try:
                source = path.read_text()
            except (UnicodeError, IsADirectoryError):
                continue
            hits.extend(f'{path.relative_to(ROOT)}:{line}' for line in forbidden_lines(source))
        self.assertEqual(hits, [])

    def test_runner_mutations_and_central_guard(self):
        import sys
        with patch.object(sys, 'path', [str(SLICE), *sys.path]):
            spec = importlib.util.spec_from_file_location('net_scope_stack', SLICE / 'stack.py')
            stack = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(stack)
        source = (SLICE / 'asm_web_live.py').read_text()
        for subcommand in ('down', 'up', 'status'):
            with self.subTest(mutation='MUT-NET-' + subcommand.upper()):
                argv = [Path('bin') / 'srf-identity-surface', 'net', subcommand]
                # Reintroduce the call into the actual runner proof in memory.
                tree = ast.parse(source)
                proof = next(n for n in ast.walk(tree)
                             if isinstance(n, ast.FunctionDef) and n.name == 'op_offline_proof')
                original = ast.get_source_segment(source, proof)
                injected = 'def op_offline_proof(self):\n        return self.stack.checked(' + repr([str(x) for x in argv]) + ')'
                mutant = source.replace(original, injected)
                if subcommand in ('down', 'up'):
                    self.assertTrue(forbidden_lines(mutant), 'static mutation survived')
                namespace = {'__file__': str(SLICE / 'asm_web_live.py'), '__name__': 'net_scope_mutant'}
                exec(compile(mutant, namespace['__file__'], 'exec'), namespace)
                backend = object.__new__(namespace['LiveBackend'])
                backend.stack = stack
                with patch.object(stack.subprocess, 'run') as spawn:
                    with self.assertRaises(stack.ForbiddenVerb) as caught:
                        backend.op_offline_proof()
                    self.assertEqual(caught.exception.code, 'E2E_FORBIDDEN_VERB')
                    spawn.assert_not_called()
        with patch.object(stack.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'ok', '')) as spawn:
            self.assertEqual(stack.checked(['srf-identity-surface', 'capabilities']), 'ok')
            spawn.assert_called_once()

    def test_readonly_fixture_proof_and_navigation_refusal(self):
        spec = importlib.util.spec_from_file_location('net_scope_web', SLICE / 'asm_web_live.py')
        web = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(web)
        backend = object.__new__(web.LiveBackend)
        with patch.object(web.subprocess, 'run', side_effect=AssertionError('proof spawned')):
            proof = backend.op_offline_proof()
            self.assertTrue(proof['fixtures_offline'])
            self.assertEqual(proof['network'], 'not altered (read-only check unavailable at pin)')
            with self.assertRaises(web.Failure):
                backend.op_navigate('form', 'https://outside.invalid')
            with patch.object(web, 'fixture', side_effect=web.Failure('fixture changed')):
                with self.assertRaises(web.Failure):
                    backend.op_offline_proof()


if __name__ == '__main__':
    unittest.main()
