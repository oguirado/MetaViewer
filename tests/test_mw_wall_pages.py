"""Synthetic page-level wall stops and ordinary-page negative controls."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host = load('wall_pages_host', ROOT / 'tools/mw_run_backend.py')


def row(role, name, **extra):
    return dict(role=role, name=name, box=[10, 20, 100, 30], **extra)


WALLS = (
    ('login_wall', [row('textbox', 'Password'), row('button', 'Sign in')]),
    ('login_wall', [row('heading', 'Sign in to your account')]),
    ('login_wall', [row('heading', '  INICIAR   SESIÓN  ')]),
    ('captcha_wall', [row('text', 'Please verify you are human before continuing')]),
    ('captcha_wall', [row('heading', 'Verify that you are human')]),
    ('captcha_wall', [row('iframe', 'reCAPTCHA')]),
    ('captcha_wall', [row('iframe', 'hCaptcha challenge')]),
    ('captcha_wall', [row('iframe', 'Widget containing a Cloudflare security challenge')]),
)


class WallPageTests(unittest.TestCase):
    def test_page_cues_without_dialogs(self):
        for expected, rows in WALLS:
            with self.subTest(rows=rows):
                self.assertEqual(host.wall_kind(dict(elements=rows)), expected)

    def test_ordinary_pages_do_not_stop(self):
        pages = (
            [row('heading', 'Daily news'), row('link', 'Sign in')],
            [row('button', 'Sign in')],
            [row('textbox', 'Password')],
            [row('heading', 'How to sign in safely'), row('link', 'Sign in')],
            [row('button', 'Verify')],
            [row('text', 'reCAPTCHA documentation')],
            [row('textbox', 'Password'), row('button', 'Change password')],
        )
        for rows in pages:
            with self.subTest(rows=rows):
                self.assertIsNone(host.wall_kind(dict(elements=rows)))

    def test_hidden_or_empty_cues_do_not_stop(self):
        for metadata in (dict(hidden=True), dict(ignored=True), dict(visible=False),
                         dict(states=dict(hidden=True)), dict(states=dict(visible=False)),
                         dict(box=[0, 0, 0, 0])):
            for _, rows in WALLS:
                with self.subTest(metadata=metadata, rows=rows):
                    hidden = [dict(r, **metadata) for r in rows]
                    self.assertIsNone(host.wall_kind(dict(elements=hidden)))
            password = dict(row('textbox', 'Password'), **metadata)
            self.assertIsNone(host.wall_kind(dict(elements=[password, row('button', 'Sign in')])))

    def test_existing_dialog_and_checkbox_cues_remain(self):
        for role, name, expected in (
            ('dialog', 'Please sign in', 'login_wall'),
            ('alertdialog', 'Log in to continue', 'login_wall'),
            ('checkbox', "I'm not a robot", 'captcha_wall'),
        ):
            self.assertEqual(host.wall_kind(dict(elements=[row(role, name)])), expected)

    def test_each_page_wall_returns_four_before_proposals_and_latches(self):
        fixtures = load('wall_pages_owner_fixture', ROOT / 'agents/tests/test_mw_owner.py')
        for expected, rows in WALLS:
            with self.subTest(rows=rows):
                fixture = fixtures.OwnerTests('test_real_gate_accepts_canonical_fixture_before_backend')
                try:
                    fixture.setUp()
                    fixture.install_backend()
                    original = fixture.owner.backend.call

                    def call(stage, **args):
                        result = original(stage, **args)
                        if stage == 'observe':
                            result['observed_wall'] = dict(observed=True, kind=host.wall_kind(dict(elements=rows)))
                        return result

                    fixture.owner.backend.call = call
                    result = fixture.owner.run()
                    self.assertEqual((result.rc, result.verdict_code), (4, 'HUMAN_HANDOFF'))
                    self.assertEqual(fixture.proposals, [])
                    import json
                    self.assertEqual(json.loads(Path(result.handoff_path).read_text())['reason'], expected)
                    calls = fixture.calls[:]
                    with self.assertRaisesRegex(host.OwnerRefused, 'MW_HANDOFF_REQUIRED'):
                        fixture.owner.run()
                    self.assertEqual(fixture.calls, calls)
                finally:
                    fixture.doCleanups()


if __name__ == '__main__':
    unittest.main()
