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


def _u1_rust_nested_alias_fixed() -> bool:
    payload_rs = (ROOT / "core/src/wire/payload.rs").read_text()
    return 'alias = "observation/v0.1"' not in payload_rs


def _u2_go_int_lexeme_fixed() -> bool:
    policy_go = (ROOT / "daemon-adapter/internal/ipc/policy.go").read_text()
    return "0|[1-9]" in policy_go or "strings.ContainsAny" in policy_go


def _u4_ramws_schema_fixed() -> bool:
    schema_text = (ROOT / "contracts/v0.2/frame_ref.schema.json").read_text()
    return r"\r\n" in schema_text or "\\r\\n" in schema_text


def _u3_py_anchor_fixed() -> bool:
    env_py = (ROOT / "agents/metaviewer_agents/envelope.py").read_text()
    return r"\Z" in env_py


def _u3_py_byte_cap_fixed() -> bool:
    env_py = (ROOT / "agents/metaviewer_agents/envelope.py").read_text()
    return "65536" in env_py and ".encode(" in env_py


def _u5_chk_byte_cap_fixed() -> bool:
    chk_py = (ROOT / "tools/check_contracts.py").read_text()
    return "65536" in chk_py and ".encode(" in chk_py


def _u2_go_surrogate_fixed() -> bool:
    json_go = (ROOT / "daemon-adapter/internal/ipc/json.go").read_text()
    return any(tok in json_go for tok in ("surrogate", "0xd800", "0xD800", "utf16", "RuneError"))


def _u5_chk_surrogate_fixed() -> bool:
    chk_py = (ROOT / "tools/check_contracts.py").read_text()
    return "0xD800" in chk_py or "0xd800" in chk_py


def _u2_go_terminal_fixed() -> bool:
    policy_go = (ROOT / "daemon-adapter/internal/ipc/policy.go").read_text()
    return "terminal_session/v0.2" in policy_go and "byte_count" in policy_go


def _u3_py_terminal_fixed() -> bool:
    env_py = (ROOT / "agents/metaviewer_agents/envelope.py").read_text()
    return "terminal_session/v0.2" in env_py and "byte_count" in env_py


def _u5_chk_terminal_fixed() -> bool:
    chk_py = (ROOT / "tools/check_contracts.py").read_text()
    return "terminal_session/v0.2" in chk_py and "byte_count" in chk_py


def _run_rust_probe(raw_lines: list[str]) -> list[bool]:
    cargo = shutil.which(os.environ.get("CARGO", "cargo"))
    if cargo is None:
        raise RuntimeError("cargo must be supplied by PATH or CARGO")
    with tempfile.TemporaryDirectory(prefix="conformance-rs-") as temp:
        directory = Path(temp)
        (directory / "src").mkdir()
        (directory / "Cargo.toml").write_text(
            '[package]\nname = "decoder-conformance-probe"\nversion = "0.0.0"\n'
            "edition = \"2021\"\n[workspace]\n[dependencies]\n"
            "metaviewer-core = { path = " + json.dumps(str(ROOT / "core")) + " }\n"
        )
        (directory / "src/main.rs").write_text(
            "use std::io::{self, BufRead};\nfn main() {\n"
            "for line in io::stdin().lock().lines() {\n"
            'println!("{}", metaviewer_core::decode_envelope(&line.unwrap()).is_ok());\n'
            "}\n}\n"
        )
        environment = dict(os.environ)
        environment.setdefault("CARGO_TARGET_DIR", str(directory / "target"))
        result = subprocess.run(
            [cargo, "run", "--offline", "--quiet", "--manifest-path", str(directory / "Cargo.toml")],
            input="".join(line + "\n" for line in raw_lines),
            text=True,
            capture_output=True,
            env=environment,
            timeout=180,
        )
        if result.returncode != 0:
            raise RuntimeError("Rust conformance probe failed: " + result.stderr)
        answers = result.stdout.splitlines()
        if len(answers) != len(raw_lines):
            raise RuntimeError(f"Rust probe line count mismatch: {len(answers)} != {len(raw_lines)}")
        return [line.strip() == "true" for line in answers]


