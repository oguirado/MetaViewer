"""Round-one fixes: typed codec failures and bounded response framing."""
import asyncio
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_client as fixtures
from metaviewer_agents import envelope as e, mcp_server as m, mvctl, tools

M = m.MAX_FRAME_BYTES


def _v02_pins(value):
    """[TARGET, unit decision] Normalize stale nested pins, preserving shape."""
    if isinstance(value, dict):
        return {k: (v.removesuffix('/v0.1') + '/v0.2'
                    if k in ('schema', 'const') and isinstance(v, str) and v.endswith('/v0.1')
                    else _v02_pins(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_v02_pins(v) for v in value]
    return value


def _target_oracle():
    from tools.check_contracts import Validator
    class TargetValidator(Validator):
        def load(self, filename):
            return _v02_pins(super().load(filename))
    return TargetValidator(Path(__file__).resolve().parents[2] / 'contracts' / 'v0.2')

class CodecRegressions(unittest.TestCase):
    def test_control_intents_match_admitted_contract(self):
        for op in ('take_control', 'release_control'):
            body = dict(schema='ui_intent/v0.2', request_id='control', op=op,
                        params={'surface_id': 'surface-demo'})
            env = fixtures._wrap(body)
            self.assertEqual(e.loads_envelope(e.dumps_envelope(env, max_bytes=M),
                                             max_bytes=M), env)
            for params in ({}, {'slot_id': 'surface-demo'},
                           {'surface_id': 'surface-demo', 'extra': True}):
                bad = copy.deepcopy(env)
                bad['body']['params'] = params
                self.assert_bad(bad)

    def test_v02_hello_and_legacy_version_isolation(self):
        hello = dict(schema='hello/v0.2', contract_version='v0.2', component='agent',
                     component_version='test', component_commit='a'*40, dependencies=[])
        env = fixtures._wrap(hello)
        self.assertEqual(env['schema'], 'envelope/v0.2')
        self.assertEqual(e.loads_envelope(e.dumps_envelope(env, max_bytes=M), max_bytes=M), env)
        legacy = fixtures._wrap(fixtures._proposal())
        self.assertEqual(legacy['schema'], 'envelope/v0.1')
        self.assertEqual(e.loads_envelope(e.dumps_envelope(legacy, max_bytes=M), max_bytes=M), legacy)
        for value in (env, legacy):
            value['schema'] = 'envelope/v0.1' if value is env else 'envelope/v0.2'
            with self.assertRaises(e.EnvelopeError) as caught:
                e.validate_envelope(value)
            self.assertEqual(caught.exception.code, 'unknown_version')

    def test_v02_contract_examples_and_closed_negative_controls(self):
        from tools.check_contracts import Validator
        root = Path(__file__).resolve().parents[2]
        oracle = _target_oracle()
        for path in sorted((root / 'contracts' / 'examples' / 'v0.2').glob('*.valid.json')):
            body = _v02_pins(json.loads(path.read_text()))
            with self.subTest(path=path.name):
                env = body if body['schema'] == 'envelope/v0.2' else fixtures._wrap(body)
                oracle.validate(env, oracle.load('envelope.schema.json'))
                self.assertEqual(e.loads_envelope(e.dumps_envelope(env, max_bytes=M), max_bytes=M), env)
                bad = copy.deepcopy(env)
                bad['body']['unknown_property'] = True
                self.assert_bad(bad)

    def test_tool_discriminators_v02(self):
        for name, value in vars(tools).items():
            if name.endswith('_SCHEMA'):
                self.assertTrue(value.endswith('/v0.2'), (name, value))

    def test_tool_results_match_v02_contract(self):
        import test_tools as t
        from tools.check_contracts import Validator, ValidationError
        oracle = _target_oracle()
        schema = oracle.load('mv_tool_result.schema.json')
        for result in (t._ok_observe('r'), t._ok_list('r', [t._surface()]),
                       t._admitted('r'), t._verified('r')):
            with self.subTest(op=result['op']):
                oracle.validate(result, schema)
                env = fixtures._wrap(result)
                self.assertEqual(e.loads_envelope(e.dumps_envelope(env, max_bytes=M), max_bytes=M), env)
                bad = copy.deepcopy(result)
                nested = next(bad[k] for k in ('observation', 'verdict', 'receipt', 'surfaces') if k in bad)
                if isinstance(nested, list):
                    nested = nested[0]
                nested['schema'] = nested['schema'].replace('/v0.2', '/v0.1')
                with self.assertRaises(ValidationError):
                    oracle.validate(bad, schema)
                env['body'] = bad
                self.assert_bad(env)

    def assert_bad(self, env):
        for call in (lambda: e.validate_envelope(env),
                     lambda: e.dumps_envelope(env, max_bytes=M),
                     lambda: e.loads_envelope(json.dumps(env).encode()+b'\n', max_bytes=M)):
            with self.assertRaises(e.EnvelopeError) as caught:
                call()
            self.assertEqual(caught.exception.code, 'bad_shape')

    def test_huge_integer_codec(self):
        for field in ('seq', 'ts_ns', 'body'):
            env = fixtures._wrap(fixtures._proposal())
            if field == 'body':
                env['body']['action']['x'] = 10**400
            else:
                env[field] = 10**400
            self.assert_bad(env)

    def test_huge_integer_recv_terminal(self):
        env = fixtures._wrap(fixtures._verdict())
        env['body']['core_seq'] = 10**400
        core = fixtures._FakeCore(self)
        core.queue(json.dumps(env).encode()+b'\n')
        client = fixtures.ClientTests._client(self, core)
        client.connect()
        client.send(fixtures._wrap(fixtures._proposal()))
        fixtures.ClientTests.assertClientCode(self, 'bad_shape', client.recv)
        self.assertTrue(client._terminal)
        self.assertIsNone(client._sock)

    def test_mvctl_huge_integer_exact_refusal(self):
        proposal = fixtures._proposal(schema='action_proposal/v0.2')
        proposal['action']['x'] = 10**400
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'request.json'
            path.write_text(json.dumps(proposal))
            err = io.StringIO()
            with mock.patch('sys.stderr', err), mock.patch('metaviewer_agents.client.ToolClient') as transport:
                rc = mvctl.run(['propose', '--json-arg', str(path), '--timeout-ms', '2000', '--max-line-bytes', str(M), '--max-reply-bytes', str(M), '--socket', str(Path(root)/'core.sock'),
                                '--session-id', 'sess-1', '--agent-instance', 'agent-1',
                                '--core-instance', 'core-1'])
            self.assertEqual(rc, 2)
            transport.assert_not_called()
            self.assertEqual(err.getvalue(), '{"verdict":"refuse","code":"schema_error","error":"schema validation failed"}\n')

    def test_surrogate_both_directions_and_unicode_control(self):
        for text in ('\ud800', '\udfff', 'ok\ud800bad'):
            env = fixtures._wrap(fixtures._proposal())
            env['body']['action'] = {'type':'type', 'text':text}
            self.assert_bad(env)
        for field in ('schema', 'msg_id', 'nonce'):
            env = fixtures._wrap(fixtures._proposal())
            env[field] = '\ud800'
            self.assert_bad(env)
        env = fixtures._wrap(fixtures._proposal(action={'type':'type', 'text':'A😀é'}))
        self.assertEqual(e.loads_envelope(e.dumps_envelope(env, max_bytes=M), max_bytes=M), env)

class FramingRegressions(unittest.TestCase):
    def serve_frames(self, requests, payload=None):
        reader = io.BytesIO(b''.join(json.dumps(x, separators=(',',':')).encode()+b'\n' for x in requests))
        writer = io.BytesIO()
        async def handle(server, message):
            return {'jsonrpc':'2.0', 'id':message['id'], 'result':payload}
        with mock.patch.object(m.sys, 'stdin', SimpleNamespace(buffer=reader)), mock.patch.object(m.sys, 'stdout', SimpleNamespace(buffer=writer)):
            if payload is None:
                asyncio.run(m.serve(client=SimpleNamespace(request=lambda *a, **k: None)))
            else:
                with mock.patch.object(m.Server, 'handle', handle):
                    asyncio.run(m.serve(client=SimpleNamespace(request=lambda *a, **k: None)))
        frames = writer.getvalue().splitlines(keepends=True)
        self.assertEqual(len(frames), len(requests))
        for frame in frames:
            self.assertLessEqual(len(frame), M)
        return [json.loads(frame) for frame in frames]

    def test_hostile_id_sweep(self):
        for ident in ('x'*(M-50), '\x01'*((M-100)//6), 10**400):
            out = self.serve_frames([dict(jsonrpc='2.0', id=ident, method='ping')])[0]
            self.assertEqual(out['error']['code'], -32603)
            self.assertIsNone(out['id'])
        out = self.serve_frames([dict(jsonrpc='2.0', id='small', method='ping')])[0]
        self.assertEqual(out['id'], 'small')
        self.assertEqual(out['error']['code'], -32000)

    def test_oversized_payload_single_bounded_error(self):
        out = self.serve_frames([dict(jsonrpc='2.0', id='normal', method='ping')], 'x'*(M+100))[0]
        self.assertEqual(out['error']['code'], -32603)
        self.assertEqual(out['id'], 'normal')

    def test_fallback_does_not_trust_handler_id(self):
        # Bypass request admission to exercise the final framing gate itself.
        out = self.serve_frames(
            [dict(jsonrpc='2.0', id='x'*(M-50), method='ping')],
            'x'*(M+100))[0]
        self.assertEqual(out['error']['code'], -32603)
        self.assertIsNone(out['id'])
