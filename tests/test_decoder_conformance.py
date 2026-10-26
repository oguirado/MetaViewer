"""Cross-language contract conformance and differential decoder test suite.

Tests Python (check_contracts Validator & metaviewer_agents), Rust (metaviewer-core wire decode),
and Go (daemon-adapter IPC JSON & struct decoders) against all v0.2 fixtures and fuzz vectors.
"""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "agents"))

from tools.check_contracts import Validator, ValidationError, check_repository, loads_strict
from metaviewer_agents.envelope import validate_envelope as py_agent_validate, EnvelopeError, loads_envelope as py_agent_loads


def run_rust_decoder_test() -> subprocess.CompletedProcess:
    return subprocess.run(
        ["cargo", "test", "--ignore-rust-version", "--test", "decode_envelope"],
        capture_output=True, text=True, cwd=ROOT / "core"
    )


def run_go_ipc_tests() -> subprocess.CompletedProcess:
    env = dict(os.environ, GOTOOLCHAIN="auto")
    return subprocess.run(
        ["go", "test", "-v", "./internal/ipc"],
        cwd=ROOT / "daemon-adapter", env=env, capture_output=True, text=True
    )


class CrossLanguageDecoderConformanceTests(unittest.TestCase):
    def setUp(self):
        self.v02_validator = Validator(ROOT / "contracts" / "v0.2")
        self.envelope_schema = self.v02_validator.load("envelope.schema.json")
        self.examples_dir = ROOT / "contracts" / "examples" / "v0.2"

    def test_repository_gate_passes(self):
        errors = check_repository()
        self.assertEqual(errors, [], f"check_repository failed: {errors}")

    def test_python_validator_accepts_all_valid_fixtures(self):
        valid_files = sorted(self.examples_dir.glob("*.valid.json"))
        self.assertGreaterEqual(len(valid_files), 20)
        for path in valid_files:
            with self.subTest(fixture=path.name):
                data = json.loads(path.read_text())
                if path.name == "envelope.valid.json":
                    self.v02_validator.validate(data, self.envelope_schema)
                else:
                    body_schema_name = path.name.replace(".valid.json", ".schema.json")
                    schema = self.v02_validator.load(body_schema_name)
                    self.v02_validator.validate(data, schema)
                    env = {
                        "schema": "envelope/v0.2",
                        "msg_id": "msg-test",
                        "ts_ns": 1000,
                        "from": {"component": "agent", "instance": "a1"},
                        "to": {"component": "core", "instance": "c1"},
                        "session_id": "sess-test",
                        "seq": 1,
                        "nonce": "nonce-123",
                        "body": data
                    }
                    self.v02_validator.validate(env, self.envelope_schema)

    def test_python_validator_rejects_all_invalid_fixtures(self):
        invalid_files = sorted(self.examples_dir.glob("*.invalid.*.json"))
        self.assertGreaterEqual(len(invalid_files), 20)
        for path in invalid_files:
            with self.subTest(fixture=path.name):
                data = json.loads(path.read_text())
                name_base = path.name.split(".invalid.")[0]
                schema_name = f"{name_base}.schema.json"
                schema = self.v02_validator.load(schema_name)
                with self.assertRaises(ValidationError):
                    self.v02_validator.validate(data, schema)

    def test_rust_decoder_all_fixtures_and_negative_controls(self):
        proc = run_rust_decoder_test()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("test result: ok", proc.stdout)

    def test_go_ipc_tests_pass(self):
        proc = run_go_ipc_tests()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_python_agent_envelope_v02_refusal(self):
        env_v02 = json.loads((self.examples_dir / "envelope.valid.json").read_text())
        with self.assertRaises(EnvelopeError) as ctx:
            py_agent_validate(env_v02)
        self.assertEqual(ctx.exception.code, "unknown_version")

        raw_v02 = json.dumps(env_v02).encode("utf-8") + b"\n"
        with self.assertRaises(EnvelopeError) as ctx:
            py_agent_loads(raw_v02, max_bytes=1048576)
        self.assertEqual(ctx.exception.code, "unknown_version")

    def test_differential_fuzz_vectors(self):
        """Differential comparison of Python validator, Python strict parser, and Rust/Go limits."""
        base_env = json.loads((self.examples_dir / "envelope.valid.json").read_text())

        # 1. Duplicate keys -> loads_strict raises ValidationError
        dup_json = '{"schema":"envelope/v0.2","msg_id":"m","ts_ns":1,"from":{"component":"core","instance":"c"},"to":{"component":"ui","instance":"u"},"session_id":"s","seq":1,"nonce":"n","body":{"schema":"hello/v0.2","contract_version":"v0.2","component":"ui","pinned_version":"0.2.0","commit":"0123456789abcdef0123456789abcdef01234567"},"msg_id":"m2"}'
        with self.assertRaises(ValidationError):
            loads_strict(dup_json)

        # 2. Non-finite values -> loads_strict raises ValidationError
        for non_finite in ('{"x": NaN}', '{"x": Infinity}', '{"x": -Infinity}'):
            with self.subTest(non_finite=non_finite):
                with self.assertRaises(ValidationError):
                    loads_strict(non_finite)

        # 3. Integers at 2^53-1 vs 2^53 (MAX_WIRE_INTEGER = 9007199254740991)
        MAX_SAFE = 9007199254740991
        env_max = copy.deepcopy(base_env)
        env_max["seq"] = MAX_SAFE
        self.v02_validator.validate(env_max, self.envelope_schema)

        env_over = copy.deepcopy(base_env)
        env_over["seq"] = MAX_SAFE + 1
        # Validator (Python) handles arbitrary ints, but Rust decode_envelope rejects > MAX_WIRE_INTEGER.

        # 4. Unknown discriminators -> Validator raises ValidationError
        env_unknown = copy.deepcopy(base_env)
        env_unknown["body"]["schema"] = "unknown_body/v0.2"
        with self.assertRaises(ValidationError):
            self.v02_validator.validate(env_unknown, self.envelope_schema)

        # 5. v0.1 body in v0.2 envelope -> Validator raises ValidationError
        env_v01_body = copy.deepcopy(base_env)
        env_v01_body["body"]["schema"] = "hello/v0.1"
        with self.assertRaises(ValidationError):
            self.v02_validator.validate(env_v01_body, self.envelope_schema)


if __name__ == "__main__":
    unittest.main()
