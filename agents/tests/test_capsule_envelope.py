"""New outer family does not widen the frozen legacy envelope."""
import copy
import json
from pathlib import Path
import unittest
from metaviewer_agents.envelope import (
    CAPSULE_SCHEMA, SCHEMA, EnvelopeError, make_envelope, validate_envelope,
)
from metaviewer_agents._contracts_v02 import FILES

ROOT = Path(__file__).resolve().parents[2]

class CapsuleEnvelopeTests(unittest.TestCase):
    def samples(self):
        for path in sorted((ROOT / 'contracts/examples/v0.2').glob('capsule_envelope.valid.*.json')):
            yield json.loads(path.read_text())

    def test_all_new_examples_validate_without_mutation(self):
        for value in self.samples():
            before = copy.deepcopy(value)
            self.assertIs(validate_envelope(value), value)
            self.assertEqual(value, before)

    def test_crossed_tags_and_unknown_extension_refuse(self):
        for value in self.samples():
            value['schema'] = SCHEMA
            with self.assertRaises(EnvelopeError):
                validate_envelope(value)
        legacy = json.loads((ROOT / 'contracts/examples/v0.2/envelope.valid.json').read_text())
        self.assertIs(validate_envelope(legacy), legacy)
        legacy['schema'] = CAPSULE_SCHEMA
        with self.assertRaises(EnvelopeError):
            validate_envelope(legacy)
        legacy['schema'] = 'capsule_envelope/v9.9'
        with self.assertRaises(EnvelopeError) as error:
            validate_envelope(legacy)
        self.assertEqual(error.exception.code, 'unknown_version')

    def test_builder_uses_only_exact_four_body_tags(self):
        for value in self.samples():
            built = make_envelope(msg_id='message-capsule', from_component='agent',
                from_instance='agent-test', to_component='core', to_instance='core-test',
                session_id='session-test', seq=2, ts_ns=0, nonce='nonce-test', body=value['body'])
            self.assertEqual(built['schema'], CAPSULE_SCHEMA)
        legacy = json.loads((ROOT / 'contracts/examples/v0.2/envelope.valid.json').read_text())
        built = make_envelope(msg_id='message-legacy', from_component='agent',
            from_instance='agent-test', to_component='core', to_instance='core-test',
            session_id='session-test', seq=3, ts_ns=0, nonce='nonce-test', body=legacy['body'])
        self.assertEqual(built['schema'], SCHEMA)
        for bad in ({'schema': []}, {'schema':'guest_command_request/v0.3'},
                    {'schema':'guest_transport_metadata/v0.2'}):
            with self.assertRaises(EnvelopeError):
                make_envelope(msg_id='message-bad', from_component='agent',
                    from_instance='agent-test', to_component='core', to_instance='core-test',
                    session_id='session-test', seq=4, ts_ns=0, nonce='nonce-test', body=bad)

    def test_old_registry_has_no_extension_refs(self):
        refs = {x['$ref'] for x in FILES['envelope.schema.json']['properties']['body']['oneOf']}
        self.assertTrue(refs.isdisjoint({'headless_request.schema.json', 'headless_event.schema.json',
                                       'guest_command_request.schema.json', 'guest_command_event.schema.json'}))

if __name__ == '__main__':
    unittest.main()
