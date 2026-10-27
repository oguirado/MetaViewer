"""T7 R2c O2 Sanitizer Parity and Secrets-Gate Test Suite.

Tests mechanical extraction of all sanitizer copies across workflow files,
volume.yml drift, old oracle comparison, gitleaks exception attacks, and
gate.py failure modes.
"""
import glob
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
GITLEAKS_BIN = os.environ.get("GITLEAKS_BIN") or shutil.which("gitleaks")

sys.path.insert(0, str(ROOT / "tests/fixtures/secrets"))
import gate


def extract_sanitizer_bodies(workflow_path):
    """Extract Python sanitizer bodies from a workflow file."""
    text = workflow_path.read_text()
    bodies = re.findall(
        r"python3 - \"\$1\" \"\$2\" <<'PYEOF'\n(.*?)\n          PYEOF",
        text,
        re.S
    )
    return bodies


def runtime_secret_token(prefix="ghp_"):
    return prefix + secrets.token_hex(18)


class SanitizerParityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp_dir = Path(self.temp.name)

    def test_o2_extract_all_sanitizers_count(self):
        ci_bodies = extract_sanitizer_bodies(ROOT / ".github/workflows/ci.yml")
        vol_bodies = extract_sanitizer_bodies(ROOT / ".github/workflows/volume.yml")
        pkg_bodies = extract_sanitizer_bodies(ROOT / ".github/workflows/package.yml")
        other_bodies = extract_sanitizer_bodies(ROOT / ".github/workflows/build-other.yml")

        self.assertEqual(len(ci_bodies), 12, f"Expected 12 sanitizers in ci.yml, got {len(ci_bodies)}")
        self.assertEqual(len(vol_bodies), 3, f"Expected 3 sanitizers in volume.yml, got {len(vol_bodies)}")
        self.assertEqual(len(pkg_bodies), 1, f"Expected 1 sanitizer in package.yml, got {len(pkg_bodies)}")
        self.assertEqual(len(other_bodies), 1, f"Expected 1 sanitizer in build-other.yml, got {len(other_bodies)}")

    def test_o2_sanitizer_shared_vector_and_volume_drift(self):
        """Test shared vector across all sanitizers and detect volume.yml drift."""
        shared_tokens = [
            runtime_secret_token("ghp_"),
            runtime_secret_token("ghs_"),
            runtime_secret_token("gho_"),
            runtime_secret_token("ghu_"),
            runtime_secret_token("ghr_"),
            "ghp%5F" + secrets.token_hex(18),
            "ghp%5f" + secrets.token_hex(18),
            "GHP_" + secrets.token_hex(18),
            "github_pat_" + secrets.token_hex(18),
            "AKIA" + "A" * 16,
            "xoxb-" + "b" * 20,
            "MV0-SYNTHETIC-SENTINEL-" + secrets.token_hex(10),
        ]
        clean_line = "clean line " + "a" * 64 + "\n"

        for wf_name in ("ci.yml", "package.yml", "build-other.yml"):
            wf_path = ROOT / ".github/workflows" / wf_name
            bodies = extract_sanitizer_bodies(wf_path)
            for idx, body in enumerate(bodies):
                with self.subTest(workflow=wf_name, index=idx):
                    raw, sane = self.tmp_dir / "raw", self.tmp_dir / "sane"
                    raw.write_text("\n".join(shared_tokens) + "\n" + clean_line)
                    result = subprocess.run(
                        ["python3", "-c", textwrap.dedent(body), str(raw), str(sane)],
                        capture_output=True, text=True
                    )
                    self.assertEqual(result.returncode, 0)
                    sane_text = sane.read_text()
                    self.assertIn(clean_line.strip(), sane_text)
                    for token in shared_tokens:
                        self.assertNotIn(token, sane_text, f"{token} was leaked in {wf_name}:{idx}")

        vol_bodies = extract_sanitizer_bodies(ROOT / ".github/workflows/volume.yml")
        for idx, body in enumerate(vol_bodies):
            raw, sane = self.tmp_dir / "raw_vol", self.tmp_dir / "sane_vol"
            ghs_token = runtime_secret_token("ghs_")
            raw.write_text(ghs_token + "\n")
            subprocess.run(["python3", "-c", textwrap.dedent(body), str(raw), str(sane)], check=True)
            sane_text = sane.read_text()
            self.assertIn(
                ghs_token, sane_text,
                f"volume.yml:{idx} unexpectedly redacted ghs_ token (drift resolved?)"
            )

    def test_o2_fail_on_old_oracle_sanitizer(self):
        """Verify old sanitizer implementation from Round 1 leaks ghp%5F."""
        old_body = textwrap.dedent(r"""
            import re, sys
            text = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace')
            for prefix in ('ghp_', 'github_pat_', 'AKIA', 'xoxb-', 'MV0-SYNTHETIC-SENTINEL-'):
                text = re.sub(re.escape(prefix) + r'[A-Za-z0-9_-]{4,}', '[REDACTED]', text, flags=re.I)
            open(sys.argv[2], 'w').write(text)
        """)
        raw, sane = self.tmp_dir / "raw_old", self.tmp_dir / "sane_old"
        encoded_token = "ghp%5F" + secrets.token_hex(18)
        raw.write_text(encoded_token + "\n")
        subprocess.run(["python3", "-c", old_body, str(raw), str(sane)], check=True)
        self.assertIn(encoded_token, sane.read_text())


class SecretsGateAdversarialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp_dir = Path(self.temp.name)

    def test_o2_attack_gitleaks_exception_allowlist(self):
        """Attack .gitleaks.toml exception path and secret matching."""
        config_file = self.tmp_dir / "config.toml"
        gate.write_default_config(config_file)

        digest_file = self.tmp_dir / "catalogue/router/manifest.json"
        digest_file.parent.mkdir(parents=True, exist_ok=True)
        hex64 = "a" * 64
        digest_file.write_text(f'{{"sha256": "{hex64}"}}\n')

        secret_token = "EAAM" + secrets.token_hex(12)
        secret_file = self.tmp_dir / "router/index/SHA256SUMS"
        secret_file.parent.mkdir(parents=True, exist_ok=True)
        secret_file.write_text(f"hash  {secret_token}\n")

        boundary_file = self.tmp_dir / "catalogue/router/manifest.json.bak"
        boundary_file.write_text(f"hash  {secret_token}\n")

        if GITLEAKS_BIN is None:
            self.skipTest("GITLEAKS_BIN not available for real scanner test")

        report = self.tmp_dir / "report.json"
        status = gate._run_scanner(
            [str(GITLEAKS_BIN), "detect", "--no-git", "--source", str(secret_file),
             "--config", str(config_file), "--redact", "--no-banner",
             "--exit-code", str(gate.FINDING_EXIT_CONTROL),
             "--report-format", "json", "--report-path", str(report)], report)
        self.assertEqual(status, gate.FINDING_EXIT_CONTROL)
        self.assertTrue(gate.summarize_findings(report))

        status_clean = gate._run_scanner(
            [str(GITLEAKS_BIN), "detect", "--no-git", "--source", str(digest_file),
             "--config", str(config_file), "--redact", "--no-banner",
             "--exit-code", str(gate.FINDING_EXIT_CONTROL),
             "--report-format", "json", "--report-path", str(report)], report)
        self.assertEqual(status_clean, 0)
        self.assertEqual(gate.summarize_findings(report), [])

    def test_o2_gate_prerequisites_and_failures(self):
        """Test gate.py failure modes and prerequisites."""
        with self.assertRaises(gate.GateFailure) as cm:
            gate._require_tool(Path("relative/gitleaks"))
        self.assertIn("not absolute", str(cm.exception))

        with self.assertRaises(gate.GateFailure) as cm:
            gate._require_tool(self.tmp_dir / "absent_gitleaks")
        self.assertIn("not a file", str(cm.exception))

        empty_context = self.tmp_dir / "empty.yml"
        empty_context.write_text("")
        with self.assertRaises(gate.GateFailure) as cm:
            gate.generate_controls(self.tmp_dir / "ctrls", empty_context)
        self.assertIn("context empty", str(cm.exception))

        symlink_scratch = self.tmp_dir / "symlink_scratch"
        real_target = self.tmp_dir / "real_target"
        real_target.mkdir()
        symlink_scratch.symlink_to(real_target)
        context = ROOT / ".github/workflows/secrets.yml"
        with self.assertRaises(gate.GateFailure) as cm:
            gate.generate_controls(symlink_scratch, context)
        self.assertIn("scratch is a symlink", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
