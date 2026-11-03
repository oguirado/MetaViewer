"""Reject unusable supplied release assets before publishing checksums."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('l1_assets', ROOT / 'tools/build_release_assets.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class ReleaseAssetsL1(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='assets-Música-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.out = self.root / 'out'
        self.out.mkdir()

    def archive(self, files):
        archive = self.root / 'input.tar'
        with tarfile.open(archive, 'w') as tf:
            for name, data in files:
                m = tarfile.TarInfo(name)
                if data is None:
                    m.type = tarfile.SYMTYPE
                    m.linkname = '/bin/false'
                    tf.addfile(m)
                else:
                    m.size = len(data)
                    tf.addfile(m, io.BytesIO(data))
        return archive

    def test_b506_node_executable_must_be_unique_and_regular(self):
        for entries in ([('node/bin/node', None)],
                        [('node/bin/node', b'node'), ('node/bin/node', b'other')]):
            with self.subTest(entries=entries):
                archive = self.archive(entries + [('node/LICENSE', b'existing upstream text')])
                with self.assertRaises(assets.AssetBuildError):
                    assets.build_node_asset(self.out, 'x64', node_tarball=archive)
                self.assertFalse((self.out / 'SHA256SUMS').exists())
                self.assertFalse((self.out / 'node-linux-x64.tar.xz').exists())

    def image_files(self, tags=None):
        manifest = [{'Config': 'config.json', 'Layers': ['layer/layer.tar'],
                     'RepoTags': assets.default_image_tags('x64') if tags is None else tags}]
        return [('manifest.json', json.dumps(manifest).encode()),
                ('config.json', b'{}'), ('layer/layer.tar', b'layer bytes')]

    def test_b507_reject_nonimage_missing_tags_and_missing_layers(self):
        cases = [[('unrelated', b'not images')], self.image_files(['unrelated:latest']),
                 self.image_files()[:-1], [('manifest.json', b'not json')],
                 self.image_files() + [('manifest.json', b'[]')]]
        for files in cases:
            with self.subTest(files=files):
                with self.assertRaises(assets.AssetBuildError):
                    assets.build_images_asset(self.out, 'x64', images_tar=self.archive(files))
                self.assertFalse((self.out / 'images-linux-x64.tar').exists())
                self.assertFalse((self.out / 'SHA256SUMS').exists())

    def test_b507_complete_image_save_and_custom_tags_remain_accepted(self):
        for tags in (None, ['operator-image:custom']):
            archive = self.archive(self.image_files(tags))
            result = assets.build_images_asset(self.out, 'x64', images_tar=archive, image_tags=tags)
            self.assertEqual(result.read_bytes(), archive.read_bytes())
