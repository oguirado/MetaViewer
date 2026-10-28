"""U3-AG-06/07: unnormalized source oracle and controlled warning isolation.

Existing test files are outside this unit's write surface. Use the independent
Validator directly here; do not inherit _v02_pins or its self-healing oracle.
"""
import copy
import gc
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import warnings
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agents"))
sys.path.insert(0, str(ROOT))
import test_tools as fixture
from metaviewer_agents import envelope, mvctl, tools
from tools.check_contracts import Validator, ValidationError


def wrap(body):
    if body["schema"] == "envelope/v0.2":
        return body
    return envelope.make_envelope(msg_id="pure-test", from_component="agent",
        from_instance="agent-test", to_component="core", to_instance="core-test",
        session_id="pure-session", seq=1, ts_ns=0, nonce="ab" * 16, body=body)


class ContractGapTests(unittest.TestCase):
    def test_direct_native_receipt_accepts_only_closed_evidence_without_promotion(self):
        # Mutation: remove native_evidence from the embedded action_receipt properties.
        source = json.loads((ROOT / "contracts/examples/v0.2/action_receipt.valid.native-click.json").read_text())
        env = wrap(source)
        self.assertEqual(envelope.loads_envelope(envelope.dumps_envelope(env, max_bytes=65536),
                                                max_bytes=65536)["body"], source)
        self.assertFalse(env["body"]["verified"])
        minimal = copy.deepcopy(source)
        for key in ("focus_verified", "native_surface_id", "kind", "result"):
            del minimal["native_evidence"][key]
        self.assertEqual(wrap(minimal)["body"], minimal)
        for change in ({"unexpected": True}, {"input_mono_ns": True},
                       {"input_ts_ns": -1}, {"focus_verified": 1},
                       {"kind": "shell"}, {"result": "forged"}):
            with self.subTest(change=change):
                bad = copy.deepcopy(env)
                bad["body"]["native_evidence"].update(change)
                with self.assertRaises(envelope.EnvelopeError) as caught:
                    envelope.validate_envelope(bad)
                self.assertEqual(caught.exception.code, "bad_shape")
        # A direct receipt does not extend the separately frozen tool-result API.
        receipt = fixture._receipt(native_evidence=source["native_evidence"])
        result = fixture._verified("r-native", receipt=receipt)
        oracle = Validator(ROOT / "contracts/v0.2")
        with self.assertRaises(ValidationError):
            oracle.validate(result, oracle.load("mv_tool_result.schema.json"))
        client = fixture._FakeClient([lambda call: dict(result, request_id=call["request_id"])])
        with self.assertRaises(tools.ToolValidationError):
            tools.wait_verify("p-1", fixture._proposal()["expectation"], 500, client=client)

    def test_raw_contracts_and_examples_have_no_stale_version_pins(self):
        # Mutation: replace any v0.2 schema const in contracts/v0.2 with v0.1.
        schemas = sorted((ROOT / "contracts/v0.2").glob("*.schema.json"))
        examples = sorted((ROOT / "contracts/examples/v0.2").glob("*.json"))
        self.assertTrue(schemas)
        self.assertTrue(examples)
        for path in schemas + examples:
            with self.subTest(path=path.name):
                self.assertNotIn("/v0.1", path.read_text(encoding="utf-8"))
        # Negative control: no normalization is allowed in this instrument.
        stale = json.dumps({"schema": "observation/v0.1"})
        self.assertIn("/v0.1", stale)

    def test_raw_source_oracle_accepts_examples_and_rejects_closed_mutants(self):
        # Mutation: validate_envelope returns value before validating body keys.
        oracle = Validator(ROOT / "contracts/v0.2")
        envelope_schema = oracle.load("envelope.schema.json")
        envelope_bodies = {
            branch["$ref"].removesuffix(".schema.json")
            for branch in envelope_schema["properties"]["body"]["oneOf"]
        }
        examples = sorted((ROOT / "contracts/examples/v0.2").glob("*.valid*.json"))
        self.assertTrue(examples)
        for path in examples:
            with self.subTest(path=path.name):
                body = json.loads(path.read_text(encoding="utf-8"))
                prefix = path.name.split(".", 1)[0]
                if prefix not in envelope_bodies and prefix != "envelope":
                    schema = oracle.load(f"{prefix}.schema.json")
                    oracle.validate(body, schema)
                    bad_body = copy.deepcopy(body)
                    bad_body["tg_unknown_property"] = True
                    with self.assertRaises(ValidationError):
                        oracle.validate(bad_body, schema)
                    base_env = json.loads(
                        (ROOT / "contracts/examples/v0.2/envelope.valid.json").read_text(encoding="utf-8")
                    )
                    with self.assertRaises(ValidationError):
                        oracle.validate({**base_env, "body": body}, envelope_schema)
                    with self.assertRaises(envelope.EnvelopeError):
                        wrap(body)
                    continue
                env = wrap(body)
                oracle.validate(env, envelope_schema)
                wire = envelope.dumps_envelope(env, max_bytes=1048576)
                self.assertEqual(envelope.loads_envelope(wire, max_bytes=1048576), env)
                bad = copy.deepcopy(env)
                bad["body"]["tg_unknown_property"] = True
                with self.assertRaises(ValidationError):
                    oracle.validate(bad, envelope_schema)
                with self.assertRaises(envelope.EnvelopeError) as caught:
                    envelope.validate_envelope(bad)
                self.assertEqual(caught.exception.code, "bad_shape")

    def test_huge_integer_refusal_stays_exact_during_resource_cleanup_warning(self):
        # Mutation: insert payload["action"]["x"] = 0 before proposal preflight.
        with tempfile.TemporaryDirectory(prefix="tg-warning-") as directory:
            root = Path(directory)
            proposal = fixture._proposal()
            proposal["action"]["x"] = 10 ** 400
            payload = root / "request.json"
            payload.write_text(json.dumps(proposal), encoding="utf-8")
            argv = ["propose", "--json-arg", str(payload), "--socket", str(root / "core.sock"),
                    "--session-id", "sess-1", "--agent-instance", "agent-1",
                    "--core-instance", "core-1", "--timeout-ms", "2000",
                    "--max-line-bytes", "65536", "--max-reply-bytes", "65536"]
            real_read = mvctl._read_request
            enabled = gc.isenabled()
            gc.disable()
            try:
                # Deliberately arrange a real delayed TemporaryDirectory cleanup
                # at the same point that polluted the map's exact stderr oracle.
                resource = tempfile.TemporaryDirectory(prefix="delayed-", dir=root)
                cycle = [resource]
                cycle.append(cycle)
                del resource, cycle

                def read(*args):
                    gc.collect()
                    return real_read(*args)

                out, err = io.StringIO(), io.StringIO()
                with warnings.catch_warnings(record=True) as caught:
                    warnings.simplefilter("always", ResourceWarning)
                    with patch("sys.stdout", out), patch("sys.stderr", err), \
                            patch.object(mvctl, "_read_request", side_effect=read), \
                            patch("metaviewer_agents.client.ToolClient") as transport:
                        rc = mvctl.run(argv)
                    self.assertTrue(any(issubclass(item.category, ResourceWarning)
                                        and "Implicitly cleaning up" in str(item.message)
                                        for item in caught))
                self.assertEqual((rc, out.getvalue()), (2, ""))
                self.assertEqual(err.getvalue(), '{"verdict":"refuse","code":"schema_error",'
                                 '"error":"schema validation failed"}\n')
                transport.assert_not_called()
                self.assertFalse(list(root.glob("delayed-*")))
            finally:
                if enabled:
                    gc.enable()


if __name__ == "__main__":
    unittest.main()
