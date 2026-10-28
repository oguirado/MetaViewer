"""Four-way cross-language decoder conformance matrix (T6R2-013).

Runs every contracts/examples/v0.2/*.json fixture plus the T6R2-001..007
adversarial mutations and their positive controls through:
  - Rust: metaviewer_core::decode_envelope
  - Go: metaviewer/daemon-adapter/internal/ipc SchemaPolicy.ValidateEnvelope
  - Python: metaviewer_agents.envelope.validate_envelope
  - Checker: tools.check_contracts.loads_strict + Validator.validate

Asserts unanimous verdicts across all four decoders on all 475+ contract
example fixtures and positive controls, and pins the T6R2-001..007 negative
controls (documenting the pre-U1..U5 splits until U1..U5 land, and enforcing
unanimous refusal once each decoder fix is present).
"""

import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "agents"))

from metaviewer_agents.envelope import EnvelopeError, validate_envelope
from tools.check_contracts import ValidationError, Validator, loads_strict


def _find_conditional_oracle_defs(source: str) -> list[str]:
    tree = ast.parse(source)
    return [
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name.endswith("_fixed")
    ]


def _run_rust_probe(raw_lines: list[str], schema_cases: list[tuple[dict, dict]] | None = None) -> tuple[list[bool], list[bool]]:
    cargo = shutil.which(os.environ.get("CARGO", "cargo"))
    if cargo is None:
        raise RuntimeError("cargo must be supplied by PATH or CARGO")
    schema_cases = schema_cases or []
    with tempfile.TemporaryDirectory(prefix="conformance-rs-") as temp:
        directory = Path(temp)
        (directory / "src").mkdir()
        (directory / "Cargo.toml").write_text(
            '[package]\nname = "decoder-conformance-probe"\nversion = "0.0.0"\n'
            "edition = \"2021\"\n[workspace]\n[dependencies]\n"
            'serde_json = "=1.0.154"\n'
            "metaviewer-core = { path = " + json.dumps(str(ROOT / "core")) + " }\n"
        )
        (directory / "src/main.rs").write_text(
            "use std::io::{self, BufRead};\nfn main() {\n"
            "for line in io::stdin().lock().lines() {\n"
            "let line = line.unwrap();\n"
            'if let Some(rest) = line.strip_prefix("SCHEMA_VALID:") {\n'
            "let pair: (serde_json::Value, serde_json::Value) = serde_json::from_str(rest).unwrap();\n"
            'println!("{}", metaviewer_core::valid(&pair.0, &pair.1, &pair.1));\n'
            "} else {\n"
            'println!("{}", metaviewer_core::decode_envelope(&line).is_ok());\n'
            "}\n"
            "}\n}\n"
        )
        environment = dict(os.environ)
        environment.setdefault("CARGO_TARGET_DIR", str(directory / "target"))
        stdin_lines = [
            *(line + "\n" for line in raw_lines),
            *(
                "SCHEMA_VALID:" + json.dumps([val, sch], separators=(",", ":")) + "\n"
                for val, sch in schema_cases
            ),
        ]
        result = subprocess.run(
            [cargo, "run", "--offline", "--quiet", "--manifest-path", str(directory / "Cargo.toml")],
            input="".join(stdin_lines),
            text=True,
            capture_output=True,
            env=environment,
            timeout=180,
        )
        if result.returncode != 0:
            raise RuntimeError("Rust conformance probe failed: " + result.stderr)
        answers = [line.strip() == "true" for line in result.stdout.splitlines()]
        expected_total = len(raw_lines) + len(schema_cases)
        if len(answers) != expected_total:
            raise RuntimeError(f"Rust probe line count mismatch: {len(answers)} != {expected_total}")
        return answers[: len(raw_lines)], answers[len(raw_lines) :]


