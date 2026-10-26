"""Kill-guard unit for AC-10: every kill site takes a recorded int pid above one outside the caller's group.

The reference predicate mirrors ui/electron/coreLauncher.js validateKillTarget;
the directly tested audit predicate and the static audit enforce the strict-int,
above-one, never-own-group rule; the token classes match the guarded site in
tools/gate.sh stop_process_tree.

No test signals a host process: allowed paths record through a stub, refused
paths raise before signalling, and audit fixtures call the predicate directly without installing global hooks.
No negative control can reach a host signal primitive.
"""
import ast
import os
import re
import signal
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[1]


class KillRefused(PermissionError):
    """A kill request failed the AC-10 guard."""


def kill_target_allowed(pid, self_pid, self_pgid):
    """True only for a strict int pid above one that is neither self nor own group."""
    if type(pid) is not int or type(self_pid) is not int or type(self_pgid) is not int:
        return False
    if pid <= 1:
        return False
    return pid != self_pid and pid != self_pgid


def checked_kill(pid, sig, *, send, self_pid=None, self_pgid=None):
    """Signal exactly one recorded pid after the guard; never a name or group."""
    caller = os.getpid() if self_pid is None else self_pid
    group = os.getpgid(0) if self_pgid is None else self_pgid
    if not kill_target_allowed(pid, caller, group):
        raise KillRefused('refused kill of %r (self=%r group=%r)' % (pid, caller, group))
    return send(pid, sig)


# [TARGET, unit decision] Exercise the audit predicate directly: negative
# controls must remain harmless even if installing an audit hook regresses.
def signal_audit_guard(event, args):
    """Reject reserved ids and the caller's process/group before signalling."""
    if event == 'os.kill' and args:
        target = args[0]
        if not kill_target_allowed(target, os.getpid(), os.getpgid(0)):
            raise PermissionError('kill guard refused')
    elif event == 'os.killpg' and args:
        target = args[0]
        if not kill_target_allowed(target, os.getpid(), os.getpgid(0)):
            raise PermissionError('kill guard refused')



KILL_FUNCS = ('kill', 'killpg')
LOWER_TOKENS = ('> 1', '>= 2', '<= 1', '< 2', '>1', '>=2', '<=1', '<2')
GROUP_TOKENS = ('getpgid', 'getpgrp')
TYPE_RE = re.compile(r'\btype\s*\(.+?\)\s+is\s+(not\s+)?int\b|\bisinstance\s*\(')
SKIP_DIRS = frozenset(('.git', '__pycache__', '.pytest_cache', '.venv', 'venv',
                       'node_modules', 'target', 'dist', 'build', 'coverage'))
KILL_BY_NAME = re.compile(r'\b(pkill|killall|taskkill|killbyname)\b')
CODE_SUFFIXES = ('.py', '.js', '.mjs', '.cjs', '.go', '.rs', '.sh')


def _guarded(body):
    return (any(token in body for token in LOWER_TOKENS)
            and any(token in body for token in GROUP_TOKENS)
            and TYPE_RE.search(body) is not None)


def unguarded_kill_lines(source):
    """Sorted line numbers of os.kill/os.killpg calls outside a guarded function body."""
    tree = ast.parse(source)
    os_aliases = {'os'}
    bare = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == 'os':
                    os_aliases.add(alias.asname or 'os')
        elif isinstance(node, ast.ImportFrom) and node.module == 'os' and node.level == 0:
            for alias in node.names:
                if alias.name in KILL_FUNCS:
                    bare.add(alias.asname or alias.name)

    def is_kill_call(node):
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in KILL_FUNCS:
            return isinstance(func.value, ast.Name) and func.value.id in os_aliases
        return isinstance(func, ast.Name) and func.id in bare

    missing = set()
    nested = set()
    for func in (node for node in ast.walk(tree)
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))):
        guarded = _guarded(ast.get_source_segment(source, func) or '')
        for node in ast.walk(func):
            if isinstance(node, ast.Call):
                nested.add(node)
                if is_kill_call(node) and not guarded:
                    missing.add(node.lineno)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and is_kill_call(node) and node not in nested:
            missing.add(node.lineno)
    return sorted(missing)


def _first_party(root, suffix):
    for path in sorted(root.rglob('*' + suffix)):
        if path.name == 'test_kill_guard.py':
            # Own refusal fixtures exercise the runtime hook, not the static rule.
            continue
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        yield path


def read_gate_python(root):
    """Extract the quoted-heredoc Python runner from tools/gate.sh with its first line number."""
    lines = (root / 'tools' / 'gate.sh').read_text(encoding='utf-8').splitlines(keepends=True)
    start = next(index for index, line in enumerate(lines) if "<<'PY'" in line) + 1
    end = next(index for index in range(len(lines) - 1, start - 1, -1)
               if lines[index] in ('PY\n', 'PY'))
    return ''.join(lines[start:end]), start + 1


def kill_by_name_hits(root):
    """Repo-relative coordinates of kill-by-name primitives in first-party code."""
    hits = []
    for suffix in CODE_SUFFIXES:
        for path in _first_party(root, suffix):
            for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
                if KILL_BY_NAME.search(line):
                    hits.append('%s:%d' % (path.relative_to(root), number))
    return sorted(hits)


