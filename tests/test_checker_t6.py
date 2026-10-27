"""Regression tests, negative controls, and four-way conformance for FX2-CHECKER."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from tools.check_contracts import (
    MAX_SAFE_INTEGER,
    ROOT,
    ValidationError,
    Validator,
    check_repository,
    loads_strict,
)

sys.path.insert(0, str(ROOT / "agents"))

from metaviewer_agents.envelope import EnvelopeError, loads_envelope, validate_envelope


class CheckerT6Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.validator = Validator(ROOT / "contracts" / "v0.2")
        self.envelope_schema = self.validator.load("envelope.schema.json")
        self.base_envelope = json.loads(
            (ROOT / "contracts" / "examples" / "v0.2" / "envelope.valid.json").read_text(encoding="utf-8")
        )

    def test_t6r2_006_checker_lone_surrogate_refused(self) -> None:
        receipt_schema = self.validator.load("action_receipt.schema.json")
        receipt = json.loads(
            (ROOT / "contracts" / "examples" / "v0.2" / "action_receipt.valid.json").read_text(encoding="utf-8")
        )
        for bad_raw in (
            '{"error": "\\ud800"}',
            '{"error": "\\udfff"}',
            '{"error": "x\\ud800y"}',
            '{"\\ud800": 1}',
        ):
            with self.subTest(raw=bad_raw):
                with self.assertRaises(ValidationError):
                    loads_strict(bad_raw)

        for bad_str in ("\ud800", "\udfff", "x\ud800y"):
            with self.subTest(value=repr(bad_str)):
                with self.assertRaises(ValidationError):
                    self.validator.validate({**receipt, "error": bad_str}, receipt_schema)

        # Negative controls: accented BMP char and astral-plane surrogate pair pass both loads_strict and validate.
        for good_raw_err in ('"é"', '"\\ud83d\\ude00"'):
            raw_doc = json.dumps(receipt).replace('"error": ""', '"error": ' + good_raw_err)
            parsed = loads_strict(raw_doc)
            self.validator.validate(parsed, receipt_schema)

    def test_t6r2_007_checker_terminal_byte_count_cross_check(self) -> None:
        term_schema = self.validator.load("terminal_session.schema.json")
        for bad_doc in (
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "write",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "input_seq": 1,
                    "b64": "YQ==",
                    "byte_count": 2,
                },
            },
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "write",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "input_seq": 1,
                    "b64": "YQ==",
                    "byte_count": 0,
                },
            },
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "data",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "seq": 1,
                    "b64": "YQ==",
                    "byte_count": 2,
                    "truncated": False,
                    "gap": False,
                },
            },
        ):
            with self.subTest(op=bad_doc["op"], byte_count=bad_doc["params"]["byte_count"]):
                with self.assertRaises(ValidationError):
                    self.validator.validate(bad_doc, term_schema)
                with self.assertRaises(ValidationError):
                    self.validator.validate({**self.base_envelope, "body": bad_doc}, self.envelope_schema)

        # Negative controls: matching decoded lengths pass both standalone and wrapped in envelope.
        for good_doc in (
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "write",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "input_seq": 1,
                    "b64": "YQ==",
                    "byte_count": 1,
                },
            },
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "data",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "seq": 1,
                    "b64": "YQ==",
                    "byte_count": 1,
                    "truncated": False,
                    "gap": False,
                },
            },
        ):
            self.validator.validate(good_doc, term_schema)
            self.validator.validate({**self.base_envelope, "body": good_doc}, self.envelope_schema)

    def test_r1_082_audit_requires_versioned_schema_const(self) -> None:
        for loose_schema in (
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "schema": {"type": "string"},
                    "x": {"type": "integer"},
                },
                "required": ["x"],
            },
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "schema": {"type": "string"},
                    "x": {"type": "integer"},
                },
                "required": ["schema", "x"],
            },
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "schema": {"const": "sample/v0.2"},
                    "x": {"type": "integer"},
                },
                "required": ["x"],
            },
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "schema": {"const": "sample/v9.9"},
                    "x": {"type": "integer"},
                },
                "required": ["schema", "x"],
            },
            {
                "$id": "https://metaviewer.local/contracts/v0.2/sample.schema.json",
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "title": "Sample",
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "x": {"type": "integer"},
                },
                "required": ["x"],
            },
        ):
            with self.subTest(schema=loose_schema):
                with self.assertRaises(ValidationError):
                    self.validator.audit(loose_schema)

        # Negative control: all 20 v0.2 schemas pass audit.
        v02_schemas = sorted((ROOT / "contracts" / "v0.2").glob("*.schema.json"))
        self.assertEqual(len(v02_schemas), 20)
        for path in v02_schemas:
            with self.subTest(schema=path.name):
                self.validator.audit(self.validator.load(path.name))

    def test_r1_083_audit_enforces_frozen_ceilings(self) -> None:
        for ceiling_breaking in (
            {"type": "string", "maxLength": 65537},
            {"type": "string", "minLength": 65537, "maxLength": 65537},
            {"type": "array", "maxItems": 65537, "items": {"type": "null"}},
            {"type": "object", "additionalProperties": False, "properties": {}, "maxProperties": 65537},
            {"type": "integer", "maximum": MAX_SAFE_INTEGER + 1},
            {"type": "integer", "minimum": -(MAX_SAFE_INTEGER + 1)},
            {"type": "number", "maximum": float(1 << 54)},
        ):
            with self.subTest(schema=ceiling_breaking):
                with self.assertRaises(ValidationError):
                    self.validator.audit(ceiling_breaking)

        # Negative controls: exact ceiling boundaries pass audit, and full repository passes.
        self.validator.audit({"type": "string", "maxLength": 65536})
        self.validator.audit({"type": "integer", "minimum": -MAX_SAFE_INTEGER, "maximum": MAX_SAFE_INTEGER})
        self.assertEqual(check_repository(), [])

    def test_four_way_shared_conformance_t6r2_006_007(self) -> None:
        cargo = shutil.which(os.environ.get("CARGO", "cargo"))
        go = shutil.which(os.environ.get("GO", "go"))
        self.assertIsNotNone(cargo, "cargo must be resolvable from PATH or CARGO")
        self.assertIsNotNone(go, "go must be resolvable from PATH or GO")

        raw_env = (ROOT / "contracts" / "examples" / "v0.2" / "envelope.valid.json").read_text(encoding="utf-8")
        raw_receipt = (ROOT / "contracts" / "examples" / "v0.2" / "action_receipt.valid.json").read_text(encoding="utf-8")

        def wrap_raw_body(body_raw: str) -> str:
            prefix = raw_env.strip()[:-1]
            idx = prefix.index('"body":')
            one_line = prefix[:idx] + '"body": ' + body_raw + "}"
            return " ".join(line.strip() for line in one_line.splitlines())

        term_write_bad = json.dumps(
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "write",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "input_seq": 1,
                    "b64": "YQ==",
                    "byte_count": 2,
                },
            },
            separators=(",", ":"),
        )
        term_write_good = json.dumps(
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "write",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "input_seq": 1,
                    "b64": "YQ==",
                    "byte_count": 1,
                },
            },
            separators=(",", ":"),
        )
        term_data_bad = json.dumps(
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "data",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "seq": 1,
                    "b64": "YQ==",
                    "byte_count": 2,
                    "truncated": False,
                    "gap": False,
                },
            },
            separators=(",", ":"),
        )
        term_data_good = json.dumps(
            {
                "schema": "terminal_session/v0.2",
                "request_id": "req-1",
                "op": "data",
                "params": {
                    "session_id": "s-1",
                    "terminal_generation": 1,
                    "seq": 1,
                    "b64": "YQ==",
                    "byte_count": 1,
                    "truncated": False,
                    "gap": False,
                },
            },
            separators=(",", ":"),
        )

        cases = [
            (
                "T6R2-006-lone-surrogate-refused",
                wrap_raw_body(raw_receipt.replace('"error": ""', '"error": "x\\ud800y"', 1)),
                False,
            ),
            (
                "T6R2-006-accented-bmp-admitted",
                wrap_raw_body(raw_receipt.replace('"error": ""', '"error": "é"', 1)),
                True,
            ),
            (
                "T6R2-006-astral-pair-admitted",
                wrap_raw_body(raw_receipt.replace('"error": ""', '"error": "\\ud83d\\ude00"', 1)),
                True,
            ),
            (
                "T6R2-007-terminal-write-mismatch-refused",
                wrap_raw_body(term_write_bad),
                False,
            ),
            (
                "T6R2-007-terminal-write-match-admitted",
                wrap_raw_body(term_write_good),
                True,
            ),
            (
                "T6R2-007-terminal-data-mismatch-refused",
                wrap_raw_body(term_data_bad),
                False,
            ),
            (
                "T6R2-007-terminal-data-match-admitted",
                wrap_raw_body(term_data_good),
                True,
            ),
            (
                "R1-082-unversioned-schema-const-refused",
                wrap_raw_body(raw_receipt.replace('"action_receipt/v0.2"', '"action_receipt"', 1)),
                False,
            ),
            (
                "R1-082-versioned-schema-const-admitted",
                wrap_raw_body(raw_receipt),
                True,
            ),
            (
                "R1-083-above-safe-int-ceiling-refused",
                " ".join(
                    line.strip()
                    for line in raw_env.replace('"seq": 1', '"seq": 9007199254740992', 1).splitlines()
                ),
                False,
            ),
            (
                "R1-083-at-safe-int-ceiling-admitted",
                " ".join(
                    line.strip()
                    for line in raw_env.replace('"seq": 1', '"seq": 9007199254740991', 1).splitlines()
                ),
                True,
            ),
        ]

        # 1. Python agents decoder (loads_envelope + validate_envelope)
        for name, raw, expected in cases:
            with self.subTest(decoder="python", case=name):
                try:
                    decoded = loads_envelope((raw + "\n").encode("utf-8"), max_bytes=65536)
                    validate_envelope(decoded)
                    py_admit = True
                except EnvelopeError:
                    py_admit = False
                self.assertEqual(py_admit, expected)

        # 2. Contract checker (loads_strict + Validator.validate)
        for name, raw, expected in cases:
            with self.subTest(decoder="checker", case=name):
                try:
                    parsed = loads_strict(raw)
                    self.validator.validate(parsed, self.envelope_schema)
                    chk_admit = True
                except ValidationError:
                    chk_admit = False
                self.assertEqual(chk_admit, expected)

        # 3. Go adapter decoder (SchemaPolicy.ValidateEnvelope via TestSharedConformanceCases)
        with tempfile.TemporaryDirectory(prefix="mv-conf-") as temp_dir:
            temp_path = Path(temp_dir)
            cases_file = temp_path / "cases.json"
            cases_file.write_text(
                json.dumps([{"name": n, "raw": r, "admit": a} for n, r, a in cases]),
                encoding="utf-8",
            )
            go_env = dict(
                os.environ,
                GOPROXY="off",
                GOSUMDB="off",
                GOTOOLCHAIN="local",
                MV_CONFORMANCE_FILE=str(cases_file),
            )
            go_res = subprocess.run(
                [go, "test", "./internal/ipc", "-run", "^TestSharedConformanceCases$", "-count=1"],
                cwd=ROOT / "daemon-adapter",
                env=go_env,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(go_res.returncode, 0, go_res.stdout + go_res.stderr)

            # 4. Rust core decoder (metaviewer_core::decode_envelope)
            probe_dir = temp_path / "rust-probe"
            (probe_dir / "src").mkdir(parents=True)
            (probe_dir / "Cargo.toml").write_text(
                '[package]\nname = "fx2-checker-probe"\nversion = "0.0.0"\n'
                'edition = "2021"\n[workspace]\n[dependencies]\n'
                "metaviewer-core = { path = " + json.dumps(str(ROOT / "core")) + " }\n",
                encoding="utf-8",
            )
            (probe_dir / "src" / "main.rs").write_text(
                "use std::io::{self, BufRead};\nfn main() {\n"
                "for line in io::stdin().lock().lines() {\n"
                'println!("{}", metaviewer_core::decode_envelope(&line.unwrap()).is_ok());\n'
                "}\n}\n",
                encoding="utf-8",
            )
            rs_env = dict(os.environ)
            rs_env.setdefault("CARGO_TARGET_DIR", str(probe_dir / "target"))
            rs_res = subprocess.run(
                [cargo, "run", "--offline", "--quiet", "--manifest-path", str(probe_dir / "Cargo.toml")],
                input="".join(r + "\n" for _, r, _ in cases),
                text=True,
                capture_output=True,
                env=rs_env,
                timeout=120,
            )
            self.assertEqual(rs_res.returncode, 0, rs_res.stderr)
            answers = rs_res.stdout.splitlines()
            self.assertEqual(len(answers), len(cases), rs_res.stdout)
            for (name, _, expected), answer in zip(cases, answers):
                with self.subTest(decoder="rust", case=name):
                    self.assertEqual(answer, str(expected).lower())


if __name__ == "__main__":
    unittest.main()
