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

        # Preserve the exact published inventory; separately admit the reviewed additions.
        import hashlib
        published = {'action_proposal.schema.json': '65ac7b8303183cf2dc07c75732818b67e14da989fd616f1028dde75d3bb2375d', 'action_receipt.schema.json': '2148a9e67669a01829965d8e7698338b425207d6f1e2e771daadd87de89ad36b', 'action_verdict.schema.json': '7c0d1653a58628d969582b204581162edc9a8fa961cfc52aa8c9032f9346b56d', 'capsule_meta.schema.json': '494d99f3882b4e8a3a1c02e2a72785cb3fe13859985aef692068f7bbc9179b0b', 'capsule_state_event.schema.json': '8172a6a2600085e6b08dfaaba91320808aae3c000be160420fcbe9bcd3634070', 'capsule_state_request.schema.json': '27bf48d0778bd9763595efffb8fde177edee13e667c9268f3e49fa4fcec19253', 'catalog_entry.schema.json': '0e3a515c2fcb6a5e2153ab892f394f73b6a4ccc3f76cc5c9916c78a9324bc833', 'envelope.schema.json': '9e4cc8049bb39d906d3e2df21bba20618959ac35c11dae68f59cf450ef0338f3', 'frame_ref.schema.json': '8050ce412b6b95792468701ea69670222798840b54787fee18f1f99dd3738397', 'hello.schema.json': 'e3099628720ebf4260528ff809f74d08a2da8a762339d2fdbaaca097f2a0d13c', 'mv_tool_call.schema.json': '7da7513b1b457dfeb08689c0ae70b2b950a2e093dab8706d99267acbd868cd5f', 'mv_tool_result.schema.json': 'f70eca64419f98375bb01259c4bb0cdd9cc64de1bb9158561ba5c32480fa3faa', 'observation.schema.json': '65ccb926746357fa88d0dad628199b3a27a51b5722201c1eb22e34059d761ead', 'record_event.schema.json': '4a18f9c8d32b43ad43a6f194717d977f786531fc7e9049ab0369951d37619fe8', 'record_request.schema.json': '4c781ef8e0807aa36d3b1abf87eff7f0ca943676626342bdc7f40ba8b6eb2a22', 'session_record.schema.json': '0b409b0e8958fbddb44d029ef8b79f634103e92d9092db76ecc207027bf5af5a', 'settings.schema.json': 'd162909a4f1a34b29f8e00651a89af7ddc75991c74c0aa527373253a729c154e', 'surface.schema.json': '90da5357ae82f065e32efa6b06cc4f6415e709a5257777f226b5c397acb8c2da', 'surface_event.schema.json': '6c4eb7497065bf6fd8fd965448c2cdcd0a5960f78012f5ec7c1453a3b0fba947', 'surface_input.schema.json': '023d7503602109c8b58dc86795cdd6279f1acf2db407ac3d6299a734765d139e', 'surface_request.schema.json': '4ab05a8018d3cc69747fa1b5d478186127fd8d0c3cd555ae7984344493e56a89', 'terminal_session.schema.json': '6896578203d3cbc14ccc474e4d9aec86d4c327e158bdc1fcc6e6689473d34cb5', 'ui_intent.schema.json': 'e30a180368df1ca38a2af58d26a7548053898a8cd6c595bd5cd7d7f4c57e3317'}
        additions = set(['capsule_capabilities.schema.json', 'capsule_envelope.schema.json', 'capsule_resource_inventory.schema.json', 'guest_command_event.schema.json', 'guest_command_request.schema.json', 'guest_command_session.schema.json', 'guest_transport_metadata.schema.json', 'headless_event.schema.json', 'headless_request.schema.json', 'headless_session.schema.json', 'rewind_envelope.schema.json', 'rewind_event.schema.json', 'rewind_guest_reset.schema.json', 'rewind_point.schema.json', 'rewind_request.schema.json', 'rewind_session.schema.json'])
        self.assertEqual(len(published), 23)
        v02_schemas = sorted((ROOT / "contracts" / "v0.2").glob("*.schema.json"))
        actual = {p.name for p in v02_schemas}
        observation = {'guest_command_observation.schema.json': '41e1b9afaffd73263768648e33752fb17614a6d7bd2968a81e588cfbe70907a7', 'guest_command_observation_envelope.schema.json': '24ea0d9952e241e7e1c4179fd10bfa05f76f26ea3895195a35089716fab4f057'}
        self.assertEqual(actual, set(published) | additions | set(observation))
        for name, expected in observation.items():
            self.assertEqual(hashlib.sha256((ROOT / 'contracts/v0.2' / name).read_bytes()).hexdigest(), expected)
        prior = {'action_proposal.schema.json': '65ac7b8303183cf2dc07c75732818b67e14da989fd616f1028dde75d3bb2375d', 'action_receipt.schema.json': '2148a9e67669a01829965d8e7698338b425207d6f1e2e771daadd87de89ad36b', 'action_verdict.schema.json': '7c0d1653a58628d969582b204581162edc9a8fa961cfc52aa8c9032f9346b56d', 'capsule_capabilities.schema.json': '8979eebb32fa093823c70d35ed7c0c8be8d9ed3ddcc5e0b6cf5c88415ec721bc', 'capsule_envelope.schema.json': 'ff84d3d69ebba8a041b93b8b64e0b31be3f91f7262c321664f9395bd119caddc', 'capsule_meta.schema.json': '494d99f3882b4e8a3a1c02e2a72785cb3fe13859985aef692068f7bbc9179b0b', 'capsule_resource_inventory.schema.json': 'affa303edcaaf839a0fb24e05584c1c039b10752d01f678ed1e87890112172de', 'capsule_state_event.schema.json': '8172a6a2600085e6b08dfaaba91320808aae3c000be160420fcbe9bcd3634070', 'capsule_state_request.schema.json': '27bf48d0778bd9763595efffb8fde177edee13e667c9268f3e49fa4fcec19253', 'catalog_entry.schema.json': '0e3a515c2fcb6a5e2153ab892f394f73b6a4ccc3f76cc5c9916c78a9324bc833', 'envelope.schema.json': '9e4cc8049bb39d906d3e2df21bba20618959ac35c11dae68f59cf450ef0338f3', 'frame_ref.schema.json': '8050ce412b6b95792468701ea69670222798840b54787fee18f1f99dd3738397', 'guest_command_event.schema.json': '254bd7340f2f675e1338591c1b736b32523e4aa59b79be2fd498c9ff14de0281', 'guest_command_request.schema.json': 'acc36863303f5990ce1f242454f59edb31f8ec4eb13d35758504ac5d364cab11', 'guest_command_session.schema.json': 'ee4c8621504efd7b02605bbc5e6dd4986f120f373e71a04b7c2b80f272bbd29f', 'guest_transport_metadata.schema.json': '2a8c9fead399aa19ce6dd3675967632163624830635f07784baab820171e37db', 'headless_event.schema.json': '0e1ee82215d970d198e514fcf8dafadc68cca20f90e89253965ccd20ac9af609', 'headless_request.schema.json': '619ab2243965f876c3a15e276f30eba12617df8716a2d0fdea0e5ee5f1189965', 'headless_session.schema.json': 'fa626cf78172c3f857814c6bfdd63db44624fe1d0ce722dcdf3cc663263128b9', 'hello.schema.json': 'e3099628720ebf4260528ff809f74d08a2da8a762339d2fdbaaca097f2a0d13c', 'mv_tool_call.schema.json': '7da7513b1b457dfeb08689c0ae70b2b950a2e093dab8706d99267acbd868cd5f', 'mv_tool_result.schema.json': 'f70eca64419f98375bb01259c4bb0cdd9cc64de1bb9158561ba5c32480fa3faa', 'observation.schema.json': '65ccb926746357fa88d0dad628199b3a27a51b5722201c1eb22e34059d761ead', 'record_event.schema.json': '4a18f9c8d32b43ad43a6f194717d977f786531fc7e9049ab0369951d37619fe8', 'record_request.schema.json': '4c781ef8e0807aa36d3b1abf87eff7f0ca943676626342bdc7f40ba8b6eb2a22', 'rewind_envelope.schema.json': '8524fc9414558caf58c8457bbe521e2cebde469c8449109d5f0a2caca8104713', 'rewind_event.schema.json': '8e9ff5c67e452e509e3566d06c87c6309f718e4669925135b030a7ea6d7c1dc7', 'rewind_guest_reset.schema.json': 'c4c3eb165cfa69f906b476217ff7d110724faceeebd638c6345549da51c7986c', 'rewind_point.schema.json': 'b91797baa9f29b07996c0e69383292d285972f66bf4d34ff928dc0225e8492f1', 'rewind_request.schema.json': 'ca5ed4c3dd6256a4e5dd0e246d49636374594142d78867993890bd74b4dcbdbe', 'rewind_session.schema.json': 'fba098950690528c848b082733f59d2670483792ce4bb7cbf4bb233452014a03', 'session_record.schema.json': '0b409b0e8958fbddb44d029ef8b79f634103e92d9092db76ecc207027bf5af5a', 'settings.schema.json': 'd162909a4f1a34b29f8e00651a89af7ddc75991c74c0aa527373253a729c154e', 'surface.schema.json': '90da5357ae82f065e32efa6b06cc4f6415e709a5257777f226b5c397acb8c2da', 'surface_event.schema.json': '6c4eb7497065bf6fd8fd965448c2cdcd0a5960f78012f5ec7c1453a3b0fba947', 'surface_input.schema.json': '023d7503602109c8b58dc86795cdd6279f1acf2db407ac3d6299a734765d139e', 'surface_request.schema.json': '4ab05a8018d3cc69747fa1b5d478186127fd8d0c3cd555ae7984344493e56a89', 'terminal_session.schema.json': '6896578203d3cbc14ccc474e4d9aec86d4c327e158bdc1fcc6e6689473d34cb5', 'ui_intent.schema.json': 'e30a180368df1ca38a2af58d26a7548053898a8cd6c595bd5cd7d7f4c57e3317'}
        for name, expected in prior.items():
            self.assertEqual(hashlib.sha256((ROOT / 'contracts/v0.2' / name).read_bytes()).hexdigest(), expected)
        self.assertTrue(set(published).isdisjoint(additions))
        for name, expected in published.items():
            self.assertEqual(hashlib.sha256((ROOT / 'contracts/v0.2' / name).read_bytes()).hexdigest(), expected)
        with self.assertRaises(AssertionError):
            self.assertEqual(actual - {next(iter(observation))}, set(published) | additions | set(observation))
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

    def test_t6_r3_008_surface_input_chord_and_unicode_scalar_alignment(self) -> None:
        schema = self.validator.load("surface_input.schema.json")

        def make_batch(events: list) -> dict:
            return {
                "schema": "surface_input/v0.2",
                "surface_id": "cap-browser",
                "stream_id": 1,
                "seq": 1,
                "events": events,
            }

        admitted_batches = [
            ("non-bmp-513-scalars", make_batch([{"kind": "type", "text": "\U0001f600" * 513}])),
            ("non-bmp-1024-scalars", make_batch([{"kind": "type", "text": "\U0001f600" * 1024}])),
            ("chord-2-control-l", make_batch([{"kind": "key", "keys": ["Control_L", "l"]}])),
            ("chord-3-ctrl-shift-l", make_batch([{"kind": "key", "keys": ["ctrl", "shift", "l"]}])),
            ("chord-8-single-a", make_batch([{"kind": "key", "keys": ["a"] * 8}])),
        ]
        refused_batches = [
            ("chord-8x-aaaa-39-chars", make_batch([{"kind": "key", "keys": ["aaaa"] * 8}])),
            ("chord-9-items", make_batch([{"kind": "key", "keys": ["a"] * 9}])),
            ("chord-malformed-token", make_batch([{"kind": "key", "keys": ["bad key!"]}])),
            ("type-1025-ascii-scalars", make_batch([{"kind": "type", "text": "a" * 1025}])),
            ("type-1025-non-bmp-scalars", make_batch([{"kind": "type", "text": "\U0001f600" * 1025}])),
            ("type-nul-char", make_batch([{"kind": "type", "text": "a\x00b"}])),
            ("events-33-batch", make_batch([{"kind": "key", "keys": ["a"]} for _ in range(33)])),
        ]

        for name, batch in admitted_batches:
            with self.subTest(verdict="admit", case=name):
                self.validator.validate(batch, schema)

        for name, batch in refused_batches:
            with self.subTest(verdict="refuse", case=name):
                with self.assertRaises(ValidationError):
                    self.validator.validate(batch, schema)


if __name__ == "__main__":
    unittest.main()
