"""Static properties of the judge scripts, the AppArmor profile and the changelog entry."""

import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from judge_sandbox import JUDGE_SRC, REPO, which  # noqa: E402

SCRIPTS = ("metaviewer-judge.sh", "preflight.sh")


class TestStatic(unittest.TestCase):
    def test_scripts_are_executable_and_parse(self):
        for name in SCRIPTS:
            path = JUDGE_SRC / name
            with self.subTest(script=name):
                self.assertTrue(os.access(path, os.X_OK))
                self.assertTrue(path.read_text().startswith("#!/usr/bin/env bash\n"))
                proc = subprocess.run([which("bash"), "-n", str(path)], capture_output=True, text=True)
                self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_no_host_paths_secrets_or_non_ascii(self):
        files = [JUDGE_SRC / n for n in SCRIPTS] + [JUDGE_SRC / "apparmor" / "metaviewer"] + sorted(Path(__file__).parent.glob("*.py"))
        for path in files:
            text = path.read_text(encoding="utf-8")
            with self.subTest(file=path.name):
                self.assertIsNone(re.search(r"/home/[A-Za-z]", text), "host path")
                self.assertTrue(text.isascii(), "ASCII only")

    def test_sudo_is_executed_in_exactly_one_gated_place(self):
        main = (JUDGE_SRC / "metaviewer-judge.sh").read_text()
        executions = [l for l in main.splitlines() if re.search(r'\bsudo "\$@"', l)]
        self.assertEqual(len(executions), 1, executions)
        self.assertIn("# MUT:JUDGE_SUDO", main)
        gate = main.index("if confirm \"Run this step now?\"")
        self.assertLess(gate, main.index('sudo "$@"'))
        for line in (JUDGE_SRC / "preflight.sh").read_text().splitlines():
            code = line.split("#", 1)[0]
            self.assertIsNone(re.match(r"\s*sudo\b", code), "preflight must never call sudo: " + line)

    def test_nothing_is_downloaded_without_a_confirmation(self):
        main = (JUDGE_SRC / "metaviewer-judge.sh").read_text()
        curl_calls = [m.start() for m in re.finditer(r"^\s+if curl --fail", main, re.M)]
        self.assertEqual(len(curl_calls), 1)
        self.assertIn("confirm \"Download them now", main[:curl_calls[0]])
        self.assertIn("--proto '=https'", main)

    def test_app_is_never_started_without_the_sandbox(self):
        main = (JUDGE_SRC / "metaviewer-judge.sh").read_text()
        launch = [l for l in main.splitlines() if 'env -i "${envv[@]}"' in l]
        self.assertEqual(len(launch), 1)
        self.assertNotIn("no-sandbox", launch[0])
        self.assertNotIn("--no-sandbox", re.sub(r"never --no-sandbox", "", (JUDGE_SRC / "preflight.sh").read_text()))

    def test_apparmor_profile_grants_only_userns(self):
        text = (JUDGE_SRC / "apparmor" / "metaviewer").read_text()
        body = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
        self.assertIn("abi <abi/4.0>,", body)
        self.assertRegex(body, r"profile metaviewer /\*\*/MetaViewer-linux-\{x64,arm64\}/metaviewer flags=\(unconfined\) \{")
        self.assertIn("  userns,", body)
        rules = [l.strip() for l in body.splitlines() if l.strip() and not l.startswith(("abi", "include", "profile", "}"))]
        self.assertEqual([r for r in rules if not r.startswith("include if exists")], ["userns,"])

    def test_changelog_mentions_the_judge_scripts_without_naming_tools_as_authors(self):
        text = (REPO / "CHANGELOG.md").read_text()
        unreleased = text.split("## [Unreleased]", 1)[1].split("\n## ", 1)[0]
        self.assertRegex(unreleased, r"(?i)judge doctor, install, run and stop scripts")
        for word in ("co-authored-by", "generated with"):
            self.assertNotIn(word, unreleased.lower())


if __name__ == "__main__":
    unittest.main()
