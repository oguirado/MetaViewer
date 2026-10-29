"""Frozen verdict/event/request parity and an executable unknown-key mutant."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agents'))
from metaviewer_agents import envelope, tools

FIXTURE = json.loads((ROOT / 'tests/fixtures/verdict_parity.json').read_text())


def accepts(payload, decoder):
    try:
        if decoder == 'envelope':
            env = copy.deepcopy(FIXTURE['envelope_template'])
            env['body'] = copy.deepcopy(payload)
            envelope.loads_envelope((json.dumps(env) + '\n').encode(), max_bytes=1048576)
        elif payload['schema'] == 'record_request/v0.2':
            tools._check_record_request(copy.deepcopy(payload))
        elif payload['schema'] == 'record_event/v0.2':
            tools._check_record_event(copy.deepcopy(payload), request_id='q', surface_id='s', recording_id='r')
        else:
            raise AssertionError('unsupported tools decoder')
        return True
    except tools.ToolRefusal:
        # A valid wire refusal is an accepted event, surfaced as a domain exception.
        return True
    except (envelope.EnvelopeError, tools.ToolValidationError):
        return False


class TestVerdictParity(unittest.TestCase):
    def test_frozen_vectors(self):
        for v in FIXTURE['vectors']:
            decoders = ['envelope']
            if v['family'] != 'action_verdict':
                decoders.append('tools')
            for decoder in decoders:
                with self.subTest(vector=v['id'], decoder=decoder):
                    self.assertEqual(accepts(v['payload'], decoder), v['contract_verdict'] == 'accept')

    def test_kills_ignore_unknown_params_mutant(self):
        v = next(v for v in FIXTURE['vectors'] if v['id'] == 'ram_start_extra_params')
        self.assertFalse(accepts(v['payload'], 'tools'))
        original = tools._check_exact

        def ignore_extra(value, keys, what):
            if isinstance(value, dict):
                value = {k: x for k, x in value.items() if k in keys}
            return original(value, keys, what)

        with patch.object(tools, '_check_exact', ignore_extra):
            self.assertTrue(accepts(v['payload'], 'tools'))
        self.assertEqual(v['contract_verdict'], 'refuse')


if __name__ == '__main__':
    unittest.main()
