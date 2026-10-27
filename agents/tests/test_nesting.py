"""Transport nesting boundary and end-to-end hostile-frame refusals."""

import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metaviewer_agents.envelope import EnvelopeError, loads_envelope, make_envelope
import test_client as fixtures
from test_client import _FakeCore, _LINE_CAP, _proposal, _wrap
from test_mvctl_v02 import config, registration, PROPOSAL


def _object_frame(depth):
    return b'{"child":' * depth + b'0' + b'}' * depth + b'\n'


_HOSTILE = (
    b'[' * 2000 + b']' * 2000 + b'\n',
    _object_frame(33),
)


class NestingTests(unittest.TestCase):
    def test_over_depth_refused_before_json_parser(self):
        for raw in _HOSTILE:
            with self.subTest(prefix=raw[:20]), mock.patch(
                    'metaviewer_agents.envelope.json.loads',
                    side_effect=AssertionError('over-depth JSON was parsed')):
                with self.assertRaises(EnvelopeError) as caught:
                    loads_envelope(raw, max_bytes=_LINE_CAP)
                self.assertEqual(caught.exception.code, 'bad_shape')

    def test_depth_boundary_reaches_shape_validation(self):
        # Closed envelope schemas have no recursive field. Isolate only
        # shape validation to prove that valid JSON at the cap reaches it.
        for raw in (_object_frame(32), b'[' * 32 + b'0' + b']' * 32 + b'\n'):
            expected = json.loads(raw)
            with self.subTest(prefix=raw[:20]), mock.patch(
                    'metaviewer_agents.envelope.validate_envelope',
                    side_effect=lambda value: value) as validate:
                self.assertEqual(loads_envelope(raw, max_bytes=_LINE_CAP), expected)
                validate.assert_called_once_with(expected)

    def test_string_brackets_quotes_and_backslashes_do_not_count(self):
        text = '[{' * 2000 + '\\"' + '}]' * 2000 + '\\'
        env = _wrap(_proposal(action={'type': 'type', 'text': text}))
        raw = json.dumps(env).encode() + b'\n'
        self.assertEqual(loads_envelope(raw, max_bytes=_LINE_CAP), env)
        # A string ending in an escaped backslash must not hide containers
        # following its closing quote.
        raw = b'["\\\\",' + b'[' * 32 + b'0' + b']' * 32 + b']\n'
        with mock.patch('metaviewer_agents.envelope.json.loads',
                        side_effect=AssertionError('over-depth JSON was parsed')):
            with self.assertRaises(EnvelopeError) as caught:
                loads_envelope(raw, max_bytes=_LINE_CAP)
        self.assertEqual(caught.exception.code, 'bad_shape')
        self.assertEqual(str(caught.exception), 'frame exceeds JSON nesting cap')

    def test_parser_recursion_error_backstop(self):
        raw = json.dumps(_wrap(_proposal())).encode() + b'\n'
        with mock.patch('metaviewer_agents.envelope.json.loads',
                        side_effect=RecursionError('parser recursion')):
            with self.assertRaises(EnvelopeError) as caught:
                loads_envelope(raw, max_bytes=_LINE_CAP)
        self.assertEqual(caught.exception.code, 'bad_shape')

    def test_hostile_reply_is_bad_shape_and_client_terminal(self):
        for raw in _HOSTILE:
            with self.subTest(prefix=raw[:20]):
                core = _FakeCore(self)
                core.queue(raw)
                client = fixtures.ClientTests._client(self, core)
                client.connect()
                client.send(_wrap(_proposal()))
                fixtures.ClientTests.assertClientCode(self, 'bad_shape', client.recv)
                self.assertIsNone(client._sock)
                self.assertTrue(client._terminal)
                for operation in (client.recv, client.connect):
                    fixtures.ClientTests.assertClientCode(self, 'socket', operation)
                fixtures.ClientTests.assertClientCode(self, 'socket', client.send,
                                                      _wrap(_proposal(), seq=2))

    def test_mvctl_hostile_reply_is_one_json_refusal_exit_two(self):
        for raw in _HOSTILE:
            with self.subTest(prefix=raw[:20]):
                core = _FakeCore(self)
                hello = make_envelope(
                    msg_id='hello', from_component='core', from_instance='core-1',
                    to_component='agent', to_instance='agent-1', session_id='sess-1',
                    seq=1, body=registration('core')['hello'])
                core.queue(json.dumps(hello).encode() + b'\n', raw)
                trusted = Path(core.root) / 'config.json'
                trusted.write_text(json.dumps(config()))
                request = Path(core.root) / 'request.json'
                request.write_text(json.dumps(PROPOSAL))
                result = subprocess.run(
                    [sys.executable, '-m', 'metaviewer_agents.mvctl',
                     'propose', '--json-arg', str(request),
                     '--config', str(trusted), '--session-id', 'sess-1',
                     '--agent-instance', 'agent-1', '--core-instance', 'core-1',
                     '--timeout-ms', '2000',
                     '--max-line-bytes', str(_LINE_CAP),
                     '--max-reply-bytes', str(_LINE_CAP),
                     '--socket', core.path],
                    cwd=Path(__file__).resolve().parents[1],
                    capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(result.stdout, '')
                self.assertEqual(len(result.stderr.splitlines()), 1)
                self.assertEqual(json.loads(result.stderr), {
                    'verdict': 'refuse', 'code': 'schema_error',
                    'error': 'schema validation failed',
                })
                received = core.received_envelopes()
                self.assertEqual(len(received), 2)
                self.assertEqual(received[0]['body'], registration('agent')['hello'])
                self.assertEqual(received[1]['body']['op'], 'propose')
                self.assertEqual(received[1]['body']['args']['proposal'], PROPOSAL)
