"""Cross-language decoder conformance matrix for MetaViewer v0.2 contracts.

Feeds all 475 valid and invalid v0.2 fixtures across Python, Go, and Rust decoders
and asserts identical accept/refuse verdicts (SW-0070, SW-0064, E4/E5/E12).
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from tools.check_contracts import ROOT
sys.path.insert(0, str(ROOT / "agents"))
import metaviewer_agents.envelope as envelope_mod

HEADER_BASE = {
    "schema": "envelope/v0.2",
    "msg_id": "0123456789abcdef0123456789abcdef",
    "ts_ns": 1,
    "from": {"component": "agent", "instance": "a1"},
    "to": {"component": "daemon", "instance": "d1"},
    "session_id": "s1",
    "seq": 1,
    "nonce": "n1",
}


def prepare_cases():
    examples_dir = ROOT / "contracts/examples/v0.2"
    fixtures = sorted(examples_dir.glob("*.json"))
    cases = []  # list of (name, expected_valid, raw_json_line)

    for path in fixtures:
        name = path.name
        is_valid = ".valid" in name
        raw_text = path.read_text().strip()

        if name.startswith("envelope."):
            try:
                env_val = json.loads(raw_text)
                line = json.dumps(env_val, separators=(',', ':'))
            except Exception:
                line = "".join(raw_text.splitlines())
        else:
            try:
                body_val = json.loads(raw_text)
                line = json.dumps({**HEADER_BASE, "body": body_val}, separators=(',', ':'))
            except Exception:
                line = '{"schema":"envelope/v0.2","seq":1,"body":' + "".join(raw_text.splitlines()) + '}'

        cases.append((name, is_valid, line))

    return cases


class DecoderConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = prepare_cases()
        cls.rust_results = cls._run_rust_decoder(cls.cases)
        cls.go_results = cls._run_go_decoder(cls.cases)

    @classmethod
    def _run_rust_decoder(cls, cases):
        cargo = os.environ.get("CARGO", "cargo")
        with tempfile.TemporaryDirectory(prefix="rust-conformance-") as temp:
            directory = Path(temp)
            (directory / "src").mkdir()
            (directory / "Cargo.toml").write_text(
                '[package]\nname = "rust-conformance-probe"\nversion = "0.0.0"\n'
                'edition = "2021"\n[workspace]\n[dependencies]\n'
                'metaviewer-core = { path = ' + json.dumps(str(ROOT / "core")) + " }\n"
            )
            (directory / "src/main.rs").write_text(
                'use std::io::{self, BufRead};\nfn main() {\n'
                'for line in io::stdin().lock().lines() {\n'
                'let l = line.unwrap();\n'
                'let res = metaviewer_core::decode_envelope(&l).is_ok();\n'
                'println!("{}", res);\n'
                '}\n}\n'
            )
            input_data = "\n".join(c[2] for c in cases) + "\n"
            result = subprocess.run(
                [cargo, "run", "--offline", "--ignore-rust-version", "--quiet", "--manifest-path", str(directory / "Cargo.toml")],
                input=input_data, text=True, capture_output=True, timeout=120
            )
            if result.returncode != 0:
                raise RuntimeError("Rust probe failed: " + result.stderr)
            lines = [line.strip() == "true" for line in result.stdout.strip().splitlines()]
            if len(lines) != len(cases):
                raise RuntimeError(f"Rust output line count mismatch: got {len(lines)}, expected {len(cases)}")
            return lines

    @classmethod
    def _run_go_decoder(cls, cases):
        go_bin = shutil.which("go")
        if not go_bin:
            raise RuntimeError("go binary not found")

        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as temp_file:
            for c in cases:
                temp_file.write(c[2] + "\n")
            temp_path = temp_file.name

        try:
            env = dict(os.environ)
            env["GOTOOLCHAIN"] = "auto"
            env["CONFORMANCE_INPUT"] = temp_path
            cmd = [go_bin, "test", "-v", "-run", "^TestConformanceProbe$", "./internal/ipc"]
            result = subprocess.run(
                cmd, text=True, capture_output=True, env=env, cwd=ROOT / "daemon-adapter", timeout=120
            )
            if result.returncode != 0:
                raise RuntimeError("Go probe failed: " + result.stderr + "\n" + result.stdout)
            verdict_lines = [
                line.split("PROBE_VERDICT:")[1].strip() == "true"
                for line in result.stdout.splitlines()
                if "PROBE_VERDICT:" in line
            ]
            if len(verdict_lines) != len(cases):
                raise RuntimeError(f"Go output line count mismatch: got {len(verdict_lines)}, expected {len(cases)}")
            return verdict_lines
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    def test_total_fixture_count(self):
        """Assert all 475 v0.2 fixtures are tested."""
        self.assertGreaterEqual(len(self.cases), 470, f"Expected >= 470 v0.2 fixtures, found {len(self.cases)}")

    def test_cross_language_conformance_matrix(self):
        """All 3 decoders (Python, Go, Rust) agree on every fixture verdict."""
        mismatches = []

        for idx, (name, expected_valid, raw_line) in enumerate(self.cases):
            # Python verdict
            line_bytes = (raw_line + "\n").encode("utf-8")
            try:
                envelope_mod.loads_envelope(line_bytes, max_bytes=1048576)
                py_verdict = True
            except Exception:
                py_verdict = False

            rust_verdict = self.rust_results[idx]
            go_verdict = self.go_results[idx]

            # Fixture truth vs decoder verdicts
            if expected_valid != py_verdict:
                mismatches.append(f"{name}: fixture expected valid={expected_valid}, Python got {py_verdict}")
            if py_verdict != rust_verdict:
                mismatches.append(f"{name}: Python={py_verdict} vs Rust={rust_verdict}")
            if py_verdict != go_verdict:
                mismatches.append(f"{name}: Python={py_verdict} vs Go={go_verdict}")

        self.assertEqual(mismatches, [], "Cross-language decoder conformance mismatches found:\n" + "\n".join(mismatches[:20]))


if __name__ == "__main__":
    unittest.main()