def _run_go_probe(raw_lines: list[str]) -> list[bool]:
    go = shutil.which(os.environ.get("GO", "go"))
    if go is None:
        raise RuntimeError("go must be supplied by PATH or GO")
    with tempfile.TemporaryDirectory(prefix="conformance-go-", dir="/tmp") as temp:
        temp_root = Path(temp)
        adapter_dir = temp_root / "daemon-adapter"
        (adapter_dir / "internal").mkdir(parents=True)
        shutil.copyfile(ROOT / "daemon-adapter/go.mod", adapter_dir / "go.mod")
        shutil.copytree(ROOT / "daemon-adapter/internal/ipc", adapter_dir / "internal/ipc")
        (adapter_dir / "internal/ipc/conformance_probe_test.go").write_text(
            """package ipc

import (
\t"bufio"
\t"fmt"
\t"os"
\t"testing"
)

func TestConformanceProbe(t *testing.T) {
\tp, err := NewPolicy(ceilingConfig(), os.DirFS(os.Getenv("MV_SCHEMA_DIR")), &dummyPolicy{})
\tif err != nil {
\t\tt.Fatal(err)
\t}
\tinFile, err := os.Open(os.Getenv("MV_PROBE_IN"))
\tif err != nil {
\t\tt.Fatal(err)
\t}
\tdefer inFile.Close()
\toutFile, err := os.Create(os.Getenv("MV_PROBE_OUT"))
\tif err != nil {
\t\tt.Fatal(err)
\t}
\tdefer outFile.Close()
\tscanner := bufio.NewScanner(inFile)
\tscanner.Buffer(make([]byte, 1024*1024), 2*1024*1024)
\tfor scanner.Scan() {
\t\t_, err := p.ValidateEnvelope(scanner.Bytes())
\t\tfmt.Fprintln(outFile, err == nil)
\t}
\tif err := scanner.Err(); err != nil {
\t\tt.Fatal(err)
\t}
}
"""
        )
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
        result = subprocess.run(
            [go, "test", "./internal/ipc", "-run", "^TestConformanceProbe$", "-count=1"],
            cwd=adapter_dir,
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

        def wrap_obj(body_obj: dict) -> str:
            return json.dumps({**cls.base_envelope, "body": body_obj}, separators=(",", ":"))

        cls.fixture_cases = []
        for path in cls.fixture_paths:
            body = json.loads(path.read_text())
            if path.name.startswith("envelope."):
                raw = json.dumps(body, separators=(",", ":"))
            else:
                raw = wrap_obj(body)
            expected = ".valid." in path.name
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
            ("pos-004-clean-sha256", wrap_obj({**frame_valid, "sha256": "a" * 64})),
            ("pos-005-65536-ascii", wrap_obj({**rcpt_valid, "error": "a" * 65536})),
            ("pos-006-valid-unicode", wrap_obj({**rcpt_valid, "error": "é-\U0001f600"})),
            (
                "pos-007-terminal-len-match",
                wrap_obj({**term_valid, "params": {**term_valid["params"], "b64": "YQ==", "byte_count": 1}}),
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

        cls.mutation_cases = [
            (
                "T6R2-001",
                raw_001,
                {
                    "rust": False if _u1_rust_nested_alias_fixed() else True,
                    "go": False,
                    "python": False,
                    "checker": False,
                },
            ),
            (
                "T6R2-002",
                raw_002,
                {
                    "rust": False,
                    "go": False if _u2_go_int_lexeme_fixed() else True,
                    "python": False,
                    "checker": False,
                },
            ),
            (
                "T6R2-003",
                raw_003,
                {
                    "rust": False,
                    "go": False if _u4_ramws_schema_fixed() else True,
                    "python": False if _u3_py_anchor_fixed() else True,
                    "checker": False,
                },
            ),
            (
                "T6R2-004",
                raw_004,
                {
                    "rust": False,
                    "go": False,
                    "python": False if _u3_py_anchor_fixed() else True,
                    "checker": False,
                },
            ),
            (
                "T6R2-005",
                raw_005,
                {
                    "rust": False,
                    "go": False,
                    "python": False if _u3_py_byte_cap_fixed() else True,
                    "checker": False if _u5_chk_byte_cap_fixed() else True,
                },
            ),
            (
                "T6R2-006",
                raw_006,
                {
                    "rust": False,
                    "go": False if _u2_go_surrogate_fixed() else True,
                    "python": False,
                    "checker": False if _u5_chk_surrogate_fixed() else True,
                },
            ),
            (
                "T6R2-007",
                raw_007,
                {
                    "rust": False,
                    "go": False if _u2_go_terminal_fixed() else True,
                    "python": False if _u3_py_terminal_fixed() else True,
                    "checker": False if _u5_chk_terminal_fixed() else True,
                },
            ),
        ]

        all_raw = (
            [raw for _, raw, _ in cls.fixture_cases]
            + [raw for _, raw in cls.positive_controls]
            + [raw for _, raw, _ in cls.mutation_cases]
        )
        rs_verdicts = _run_rust_probe(all_raw)
        go_verdicts = _run_go_probe(all_raw)
        py_verdicts = [_run_python_decoder(raw) for raw in all_raw]
        chk_verdicts = [
            _run_checker_decoder(cls.validator, cls.envelope_schema, raw) for raw in all_raw
        ]

        cls.verdicts = [
            {"rust": r, "go": g, "python": p, "checker": c}
            for r, g, p, c in zip(rs_verdicts, go_verdicts, py_verdicts, chk_verdicts)
        ]

    def test_all_v02_example_fixtures_unanimous_across_four_decoders(self):
        self.assertGreaterEqual(len(self.fixture_cases), 475)
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
        require_unanimous = os.environ.get("MV_REQUIRE_UNANIMOUS_MUTATIONS") == "1"
        offset = len(self.fixture_cases) + len(self.positive_controls)
        for idx, (uid, _, expected_map) in enumerate(self.mutation_cases):
            verdict = self.verdicts[offset + idx]
            target = (
                {"rust": False, "go": False, "python": False, "checker": False}
                if require_unanimous
                else expected_map
            )
            with self.subTest(uid=uid):
                self.assertEqual(verdict, target)


if __name__ == "__main__":
    unittest.main()
