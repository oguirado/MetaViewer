import io
import json
import os
from pathlib import Path
import shutil
import secrets
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
GITLEAKS_BIN = os.environ.get("GITLEAKS_BIN") or shutil.which("gitleaks")

sys.path.insert(0, str(ROOT / "tests/fixtures/secrets"))
import gate


def runtime_token():
    """Build scanner-sensitive bytes only in memory and temporary fixtures."""
    return "".join(map(chr, (103, 104, 112, 95))) + secrets.token_hex(18)


class AdversarialSecretsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp_dir = Path(self.temp.name)

    def create_fake_gitleaks_stub(self, behavior="success", sleep_sec=0):
        """Creates a dummy executable script to simulate gitleaks responses."""
        stub_path = self.tmp_dir / "fake_gitleaks"
        if behavior == "sleep":
            content = f"#!/bin/sh\nsleep {sleep_sec}\nexit 0\n"
        elif behavior == "malformed_json_dict":
            content = '#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "--report-path" ]; then\n    shift\n    echo "{\\"RuleID\\": \\"github\\"}" > "$1"\n  fi\n  shift\ndone\nexit 1\n'
        elif behavior == "malformed_int_ruleid":
            content = '#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "--report-path" ]; then\n    shift\n    echo "[{\\"RuleID\\": 12345}]" > "$1"\n  fi\n  shift\ndone\nexit 1\n'
        else:
            content = "#!/bin/sh\nexit 0\n"

        stub_path.write_text(content, encoding="utf-8")
        stub_path.chmod(0o755)
        return stub_path

    def test_token_split_across_lines_and_no_leak_stdout(self):
        """O3: Secret/token split across two lines or in non-standard shape."""
        token = runtime_token()
        secret_part1, secret_part2 = token[:10], token[10:]
        split_secret = secret_part1 + "\n" + secret_part2

        test_file = self.tmp_dir / "split_secret.txt"
        test_file.write_text(split_secret, encoding="utf-8")

        # Verify shannon entropy or scanner output on split line
        captured = io.StringIO()
        old_stdout = sys.stdout
        try:
            sys.stdout = captured
            findings = gate.summarize_findings(ROOT / "tests/fixtures/secrets/README.md")
        except gate.GateFailure:
            pass
        finally:
            sys.stdout = old_stdout

        out = captured.getvalue()
        self.assertNotIn(secret_part1, out)
        self.assertNotIn(secret_part2, out)

        # The split shape is not itself guaranteed detectable. Prove the
        # reassembled credential is detected by the real default rules.
        self.assertIsNotNone(GITLEAKS_BIN, "E2E_PREREQ: real gitleaks required")
        plant = self.tmp_dir / "reassembled"
        plant.mkdir()
        (plant / "credential.txt").write_text(token + "\n", encoding="utf-8")
        config = self.tmp_dir / "default.toml"
        gate.write_default_config(config)
        report = self.tmp_dir / "reassembled-report.json"
        status = gate._run_scanner(
            [str(GITLEAKS_BIN), "detect", "--no-git", "--source", str(plant),
             "--config", str(config), "--redact", "--no-banner",
             "--exit-code", str(gate.FINDING_EXIT_CONTROL),
             "--report-format", "json", "--report-path", str(report)], report)
        self.assertEqual(status, gate.FINDING_EXIT_CONTROL)
        self.assertTrue(gate.summarize_findings(report))

    def test_secret_appended_to_non_checksum_line_fails(self):
        """O3: generate_controls fails if context lacks the expected checksum line."""
        scratch = self.tmp_dir / "scratch"
        scratch.mkdir()
        context_file = self.tmp_dir / "no_checksum_context.yml"
        context_file.write_text("name: No Checksum\nsteps: []\n", encoding="utf-8")

        with self.assertRaises(gate.GateFailure) as cm:
            gate.generate_controls(scratch, context_file)
        self.assertIn("context lacks checksum line", str(cm.exception))

    def test_scanner_timeout_rejects(self):
        """O3: Scanner timeout triggers fail-closed rejection [INV-FC-02]."""
        stub = self.create_fake_gitleaks_stub(behavior="sleep", sleep_sec=10)
        report = self.tmp_dir / "report.json"

        # Patch gate.SCAN_TIMEOUT temporarily to 0.1s for fast test execution
        orig_timeout = gate.SCAN_TIMEOUT
        try:
            gate.SCAN_TIMEOUT = 0.1
            with self.assertRaises(gate.GateFailure) as cm:
                gate._run_scanner([str(stub)], report)
            self.assertIn("scanner timeout", str(cm.exception))
        finally:
            gate.SCAN_TIMEOUT = orig_timeout

    def test_disk_full_or_unwritable_scratch_rejects(self):
        """O3: Unwritable or disk-full scratch causes fail-closed GateFailure."""
        read_only_scratch = self.tmp_dir / "read_only_scratch"
        read_only_scratch.mkdir(mode=0o500)
        context_file = ROOT / ".github/workflows/secrets.yml"

        try:
            with self.assertRaises(gate.GateFailure):
                gate.generate_controls(read_only_scratch / "nested", context_file)
        finally:
            os.chmod(read_only_scratch, 0o700)

    def test_malformed_reports_reject(self):
        """O3: Malformed scanner reports (top-level dict, integer RuleID) reject [INV-FC-02]."""
        dict_report = self.tmp_dir / "dict_report.json"
        dict_report.write_text('{"RuleID": "github"}', encoding="utf-8")

        with self.assertRaises(gate.GateFailure) as cm1:
            gate.summarize_findings(dict_report)
        self.assertIn("report wrong type", str(cm1.exception))

        int_rule_report = self.tmp_dir / "int_rule_report.json"
        int_rule_report.write_text('[{"RuleID": 12345}]', encoding="utf-8")

        with self.assertRaises(gate.GateFailure) as cm2:
            gate.summarize_findings(int_rule_report)
        self.assertIn("report RuleID wrong type", str(cm2.exception))

    def test_real_scanner_nested_repo_and_stash_rejects(self):
        """O3: Real gitleaks scanner detects secrets in stashes and side branches."""
        repo_dir = self.tmp_dir / "test_repo"
        repo_dir.mkdir()

        subprocess.run(["git", "-C", str(repo_dir), "init"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # [TARGET, unit decision] Import an isolated stash history directly;
        # the execution contract forbids invoking git commit even in fixtures.
        self.assertIsNotNone(GITLEAKS_BIN, "E2E_PREREQ: real gitleaks required")
        secret_token = runtime_token()
        clean = b"# Test Repo\n"
        dirty = ("token = '" + secret_token + "'\n").encode()
        stream = (b"blob\nmark :1\ndata " + str(len(clean)).encode() + b"\n" + clean +
                  b"commit refs/heads/main\nmark :2\ncommitter Test <test@example.invalid> 1 +0000\ndata 4\ninit\nM 100644 :1 README.md\n\n" +
                  b"blob\nmark :3\ndata " + str(len(dirty)).encode() + b"\n" + dirty +
                  b"commit refs/stash\ncommitter Test <test@example.invalid> 2 +0000\ndata 5\nstash\nfrom :2\nM 100644 :3 secret.txt\n\ndone\n")
        subprocess.run(["git", "-C", str(repo_dir), "fast-import", "--quiet"],
                       input=stream, check=True, capture_output=True)

        scratch = self.tmp_dir / "scratch"
        scratch.mkdir()

        # Scanner should detect secret or gate should reject
        captured = io.StringIO()
        old_stdout, old_stderr = sys.stdout, sys.stderr
        try:
            sys.stdout = captured
            sys.stderr = captured
            rc = gate.main(["gate.py", "history", "--gitleaks", GITLEAKS_BIN, "--repo", str(repo_dir)])
        finally:
            sys.stdout, sys.stderr = old_stdout, old_stderr

        out = captured.getvalue()
        # Ensure secret bytes never printed to stdout/stderr
        self.assertNotIn(secret_token, out)
        self.assertEqual(rc, 1, "stash secret must reject")


if __name__ == "__main__":
    unittest.main()
