"""G-THEME and host settings regression gates, including planted violations."""
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('check_theme', ROOT / 'tools/check_theme.py')
THEME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(THEME)


class ThemeTests(unittest.TestCase):
    def test_actual_theme(self):
        self.assertGreater(THEME.check(ROOT), 0)

    def copy_theme(self, root):
        shutil.copytree(ROOT / 'ui/src/design', root / 'ui/src/design')

    def test_low_contrast_pair_rejected_in_both_modes(self):
        for scheme in ('mv-light', 'mv-dark'):
            mode = scheme.removeprefix('mv-')
            with self.subTest(scheme=scheme), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                self.copy_theme(root)
                path = root / 'ui/src/design/metaviewer.tokens.json'
                data = json.loads(path.read_text())
                data['semantic']['text']['primary']['modes'][mode + '.normal'] = '{primitive.color.neutral.0}'
                data['semantic']['surface']['canvas']['modes'][mode + '.normal'] = '{primitive.color.neutral.0}'
                path.write_text(json.dumps(data))
                # Mutate generated CSS as well: this must fail contrast, not drift.
                css = root / 'ui/src/design/metaviewer.css'
                source = css.read_text()
                selector = f':root[data-theme-scheme="{mode}"][data-theme-contrast="normal"]'
                before, body = source.split(selector, 1)
                block, after = body.split('}', 1)
                for token in ('text-primary', 'surface-canvas'):
                    block = re.sub(r'(--mv-semantic-' + token + r':)[^;]+;', r'\1 #ffffff;', block)
                css.write_text(before + selector + block + '}' + after)
                with self.assertRaisesRegex(ValueError, f'G-THEME {scheme}.*< 4.5'):
                    THEME.check(root)

    def test_new_explicit_css_pair_is_checked(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.copy_theme(root)
            (root / 'ui/src/planted.css').write_text(
                '.planted {color:var(--mv-semantic-text-primary);'
                'background:var(--mv-semantic-text-primary);}')
            with self.assertRaisesRegex(ValueError, 'G-THEME.*< 4.5'):
                THEME.check(root)

    def test_css_drift_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.copy_theme(root)
            css = root / 'ui/src/design/metaviewer.css'
            css.write_text(css.read_text().replace('--mv-semantic-text-primary: var(',
                                                   '--mv-semantic-text-primary: #ffffff; --unused: var('))
            with self.assertRaisesRegex(ValueError, 'generated CSS differs'):
                THEME.check(root)

    def test_empty_matrix_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.copy_theme(root)
            path = root / 'ui/src/design/metaviewer.tokens.json'
            data = json.loads(path.read_text())
            data['contrastPairs'] = []
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'empty contrast'):
                THEME.check(root)

    def test_malformed_usage_matrix_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.copy_theme(root)
            path = root / 'ui/src/design/metaviewer.tokens.json'
            data = json.loads(path.read_text())
            data['contrastPairs'] = [{'foreground': 'semantic.text.primary'}]
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'invalid contrast usage matrix'):
                THEME.check(root)

    def test_non_system_font_stack_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.copy_theme(root)
            path = root / 'ui/src/design/metaviewer.css'
            path.write_text(path.read_text().replace('system-ui, -apple-system',
                                                     'CustomFont, system-ui, -apple-system'))
            with self.assertRaisesRegex(ValueError, 'requires SYSTEM font stack'):
                THEME.check(root)

    def test_fonts_rejected_in_each_package_location(self):
        for location in ('ui/src', 'ui/public', 'ui/dist', 'dist'):
            for extension in ('.woff', '.woff2', '.ttf', '.otf'):
                with self.subTest(location=location, extension=extension), tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    self.copy_theme(root)
                    directory = root / location
                    directory.mkdir(parents=True, exist_ok=True)
                    (directory / ('planted' + extension.upper())).write_bytes(b'planted-font')
                    with self.assertRaisesRegex(ValueError, 'G-PKG bundled font'):
                        THEME.check(root)

    def test_settings_store_and_preload(self):
        node = shutil.which(os.environ.get('NODE', 'node'))
        self.assertIsNotNone(node, 'Node is required')
        result = subprocess.run([node, '--test', str(ROOT / 'tests/settings_store.test.mjs')],
                                cwd=ROOT, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
