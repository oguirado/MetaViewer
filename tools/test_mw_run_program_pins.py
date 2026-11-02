"""Pinned planner integration; run with the dependency roots from deps.lock."""
import copy
import hashlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mw_run_program as program
from metaviewer_agents.perception.base import Frame, PerceptionError
from metaviewer_agents.perception.deps_lock import resolve_locked_component
from metaviewer_agents.observe import ObservationError
from test_mw_run_program import frame


class PinnedProgramTests(unittest.TestCase):
    def test_actual_static_first_frame_needs_real_marks_for_localization(self):
        pixels = bytearray(b'\xff' * (100 * 80 * 3))
        for y in range(20, 40):
            for x in range(20, 52):
                if y in (20, 39) or x in (20, 51):
                    offset = (y * 100 + x) * 3
                    pixels[offset:offset + 3] = b'\0\0\0'
        image = Frame(100, 80, bytes(pixels))
        ref = dict(frame(), sha256=hashlib.sha256(image.data).hexdigest())
        plain = program.VCorePerceptionAdapter(verify_lock=True, timeout=10)
        try:
            no_marks = plain.perceive(ref, image)
            self.assertEqual(program.project_element_table(ref, no_marks)['elements'], [])
        finally:
            plain.close()
        with program.marks_workspace() as marks:
            adapter = program.VCorePerceptionAdapter(verify_lock=True, timeout=10, marks_out=marks)
            try:
                vision = adapter.perceive(ref, image)
                elements = program.project_element_table(ref, vision)['elements']
                self.assertTrue(elements)
                payload = adapter.last_c2_payload
                self.assertEqual(payload['frame_sha256'], ref['sha256'])
                payload['marks'].clear()
                self.assertTrue(adapter.last_c2_payload['marks'])
                self.assertTrue(marks.is_file())
                self.assertTrue(marks.is_relative_to('/dev/shm/vqa-cu'))
                with self.assertRaises(PerceptionError):
                    adapter.perceive(dict(ref, ramws_path='/dev/shm/nonexistent-program-test-frame'))
                self.assertIsNone(adapter.last_c2_payload)
            finally:
                adapter.close()
        self.assertFalse(marks.exists())

    def test_actual_pinned_wender_cli_plans_goal_bound_click_without_url_or_ax(self):
        root = resolve_locked_component('wender-agent')
        planner = program.WenderSubprocessAdapter(wender_root=root, verify_lock=True,
            command=[sys.executable, '-m', 'wender.plan.cli'])
        observation = program.build_observation(frame(), surface_id='surface-alice', generation=1)
        table = dict(schema='vqa.element-table/v1', frame_sha256='a' * 64,
            width=100, height=80, elements=[
                dict(bbox=dict(x=10,y=20,w=20,h=20), role='button', name='Covered square', score_ppm=900000),
                dict(bbox=dict(x=60,y=20,w=20,h=20), role='button', name='Menu', score_ppm=900000)])
        action, expectation, state, target = planner.plan_step(observation, table, 'Covered square')
        self.assertEqual(action, dict(type='click', x=20, y=30, button='left'))
        self.assertEqual(target['name'], 'Covered square')
        self.assertEqual(expectation['type'], 'changed_region')
        self.assertIsNone(state['source']['url'])
        wrong = copy.deepcopy(table)
        wrong['frame_sha256'] = 'b' * 64
        with self.assertRaises(ObservationError):
            planner.plan_step(observation, wrong, 'Covered square')

    def test_real_vision_adapter_refuses_unavailable_frame(self):
        adapter = program.VCorePerceptionAdapter(verify_lock=True)
        try:
            missing = dict(frame(), ramws_path='/dev/shm/nonexistent-program-test-frame')
            with self.assertRaises(PerceptionError):
                adapter.perceive(missing)
        finally:
            adapter.close()


if __name__ == '__main__':
    unittest.main()