def _run_go_probe(raw_lines: list[str], envelope_schema_override: str | None = None) -> list[bool]:
    go = shutil.which(os.environ.get("GO", "go"))
    if go is None:
        raise RuntimeError("go must be supplied by PATH or GO")
    with tempfile.TemporaryDirectory(prefix="conformance-go-", dir="/tmp") as temp:
        temp_root = Path(temp)
        in_path = temp_root / "in.jsonl"
        out_path = temp_root / "out.txt"
        in_path.write_text("".join(line + "\n" for line in raw_lines))
        environment = dict(
            os.environ,
            GOPROXY="off",
            GOSUMDB="off",
            GOTOOLCHAIN="local",
            TMPDIR=str(temp_root),
            MV_SCHEMA_DIR=str(ROOT / "contracts/v0.2"),
            MV_PROBE_IN=str(in_path),
            MV_PROBE_OUT=str(out_path),
        )
        if envelope_schema_override is not None:
            environment["MV_ENVELOPE_SCHEMA_JSON"] = envelope_schema_override
        result = subprocess.run(
            [go, "test", "./internal/ipc", "-run", "^TestConformanceProbe$", "-count=1"],
            cwd=ROOT / "daemon-adapter",
            text=True,
            capture_output=True,
            env=environment,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError("Go conformance probe failed: " + result.stdout + result.stderr)
        answers = out_path.read_text().splitlines()
        if len(answers) != len(raw_lines):
            raise RuntimeError(f"Go probe line count mismatch: {len(answers)} != {len(raw_lines)}")
        return [line.strip() == "true" for line in answers]


def _run_go_schema_probe(schema_cases: list[tuple[dict, dict]]) -> list[bool]:
    go = shutil.which(os.environ.get("GO", "go"))
    if go is None:
        raise RuntimeError("go must be supplied by PATH or GO")
    with tempfile.TemporaryDirectory(prefix="conformance-go-sch-", dir="/tmp") as temp:
        temp_root = Path(temp)
        in_path = temp_root / "in.jsonl"
        out_path = temp_root / "out.txt"
        in_path.write_text(
            "".join(
                json.dumps([val, sch], separators=(",", ":")) + "\n"
                for val, sch in schema_cases
            )
        )
        environment = dict(
            os.environ,
            GOPROXY="off",
            GOSUMDB="off",
            GOTOOLCHAIN="local",
            TMPDIR=str(temp_root),
            MV_SCHEMA_VALID_IN=str(in_path),
            MV_SCHEMA_VALID_OUT=str(out_path),
        )
        result = subprocess.run(
            [go, "test", "./internal/ipc", "-run", "^TestSchemaNodeAcceptProbe$", "-count=1"],
            cwd=ROOT / "daemon-adapter",
            text=True,
            capture_output=True,
            env=environment,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError("Go schema probe failed: " + result.stdout + result.stderr)
        answers = out_path.read_text().splitlines()
        if len(answers) != len(schema_cases):
            raise RuntimeError(f"Go schema probe line count mismatch: {len(answers)} != {len(schema_cases)}")
        return [line.strip() == "true" for line in answers]


def _run_python_decoder(raw_line: str) -> bool:
    try:
        value = json.loads(
            raw_line,
            object_pairs_hook=lambda pairs: (
                (_ for _ in ()).throw(ValueError("duplicate key"))
                if len({k for k, _ in pairs}) != len(pairs)
                else dict(pairs)
            ),
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite")),
        )
        validate_envelope(value)
        return True
    except (EnvelopeError, ValueError, TypeError, RecursionError):
        return False


def _run_checker_decoder(validator: Validator, envelope_schema: dict, raw_line: str) -> bool:
    try:
        value = loads_strict(raw_line)
        validator.validate(value, envelope_schema)
        return True
    except (ValidationError, ValueError, TypeError, RecursionError):
        return False


def _run_python_schema_check(value: dict, schema: dict) -> bool:
    import copy
    import metaviewer_agents.envelope as env_mod

    versioned = copy.deepcopy(schema)
    for k in ("$schema", "$id", "title", "description", "$defs"):
        versioned.pop(k, None)
    env_mod._version_refs(versioned)
    try:
        env_mod._check(value, versioned, 0)
        return True
    except env_mod._Mismatch:
        return False


class DecoderConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.validator = Validator(ROOT / "contracts/v0.2")
        cls.envelope_schema = cls.validator.load("envelope.schema.json")
        cls.base_envelope = json.loads(
            (ROOT / "contracts/examples/v0.2/envelope.valid.json").read_text()
        )
        cls.examples_dir = ROOT / "contracts/examples/v0.2"
        cls.fixture_paths = sorted(cls.examples_dir.glob("*.json"))
        envelope_bodies = {
            branch["$ref"].removesuffix(".schema.json")
            for branch in cls.envelope_schema["properties"]["body"]["oneOf"]
        }

        def wrap_obj(body_obj: dict) -> str:
            return json.dumps({**cls.base_envelope, "body": body_obj}, separators=(",", ":"))

        cls.fixture_cases = []
        for path in cls.fixture_paths:
            body = json.loads(path.read_text())
            schema_prefix = path.name.split(".", 1)[0]
            if path.name.startswith("envelope."):
                raw = json.dumps(body, separators=(",", ":"))
            else:
                raw = wrap_obj(body)
            expected = ".valid." in path.name and (
                schema_prefix == "envelope" or schema_prefix in envelope_bodies
            )
            cls.fixture_cases.append((path.name, raw, expected))

        obs_valid = json.loads((cls.examples_dir / "observation.valid.json").read_text())
        frame_valid = json.loads((cls.examples_dir / "frame_ref.valid.json").read_text())
        rcpt_valid = json.loads((cls.examples_dir / "action_receipt.valid.json").read_text())
        term_valid = json.loads((cls.examples_dir / "terminal_session.valid.json").read_text())

        # Positive controls corresponding to 001..007
        cls.positive_controls = [
            (
                "pos-001-nested-v02",
                wrap_obj(
                    {
                        "schema": "mv_tool_result/v0.2",
                        "request_id": "req-001",
                        "op": "observe",
                        "status": "ok",
                        "observation": obs_valid,
                    }
                ),
            ),
            ("pos-002-int-generation", wrap_obj({**frame_valid, "generation": 1})),
            ("pos-003-clean-ramws", wrap_obj({**frame_valid, "ramws_path": "/dev/shm/ramws/demo.rgb"})),
            (
                "pos-003b-adapter-ramws",
                wrap_obj(
                    {
                        **frame_valid,
                        "ramws_path": "/dev/shm/mv-adapter-1/frames-123456/0123456789abcdef0123456789abcdef.rgb",
                    }
                ),
            ),
            ("pos-004-clean-sha256", wrap_obj({**frame_valid, "sha256": "a" * 64})),
            ("pos-005-65536-ascii", wrap_obj({**rcpt_valid, "error": "a" * 65536})),
            ("pos-006-valid-unicode", wrap_obj({**rcpt_valid, "error": "é-\U0001f600"})),
            (
                "pos-007-terminal-len-match",
                wrap_obj({**term_valid, "params": {**term_valid["params"], "b64": "YQ==", "byte_count": 1}}),
            ),
            (
                "pos-008-create-nested-depth-0",
                wrap_obj(
                    {
                        "schema": "surface_request/v0.2",
                        "op": "create",
                        "params": {
                            "kind": "desktop_capsule",
                            "geometry": {"w": 1280, "h": 720},
                            "profile_id": "notepad-0",
                            "nested_depth": 0,
                        },
                    }
                ),
            ),
            (
                "pos-009-create-nested-depth-1",
                wrap_obj(
                    {
                        "schema": "surface_request/v0.2",
                        "op": "create",
                        "params": {
                            "kind": "desktop_capsule",
                            "geometry": {"w": 1280, "h": 720},
                            "profile_id": "inner-host-1",
                            "nested_depth": 1,
                        },
                    }
                ),
            ),
        ]

        # Adversarial mutations T6R2-001..007
        raw_001 = wrap_obj(
            {
                "schema": "mv_tool_result/v0.2",
                "request_id": "req-001",
                "op": "observe",
                "status": "ok",
                "observation": {**obs_valid, "schema": "observation/v0.1"},
            }
        )
        raw_002 = wrap_obj({**frame_valid, "generation": 1}).replace(
            '"generation":1', '"generation":1.0'
        )
        raw_003 = wrap_obj({**frame_valid, "ramws_path": "/dev/shm/a\nb"})
        raw_004 = wrap_obj({**frame_valid, "sha256": frame_valid["sha256"] + "\n"})
        raw_005 = wrap_obj({**rcpt_valid, "error": "é" * 32769})
        raw_006 = wrap_obj({**rcpt_valid, "error": "SURROGATE_MARKER"}).replace(
            "SURROGATE_MARKER", r"x\ud800y"
        )
        raw_007 = wrap_obj(
            {**term_valid, "params": {**term_valid["params"], "b64": "YQ==", "byte_count": 2}}
        )

        unanimous_refusal = {
            "rust": False,
            "go": False,
            "python": False,
            "checker": False,
        }
        cls.mutation_cases = [
            ("T6R2-001", raw_001, dict(unanimous_refusal)),
            ("T6R2-002", raw_002, dict(unanimous_refusal)),
            ("T6R2-003", raw_003, dict(unanimous_refusal)),
            ("T6R2-004", raw_004, dict(unanimous_refusal)),
            ("T6R2-005", raw_005, dict(unanimous_refusal)),
            ("T6R2-006", raw_006, dict(unanimous_refusal)),
            ("T6R2-007", raw_007, dict(unanimous_refusal)),
            (
                "RV7-ramws-traversal",
                wrap_obj({**frame_valid, "ramws_path": "/dev/shm/../etc/x"}),
                {"rust": False, "go": False, "python": False, "checker": False},
            ),
            (
                "RV7-ramws-empty-seg",
                wrap_obj({**frame_valid, "ramws_path": "/dev/shm/a//b"}),
                {"rust": False, "go": False, "python": False, "checker": False},
            ),
            (
                "RV7-ramws-hidden-seg",
                wrap_obj({**frame_valid, "ramws_path": "/dev/shm/.x"}),
                {"rust": False, "go": False, "python": False, "checker": False},
            ),
            (
                "RV7-ramws-bare-root",
                wrap_obj({**frame_valid, "ramws_path": "/dev/shm"}),
                {"rust": False, "go": False, "python": False, "checker": False},
            ),
            (
                "AC17-nested-depth-2",
                wrap_obj(
                    {
                        "schema": "surface_request/v0.2",
                        "op": "create",
                        "params": {
                            "kind": "desktop_capsule",
                            "geometry": {"w": 1280, "h": 720},
                            "profile_id": "inner-host-1",
                            "nested_depth": 2,
                        },
                    }
                ),
                dict(unanimous_refusal),
            ),
            (
                "AC17-nested-depth-neg1",
                wrap_obj(
                    {
                        "schema": "surface_request/v0.2",
                        "op": "create",
                        "params": {
                            "kind": "desktop_capsule",
                            "geometry": {"w": 1280, "h": 720},
                            "profile_id": "inner-host-1",
                            "nested_depth": -1,
                        },
                    }
                ),
                dict(unanimous_refusal),
            ),
            (
                "AC17-nested-depth-float",
                wrap_obj(
                    {
                        "schema": "surface_request/v0.2",
                        "op": "create",
                        "params": {
                            "kind": "desktop_capsule",
                            "geometry": {"w": 1280, "h": 720},
                            "profile_id": "inner-host-1",
                            "nested_depth": 1,
                        },
                    }
                ).replace('"nested_depth":1', '"nested_depth":1.0'),
                dict(unanimous_refusal),
            ),
            (
                "AC17-nested-depth-bool",
                wrap_obj(
                    {
                        "schema": "surface_request/v0.2",
                        "op": "create",
                        "params": {
                            "kind": "desktop_capsule",
                            "geometry": {"w": 1280, "h": 720},
                            "profile_id": "inner-host-1",
                            "nested_depth": True,
                        },
                    }
                ),
                dict(unanimous_refusal),
            ),
        ]

        all_raw = (
            [raw for _, raw, _ in cls.fixture_cases]
            + [raw for _, raw in cls.positive_controls]
            + [raw for _, raw, _ in cls.mutation_cases]
        )

        import copy

        synth_good_const = copy.deepcopy(cls.envelope_schema)
        synth_good_const["properties"]["body"] = {
            "oneOf": [
                {
                    "$ref": "frame_ref.schema.json",
                    "const": frame_valid,
                }
            ]
        }
        frame_bad_sha = {**frame_valid, "sha256": "not-a-valid-sha256"}
        synth_bad_const = copy.deepcopy(cls.envelope_schema)
        synth_bad_const["properties"]["body"] = {
            "oneOf": [
                {
                    "$ref": "frame_ref.schema.json",
                    "const": frame_bad_sha,
                }
            ]
        }

        env_gen1 = {**cls.base_envelope, "body": frame_valid}
        env_gen2 = {**cls.base_envelope, "body": {**frame_valid, "generation": 2}}
        env_bad_sha = {**cls.base_envelope, "body": frame_bad_sha}

        synth_max_props_10 = copy.deepcopy(cls.envelope_schema)
        synth_max_props_10["properties"]["body"] = {
            "oneOf": [
                {
                    "$ref": "frame_ref.schema.json",
                    "maxProperties": 10,
                }
            ]
        }
        synth_max_props_12 = copy.deepcopy(cls.envelope_schema)
        synth_max_props_12["properties"]["body"] = {
            "oneOf": [
                {
                    "$ref": "frame_ref.schema.json",
                    "maxProperties": 12,
                }
            ]
        }

        cls.r1_084_cases = [
            ("r1-084-pos-both-match", env_gen1, synth_good_const, True),
            ("r1-084-neg-ref-ok-const-mismatch", env_gen2, synth_good_const, False),
            ("r1-084-neg-const-ok-ref-mismatch", env_bad_sha, synth_bad_const, False),
            ("t6-r3-007-neg-ref-max-properties-10", env_gen1, synth_max_props_10, False),
            ("t6-r3-007-pos-ref-max-properties-12", env_gen1, synth_max_props_12, True),
        ]

        cls.open_props_cases = [
            (
                "d3-open-props-extra-key-admitted",
                {"a": 1, "zzz": 1},
                {"properties": {"a": {"type": "integer"}}},
                True,
            ),
            (
                "d3-open-props-declared-key-type-mismatch-refused",
                {"a": "bad", "zzz": 1},
                {"properties": {"a": {"type": "integer"}}},
                False,
            ),
            (
                "d3-closed-props-extra-key-refused",
                {"a": 1, "zzz": 1},
                {"properties": {"a": {"type": "integer"}}, "additionalProperties": False},
                False,
            ),
        ]

        rs_verdicts, rs_schema_all = _run_rust_probe(
            all_raw,
            [(val, sch) for _, val, sch, _ in cls.r1_084_cases]
            + [(val, sch) for _, val, sch, _ in cls.open_props_cases],
        )
        rs_r1_084 = rs_schema_all[: len(cls.r1_084_cases)]
        rs_open_props = rs_schema_all[len(cls.r1_084_cases) :]
        go_verdicts = _run_go_probe(all_raw)
        go_r1_084_good = _run_go_probe(
            [
                json.dumps(env_gen1, separators=(",", ":")),
                json.dumps(env_gen2, separators=(",", ":")),
            ],
            envelope_schema_override=json.dumps(synth_good_const),
        )
        go_r1_084_bad = _run_go_probe(
            [json.dumps(env_bad_sha, separators=(",", ":"))],
            envelope_schema_override=json.dumps(synth_bad_const),
        )
        go_t6_007_10 = _run_go_probe(
            [json.dumps(env_gen1, separators=(",", ":"))],
            envelope_schema_override=json.dumps(synth_max_props_10),
        )
        go_t6_007_12 = _run_go_probe(
            [json.dumps(env_gen1, separators=(",", ":"))],
            envelope_schema_override=json.dumps(synth_max_props_12),
        )
        go_r1_084 = go_r1_084_good + go_r1_084_bad + go_t6_007_10 + go_t6_007_12
        go_open_props = _run_go_schema_probe([(val, sch) for _, val, sch, _ in cls.open_props_cases])
        py_verdicts = [_run_python_decoder(raw) for raw in all_raw]
        chk_verdicts = [
            _run_checker_decoder(cls.validator, cls.envelope_schema, raw) for raw in all_raw
        ]

        cls.verdicts = [
            {"rust": r, "go": g, "python": p, "checker": c}
            for r, g, p, c in zip(rs_verdicts, go_verdicts, py_verdicts, chk_verdicts)
        ]
        cls.r1_084_verdicts = [
            {
                "rust": rs_r1_084[i],
                "go": go_r1_084[i],
                "python": _run_python_schema_check(val, sch),
                "checker": _run_checker_decoder(
                    cls.validator, sch, json.dumps(val, separators=(",", ":"))
                ),
            }
            for i, (_, val, sch, _) in enumerate(cls.r1_084_cases)
        ]
        cls.open_props_verdicts = [
            {
                "rust": rs_open_props[i],
                "go": go_open_props[i],
                "python": _run_python_schema_check(val, sch),
                "checker": _run_checker_decoder(
                    cls.validator, sch, json.dumps(val, separators=(",", ":"))
                ),
            }
            for i, (_, val, sch, _) in enumerate(cls.open_props_cases)
        ]

    def test_all_v02_example_fixtures_unanimous_across_four_decoders(self):
        import hashlib

        names_all = [name for name, _, _ in self.fixture_cases]
        names_488 = [n for n in names_all if n != "surface_input.invalid.chord_overflow.json"]
        self.assertEqual(len(names_488), 488)
        self.assertIn(len(names_all), (488, 489))
        self.assertIn("surface_request.invalid.origin_unknown.json", names_488)
        self.assertEqual(
            hashlib.sha256("\n".join(names_488).encode("utf-8")).hexdigest(),
            "0152797c88a120d4870524f0b8cbed6eeae16a2e0a0089a895968987a89d3e8a",
        )
        if len(names_all) == 489:
            self.assertEqual(
                hashlib.sha256("\n".join(names_all).encode("utf-8")).hexdigest(),
                "ca0ef707054090c6576c47ca7838b5a43da82767ec7e4da195787d7c9589d9c0",
            )
        for idx, (name, _, expected) in enumerate(self.fixture_cases):
            self.assertTrue(
                ".valid." in name or ".invalid." in name,
                f"Unexpected fixture naming: {name}",
            )
            verdict = self.verdicts[idx]
            with self.subTest(fixture=name):
                self.assertEqual(
                    verdict,
                    {"rust": expected, "go": expected, "python": expected, "checker": expected},
                )

    def test_adversarial_mutations_positive_controls_unanimous_admit(self):
        offset = len(self.fixture_cases)
        for idx, (name, _) in enumerate(self.positive_controls):
            verdict = self.verdicts[offset + idx]
            with self.subTest(control=name):
                self.assertEqual(
                    verdict,
                    {"rust": True, "go": True, "python": True, "checker": True},
                )

    def test_adversarial_mutations_001_to_007_negative_controls(self):
        offset = len(self.fixture_cases) + len(self.positive_controls)
        unanimous_refusal = {"rust": False, "go": False, "python": False, "checker": False}
        for idx, (uid, _, expected_map) in enumerate(self.mutation_cases):
            verdict = self.verdicts[offset + idx]
            with self.subTest(uid=uid):
                self.assertEqual(expected_map, unanimous_refusal)
                self.assertEqual(verdict, unanimous_refusal)

    def test_no_source_sniffing_oracles_in_conformance_module(self):
        source = Path(__file__).read_text()
        self.assertEqual(_find_conditional_oracle_defs(source), [])
        # Negative control: synthetic copy with a dummy *_fixed helper is detected.
        mutated_source = source + "\ndef _u1_dummy_fixed() -> bool:\n    return True\n"
        self.assertEqual(
            _find_conditional_oracle_defs(mutated_source),
            ["_u1_dummy_fixed"],
        )

    def test_r1_084_ref_with_sibling_const_mirrored_across_decoders(self):
        for idx, (name, _, _, expected) in enumerate(self.r1_084_cases):
            with self.subTest(case=name):
                self.assertEqual(
                    self.r1_084_verdicts[idx],
                    {"rust": expected, "go": expected, "python": expected, "checker": expected},
                )

    def test_properties_without_additional_properties_false_four_way_conformance(self):
        for idx, (name, _, _, expected) in enumerate(self.open_props_cases):
            with self.subTest(case=name):
                self.assertEqual(
                    self.open_props_verdicts[idx],
                    {"rust": expected, "go": expected, "python": expected, "checker": expected},
                )


if __name__ == "__main__":
    unittest.main()
