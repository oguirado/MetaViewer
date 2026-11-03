"""Offline compiled asset admission, including hash and source-leak mutants."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sidecar_assets', ROOT / 'tools/build_release_assets.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class CompiledAssetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / 'out'
        self.output.mkdir()
        self.archive = self.root / 'wender-agent-linux-x64.tar.gz'

    def fixture(self, name='wender-runtime'):
        data = b'compiled fixture'
        with tarfile.open(self.archive, 'w:gz') as tf:
            member = tarfile.TarInfo('wender-agent/' + name)
            member.mode, member.size = 0o755, len(data)
            tf.addfile(member, io.BytesIO(data))
        lock = self.root / 'agents/metaviewer_agents/perception/compiled.lock.json'
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text(json.dumps({'components': {'wender-agent': dict(
            commit='a'*40, archive_sha256=assets.sha256_file(self.archive),
            files={name: hashlib.sha256(data).hexdigest()})}}))
        return lock

    def build(self):
        return assets.build_compiled_component_asset('wender-agent', self.root, self.output, 'x64')

    def test_valid_export_and_hash_mutant(self):
        self.fixture()
        with patch.object(assets, 'REPO_ROOT', self.root), \
                patch.object(assets, 'load_deps_lock', return_value={'wender-agent': {'commit': 'a'*40}}):
            result = self.build()
            self.assertEqual(result.read_bytes(), self.archive.read_bytes())
            self.archive.write_bytes(self.archive.read_bytes() + b'mutant')
            with self.assertRaisesRegex(assets.AssetBuildError, 'hash mismatch'):
                self.build()
            self.archive.unlink()
            with self.assertRaisesRegex(assets.AssetBuildError, 'missing'):
                self.build()

    def test_source_file_even_if_pinned_refuses(self):
        self.fixture('private.py')
        with patch.object(assets, 'REPO_ROOT', self.root), \
                patch.object(assets, 'load_deps_lock', return_value={'wender-agent': {'commit': 'a'*40}}):
            with self.assertRaisesRegex(assets.AssetBuildError, 'unpinned compiled member'):
                self.build()

    def test_wrong_source_commit_and_absent_architecture_refuse(self):
        self.fixture()
        with patch.object(assets, 'REPO_ROOT', self.root), \
                patch.object(assets, 'load_deps_lock', return_value={'wender-agent': {'commit': 'b'*40}}):
            with self.assertRaisesRegex(assets.AssetBuildError, 'source commit'):
                self.build()
            with self.assertRaisesRegex(assets.AssetBuildError, 'linux-x64'):
                assets.build_compiled_component_asset('wender-agent', self.root, self.output, 'arm64')

    def test_host_window_is_included_in_opensuperficies_asset(self):
        source = self.root / 'bin'
        source.mkdir()
        for name in ('srf-identity-surface', 'srf-host-window'):
            (source / name).write_bytes(b'binary fixture')
        result = assets.build_opensuperficies_asset(source, self.output, 'x64')
        with tarfile.open(result) as tf:
            self.assertTrue(tf.getmember('opensuperficies/bin/srf-host-window').mode & 0o111)


if __name__ == '__main__':
    unittest.main()
