"""Replay a core publication during the browser's durable dispatch intent."""
import copy
import unittest
from unittest.mock import patch

from tests import test_mw_rebind_caret as replay_module

goal = replay_module.goal


class DispatchPublicationRaceTests(unittest.TestCase):
    def setUp(self):
        self.replay = replay_module.CaretRebindTests()
        self.replay.setUp()
        self.addCleanup(self.replay.doCleanups)

    def run_race(self, *, always_stale=False, journal_error=False,
                 stale_type_once=False, type_transport_error=False,
                 stale_type_round=False, focus_loss=False, budget_exhaustion=False):
        replay = self.replay
        current = {}
        publication, submit, journal = replay.publication, replay.submit, goal.atomic_journal
        self.proposals = []
        self.records = []
        refused_type = False
        stale_types = 0

        def publish(*args, **kwargs):
            observed = publication(*args, **kwargs)
            current.update(observed['frame_ref'])
            return observed

        def durable(path, value, **kwargs):
            if path.name.startswith('dispatch-'):
                if journal_error:
                    raise OSError('dispatch journal unavailable')
                self.records.append(copy.deepcopy(value))
                result = journal(path, value, **kwargs)
                # Same pixels, new generation: admission must still refuse an
                # old binding. No refresh fence and no stale observe involved.
                current.update(replay.frame(replay.off))
                replay.events.append('journal_publication')
                return result
            return journal(path, value, **kwargs)

        def admit(proposal, **kwargs):
            nonlocal refused_type, stale_types
            self.proposals.append(copy.deepcopy(proposal))
            binding = proposal['based_on_frame']
            if stale_type_round and proposal['action']['type'] == 'type' and stale_types < 3:
                stale_types += 1
                if stale_types == 3:
                    if focus_loss:
                        replay.fixture.row['focused'] = False
                        replay.fixture.row['states']['focused'] = False
                    if budget_exhaustion:
                        replay.b.run_deadline_ns = 0
                raise goal.host.tools.ToolRefusal('STALE_FRAME', None)
            if stale_type_once and proposal['action']['type'] == 'type' and not refused_type:
                refused_type = True
                raise goal.host.tools.ToolRefusal('STALE_FRAME', None)
            if always_stale or any(binding[k] != current[k] for k in ('sha256', 'generation')):
                raise goal.host.tools.ToolRefusal('STALE_FRAME', None)
            result = submit(proposal, **kwargs)
            if type_transport_error and proposal['action']['type'] == 'type':
                raise TimeoutError('reply lost after text delivery')
            return result

        with patch.object(replay, 'publication', side_effect=publish), \
             patch.object(replay, 'submit', side_effect=admit), \
             patch.object(goal, 'atomic_journal', side_effect=durable):
            return replay.run_goal()

    def test_publication_during_journal_rebinds_before_submit_once_per_action(self):
        moves = self.run_race()
        self.assertEqual([p['action']['type'] for p in self.proposals], ['click', 'type', 'key'])
        self.assertEqual([r['status'] for r in self.replay.b.frame_attempts], ['admitted'] * 3)
        self.assertEqual(len(moves), 3)
        self.assertEqual(self.replay.events[-2:], ['publication', 'submit'])
        for candidate, proposal in zip(self.records, self.proposals):
            self.assertEqual(candidate['binding_status'], 'candidate_before_rebind')
            self.assertEqual(candidate['proposal']['proposal_id'], proposal['proposal_id'])
            self.assertGreater(proposal['based_on_frame']['generation'],
                               candidate['proposal']['based_on_frame']['generation'])
        final = self.replay.b.attempts[-1]['submitted_proposal']
        self.assertEqual(final, self.proposals[-1])

    def test_actual_stale_admission_still_exhausts_without_dispatch(self):
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_STALE_FRAME_EXHAUSTED'):
            self.run_race(always_stale=True)
        self.assertEqual([r['status'] for r in self.replay.b.frame_attempts], ['STALE_FRAME'] * 9)
        self.assertEqual(self.replay.submitted, [])

    def test_stale_round_then_admitted_delivers_text_once(self):
        moves = self.run_race(stale_type_round=True)
        self.assertEqual(len(moves), 3)
        self.assertEqual([p['action']['type'] for p in self.replay.submitted],
                         ['click', 'type', 'key'])
        self.assertEqual([r['status'] for r in self.replay.b.frame_attempts],
                         ['admitted'] + ['STALE_FRAME'] * 3 + ['admitted'] * 2)
        self.assertEqual(len(self.replay.b.attempts), 3)
        self.assertEqual(len(list(self.replay.b.evidence.glob('intent-*.json'))), 3)
        self.assertTrue(all(a['status'] == 'verified_move' for a in self.replay.b.attempts))

    def test_focus_loss_during_round_retry_never_delivers_text(self):
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_BROWSER_FOCUS'):
            self.run_race(stale_type_round=True, focus_loss=True)
        self.assertEqual([p['action']['type'] for p in self.replay.submitted], ['click'])
        self.assertEqual(len(self.proposals), 4)
        self.assertEqual(len(self.replay.b.attempts), 2)

    def test_budget_exhaustion_during_round_retry_never_delivers_text(self):
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_PROGRAM_DEADLINE'):
            self.run_race(stale_type_round=True, budget_exhaustion=True)
        self.assertEqual([p['action']['type'] for p in self.replay.submitted], ['click'])
        self.assertEqual(len(self.proposals), 4)

    def test_rebind_pixels_round_never_retries(self):
        self.replay.b.rebind_caret_keys = False
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_STALE_FRAME_EXHAUSTED'):
            self.run_race()
        self.assertEqual([r['status'] for r in self.replay.b.frame_attempts],
                         ['admitted', 'admitted'] + ['MW_REBIND_PIXELS'] * 3)
        self.assertEqual([p['action']['type'] for p in self.replay.submitted], ['click', 'type'])

    def test_journal_failure_never_submits(self):
        with self.assertRaisesRegex(OSError, 'dispatch journal unavailable'):
            self.run_race(journal_error=True)
        self.assertEqual(self.proposals, [])

    def test_stale_type_retries_only_refused_input_and_sends_text_once(self):
        self.run_race(stale_type_once=True)
        self.assertEqual([p['action']['type'] for p in self.proposals],
                         ['click', 'type', 'type', 'key'])
        self.assertEqual([p['action']['type'] for p in self.replay.submitted],
                         ['click', 'type', 'key'])
        self.assertEqual([r['status'] for r in self.replay.b.frame_attempts],
                         ['admitted', 'STALE_FRAME', 'admitted', 'admitted'])

    def test_transport_failure_after_text_delivery_never_retries(self):
        with self.assertRaisesRegex(TimeoutError, 'reply lost after text delivery'):
            self.run_race(type_transport_error=True)
        self.assertEqual([p['action']['type'] for p in self.proposals], ['click', 'type'])
        self.assertEqual([p['action']['type'] for p in self.replay.submitted], ['click', 'type'])

    def test_journal_time_is_charged_before_rebind(self):
        replay = self.replay
        b, f = replay.b, replay.fixture
        sensed = b.perceive(f.observe(1000))
        b.active_attempt = dict(intent_artifact='fixture-intent')
        now = 0

        def durable(*args, **kwargs):
            nonlocal now
            now = 1_000_000_001
            return 'fixture-dispatch'

        with patch.object(goal, 'atomic_journal', side_effect=durable), \
             patch.object(goal.host.time, 'monotonic_ns', side_effect=lambda: now), \
             patch.object(b, 'rebind') as rebind, \
             patch.object(goal.host.tools, 'propose') as submit:
            with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_STALE_FRAME_EXHAUSTED'):
                b.propose(sensed, dict(action=dict(type='click', x=30, y=30, button='left'),
                    expectation=dict(type='changed_region', bbox=dict(x=0, y=0, w=100, h=80))), 1000)
        rebind.assert_not_called()
        submit.assert_not_called()


if __name__ == '__main__':
    unittest.main()
