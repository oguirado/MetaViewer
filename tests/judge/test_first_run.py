"""Fresh-host paths and negative controls; all assets and host commands are fake."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

from tests.judge.judge_sandbox import Sandbox, make_tar

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('judge_fetch', ROOT / 'scripts/judge/fetch_assets.py')
fetch_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_module)


class FirstRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sb = Sandbox(self.root / 'sandbox', arch='x86_64')
        self.addCleanup(self.sb.cleanup)

    def test_before_install_ignores_installed_images_and_profile(self):
        self.sb.put('images', '')
        self.sb.put('network', '')
        self.assertEqual(self.sb.judge('doctor', '--capsules', '--before-install').rc, 0)
        result = self.sb.judge('doctor', '--capsules')
        self.assertEqual(result.rc, 2)
        self.assertIn('JUDGE_IMAGE', result.codes)

    def test_t1_ram_and_disk_are_enforced(self):
        # The sandbox exposes /proc through a real fixture file.
        (self.sb.proc / 'meminfo').write_text('MemTotal: 16777216 kB\nMemAvailable: 1 kB\n')
        self.assertIn('JUDGE_RAM', self.sb.judge('doctor', '--before-install').codes)
        (self.sb.proc / 'meminfo').write_text('MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n')
        self.sb.set_df(home=1_999_999_999)
        self.assertIn('JUDGE_DISK', self.sb.judge('doctor', '--before-install').codes)
        self.sb.set_df(home=2_000_000_000)
        self.assertEqual(self.sb.judge('doctor', '--before-install').rc, 0)

    def test_headless_install_refuses_before_extracting_the_app(self):
        self.sb.full_kit()
        result = self.sb.judge('install', env={'DISPLAY': None})
        self.assertIn('JUDGE_DISPLAY', result.codes)
        self.assertIn('xvfb-run -a bash', result.err)
        self.assertFalse((self.sb.jh / 'app').exists())
        self.assertNotIn('--smoke', self.sb.log('node.log'))

    def test_legacy_only_kit_does_not_install_open_firewall(self):
        self.sb.full_kit(t2=True)
        asset = self.sb.assets / 'images-linux-x64.tar'
        asset.write_text(asset.read_text().replace('opensuperficies-identity-browser-x64:0.2.0\n', ''))
        self.sb.write_sums()
        self.sb.make_t2_ready_for_install()
        result = self.sb.judge('install', '--capsules', '--yes')
        self.assertEqual(result.rc, 0, result.text)
        self.assertFalse(self.sb.witness.exists())
        self.assertIn('Legacy network reaches no public site today', result.out)
        self.assertIn('net up', self.sb.log('srf.log'))

    def test_official_style_node_archive_preserves_npm_without_links(self):
        self.sb.full_kit()
        self.sb.put('node_version', 'v18.0.0\n')
        self.sb.add_node_asset()
        archive = self.sb.assets / 'node-linux-x64.tar.xz'
        make_tar(archive, [('node-v24/bin/node', b'#!/bin/sh\necho v24.1.0\n', 0o755),
                           ('node-v24/lib/node_modules/npm/bin/npm-cli.js', b'// npm\n', 0o644),
                           ('node-v24/bin/npm', ('symlink', '../lib/node_modules/npm/bin/npm-cli.js'), 0o777)], 'w:xz')
        self.sb.write_sums()
        result = self.sb.judge('install')
        self.assertEqual(result.rc, 0, result.text)
        npm = self.sb.jh / 'node/bin/npm'
        self.assertTrue(npm.is_file())
        self.assertFalse(npm.is_symlink())
        self.assertIn('npm-cli.js', npm.read_text())

    def test_local_fetch_checks_all_selected_assets_before_publication(self):
        self.sb.full_kit()
        self.sb.add_node_asset()
        self.sb.write_sums()
        dest = self.root / 'download'
        fetch_module.fetch(str(self.sb.assets), dest, 'x64')
        self.assertTrue((dest / 'SHA256SUMS').is_file())
        (self.sb.assets / 'node-linux-x64.tar.xz').write_bytes(b'tampered')
        before = (dest / 'node-linux-x64.tar.xz').read_bytes()
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            fetch_module.fetch(str(self.sb.assets), dest, 'x64')
        self.assertEqual((dest / 'node-linux-x64.tar.xz').read_bytes(), before)

    def test_missing_npm_has_a_typed_refusal_before_package_install(self):
        self.sb.full_kit()
        (self.sb.kit / 'ui/package-lock.json').write_text('{}')
        result = self.sb.judge('install')
        self.assertIn('JUDGE_NPM', result.codes)
        self.assertIn('-- fix: sudo apt-get install -y npm', result.err)
        self.assertNotIn('--smoke', self.sb.log('node.log'))

    def test_incomplete_local_tier_refuses_without_publishing_manifest(self):
        self.sb.full_kit()
        destination = self.root / 'download'
        with self.assertRaisesRegex(ValueError, 'no entry for node-linux-x64'):
            fetch_module.fetch(str(self.sb.assets), destination, 'x64')
        self.assertFalse((destination / 'SHA256SUMS').exists())

    def test_remote_fetch_requires_independent_manifest_pin(self):
        with self.assertRaisesRegex(ValueError, 'requires --sums-sha256'):
            fetch_module.fetch('https://invalid.example/release', self.root / 'download', 'x64')

    def test_wrong_manifest_pin_is_refused_locally_too(self):
        self.sb.full_kit()
        with self.assertRaisesRegex(ValueError, 'SHA256SUMS digest mismatch'):
            fetch_module.fetch(str(self.sb.assets), self.root / 'download', 'x64', sums_sha256='0' * 64)


class ReleaseNodeTests(unittest.TestCase):
    def test_builder_includes_available_npm_and_extractor_rejects_traversal(self):
        builder_spec = importlib.util.spec_from_file_location('release_builder', ROOT / 'tools/build_release_assets.py')
        builder = importlib.util.module_from_spec(builder_spec)
        builder_spec.loader.exec_module(builder)
        unpack_spec = importlib.util.spec_from_file_location('node_unpack', ROOT / 'scripts/judge/unpack_node.py')
        unpacker = importlib.util.module_from_spec(unpack_spec)
        unpack_spec.loader.exec_module(unpacker)
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            node = base / 'runtime/bin/node'
            node.parent.mkdir(parents=True)
            node.write_bytes(b'node')
            (node.parent.parent / 'LICENSE').write_bytes(b'Node fixture license\n')
            cli = base / 'runtime/lib/node_modules/npm/bin/npm-cli.js'
            cli.parent.mkdir(parents=True)
            cli.write_bytes(b'npm')
            archive = builder.build_node_asset(base, 'x64', node_bin=node)
            output = base / 'unpacked'
            unpacker.unpack(archive, output)
            self.assertEqual((output / 'lib/node_modules/npm/bin/npm-cli.js').read_bytes(), b'npm')
            self.assertTrue((output / 'bin/npm').is_file())
            make_tar(archive, [('node-v24/../../escape', b'bad', 0o644)], 'w:xz')
            with self.assertRaisesRegex(ValueError, 'unsafe Node member'):
                unpacker.unpack(archive, base / 'bad')
            self.assertFalse((base / 'escape').exists())
