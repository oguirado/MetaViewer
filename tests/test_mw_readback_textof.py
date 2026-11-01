"""Replay exact native editable JSON, including binding and polling mutants."""
import copy
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('textof_receipt', ROOT / 'tests/test_mw_e1_receipt.py')
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)
host = receipt.host


def row(value=''):
    return dict(id='0000000000000001', role='textbox', name='Composer',
                box=[10, 20, 80, 30], focused=True, value_len=len(value))


def reply(value):
    return dict(elements=[row(value)], truncated=False,
                editable_text=dict(id=row()['id'], bytes=len(value.encode('utf-8')),
                    text=value, value_len=len(value), length_unit='unicode_code_points', truncated=False))


class TextOfTests(unittest.TestCase):
    def backend(self):
        backend = object.__new__(host.HostBackend)
        backend.binary = Path('/fake/srf-identity-surface')
        backend.capsule, backend.state = 'owned', Path('/fake/state')
        backend.ownership = Mock()
        return backend

    def test_unicode_empty_legacy_projection_and_boundary(self):
        for value in ('', 'first\nΩ🙂 e\u0301\nlast', 'a' * 65536):
            with self.subTest(value_bytes=len(value.encode())):
                backend = self.backend()
                native = reply(value)
                native['text'] = dict(container_id=row()['id'], bytes=0, text='')
                backend.native = Mock(side_effect=[dict(elements=[row()], truncated=False), native])
                actual = backend.ax()['elements'][0]
                self.assertEqual(actual['value'], value)
                self.assertEqual(actual['value_len'], len(value))
                self.assertEqual(backend.native.call_args.args[1][-2:], ['--text-of', row()['id']])
                # Legacy projection is deliberately empty; removing editable data
                # must refuse, never silently use that empty ancestor projection.
                native.pop('editable_text')
                backend.native = Mock(return_value=native)
                with self.assertRaisesRegex(host.OwnerRefused, 'MW_SLOT_LENGTH_MISSING_READABLE_TEXT'):
                    backend.slot_text(row())

    def test_independent_contract_and_binding_mutants(self):
        value = 'first\nΩ🙂 e\u0301'
        mutants = [
            ('value_len', lambda r: r['editable_text'].update(value_len=len(value)+1), 'TEXT_MISMATCH'),
            ('row_length', lambda r: r['elements'][0].update(value_len=0), 'TEXT_MISMATCH'),
            ('null_length', lambda r: r['elements'][0].update(value_len=None), 'TEXT_MISMATCH'),
            ('unit', lambda r: r['editable_text'].update(length_unit='utf16'), 'TEXT_MISMATCH'),
            ('truncated', lambda r: r['editable_text'].update(truncated=True), 'TRUNCATED_TEXT'),
            ('absent_truncated', lambda r: r['editable_text'].pop('truncated'), 'TRUNCATED_TEXT'),
            ('bytes', lambda r: r['editable_text'].update(bytes=len(value)), 'TRUNCATED_TEXT'),
            ('id', lambda r: r['editable_text'].update(id='foreign'), 'MISSING_READABLE_TEXT'),
            ('duplicate', lambda r: r['elements'].append(copy.deepcopy(r['elements'][0])), 'EDITOR_BINDING'),
            ('tree_truncated', lambda r: r.update(truncated=True), 'EDITOR_BINDING'),
        ]
        for key in ('id', 'role', 'name', 'box', 'focused'):
            mutants.append((key, lambda r, k=key: r['elements'][0].update({k: None}), 'EDITOR_BINDING'))
        for name, mutate, code in mutants:
            with self.subTest(mutant=name):
                backend = self.backend()
                native = reply(value)
                mutate(native)
                backend.native = Mock(return_value=native)
                observed = row()
                with self.assertRaisesRegex(host.OwnerRefused, 'MW_SLOT_LENGTH_' + code):
                    backend.slot_text(observed)
                self.assertEqual(observed['value_len'], 0)

    def test_old_binary_and_timeout_refuse_actionably_without_fallback(self):
        from types import SimpleNamespace
        for error in (SimpleNamespace(returncode=2, stdout=b'', stderr=b'flag provided but not defined: -text-of'),
                      subprocess.TimeoutExpired('ax', 30)):
            backend = self.backend()
            backend.client = SimpleNamespace(host_env={})
            kwargs = dict(side_effect=error) if isinstance(error, Exception) else dict(return_value=error)
            with self.subTest(error=type(error).__name__), patch.object(host.subprocess, 'run', **kwargs) as run:
                with self.assertRaises(host.OwnerRefused) as caught:
                    backend.slot_text(row())
                self.assertEqual(caught.exception.code, 'MW_SLOT_LENGTH_TEXT_OF_UNAVAILABLE')
                self.assertIn('update srf-identity-surface', str(caught.exception))
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.kwargs['timeout'], 30)
                self.assertEqual(run.call_args.args[0][-2:], ['--text-of', row()['id']])

    def test_whole_runner_stale_then_current_and_no_window_mutant(self):
        spec = importlib.util.spec_from_file_location(
            'textof_workflow_fixture', ROOT / 'agents/tests/test_mw_owner.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for stale in ('', 'abc'):
            for mutant in (False, True):
                with self.subTest(stale=stale, no_window=mutant):
                    fixture = module.OwnerTests('test_private_text_run_and_no_content_in_evidence')
                    fixture.setUp()
                    try:
                        fixture.prepare_text('éΩ🙂')
                        fixture.owner.readback_runner = None if mutant else host.readback_runner
                        original = fixture.owner.backend.call
                        backend = self.backend()
                        samples = []

                        def call(stage, **args):
                            result = original(stage, **args)
                            if stage == 'ax' and fixture.focused == 'Operator Name':
                                value = fixture.editor_text
                                if any(p['type'] == 'type' for p in fixture.proposals):
                                    value = stale if not samples else value
                                    samples.append(value)
                                native = reply(value)
                                native['elements'][0]['name'] = 'Operator Name'
                                observed = copy.deepcopy(native['elements'][0])
                                observed['value_len'] = 0
                                backend.native = Mock(side_effect=[
                                    dict(elements=[observed], truncated=False), native])
                                editor = backend.ax()['elements'][0]
                                return dict(nodes=[editor, *result['nodes'][1:]])
                            return result

                        fixture.owner.backend.call = call
                        result = fixture.owner.run()
                        if mutant:
                            self.assertNotEqual(result.rc, 0)
                            self.assertEqual(result.verdict_code, 'CHANGE_MISMATCH')
                            self.assertEqual(samples, [stale])
                            self.assertEqual([p['type'] for p in fixture.proposals], ['click', 'type'])
                        else:
                            self.assertEqual((result.rc, result.verdict_code), (0, 'VERIFIED'), result)
                            self.assertEqual(samples[:2], [stale, 'éΩ🙂'])
                            self.assertEqual([p['type'] for p in fixture.proposals], ['click', 'type', 'key'])
                            fixture.assert_summary(result)
                        self.assertIsNone(fixture.owner.slot_readback_error)
                    finally:
                        fixture.doCleanups()

    def test_poll_false_then_true_and_persistent_stale_mutant(self):
        from types import SimpleNamespace
        from metaviewer_agents.mw_owner import PrivateSlots
        value = 'first\nΩ🙂 e\u0301'
        for recover in (True, False):
            with self.subTest(recover=recover):
                backend = self.backend()
                owner = SimpleNamespace(answer=lambda v: v, receipts=[{}], last_send=123)
                slots = PrivateSlots(owner, {})
                slots.pending = ('prompt', value, 0)
                state = SimpleNamespace(input_ns=123)
                backend.native = Mock(side_effect=[
                    dict(elements=[row()], truncated=False), reply(''),
                    dict(elements=[row()], truncated=False), reply(value if recover else '')])
                results = []
                # Two deterministic poll ticks inside one fixed deadline. Each
                # acquisition runs the real ax/text-of and exact slot verifier.
                deadline = 200
                for now in (100, 150):
                    self.assertLess(now, deadline)
                    observed = backend.ax()['elements'][0]
                    slots.observed_text = observed['value']
                    results.append(slots.verify(dict(slot_id='prompt'), state, observed['value_len'], 0))
                self.assertEqual(results, [False, recover])
                self.assertEqual(backend.native.call_count, 4)


if __name__ == '__main__':
    unittest.main()
