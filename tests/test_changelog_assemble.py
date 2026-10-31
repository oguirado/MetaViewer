import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from tools import changelog_assemble as assembler
from tools import check_laws as laws

REPO_ROOT = Path(__file__).resolve().parents[1]
ASSEMBLER_PY = REPO_ROOT / 'tools' / 'changelog_assemble.py'
LAWS_PY = REPO_ROOT / 'tools' / 'check_laws.py'

SAMPLE_CHANGELOG = """# Changelog

## [Unreleased]

- Existing first entry.
- Existing second entry.

## 0.2.0 (candidate)

- Released entry.
"""


def _git_env():
    env = {
        k: v for k, v in os.environ.items()
        if not k.startswith(('GIT_AUTHOR_', 'GIT_COMMITTER_')) and k != 'EMAIL'
    }
    env['GIT_CONFIG_GLOBAL'] = '/dev/null'
    env['GIT_CONFIG_NOSYSTEM'] = '1'
    return env


def _init_git_repo(root: Path):
    env = _git_env()
    subprocess.run(['git', 'init', '-q'], cwd=root, env=env, check=True, timeout=15)
    subprocess.run(['git', 'config', 'user.name', laws.NAME], cwd=root, env=env, check=True, timeout=15)
    subprocess.run(['git', 'config', 'user.email', laws.EMAIL], cwd=root, env=env, check=True, timeout=15)
    subprocess.run(['git', 'config', 'commit.gpgsign', 'false'], cwd=root, env=env, check=True, timeout=15)
    (root / 'VERSION').write_text('0.2.0\n', encoding='utf-8')
    (root / 'CHANGELOG.md').write_text(SAMPLE_CHANGELOG, encoding='utf-8')
    (root / 'changes').mkdir(parents=True, exist_ok=True)
    (root / 'changes' / 'README.md').write_text('# Changelog fragments\n', encoding='utf-8')
    (root / 'changes' / 'unreleased').mkdir(parents=True, exist_ok=True)
    (root / 'changes' / 'unreleased' / 'init.md').write_text('- Initialize fixture.\n', encoding='utf-8')
    (root / 'tools').mkdir(parents=True, exist_ok=True)
    shutil.copy2(LAWS_PY, root / 'tools' / 'check_laws.py')
    shutil.copy2(ASSEMBLER_PY, root / 'tools' / 'changelog_assemble.py')
    subprocess.run(['git', 'add', '-A'], cwd=root, env=env, check=True, timeout=15)
    subprocess.run(['git', 'commit', '-q', '-m', 'docs: initialize changelog fixture'],
                   cwd=root, env=env, check=True, timeout=15)
    return env


class ChangelogAssembleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mv-chfrag-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'CHANGELOG.md').write_text(SAMPLE_CHANGELOG, encoding='utf-8')
        self.unreleased = self.root / 'changes' / 'unreleased'
        self.unreleased.mkdir(parents=True)

    def _write_fragment(self, name: str, content: str | bytes):
        path = self.unreleased / name
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding='utf-8')
        return path

    def test_assembly_order_and_existing_lines_preserved(self):
        self._write_fragment('z-omega.md', '- Add omega feature.\n')
        self._write_fragment('a-alpha.md', '- Add alpha feature.\n- Support alpha fallback.\n')
        self._write_fragment('m-middle.md', '- Fix middle boundary.\n')

        rc, _, errors = assembler.assemble(root=self.root)
        self.assertEqual(rc, 0, errors)
        self.assertEqual(errors, [])

        remaining = [p.name for p in self.unreleased.iterdir()]
        self.assertEqual(remaining, [])

        assembled = (self.root / 'CHANGELOG.md').read_text(encoding='utf-8')
        expected = """# Changelog

## [Unreleased]

- Existing first entry.
- Existing second entry.
- Add alpha feature.
- Support alpha fallback.
- Fix middle boundary.
- Add omega feature.

## 0.2.0 (candidate)

- Released entry.
"""
        self.assertEqual(assembled, expected)

    def test_idempotence_second_run_is_noop(self):
        self._write_fragment('b-two.md', '- Add second unit.\n')
        self._write_fragment('a-one.md', '- Add first unit.\n')

        rc1, _, errors1 = assembler.assemble(root=self.root)
        self.assertEqual(rc1, 0, errors1)
        after_first = (self.root / 'CHANGELOG.md').read_bytes()

        rc2, _, errors2 = assembler.assemble(root=self.root)
        self.assertEqual(rc2, 0, errors2)
        after_second = (self.root / 'CHANGELOG.md').read_bytes()
        self.assertEqual(after_first, after_second)

        # Also idempotent when changes/unreleased directory does not exist.
        shutil.rmtree(self.root / 'changes')
        rc3, _, errors3 = assembler.assemble(root=self.root)
        self.assertEqual(rc3, 0, errors3)
        self.assertEqual((self.root / 'CHANGELOG.md').read_bytes(), after_first)

    def test_dry_run_prints_assembled_without_modifying_disk(self):
        frag = self._write_fragment('dry-unit.md', '- Preview dry-run bullet.\n')
        before = (self.root / 'CHANGELOG.md').read_text(encoding='utf-8')

        proc = subprocess.run(
            [sys.executable, str(ASSEMBLER_PY), '--root', str(self.root), '--dry-run'],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('- Preview dry-run bullet.\n', proc.stdout)
        self.assertEqual((self.root / 'CHANGELOG.md').read_text(encoding='utf-8'), before)
        self.assertTrue(frag.is_file())

    def test_check_on_clean_and_dirty_tree(self):
        # Clean tree with no fragments passes --check.
        clean_proc = subprocess.run(
            [sys.executable, str(ASSEMBLER_PY), '--root', str(self.root), '--check'],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(clean_proc.returncode, 0, clean_proc.stderr)

        # Dirty tree with un-assembled fragment fails --check.
        self._write_fragment('pending-unit.md', '- Add pending unit.\n')
        dirty_proc = subprocess.run(
            [sys.executable, str(ASSEMBLER_PY), '--root', str(self.root), '--check'],
            capture_output=True, text=True, timeout=30,
        )
        self.assertNotEqual(dirty_proc.returncode, 0)
        self.assertIn('pending-unit.md', dirty_proc.stderr)

        # After assembling, tree is clean again and passes --check.
        run_proc = subprocess.run(
            [sys.executable, str(ASSEMBLER_PY), '--root', str(self.root)],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(run_proc.returncode, 0, run_proc.stderr)

        clean_after = subprocess.run(
            [sys.executable, str(ASSEMBLER_PY), '--root', str(self.root), '--check'],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(clean_after.returncode, 0, clean_after.stderr)

    def test_malformed_fragments_refused(self):
        before = (self.root / 'CHANGELOG.md').read_text(encoding='utf-8')
        malformed_cases = [
            ('empty.md', ''),
            ('whitespace.md', '   \n\t\n'),
            ('no-bullet.md', 'Add something without a bullet prefix.\n'),
            ('bare-dash.md', '-   \n'),
            ('mixed-non-bullet.md', '- Valid bullet.\nSecond line lacks bullet.\n'),
            ('too-long.md', '- ' + ('x' * assembler.MAX_LINE_LENGTH) + '\n'),
            ('bad-utf8.md', b'- Invalid UTF-8 \xff\xfe sequence.\n'),
            ('BadUpper.md', '- Invalid uppercase filename.\n'),
            ('bad_underscore.md', '- Invalid underscore in slug.\n'),
            ('-leading-dash.md', '- Invalid leading dash in slug.\n'),
            ('not-markdown.txt', '- Wrong file extension.\n'),
            ('forbidden-word.md', '- Add feature with ' + laws.FORBIDDEN[0] + ' marker.\n'),
        ]
        for filename, payload in malformed_cases:
            with self.subTest(filename=filename):
                for existing in self.unreleased.iterdir():
                    existing.unlink()
                frag_path = self._write_fragment(filename, payload)

                rc_check, _, err_check = assembler.assemble(root=self.root, check=True)
                self.assertEqual(rc_check, 1, f'expected --check failure for {filename}')
                self.assertTrue(err_check)

                rc_run, _, err_run = assembler.assemble(root=self.root, check=False)
                self.assertEqual(rc_run, 1, f'expected assemble failure for {filename}')
                self.assertTrue(err_run)

                # Neither CHANGELOG.md nor the fragment on disk was altered.
                self.assertEqual((self.root / 'CHANGELOG.md').read_text(encoding='utf-8'), before)
                self.assertTrue(frag_path.is_file())


class ChangelogEnforcementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mv-chfrag-git-')
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.env = _init_git_repo(self.repo)

    def _commit_files(self, files: dict[str, str | bytes], message: str):
        for rel_path, content in files.items():
            target = self.repo / rel_path
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, bytes):
                target.write_bytes(content)
            else:
                target.write_text(content, encoding='utf-8')
        subprocess.run(['git', 'add', '-A'], cwd=self.repo, env=self.env, check=True, timeout=15)
        subprocess.run(['git', 'commit', '-q', '-m', message],
                       cwd=self.repo, env=self.env, check=True, timeout=15)

    def test_code_only_commit_fails_enforcement(self):
        self._commit_files({'core/src/lib.rs': 'pub fn run() {}\n'}, 'core: add runner entry')

        errors = laws.check_commit_changelog('HEAD', root=self.repo)
        self.assertTrue(errors)
        self.assertTrue(any('changes/unreleased/<slug>.md' in e for e in errors), errors)

        proc = subprocess.run(
            [sys.executable, 'tools/check_laws.py'],
            cwd=self.repo, env=self.env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn('changes/unreleased/<slug>.md', proc.stderr)

    def test_code_plus_fragment_commit_passes_enforcement(self):
        self._commit_files(
            {
                'core/src/lib.rs': 'pub fn run() {}\n',
                'changes/unreleased/core-runner.md': '- Add the core runner entry point.\n',
            },
            'core: add runner entry',
        )
        self.assertEqual(laws.check_commit_changelog('HEAD', root=self.repo), [])

        proc = subprocess.run(
            [sys.executable, 'tools/check_laws.py'],
            cwd=self.repo, env=self.env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('Laws check: OK', proc.stdout)

    def test_docs_only_and_changelog_only_and_transition_rule(self):
        # 1. Docs-only commit passes regardless of transition switch.
        self._commit_files({'docs/GUIDE.md': '# Guide\n'}, 'docs: add operator guide')
        self.assertEqual(laws.check_commit_changelog('HEAD', root=self.repo, allow_direct=True), [])
        self.assertEqual(laws.check_commit_changelog('HEAD', root=self.repo, allow_direct=False), [])

        # 2. CHANGELOG-only commit passes regardless of transition switch.
        updated_cl = SAMPLE_CHANGELOG.replace(
            '- Existing second entry.\n',
            '- Existing second entry.\n- Direct changelog note.\n',
        )
        self._commit_files({'CHANGELOG.md': updated_cl}, 'docs: update changelog notes')
        self.assertEqual(laws.check_commit_changelog('HEAD', root=self.repo, allow_direct=True), [])
        self.assertEqual(laws.check_commit_changelog('HEAD', root=self.repo, allow_direct=False), [])

        # 3. Product-code + direct CHANGELOG.md edit (no fragment):
        #    passes while ALLOW_DIRECT_CHANGELOG transition switch is True,
        #    fails once the conductor flips ALLOW_DIRECT_CHANGELOG to False.
        updated_cl_2 = updated_cl.replace(
            '- Direct changelog note.\n',
            '- Direct changelog note.\n- Add transition feature.\n',
        )
        self._commit_files(
            {
                'ui/src/main.js': 'export const ok = true;\n',
                'CHANGELOG.md': updated_cl_2,
            },
            'ui: add transition feature',
        )
        self.assertEqual(laws.check_commit_changelog('HEAD', root=self.repo, allow_direct=True), [])
        strict_errors = laws.check_commit_changelog('HEAD', root=self.repo, allow_direct=False)
        self.assertTrue(strict_errors)
        self.assertTrue(any('changes/unreleased/<slug>.md' in e for e in strict_errors), strict_errors)

        # Also verify the environment override MV_CHANGELOG_ALLOW_DIRECT=0 flips the switch.
        strict_env = dict(self.env, MV_CHANGELOG_ALLOW_DIRECT='0')
        proc = subprocess.run(
            [sys.executable, 'tools/check_laws.py'],
            cwd=self.repo, env=strict_env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn('changes/unreleased/<slug>.md', proc.stderr)


class ChangelogMutantTests(unittest.TestCase):
    """Verify the three required mutants each cause their corresponding test check to fail."""

    def test_mutant_unsorted_assembly_is_caught(self):
        with tempfile.TemporaryDirectory(prefix='mv-mutant-sort-') as tmp:
            root = Path(tmp)
            (root / 'CHANGELOG.md').write_text(SAMPLE_CHANGELOG, encoding='utf-8')
            unreleased = root / 'changes' / 'unreleased'
            unreleased.mkdir(parents=True)
            (unreleased / 'a-first.md').write_text('- First ordered item.\n', encoding='utf-8')
            (unreleased / 'b-second.md').write_text('- Second ordered item.\n', encoding='utf-8')
            (unreleased / 'c-third.md').write_text('- Third ordered item.\n', encoding='utf-8')

            # Mutant: reverse/unsorted order instead of ascending filename order.
            rc, assembled_mutant, errors = assembler.assemble(
                root=root, sort_key=lambda p: tuple(-b for b in p.name.encode('utf-8'))
            )
            self.assertEqual(rc, 0, errors)
            expected_order = [
                '- Existing first entry.',
                '- Existing second entry.',
                '- First ordered item.',
                '- Second ordered item.',
                '- Third ordered item.',
            ]
            actual_bullets = [
                line for line in assembled_mutant.splitlines()
                if line.startswith('- ') and 'Released' not in line
            ]
            # The mutant produces the wrong order and fails the ordering check.
            self.assertNotEqual(actual_bullets, expected_order)

    def test_mutant_keeping_consumed_fragments_is_caught(self):
        with tempfile.TemporaryDirectory(prefix='mv-mutant-keep-') as tmp:
            root = Path(tmp)
            (root / 'CHANGELOG.md').write_text(SAMPLE_CHANGELOG, encoding='utf-8')
            unreleased = root / 'changes' / 'unreleased'
            unreleased.mkdir(parents=True)
            (unreleased / 'keep-me.md').write_text('- Add feature.\n', encoding='utf-8')

            # Mutant: assembler does not delete consumed fragments.
            rc1, after_first, _ = assembler.assemble(root=root, delete_consumed=False)
            self.assertEqual(rc1, 0)
            # 1. Post-assembly --check fails because the consumed fragment remained on disk.
            rc_check, _, _ = assembler.assemble(root=root, check=True)
            self.assertNotEqual(rc_check, 0)
            # 2. A second run duplicates the bullet instead of being an idempotent no-op.
            rc2, after_second, _ = assembler.assemble(root=root, delete_consumed=False)
            self.assertEqual(rc2, 0)
            self.assertNotEqual(after_first, after_second)

    def test_mutant_enforcement_disabled_is_caught(self):
        code_only_changes = [('M', 'core/src/lib.rs')]
        # Genuine enforcement rejects a code-only change.
        genuine_errors = laws.check_changelog_changes(code_only_changes)
        self.assertTrue(genuine_errors)
        # Mutant: flipping ENFORCE_CHANGELOG_FRAGMENTS = False disables enforcement
        # and silently passes the code-only commit, which our refusal assertion catches.
        with patch.object(laws, 'ENFORCE_CHANGELOG_FRAGMENTS', False):
            mutant_errors = laws.check_changelog_changes(code_only_changes)
        self.assertNotEqual(mutant_errors, genuine_errors)
        self.assertEqual(mutant_errors, [])


if __name__ == '__main__':
    unittest.main()
