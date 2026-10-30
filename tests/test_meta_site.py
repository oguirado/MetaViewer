"""META-SITE offline lookup, checker custody and hosted replay controls."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agents'))
from metaviewer_agents.mw_home import HomeError, site_root

PACK = ROOT / 'tests/e2e/packs/builtin-fixtures/META'
BUILTIN = ROOT / 'memoryweb-builtin'


class MetaSiteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='meta-Música-')
        self.addCleanup(self.temp.cleanup)
        self.temp_root = Path(self.temp.name)
        self.home = self.temp_root / 'home'
        self.home.mkdir(mode=0o700)

    def test_fallback_is_read_only_and_user_site_wins_entirely(self):
        before = {p.relative_to(BUILTIN): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in BUILTIN.rglob('*') if p.is_file()}
        self.assertEqual(site_root(self.home, 'meta-ai'), BUILTIN)
        self.assertEqual(list(self.home.iterdir()), [])
        user = self.home / 'sites/meta-ai'
        user.mkdir(parents=True)
        # Even an incomplete user site wins: never mix in built-in workflows.
        self.assertEqual(site_root(self.home, 'meta-ai'), self.home)
        self.assertFalse((user / 'workflows/ask.json').exists())
        after = {p.relative_to(BUILTIN): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in BUILTIN.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_negative_invalid_missing_file_and_symlink(self):
        for name in ('../meta-ai', '/meta-ai', 'meta-ai/x', '', 'META'):
            with self.assertRaises(HomeError):
                site_root(self.home, name)
        with self.assertRaisesRegex(HomeError, 'MW_SITE_MISSING'):
            site_root(self.home, 'not-provided')
        sites = self.home / 'sites'
        sites.mkdir()
        site = sites / 'meta-ai'
        site.write_text('invalid')
        with self.assertRaisesRegex(HomeError, 'MW_SITE_PATH'):
            site_root(self.home, 'meta-ai')
        site.unlink()
        site.symlink_to(self.temp_root / 'absent')
        with self.assertRaisesRegex(HomeError, 'MW_HOME_SYMLINK'):
            site_root(self.home, 'meta-ai')

    def test_demo_check_offline_uses_builtin_without_installing(self):
        spec = importlib.util.spec_from_file_location('meta_demo_test', ROOT / 'tools/mv_demo.py')
        demo = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(demo)
        # Hosted authoring fixture exercises the real disposable-copy/check
        # protocol. The operator's real MemoryWeb checkout is checked separately.
        checkout = self.temp_root / 'authoring'
        (checkout / 'tools').mkdir(parents=True)
        source_digest = hashlib.sha256((BUILTIN / 'sites/meta-ai/site.json').read_bytes()).hexdigest()
        (checkout / 'tools/build_index.py').write_text(
            'import hashlib,pathlib,sys\n'
            'root=pathlib.Path(sys.argv[sys.argv.index("--root")+1])\n'
            'site=root/"sites/meta-ai/site.json"\n'
            f'assert hashlib.sha256(site.read_bytes()).hexdigest()=={source_digest!r}\n'
            'index=root/"checked"\n'
            'if "--check" in sys.argv: assert index.read_text()=="validated"\n'
            'else: index.write_text("validated")\n')
        with patch.object(demo, 'admitted_home', return_value=self.home), \
             patch.object(demo, 'authoring_checkout', return_value=checkout), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(demo.main(['check', '--site', 'meta-ai']), 0)
        self.assertTrue(json.loads(output.getvalue())['result']['validated'])
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertFalse((checkout / 'sites').exists())

    def test_hosted_fixture_replay_and_negative_controls(self):
        node = shutil.which(os.environ.get('NODE', 'node'))
        self.assertIsNotNone(node, 'Node from PATH or NODE is required')
        environment = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
        for mutation in ('', 'no-proof', 'text-receipt', 'captcha', 'login-wall', 'draft-ask', 'draft-new-chat'):
            with self.subTest(mutation=mutation):
                result = subprocess.run([node, str(PACK / 'hosted.mjs'), mutation],
                                        cwd=ROOT, env=environment, capture_output=True,
                                        text=True, timeout=90, check=False)
                self.assertEqual(result.returncode, 0, result.stderr[-6000:])
                self.assertEqual(json.loads(result.stdout)['status'], 'PASS')


if __name__ == '__main__':
    unittest.main()
