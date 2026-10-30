"""STOP fixtures and mutation controls against the pinned runner."""
import json
import stat
import time
import unittest
from unittest.mock import patch
from tests import test_mw_owner as fixture
from metaviewer_agents.mw_owner import OwnerRefused


class HandoffTests(unittest.TestCase):
    setUp = fixture.OwnerTests.setUp
    remove_private_imports = fixture.OwnerTests.remove_private_imports
    install_backend = fixture.OwnerTests.install_backend
    assert_summary = fixture.OwnerTests.assert_summary
    rewrite = fixture.OwnerTests.rewrite

    def wall_backend(self, evidence, after=0):
        self.install_backend()
        original = self.owner.backend.call
        def call(stage, **args):
            result = original(stage, **args)
            if stage == 'observe' and len(self.proposals) >= after:
                result.update(evidence)
            return result
        self.owner.backend.call = call

    def test_stop_reasons_private_record_summary_and_absorbing_latch(self):
        fixtures = [
            ('google_sorry', dict(url='https://www.google.com/sorry/index?secret=private')),
            ('recaptcha_v2', dict(frame_urls=['https://www.google.com/recaptcha/api2/anchor?k=private'])),
            ('turnstile_challenge', dict(frame_urls=['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget'])),
            ('cloudflare_challenge', dict(headers={'cf-mitigated': 'challenge', 'content-type': 'text/html'})),
            ('unusual_traffic', {}),
            ('login_wall', dict(observed_wall={'kind': 'login_wall', 'observed': True})),
            ('captcha_wall', dict(observed_wall={'kind': 'captcha_wall', 'observed': True})),
        ]
        # Each receipt needs a fresh invocation and private output.
        for reason, evidence in fixtures:
            with self.subTest(reason=reason):
                self.owner.output = self.evidence / (reason + '.json')
                from metaviewer_agents.mw_handoff import HandoffLatch
                self.owner.handoff = HandoffLatch(self.owner.output.with_suffix('.handoff.json'))
                self.owner.events = []
                self.owner.cancelled = False
                self.wall_backend(evidence)
                original = self.owner.backend.call
                def call(stage, **args):
                    result = original(stage, **args)
                    if stage == 'state':
                        cues = {
                            'recaptcha_v2': ('checkbox', "I'm not a robot"),
                            'turnstile_challenge': ('checkbox', 'Verify you are human'),
                            'unusual_traffic': ('heading', 'Our systems have detected unusual traffic from your computer network.'),
                        }
                        if reason in cues:
                            role, name = cues[reason]
                            result['nodes'][0].update(role=role, name=name)
                    return result
                self.owner.backend.call = call
                result = self.owner.run()
                self.assertEqual((result.rc, result.verdict_code), (4, 'HUMAN_HANDOFF'))
                self.assert_summary(result)
                self.assertEqual(result.handoff_path, str(self.owner.handoff.path))
                self.assertIn(self.owner.handoff.path.name, result.summary['evidence_refs'])
                raw = self.owner.handoff.path.read_text()
                record = json.loads(raw)
                self.assertEqual(set(record), {'schema', 'surface_id', 'step_index', 'reason', 'confidence', 'evidence_kinds'})
                self.assertEqual(record['reason'], reason)
                self.assertEqual(record['step_index'], 1)
                self.assertEqual(stat.S_IMODE(self.owner.handoff.path.stat().st_mode), 0o600)
                for secret in ('private', '?', 'cookie', 'Our systems', "I'm not a robot"):
                    self.assertNotIn(secret, raw)
                self.assertEqual(self.proposals, [])
                calls = self.calls[:]
                for invoke in (
                    lambda: self.owner.send(dict(kind='key', key_name='Tab'), None),
                    lambda: self.owner.send(dict(kind='type', text='secret'), None),
                    lambda: self.owner.send_private({}, None, b'secret'),
                    lambda: self.owner.action({}, None),
                    lambda: self.owner.sense(time.monotonic_ns() + 1000000000),
                    self.owner.run,
                ):
                    with self.assertRaisesRegex(OwnerRefused, 'MW_HANDOFF_REQUIRED'):
                        invoke()
                self.assertEqual(self.calls, calls)  # MUT-RETRY-LOOP / MUT-AUTO-SOLVE.
                self.assertEqual(self.owner.handoff.path.read_text(), raw)

    def test_stop_after_verified_input_has_no_next_propose(self):
        self.wall_backend(dict(url='https://google.com/sorry'), after=1)
        result = self.owner.run()
        self.assertEqual(result.rc, 4)
        self.assertEqual(len(self.proposals), 1)
        self.assert_summary(result)
        self.assertEqual(json.loads(self.owner.handoff.path.read_text())['step_index'], 1)

    def test_pre_send_current_observation_stops_before_intent(self):
        self.install_backend()
        check = self.owner.check
        def checked(*args):
            if len(args) > 1 and args[0] == 'send':
                self.wall_backend(dict(url='https://google.com/sorry'))
            return check(*args)
        self.owner.check = checked
        result = self.owner.run()
        self.assertEqual(result.rc, 4)
        self.assert_summary(result)
        self.assertEqual(self.proposals, [])
        self.assertFalse(any(json.loads(raw)['kind'] == 'intent' for raw in self.owner.events))

    def test_wall_during_pace_stops_before_next_intent(self):
        self.rewrite(lambda w, s: w['execution_policy'].update(min_action_pace_ms=5000))
        self.install_backend()
        original = self.owner.backend.call
        wall = False
        def call(stage, **args):
            result = original(stage, **args)
            if stage == 'observe' and wall:
                result['url'] = 'https://google.com/sorry'
            return result
        def during_pace(seconds):
            nonlocal wall
            self.assertGreater(seconds, 0)
            self.assertEqual(len(self.proposals), 1)
            wall = True
        self.owner.backend.call = call
        with patch('metaviewer_agents.mw_owner.time.sleep', side_effect=during_pace) as sleep:
            result = self.owner.run()
        sleep.assert_called_once()
        self.assertEqual((result.rc, result.verdict_code), (4, 'HUMAN_HANDOFF'))
        self.assert_summary(result)
        self.assertEqual(len(self.proposals), 1)
        self.assertEqual(sum(json.loads(raw)['kind'] == 'intent' for raw in self.owner.events), 1)
        self.assertEqual(result.handoff_path, str(self.owner.handoff.path))
        self.assertIn(self.owner.handoff.path.name, result.summary['evidence_refs'])
        self.assertEqual(json.loads(self.owner.handoff.path.read_text())['reason'], 'google_sorry')

    def test_observed_wall_allows_extra_metadata(self):
        self.wall_backend(dict(observed_wall=dict(kind='login_wall', observed=True, confidence=99)))
        result = self.owner.run()
        self.assertEqual((result.rc, result.verdict_code), (4, 'HUMAN_HANDOFF'))
        self.assert_summary(result)
        self.assertEqual(self.proposals, [])
        record = json.loads(self.owner.handoff.path.read_text())
        self.assertEqual(record['reason'], 'login_wall')
        self.assertEqual(record['evidence_kinds'], ['ax_role_name'])

    def test_wender_fixture_negatives_do_not_stop(self):
        self.install_backend()
        for role, name in (('dialog', 'Cookie consent'), ('button', 'Accept all cookies'),
                           ('button', 'Log in'), ('textbox', 'Password'), ('button', 'Verify'),
                           ('checkbox', 'Verify you are human'), ('checkbox', "I'm not a robot")):
            with self.subTest(name=name):
                sensed = dict(frame={'surface_id': 'owned'}, state={'nodes': [{'role': role, 'name': name}]})
                self.assertFalse(self.owner.handoff.inspect(sensed, 1, self.owner.write))
        for observed in (False, 1, None):
            sensed = dict(frame={'surface_id': 'owned'}, state={'nodes': []},
                          observed={'observed_wall': {'kind': 'login_wall', 'observed': observed}})
            self.assertFalse(self.owner.handoff.inspect(sensed, 1, self.owner.write))
        for frame in ('https://www.google.com/recaptcha/api2/anchor?size=invisible',
                      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/script.js'):
            sensed = dict(frame={'surface_id': 'owned'}, state={'nodes': [
                {'role': 'checkbox', 'name': "I'm not a robot"},
                {'role': 'checkbox', 'name': 'Verify you are human'}]},
                observed={'frame_urls': [frame]})
            self.assertFalse(self.owner.handoff.inspect(sensed, 1, self.owner.write))
        self.assertFalse(self.owner.handoff.path.exists())


if __name__ == '__main__':
    unittest.main()
