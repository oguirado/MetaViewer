"""[TARGET, unit decision] Exercise router exceptions with the pinned scanner."""
import base64
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / ".gitleaks.toml"


class GitleaksConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = os.environ.get("GITLEAKS_BIN") or shutil.which("gitleaks")
        if not cls.binary:
            raise AssertionError("GITLEAKS_BIN or gitleaks on PATH required; no skips")
        version = subprocess.run([cls.binary, "version"], capture_output=True,
                                 text=True, check=True, timeout=30)
        if version.stdout.strip() != "8.18.4":
            raise AssertionError("gitleaks 8.18.4 required")

    def environment(self):
        env = os.environ.copy()
        env.pop("GITLEAKS_CONFIG", None)
        env.pop("GITLEAKS_CONFIG_TOML", None)
        return env

    def scan(self, source, config=None):
        with tempfile.TemporaryDirectory() as output:
            report = Path(output) / "report.json"
            argv = [self.binary, "detect", "--no-git", "--source", ".",
                    "--redact", "--no-banner", "--report-format", "json",
                    "--report-path", str(report)]
            if config:
                argv += ["--config", str(config)]
            result = subprocess.run(argv, cwd=source, env=self.environment(),
                                    capture_output=True, text=True, timeout=60)
            self.assertIn(result.returncode, (0, 1), "scanner failed")
            self.assertTrue(report.is_file(), "scanner omitted report")
            return result.returncode, json.loads(report.read_text()) or []

    def plant(self, source, relative, text):
        path = source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_rule_scope_and_workflow(self):
        config = tomllib.loads(CONFIG.read_text())
        self.assertTrue(config["extend"]["useDefault"])
        self.assertNotIn("allowlist", config)
        self.assertEqual([rule["id"] for rule in config["rules"]],
                         ["facebook-page-access-token",
                          "facebook-page-access-token-generated-digest-files",
                          "square-access-token",
                          "square-access-token-generated-digest-files"])
        for rule in config["rules"]:
            if "path" in rule:
                self.assertEqual(rule["secretGroup"], 1)
                self.assertEqual(rule["allowlist"], {
                    "regexTarget": "secret", "regexes": ["^[0-9a-f]{64}$"]})
            else:
                self.assertEqual(list(rule["allowlist"]), ["paths"])
        workflow = (ROOT / ".github/workflows/secrets.yml").read_text()
        self.assertIn('--config "$GITHUB_WORKSPACE/.gitleaks.toml"', workflow)
        self.assertIn("gate.py controls --gitleaks", workflow)
        self.assertIn("test_gitleaks_config.py", workflow)

    def test_generated_digest_false_positive_and_default_discovery(self):
        # Runtime-only digest shape reproduces the EAAA-prefixed hex collision.
        digest = "e" + "a" * 3 + secrets.token_hex(30)
        with tempfile.TemporaryDirectory() as scratch:
            source = Path(scratch) / "Música"
            source.mkdir()
            defaults = Path(scratch) / "defaults.toml"
            defaults.write_text("[extend]\nuseDefault = true\n")
            paths = ("catalogue/router/manifest.json", "router/index/SHA256SUMS")
            for relative in paths:
                self.plant(source, relative, json.dumps({"sha256": digest}) + "\n"
                           if relative.endswith((".json", ".jsonl"))
                           else digest + "  generated.json\n")
            rc, findings = self.scan(source, defaults)
            self.assertEqual(rc, 1)
            self.assertEqual({f["RuleID"] for f in findings}, {"square-access-token"})
            self.assertEqual(len(findings), len(paths))
            self.assertEqual(self.scan(source, CONFIG), (0, []))
            shutil.copyfile(CONFIG, source / ".gitleaks.toml")
            self.assertEqual(self.scan(source), (0, []))

    def test_generated_files_still_detect_every_credential_kind(self):
        body = base64.b64encode(secrets.token_bytes(96)).decode("ascii")
        pem = ("-----BEGIN RS" + "A PRIVATE KEY-----\n"
               + "\n".join(body[i:i + 64] for i in range(0, len(body), 64))
               + "\n-----END RS" + "A PRIVATE KEY-----\n")
        shapes = (
            ("square-access-token-generated-digest-files",
             "sq0" + "atp-" + secrets.token_hex(22)),
            ("square-access-token-generated-digest-files",
             "EA" + "AA" + "G" + secrets.token_hex(20)),
            ("facebook-page-access-token-generated-digest-files",
             "EA" + "AC" + "G" + secrets.token_hex(20)),
            ("github-pat", "gh" + "p_" + secrets.token_hex(18)),
            ("private-key", pem),
        )
        for rule, value in shapes:
            with self.subTest(rule=rule), tempfile.TemporaryDirectory() as scratch:
                source = Path(scratch) / "Música"
                source.mkdir()
                paths = ("catalogue/router/manifest.json", "router/index/SHA256SUMS")
                for relative in paths:
                    self.plant(source, relative, value + "\n")
                rc, findings = self.scan(source, CONFIG)
                self.assertEqual(rc, 1)
                self.assertEqual(len(findings), len(paths))
                self.assertEqual({f["RuleID"] for f in findings}, {rule})
                self.assertEqual({f["File"] for f in findings}, set(paths))

    def test_real_tokens_and_path_boundaries_still_detected(self):
        square = "sq0" + "atp-" + secrets.token_hex(22)
        github = "gh" + "p_" + secrets.token_hex(18)
        paths = ("src/payment.py", "notes/token.txt", "catalogue/router-other/token.txt",
                 "src/catalogue/router/token.json", "router/index/SHA256SUMS.bak",
                 "catalogue/router/digest/0.jsonl", "catalogue/router/post/ab.json")
        with tempfile.TemporaryDirectory() as scratch:
            source = Path(scratch)
            for relative in paths:
                self.plant(source, relative, square + "\n")
            # Other default rules remain active even within the generated mount.
            self.plant(source, "catalogue/router/docs/0.jsonl", github + "\n")
            rc, findings = self.scan(source, CONFIG)
            self.assertEqual(rc, 1)
            self.assertEqual(len(findings), len(paths) + 1)
            self.assertEqual(sum(f["RuleID"] == "square-access-token" for f in findings),
                             len(paths))
            self.assertIn("github-pat", {f["RuleID"] for f in findings})

    def test_detect_discovers_config_in_integration_worktree(self):
        result = subprocess.run(
            [self.binary, "detect", "--source", str(ROOT), "--log-opts=-1",
             "--log-level", "debug", "--redact", "--no-banner"],
            cwd=ROOT, env=self.environment(), capture_output=True, text=True, timeout=60)
        self.assertIn(result.returncode, (0, 1), "scanner failed")
        self.assertIn("from `(--source)/.gitleaks.toml`", result.stderr)
        self.assertIn("extending config with default config", result.stderr)
