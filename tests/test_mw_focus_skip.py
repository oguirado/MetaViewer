"""Focus evidence uses Wender's honest satisfied_skip; core receipts stay separate."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

fixture = load('focus_fixture', ROOT / 'agents/tests/test_mw_owner.py')
host = load('focus_host', ROOT / 'tools/mw_run_backend.py')


class FocusSkipTests(unittest.TestCase):
    def run_case(self, focus=True, *, different=False, submit=False, role='textbox', mutant=None):
        f = fixture.OwnerTests('test_private_text_run_and_no_content_in_evidence')
        f.setUp()
        self.addCleanup(f.doCleanups)
        f.prepare_text('éΩ🙂')
        if submit:
            # A submit button verifies an answer, never just editor focus.
            def change(workflow, site):
                workflow['steps'][0]['verify']['predicate'] = copy.deepcopy(workflow['steps'][0]['target']['frame_predicate'])
            f.rewrite(change)
        corpus, projection = host.focus_corpus(f.corpus, f.evidence)
        f.owner = fixture.ReplayOwner(f.owner.backend, corpus, f.owner.output,
            notice=f.owner.notice, slot_values={'prompt': 'éΩ🙂'})
        original = f.owner.backend.call
        f.focused = 'Submit Greeting' if different else ('Operator Name' if focus is True else None)
        def call(stage, **kwargs):
            result = original(stage, **kwargs)
            if stage == 'state':
                result['nodes'][0]['role'] = role
            if stage == 'ax':
                for i, row in enumerate(result['nodes']):
                    row.update(id='native-' + str(i), role=role if i == 0 else 'button',
                               box=[10 + i * 100, 20, 80, 30])
                    if i == 0 and f.focused is None:
                        row['focused'] = focus
            return result
        f.owner.backend.call = call
        if mutant is None:
            result = f.owner.run()
        else:
            with patch.object(type(f.owner), 'focus_row', staticmethod(mutant)):
                result = f.owner.run()
        return f, result, projection

    def test_same_native_row_met_by_evidence_without_click(self):
        f, result, projection = self.run_case()
        self.assertEqual(result.rc, 0, result.diagnostic)
        self.assertEqual([p['type'] for p in f.proposals], ['type', 'key'])
        self.assertEqual(len(f.owner.receipts), 2)
        self.assertEqual(result.summary['steps_verified'], 2)
        self.assertEqual(result.summary['steps_skipped_satisfied'], 1)
        row = f.owner.focus_evidence[0]
        self.assertEqual((row['status'], row['result'], row['ax_row_id'], row['core_action_verified']),
                         ('met-by-evidence', 'focus: already-focused (AX)', 'native-0', False))
        self.assertTrue(f.owner.output.with_suffix('.focus.json').is_file())
        self.assertNotEqual(projection['source_sha256'], projection['projected_sha256'])
        self.assertEqual(f.corpus.workflow['steps'][0]['already_satisfied'], None)

    def test_false_null_foreign_or_button_focus_sends_click(self):
        for args in (dict(focus=False), dict(focus=None), dict(different=True), dict(role='button')):
            with self.subTest(args=args):
                f, result, _ = self.run_case(**args)
                self.assertEqual(result.rc, 0, result.diagnostic)
                self.assertEqual([p['type'] for p in f.proposals], ['click', 'type', 'key'])
                self.assertEqual(f.owner.focus_evidence, [])

    def test_non_focus_submit_is_not_projected(self):
        f, _, projection = self.run_case(submit=True)
        self.assertIsNone(projection)
        self.assertEqual(f.proposals[0]['type'], 'click')

    def test_mutant_skip_false_is_detected(self):
        f, result, _ = self.run_case(focus=False, mutant=lambda spec, sensed: sensed['ax'][0])
        # The false-focus mutant suppresses the click and cannot complete paste.
        self.assertNotEqual(result.rc, 0)
        self.assertNotIn('click', [p['type'] for p in f.proposals])

    def test_mutant_always_click_is_detected(self):
        f, result, _ = self.run_case(mutant=lambda spec, sensed: None)
        self.assertEqual(result.rc, 0)
        self.assertEqual(f.proposals[0]['type'], 'click')
        self.assertNotEqual([p['type'] for p in f.proposals], ['type', 'key'])

    def test_same_name_wrong_id_geometry_or_duplicate_never_proves_focus(self):
        from metaviewer_agents.mw_owner import ReplayOwner
        spec = dict(anchor_ref='ax:Composer')
        row = dict(id='native', name='Composer', role='textbox', focused=True, box=[0, 0, 20, 20])
        node = dict(copy.deepcopy(row), id='0000000000000000', actionable=True)
        sensed = dict(ax=[row], state=dict(nodes=[node]),
                      frame=dict(width=100, height=100))
        for mutation in ('id', 'box', 'duplicate', 'role', 'null'):
            changed = copy.deepcopy(sensed)
            if mutation == 'id': changed['ax'][0]['id'] = None
            if mutation == 'box': changed['ax'][0]['box'][0] = 1
            if mutation == 'duplicate': changed['ax'].append(dict(row, id='foreign'))
            if mutation == 'role': changed['ax'][0]['role'] = 'button'
            if mutation == 'null': changed['ax'][0]['focused'] = None
            self.assertIsNone(ReplayOwner.focus_row(spec, changed))


if __name__ == '__main__':
    unittest.main()
