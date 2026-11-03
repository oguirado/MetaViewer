"""Release archives retain supplied legal text without granting component rights."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_notices', ROOT / 'tools/build_release_assets.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class ReleaseNoticesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='release-Música-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.out = self.root / 'out'
        self.out.mkdir()

    def test_app_product_notices_are_sealed_and_electron_license_survives(self):
        app = self.root / 'MetaViewer-linux-x64'
        app.mkdir()
        (app / 'metaviewer').write_bytes(b'app')
        (app / 'metaviewer').chmod(0o755)
        (app / 'LICENSE').write_bytes(b'Electron license')
        # A supplied manifest predating product notices must not be reused.
        (self.root / 'MetaViewer-linux-x64.sha256').write_text('stale manifest\n')
        archive = assets.build_app_asset(app, self.out, 'x64')
        with tarfile.open(archive) as tf:
            self.assertEqual(tf.extractfile(app.name + '/LICENSE').read(), b'Electron license')
            manifest = tf.extractfile(app.name + '.sha256').read().decode()
            for source, dest in [('LICENSE', 'licenses/metaviewer/LICENSE'),
                                 ('NOTICE-EVALUATION.md', 'licenses/metaviewer/NOTICE-EVALUATION.md')]:
                data = tf.extractfile(app.name + '/' + dest).read()
                self.assertEqual(data, (ROOT / source).read_bytes())
                self.assertIn(hashlib.sha256(data).hexdigest() + '  ' + dest + '\n', manifest)
            for line in manifest.splitlines():
                digest, name = line[:64], line[66:]
                self.assertEqual(hashlib.sha256(tf.extractfile(app.name + '/' + name).read()).hexdigest(), digest)
        self.assertFalse((app / 'licenses/metaviewer/LICENSE').exists())

    def test_node_license_is_required_and_copied_verbatim(self):
        node = self.root / 'runtime/bin/node'
        node.parent.mkdir(parents=True)
        node.write_bytes(b'node')
        license_path = node.parent.parent / 'LICENSE'
        license_path.write_bytes(b'upstream Node license\n')
        archive = assets.build_node_asset(self.out, 'x64', node_bin=node)
        with tarfile.open(archive) as tf:
            self.assertEqual(tf.extractfile('node-v24-linux-x64/LICENSE').read(), license_path.read_bytes())
        license_path.unlink()
        with self.assertRaisesRegex(assets.AssetBuildError, 'LICENSE'):
            assets.build_node_asset(self.out, 'x64', node_bin=node)

    def test_supplied_node_archive_must_include_regular_runtime_license(self):
        archive = self.root / 'node.tar.xz'
        for licensed in (False, True):
            with tarfile.open(archive, 'w:xz') as tf:
                for name, data in [('node/bin/node', b'node')] + ([('node/LICENSE', b'Node license')] if licensed else []):
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    tf.addfile(member, io.BytesIO(data))
            if licensed:
                result = assets.build_node_asset(self.out, 'x64', node_tarball=archive)
                self.assertEqual(result.read_bytes(), archive.read_bytes())
            else:
                with self.assertRaisesRegex(assets.AssetBuildError, 'LICENSE'):
                    assets.build_node_asset(self.out, 'x64', node_tarball=archive)

    def test_opensuperficies_preserves_notices_from_flat_and_staged_inputs(self):
        for staged in (False, True):
            source = self.root / str(staged)
            binaries = source / 'bin' if staged else source
            binaries.mkdir(parents=True)
            (binaries / 'srf-identity-surface').write_bytes(b'binary')
            for parent in {source, binaries}:
                (parent / 'NOTICE-EVALUATION.md').write_bytes(b'supplied terms only')
                (parent / 'LICENSE').write_bytes(b'upstream license')
                (parent / 'THIRD_PARTY_NOTICES.txt').write_bytes(b'upstream dependency notices')
                (parent / 'private-source.py').write_bytes(b'not a release notice')
            archive = assets.build_opensuperficies_asset(source, self.out, 'x64')
            with tarfile.open(archive) as tf:
                for parent in {source, binaries}:
                    relative = parent.relative_to(source).as_posix()
                    prefix = 'opensuperficies/' + (relative + '/' if staged and relative != '.' else ('bin/' if not staged else ''))
                    for name in ('NOTICE-EVALUATION.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'):
                        member = tf.getmember(prefix + name)
                        self.assertEqual(member.mode, 0o644)
                        self.assertEqual(tf.extractfile(member).read(), (parent / name).read_bytes())
                self.assertFalse(any('private-source' in name for name in tf.getnames()))

    def test_quickstart_obtains_matching_public_tag_before_fetch(self):
        text = (ROOT / 'docs/JUDGE_QUICKSTART.md').read_text()
        acquisition = text.split('From a fresh clone')[1].split('Set these variables')[0]
        self.assertIn('https://github.com/oguirado/MetaViewer.git', acquisition)
        self.assertIn('--branch "$RELEASE_TAG"', acquisition)
        self.assertLess(acquisition.index('git clone'), acquisition.index('fetch_assets.py'))
        self.assertIn('cd MetaViewer', acquisition)
        self.assertIn('same release', acquisition)