class KillGuardTests(unittest.TestCase):
    def test_allowed_recorded_pid(self):
        pid = os.getpid() + os.getpgid(0) + 2
        self.assertTrue(kill_target_allowed(pid, os.getpid(), os.getpgid(0)))

    def test_refuses_reserved_pids(self):
        for pid in (0, 1, -1):
            with self.subTest(pid=pid):
                self.assertFalse(kill_target_allowed(pid, os.getpid(), os.getpgid(0)))
                with self.assertRaises(KillRefused):
                    checked_kill(pid, signal.SIGKILL, send=MagicMock())

    def test_refuses_self_and_own_group(self):
        for pid in (os.getpid(), os.getpgid(0)):
            with self.subTest(pid=pid):
                self.assertFalse(kill_target_allowed(pid, os.getpid(), os.getpgid(0)))
                with self.assertRaises(KillRefused):
                    checked_kill(pid, signal.SIGKILL, send=MagicMock())

    def test_refuses_non_int_pid(self):
        caller, group = os.getpid(), os.getpgid(0)
        for pid in (True, False, 2.0, '4242', None, object()):
            with self.subTest(pid=pid):
                self.assertFalse(kill_target_allowed(pid, caller, group))
        for probe in (MagicMock(), MagicMock(spec=int)):
            with self.subTest(probe=repr(probe)):
                # spec=int fools isinstance but not the strict type identity check.
                self.assertFalse(kill_target_allowed(probe, caller, group))
                self.assertEqual(probe.mock_calls, [])

    def test_self_ids_must_be_int(self):
        pid = os.getpid() + os.getpgid(0) + 2
        self.assertFalse(kill_target_allowed(pid, 'self', os.getpgid(0)))
        self.assertFalse(kill_target_allowed(pid, os.getpid(), None))
        self.assertFalse(kill_target_allowed(pid, True, os.getpgid(0)))

    def test_checked_kill_records_without_signalling(self):
        sent = []
        pid = os.getpid() + os.getpgid(0) + 2
        checked_kill(pid, signal.SIGTERM, send=lambda p, s: sent.append((p, s)))
        self.assertEqual(sent, [(pid, signal.SIGTERM)])

    def test_checked_kill_never_sends_on_refusal(self):
        sent = []

        def send(pid, sig):
            sent.append((pid, sig))

        for pid in (0, 1, -1, os.getpid(), os.getpgid(0), '4242', None, MagicMock()):
            with self.subTest(pid=repr(pid)):
                with self.assertRaises(KillRefused):
                    checked_kill(pid, signal.SIGKILL, send=send)
        self.assertEqual(sent, [])

    def test_hook_refuses_dangerous_calls(self):
        for event, target in (('os.killpg', MagicMock()),
                              ('os.kill', 1), ('os.kill', -1),
                              ('os.kill', 0), ('os.killpg', os.getpgid(0)),
                              ('os.kill', os.getpid())):
            with self.subTest(event=event, target=repr(target)):
                with self.assertRaises(PermissionError):
                    signal_audit_guard(event, (target, signal.SIGKILL))

    def test_hook_allows_recorded_child_shape_without_signalling(self):
        pid = os.getpid() + os.getpgid(0) + 2
        signal_audit_guard('os.kill', (pid, signal.SIGTERM))

    def test_every_python_kill_site_is_guarded(self):
        missing = []
        for path in _first_party(ROOT, '.py'):
            for line in unguarded_kill_lines(path.read_text(encoding='utf-8')):
                missing.append('%s:%d' % (path.relative_to(ROOT), line))
        source, first = read_gate_python(ROOT)
        for line in unguarded_kill_lines(source):
            missing.append('tools/gate.sh:%d' % (first + line - 1))
        self.assertEqual(missing, [])

    def test_gate_python_extracts(self):
        source, first = read_gate_python(ROOT)
        ast.parse(source)
        self.assertGreater(first, 1)
        self.assertIn('os.kill(', source)

    def test_auditor_rejects_unguarded_snippets(self):
        cases = {
            'import os\ndef stop(pid):\n    os.kill(pid, 9)\n': [3],
            'import os\ndef stop(pgid):\n    os.killpg(pgid, 9)\n': [3],
            'from os import kill\ndef stop(pid):\n    kill(pid, 9)\n': [3],
            'import os as o\ndef stop(pid):\n    o.killpg(pid, 9)\n': [3],
            'import os\nos.kill(pid, 9)\n': [2],
        }
        for source, lines in cases.items():
            with self.subTest(source=source):
                self.assertEqual(unguarded_kill_lines(source), lines)

    def test_auditor_accepts_guarded_snippet(self):
        source = ('import os\ndef stop(pid):\n'
                  '    if type(pid) is not int or pid <= 1:\n'
                  '        raise ValueError("unsafe child pid")\n'
                  '    if os.getpgid(pid) == os.getpgrp():\n'
                  '        raise ValueError("child shares caller process group")\n'
                  '    os.kill(pid, 9)\n')
        self.assertEqual(unguarded_kill_lines(source), [])

    def test_auditor_ignores_handle_kill(self):
        # Recorded-handle signals are single-pid by construction, not kill sites.
        self.assertEqual(unguarded_kill_lines('def stop(child):\n    child.kill()\n'), [])
        self.assertEqual(unguarded_kill_lines('def stop(proc):\n    proc.terminate()\n'), [])

    def test_no_kill_by_name(self):
        self.assertEqual(kill_by_name_hits(ROOT), [])

    def test_by_name_scanner_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'clean.py').write_text('import os\nos.kill(pid, 9)\n', encoding='utf-8')
            (root / 'dirty.sh').write_text('#!/bin/sh\npkill -f worker\n', encoding='utf-8')
            self.assertEqual(kill_by_name_hits(root), ['dirty.sh:2'])


if __name__ == '__main__':
    unittest.main()
