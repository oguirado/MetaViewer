import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from tools import check_laws as laws

class LawsTests(unittest.TestCase):
    def test_forbidden_patterns(self):
        for pattern in laws.FORBIDDEN:
            with self.subTest(pattern=pattern):
                self.assertTrue(laws.check_message('contracts: add schemas\n\n' + pattern.upper()))
        self.assertEqual(laws.check_message('contracts: add v0.1 schemas\n\nDefine typed boundaries.'), [])

    def test_subject(self):
        for message in ('add schemas', 'other: add schemas', 'core: added schemas',
                        'docs: actualizar documentos', 'core: add ' + 'x' * 72, ''):
            with self.subTest(message=message):
                self.assertTrue(laws.check_message(message))
        for scope in ('core', 'contracts', 'ui', 'ci', 'docs', 'deps', 'tools'):
            self.assertFalse(laws.check_message(scope + ': update contracts'))

    def test_identity(self):
        good = (laws.NAME, laws.EMAIL, laws.NAME, laws.EMAIL)
        self.assertFalse(laws.check_identity(*good))
        for index in range(4):
            bad = list(good); bad[index] = 'wrong'
            self.assertTrue(laws.check_identity(*bad))
        self.assertTrue(laws.check_ident(f'{laws.NAME} <{laws.EMAIL}> 100 +0200'))
        self.assertFalse(laws.check_ident(f'{laws.NAME} <wrong@example.org> 100 +0200'))
        self.assertFalse(laws.check_ident('malformed'))

    def test_version(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for version in ('0.1.0', '1.2.3-alpha.1+build.5'):
                (root / 'VERSION').write_text(version + '\n')
                (root / 'CHANGELOG.md').write_text('## ' + version + ' (unreleased)\n')
                self.assertFalse(laws.check_version(root))
            for version in ('01.1.0', '1.2', 'v1.2.3', '1.2.3-01'):
                (root / 'VERSION').write_text(version)
                self.assertTrue(laws.check_version(root))
            (root / 'VERSION').write_text('0.1.0')
            (root / 'CHANGELOG.md').write_text('## 0.1.01\n')
            self.assertTrue(laws.check_version(root))

    def test_history_checks_every_commit(self):
        responses = ['first\nsecond\n', f'{laws.NAME}\0{laws.EMAIL}\0{laws.NAME}\0{laws.EMAIL}\0core: add loop',
                     f'wrong\0{laws.EMAIL}\0{laws.NAME}\0{laws.EMAIL}\0core: add loop\nGenerated with tooling']
        with patch.object(laws, 'git', side_effect=responses):
            errors = laws.check_history('base..head')
        self.assertEqual(len(errors), 2)
        self.assertTrue(all(error.startswith('second:') for error in errors))

    def test_empty_history_and_bad_range(self):
        with patch.object(laws, 'git', return_value=''):
            self.assertEqual(laws.check_history(), [])
        with patch.object(laws, 'git', side_effect=subprocess.CalledProcessError(128, 'git')):
            with self.assertRaises(subprocess.CalledProcessError):
                laws.check_history('invalid..range')
