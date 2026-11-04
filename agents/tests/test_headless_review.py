"""Independent synthetic regressions for headless SDK review findings."""
import copy
import json
from pathlib import Path
import runpy
from types import SimpleNamespace
import unittest

from metaviewer_agents.client import ToolClient
from metaviewer_agents.envelope import _BODIES, _check
from metaviewer_agents.tools import ToolValidationError

ROOT = Path(__file__).resolve().parents[2]
normalized = runpy.run_path(str(ROOT / 'tests/test_python_contract_mirror.py'))['normalized']


class HeadlessReviewTests(unittest.TestCase):
    def events(self):
        base = ROOT / 'contracts/examples/v0.2'
        accepted = json.loads((base / 'headless_event.valid.accepted_1.json').read_text())
        unknown = json.loads((base / 'headless_event.valid.unknown_create.json').read_text())
        unknown['request_id'] = accepted['request_id']
        return accepted, unknown

    def client(self, events):
        local = {'component': 'agent', 'instance': 'agent-test'}
        core = {'component': 'core', 'instance': 'core-test'}
        frames = [{'from': core, 'to': local, 'session_id': 'session-test', 'body': event}
                  for event in events]
        # Each body independently passes the actual embedded schema. The
        # adversary changes correlation across otherwise valid messages.
        for event in events:
            _check(event, _BODIES['headless_event/v0.2'], 0)
        client = ToolClient.__new__(ToolClient)
        client._ready = True
        client.session_id = 'session-test'
        client._sequence_fd = None
        closed = []
        client.active = SimpleNamespace(_timeout_s=5, send=lambda _: None,
                                        recv=lambda: frames.pop(0),
                                        close=lambda: closed.append(True))
        client._envelope = lambda body, key: {'from': local, 'to': core, 'body': body}
        client._reserve = lambda: None
        client._accept_frame_event = lambda _: False
        return client, closed

    def request(self, client):
        return client.request({'schema': 'headless_request/v0.2',
                               'request_id': 'request-1', 'op': 'create',
                               'params': {'template': 'headless-sumsq'}},
                              'headless_event/v0.2', timeout_ms=1000)

    def test_matching_unknown_is_preserved(self):
        client, closed = self.client(self.events())
        self.assertEqual(self.request(client)['event'], 'outcome_unknown')
        self.assertEqual(closed, [])

    def test_unknown_cannot_replace_any_accepted_identity_coordinate(self):
        for key, value in (('workload_id', 'workload-other'),
                           ('generation', 2), ('owner_id', 'actor-other')):
            with self.subTest(coordinate=key):
                accepted, unknown = self.events()
                unknown['data']['session'][key] = value
                client, closed = self.client((accepted, unknown))
                with self.assertRaises(ToolValidationError):
                    self.request(client)
                self.assertEqual(closed, [True])

    def test_sibling_only_definition_drift_is_not_hidden(self):
        name = 'headless_session.schema.json'
        original = json.loads((ROOT / 'contracts/v0.2' / name).read_text())
        for definition in ('request_id', 'event_id'):
            with self.subTest(definition=definition):
                mutant = copy.deepcopy(original)
                mutant['$defs'][definition]['pattern'] = '^.*$'
                # Negative contrast proves why projection alone was insufficient.
                self.assertEqual(normalized(original, original, name),
                                 normalized(mutant, mutant, name))
                self.assertNotEqual(normalized(original, original, name, True),
                                    normalized(mutant, mutant, name, True))

    def test_orphan_definition_drift_is_not_hidden(self):
        name = 'headless_session.schema.json'
        original = json.loads((ROOT / 'contracts/v0.2' / name).read_text())
        original['$defs']['unused_review_definition'] = {'type': 'string', 'maxLength': 4}
        mutant = copy.deepcopy(original)
        mutant['$defs']['unused_review_definition']['maxLength'] = 5
        self.assertEqual(normalized(original, original, name), normalized(mutant, mutant, name))
        self.assertNotEqual(normalized(original, original, name, True),
                            normalized(mutant, mutant, name, True))


if __name__ == '__main__':
    unittest.main()
