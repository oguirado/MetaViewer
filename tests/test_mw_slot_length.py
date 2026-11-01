"""Exact native slot evidence; length-only and prefix mutants must refuse."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('slot_receipt', ROOT / 'tests/test_mw_e1_receipt.py')
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)
host = receipt.host


class NativeSlotTests(unittest.TestCase):
    def test_own_editor_read_empty_and_unicode_and_binding_mutants(self):
        backend = object.__new__(host.HostBackend)
        backend.binary, backend.capsule, backend.state = Path('/fake/surface'), 'owned', Path('/fake/state')
        row = dict(id='editor', role='textbox', name='Composer', box=[1, 2, 30, 40], focused=True)
        for value in ('', 'éΩ🙂', 'e\u0301'):
            row['value_len'] = len(value)
            reply = dict(elements=[row], truncated=False,
                         editable_text=dict(id='editor', bytes=len(value.encode()), text=value,
                                            value_len=len(value), length_unit='unicode_code_points',
                                            truncated=False))
            backend.native = Mock(return_value=reply)
            self.assertEqual(backend.slot_text(row), value)
            self.assertEqual(backend.native.call_args.args[1][-2:], ['--text-of', 'editor'])
            for mutant in ('missing', 'foreign', 'bytes', 'truncated', 'focus', 'length'):
                import copy
                changed = copy.deepcopy(reply)
                if mutant == 'missing': changed.pop('editable_text')
                if mutant == 'foreign': changed['editable_text']['id'] = 'ancestor'
                if mutant == 'bytes': changed['editable_text']['bytes'] += 1
                if mutant == 'truncated': changed['truncated'] = True
                if mutant == 'length': changed['elements'][0]['value_len'] = len(value) + 1
                if mutant == 'focus': changed['elements'][0]['focused'] = False
                backend.native = Mock(return_value=changed)
                with self.subTest(value=value, mutant=mutant), self.assertRaises(host.OwnerRefused):
                    backend.slot_text(row)

    def test_exact_verification_rejects_nonempty_prefix_and_same_length_mutants(self):
        from metaviewer_agents.mw_owner import PrivateSlots
        owner = SimpleNamespace(answer=lambda value: value, receipts=[{}], last_send=123)
        slots = PrivateSlots(owner, {})
        prompt = 'éΩ🙂'
        slots.pending = ('prompt', prompt, 0)
        state = SimpleNamespace(input_ns=123)
        for readback, expected in ((prompt, True), ('abc', False), (prompt+'extra', False),
                                   (prompt[:-1], False), ('', False)):
            slots.observed_text = readback
            # Deliberately supply the correct length independently: an exact-content
            # check must still defeat any-nonempty and prefix-match mutations.
            self.assertEqual(slots.verify(dict(slot_id='prompt'), state, len(prompt), 0), expected)

    def test_workflow_refuses_same_length_readback_before_enter(self):
        spec = importlib.util.spec_from_file_location('slot_owner_fixture', ROOT / 'agents/tests/test_mw_owner.py')
        fixture_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture_module)
        fixture = fixture_module.OwnerTests('test_private_text_run_and_no_content_in_evidence')
        fixture.setUp()
        try:
            fixture.prepare_text('éΩ🙂')
            original = fixture.owner.backend.call
            def call(stage, **args):
                result = original(stage, **args)
                if stage == 'ax' and any(p['type'] == 'type' for p in fixture.proposals):
                    result['nodes'][0]['text'] = 'abc'
                return result
            fixture.owner.backend.call = call
            result = fixture.owner.run()
            self.assertNotEqual(result.rc, 0)
            self.assertEqual([p['type'] for p in fixture.proposals], ['click', 'type'])
        finally:
            fixture.doCleanups()


    def test_unexpected_initial_editor_text_refuses(self):
        from metaviewer_agents.mw_owner import PrivateSlots
        slot = dict(slot_id='prompt', chip_clear_steps=[], max_length=100, clear_first=False,
                    empty_len_allowed=[0])
        owner = SimpleNamespace(answer=lambda value: value, corpus=SimpleNamespace(workflow=dict(text_slots=[slot])),
                                check_text=lambda value, limit: None,
                                length_binding=lambda slot_id: SimpleNamespace(predicate='len'),
                                acquire=lambda predicate, deadline: SimpleNamespace(value=0),
                                mw=SimpleNamespace(PrivateSlot=lambda *a: a), scope='s', authority='a')
        state = SimpleNamespace(deadline_ns=10**18)
        for observed, admitted in (('', True), ('new prompt', True), ('stale leftover', False)):
            slots = PrivateSlots(owner, {'prompt': 'new prompt'})
            slots.observed_text = observed
            with self.subTest(observed=observed):
                if admitted:
                    slots.read(slot, state, 1000)
                else:
                    with self.assertRaisesRegex(Exception, 'MW_SLOT_INITIAL_TEXT'):
                        slots.read(slot, state, 1000)

if __name__ == '__main__':
    unittest.main()
