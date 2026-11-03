"""Replay native ordering and retained RGB phases without live input."""
import copy
import hashlib
import unittest
from unittest.mock import Mock, patch

from tests import test_mw_browser_goal as fixture_module

goal = fixture_module.goal


class CaretRebindTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_module.BrowserGoalTests('test_real_planner_click_and_journals')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.b = f.b
        self.b.pending = {}
        self.b.ownership = Mock()
        self.b.network_context = Mock()
        self.b.propose = goal.host.HostBackend.propose.__get__(self.b)
        self.b.ax = Mock(side_effect=lambda: dict(elements=[copy.deepcopy(f.row)], window={}))
        f.args.text, f.args.key, f.args.steps = 'OperatorName', 'Enter', 3
        self.off = (f.root / 'frame.rgb').read_bytes()
        pixels = bytearray(self.off)
        for y in range(22, 37):
            offset = (y * 100 + 30) * 3
            pixels[offset:offset+3] = b'\0\0\0'
        self.on = bytes(pixels)
        self.events, self.submitted = [], []
        self.phase = 0
        self.final_change = None
        self.last_change = None

    def frame(self, pixels):
        f = self.fixture
        digest = hashlib.sha256(pixels).hexdigest()
        path = f.root / (digest + '-source.rgb')
        path.write_bytes(pixels)
        f.frame['generation'] += 1
        return dict(f.frame, sha256=digest, ramws_path=str(path))

    def publication(self, *args, **kwargs):
        # Rebind order: native AX -> initial pixels -> retain -> latest pixels
        # -> retain -> final pixels. Slow capture can flip at that final read.
        is_key = len(self.submitted) == 2
        self.events.append('publication')
        pixels = self.off
        if is_key:
            self.phase += 1
            if self.phase % 3 == 2:
                pixels = self.final_change or self.on
            if self.phase % 3 == 0 and self.last_change is not None:
                pixels = self.last_change
        return dict(frame_ref=self.frame(pixels))

    def submit(self, proposal, **kwargs):
        self.events.append('submit')
        self.submitted.append(copy.deepcopy(proposal))
        action = proposal['action']
        f = self.fixture
        if action['type'] == 'click':
            f.row['focused'] = f.row['states']['focused'] = True
        elif action['type'] == 'type':
            f.row['value'] = action['text']
            f.row['value_len'] = len(action['text'])
        return dict(decision='admitted')

    def run_goal(self):
        b, f = self.b, self.fixture
        retain = b.retain
        observe = b.observe_for_rebind
        def initial(timeout_ms):
            self.phase = 0
            return observe(timeout_ms)
        def keep(frame):
            self.events.append('retain')
            return retain(frame)
        with patch.object(goal.host.tools, 'observe', side_effect=self.publication), \
             patch.object(goal.host.tools, 'propose', side_effect=self.submit), \
             patch.object(goal.host.tools, 'wait_verify',
                          return_value=dict(native_evidence=dict(surface_id=b.surface_id))), \
             patch.object(b, 'observe_for_rebind', side_effect=initial), \
             patch.object(b, 'retain', side_effect=keep):
            return goal.run_moves(b, f.planner, f.args)

    def test_real_order_caret_flip_at_final_read_sends_enter_once(self):
        moves = self.run_goal()
        self.assertEqual([m['action']['type'] for m in moves], ['click', 'type', 'key'])
        self.assertEqual([p['action']['type'] for p in self.submitted], ['click', 'type', 'key'])
        self.assertEqual([r['status'] for r in self.b.frame_attempts], ['admitted'] * 3)
        self.assertEqual(moves[1]['text_gate']['status'], 'exact_native_readback')
        self.assertEqual(self.phase, 3)
        # Retained off-phase witness must match the final publication, with no
        # further native capture or file read between final binding and input.
        self.assertEqual(self.events[-2:], ['publication', 'submit'])
        pending = self.b.pending[self.submitted[-1]['proposal_id']][1]
        self.assertEqual(pending['sha256'], hashlib.sha256(self.off).hexdigest())
        self.assertEqual(self.submitted[-1]['based_on_frame']['sha256'], pending['sha256'])

    def test_old_gate_exhausts_same_caret_only_order_without_repeating_text(self):
        self.b.rebind_caret_keys = False
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_STALE_FRAME_EXHAUSTED'):
            self.run_goal()
        self.assertEqual([p['action']['type'] for p in self.submitted], ['click', 'type'])
        self.assertEqual([r['status'] for r in self.b.frame_attempts],
                         ['admitted', 'admitted'] + ['MW_REBIND_PIXELS'] * 3)

    def test_content_change_in_final_frame_refuses_without_enter(self):
        pixels = bytearray(self.on)
        pixels[(25 * 100 + 34)*3:(25 * 100 + 34)*3+3] = b'\0\0\0'
        self.final_change = bytes(pixels)
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_STALE_FRAME_EXHAUSTED'):
            self.run_goal()
        self.assertEqual([p['action']['type'] for p in self.submitted], ['click', 'type'])

    def test_third_pixel_state_after_classification_still_refuses(self):
        pixels = bytearray(self.off)
        pixels[0:3] = b'\0\0\0'
        self.last_change = bytes(pixels)
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_STALE_FRAME_EXHAUSTED'):
            self.run_goal()
        self.assertEqual([p['action']['type'] for p in self.submitted], ['click', 'type'])

    def rebind_frames(self, action, phases, *, change=None, clock=None):
        f = self.fixture
        f.row['focused'] = f.row['states']['focused'] = True
        observed = dict(frame_ref=self.frame(self.off),
                        ax_snapshot=dict(elements=[copy.deepcopy(f.row)], window={}))
        sensed = copy.deepcopy(self.b.perceive(observed))
        if change:
            observed['ax_snapshot']['elements'][0].update(change)
        publications = [dict(frame_ref=self.frame(pixels)) for pixels in phases]
        with patch.object(self.b, 'observe_for_rebind', return_value=observed), \
             patch.object(goal.host.tools, 'observe', side_effect=publications) as observe:
            if clock is None:
                result = self.b.rebind(sensed, dict(action=action), 1000)
            else:
                with patch.object(goal.host.time, 'monotonic_ns', side_effect=clock):
                    result = self.b.rebind(sensed, dict(action=action), 1000)
            self.assertTrue(all(c.kwargs['timeout_ms'] <= 1000 for c in observe.call_args_list))
        return result

    def test_flip_at_both_pixel_checks_binds_exact_retained_on_phase(self):
        result = self.rebind_frames(dict(type='key', keys=['Return']),
                                    [self.on, self.off, self.on])
        self.assertEqual(result['frame']['sha256'], hashlib.sha256(self.on).hexdigest())
        self.assertEqual(result['frame_witness']['sha256'], result['frame']['sha256'])
        self.assertEqual(result['frame_witness']['generation'], result['frame']['generation'])

    def test_click_and_type_do_not_gain_final_caret_tolerance(self):
        for action in (dict(type='click', x=30, y=30), dict(type='type', text='hello')):
            with self.subTest(action=action), \
                 self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_REBIND_PIXELS'):
                self.rebind_frames(action, [self.off, self.on])

    def test_native_identity_value_geometry_or_focus_change_refuses(self):
        for change in (dict(id='replacement'), dict(value='changed'),
                       dict(box=[11, 20, 40, 20]),
                       dict(focused=False, states=dict(focused=False))):
            with self.subTest(change=change), \
                 self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_REBIND_TARGET'):
                self.rebind_frames(dict(type='key', keys=['Return']), [], change=change)

    def test_caret_classification_cannot_extend_remaining_deadline(self):
        with self.assertRaisesRegex(goal.host.OwnerRefused, 'MW_STALE_FRAME_EXHAUSTED'):
            self.rebind_frames(dict(type='key', keys=['Return']),
                               [self.off, self.on], clock=[0, 1_000_000_001])


if __name__ == '__main__':
    unittest.main()
