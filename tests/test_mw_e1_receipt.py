"""E1 consumes the core's frozen wait projection, with fail-closed witnesses."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agents'))
spec = importlib.util.spec_from_file_location('e1_host', ROOT / 'tools/mw_run_backend.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class ReceiptProjectionTests(unittest.TestCase):
    def setUp(self):
        import json
        self.host = object.__new__(host.HostBackend)
        self.frame = json.loads((ROOT / 'contracts/examples/v0.2/frame_ref.valid.json').read_text())
        self.host.surface_id = self.frame['surface_id']
        self.receipt = dict(schema='action_receipt/v0.2', proposal_id='e1-proposal',
                            executed_at_ns=10, after_frame=self.frame, verified=True,
                            verification=dict(method='pixel', detail='core verified'), error='')

    def verified(self, receipt=None, **changes):
        values = dict(focus_verified=True, input_mono_ns=123, frame_sha256=self.frame['sha256'])
        values.update(changes)
        return host.tools._VerifiedReceipt(copy.deepcopy(receipt or self.receipt), **values)

    def test_frozen_projection_uses_validated_metadata_without_forging_wire_receipt(self):
        verified = self.verified()
        self.assertEqual(self.host.native_witness(verified),
                         dict(surface_id=self.host.surface_id, input_mono_ns=123))
        self.assertNotIn('native_evidence', verified)
        self.assertEqual(dict(verified), self.receipt)
        before = dict(self.frame, generation=self.frame['generation'] - 1)
        proposal = dict(surface_id=self.host.surface_id, proposal_id='e1-proposal',
                        based_on_frame={k: before[k] for k in ('sha256', 'generation')})
        self.assertTrue(self.host.binding(proposal, before, verified))
        for change in (dict(surface_id='foreign'), dict(proposal_id='foreign'),
                       dict(based_on_frame=dict(sha256='f' * 64, generation=before['generation']))):
            self.assertFalse(self.host.binding(dict(proposal, **change), before, verified))

    def test_missing_or_mutated_witnesses_refuse(self):
        for changed in (dict(focus_verified=False), dict(input_mono_ns=0),
                        dict(input_mono_ns=None), dict(frame_sha256='f' * 64)):
            with self.subTest(changed=changed), self.assertRaisesRegex(host.OwnerRefused, 'MW_RECEIPT_MISMATCH'):
                self.host.native_witness(self.verified(**changed))
        with self.assertRaisesRegex(host.OwnerRefused, 'MW_RECEIPT_MISMATCH'):
            self.host.native_witness(dict(self.verified()))
        wrong = dict(self.receipt, after_frame=dict(self.frame, surface_id='foreign'))
        with self.assertRaises(ValueError):
            self.host.native_witness(self.verified(wrong))


class CaretTests(unittest.TestCase):
    def test_measured_shape_and_noncaret_mutants(self):
        frame = dict(surface_id='owned', width=100, height=80)
        rows = [dict(role='textbox', focused=True, box=[10, 10, 80, 60])]
        off = bytes([221, 238, 255]) * (100 * 80)
        def caret(x=15, y=16, width=1, height=15):
            pixels = bytearray(off)
            for dy in range(height):
                for dx in range(width):
                    i = ((y+dy)*100+x+dx)*3
                    pixels[i:i+3] = bytes(3)
            return bytes(pixels)
        check = host.HostBackend.caret_only_change
        self.assertTrue(check(frame, frame, rows, off, caret()))
        self.assertTrue(check(frame, frame, rows, caret(), off))
        for pixels in (caret(width=2), caret(height=33), caret(x=2), off):
            self.assertFalse(check(frame, frame, rows, off, pixels))
        self.assertFalse(check(frame, frame, [dict(rows[0], focused=False)], off, caret()))
        self.assertFalse(check(frame, dict(frame, surface_id='foreign'), rows, off, caret()))
        # Disjoint strokes and non-background neighbors cannot be called a caret.
        broken = bytearray(caret())
        broken[(20*100+15)*3:(20*100+15)*3+3] = bytes([221,238,255])
        self.assertFalse(check(frame, frame, rows, off, bytes(broken)))


class OwnerProjectionTests(unittest.TestCase):
    def test_native_null_length_is_not_evidence_of_an_empty_editor(self):
        import time
        spec = importlib.util.spec_from_file_location('e1_length_fixture', ROOT / 'agents/tests/test_mw_owner.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        fixture = module.OwnerTests('test_private_text_run_and_no_content_in_evidence')
        fixture.setUp()
        try:
            fixture.prepare_text()
            owner = fixture.owner
            predicate = owner.length_binding('prompt').predicate
            row = dict(name=predicate['bindings'][0]['value'], focused=True, value_len=None)
            owner.sense = lambda deadline: dict(ax=[row], capture_start=time.monotonic_ns(),
                frame=dict(surface_id='owned', generation=1, sha256='a' * 64))
            with self.assertRaisesRegex(host.OwnerRefused, 'MW_SLOT_LENGTH'):
                owner.acquire(predicate, time.monotonic_ns() + 1_000_000_000)
            row['value'] = ''
            self.assertEqual(owner.acquire(predicate, time.monotonic_ns() + 1_000_000_000).value, 0)
        finally:
            fixture.doCleanups()

    def test_grounding_deadline_is_not_relaxed(self):
        import time
        from types import SimpleNamespace
        spec = importlib.util.spec_from_file_location('e1_deadline_fixture', ROOT / 'agents/tests/test_mw_owner.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        fixture = module.OwnerTests('test_run_click_key_scroll_sequence_and_run_schema')
        fixture.setUp()
        try:
            fixture.install_backend()
            owner = fixture.owner
            start = time.monotonic_ns()
            deadline = start + 10_000_000_000
            state = SimpleNamespace(start_ns=start, run=SimpleNamespace(last_input_ns=None))
            target_spec = fixture.corpus.workflow['steps'][0]['target']
            value = owner.target(target_spec, state, deadline)
            owners = SimpleNamespace(scope=owner.scope, authority=owner.authority,
                                     observations=owner, capabilities=owner,
                                     clock=lambda: deadline - 1)
            self.assertTrue(owner.mw._grounded(value, target_spec, state, owners, deadline))
            owners.clock = lambda: deadline
            self.assertFalse(owner.mw._grounded(value, target_spec, state, owners, deadline))
            owners.clock = lambda: deadline + 1
            self.assertFalse(owner.mw._grounded(value, target_spec, state, owners, deadline))
        finally:
            fixture.doCleanups()

    def test_frozen_projection_completes_and_missing_witness_mutants_refuse(self):
        spec = importlib.util.spec_from_file_location('e1_owner_fixture', ROOT / 'agents/tests/test_mw_owner.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for mutant in (None, 'input_mono_ns', 'focus_verified', 'frame_sha256', 'surface_id'):
            with self.subTest(mutant=mutant):
                fixture = module.OwnerTests('test_run_click_key_scroll_sequence_and_run_schema')
                fixture.setUp()
                try:
                    fixture.install_backend()
                    original = fixture.owner.backend.call
                    def call(stage, **args):
                        result = original(stage, **args)
                        if stage == 'propose':
                            result['native_evidence']['surface_id'] = 'foreign' if mutant == 'surface_id' else 'owned'
                        if stage == 'wait_verify':
                            del result['receipt']['native_evidence']
                            if mutant in ('input_mono_ns', 'focus_verified', 'frame_sha256'):
                                result.pop(mutant)
                        return result
                    fixture.owner.backend.call = call
                    result = fixture.owner.run()
                    self.assertEqual(result.verdict_code, 'VERIFIED' if mutant is None else 'INPUT_UNCERTAIN')
                finally:
                    fixture.doCleanups()


class SnapshotTests(unittest.TestCase):
    def test_state_uses_acquired_ax_and_never_reacquires(self):
        import json
        import os
        from unittest.mock import patch
        from metaviewer_agents.perception.deps_lock import resolve_locked_component
        override = os.environ.get('MV_MW_WENDER_ROOT')
        with patch.dict(os.environ, {'MV_WENDER_ROOT': override} if override else {}):
            root = resolve_locked_component('wender-agent')
        backend = object.__new__(host.HostBackend)
        backend.wender = Path(root)
        sensed = dict(ax=[dict(id='composer', role='textbox', name='Composer',
                              box=[1, 1, 80, 40], actionable=True, states={'focused': True})],
                      window=dict(url='file:///fixture.html', title='Fixture'),
                      table=dict(schema='vqa.element-table/v1', width=100, height=80,
                                 frame_sha256='a' * 64,
                                 elements=[dict(bbox=dict(x=1, y=1, w=80, h=40))]))
        with patch.object(backend, 'ax', side_effect=AssertionError('redundant AX mutant')):
            state = backend.state_for(sensed)
        self.assertEqual([n['name'] for n in state['nodes']], ['Composer'])
        self.assertIs(sensed['ax'][0]['states']['focused'], True)
        changed = copy.deepcopy(sensed)
        changed['ax'][0]['name'] = 'Different target'
        with patch.object(backend, 'ax', side_effect=AssertionError('redundant AX mutant')):
            other = backend.state_for(changed)
        self.assertNotEqual(state['ax_stable_sha256'], other['ax_stable_sha256'])


if __name__ == '__main__':
    unittest.main()
