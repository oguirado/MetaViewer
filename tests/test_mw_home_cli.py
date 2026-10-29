"""Hosted CLI checks in disposable private repositories, with no live services."""

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "tools" / "mw_home_check.py"


class HomeCliTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="mw-home-")
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name) / "Música"
        self.repo.mkdir(mode=0o700)
        self.git("init", "-q")
        # Use the shipped ignore file: deleting its home entry must break this test.
        (self.repo / ".gitignore").write_bytes((ROOT / ".gitignore").read_bytes())

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                              capture_output=True, timeout=10)

    def cli(self, expected_rc, expected_code=None, *extra):
        result = subprocess.run([sys.executable, str(CLI), "--repo", str(self.repo), *extra],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, expected_rc, result.stderr + result.stdout)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        report = json.loads(result.stdout)
        self.assertEqual(report["schema"], "metaviewer.mw_home/v1")
        self.assertEqual(report["ok"], expected_rc == 0)
        self.assertEqual(report["code"], expected_code)
        return report

    def test_shipped_ignore_and_private_creation(self):
        report = self.cli(0)
        home = self.repo / "memoryweb"
        self.assertEqual(report["home"], str(home))
        self.assertEqual(stat.S_IMODE(home.stat().st_mode), 0o700)
        self.assertEqual(home.stat().st_uid, os.getuid())
        self.git("check-ignore", "-q", "memoryweb/x")
        nested = self.repo / "sub" / "memoryweb"
        nested.mkdir(parents=True)
        result = subprocess.run(["git", "-C", str(self.repo), "check-ignore", "-q",
                                 "sub/memoryweb/x"], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1, "home ignore must be root-anchored")

    def test_removed_ignore_refused(self):
        (self.repo / ".gitignore").write_text("")
        self.cli(6, "MW_HOME_NOT_IGNORED")
        self.assertFalse((self.repo / "memoryweb").exists())

    def test_force_added_home_refused(self):
        self.cli(0)
        (self.repo / "memoryweb" / "site.json").write_text("{}")
        self.git("add", "-f", "memoryweb/site.json")
        self.cli(6, "MW_HOME_TRACKED")

    def test_profile_and_permissions_refused(self):
        self.cli(0)
        home = self.repo / "memoryweb"
        (home / "Cookies").write_text("private")
        self.cli(6, "MW_HOME_PROFILE")
        (home / "Cookies").unlink()
        home.chmod(0o755)
        self.cli(6, "MW_HOME_MODE")

    def test_absolute_override_and_relative_usage(self):
        override = self.repo.parent / "private-home"
        report = self.cli(0, None, "--home", str(override))
        self.assertEqual(report["home"], str(override))
        self.cli(2, "MW_HOME_PATH", "--home", "relative")

    def test_override_in_repo_requires_ignore_and_tracking_check(self):
        override = self.repo / "alternate"
        self.cli(6, "MW_HOME_NOT_IGNORED", "--home", str(override))
        with (self.repo / ".gitignore").open("a") as stream:
            stream.write("\n/alternate/\n")
        self.cli(0, None, "--home", str(override))
        (override / "site.json").write_text("{}")
        self.git("add", "-f", "alternate/site.json")
        self.cli(6, "MW_HOME_TRACKED", "--home", str(override))

    def test_non_repository_fails_closed(self):
        outside = self.repo.parent / "not-a-repository"
        outside.mkdir(mode=0o700)
        result = subprocess.run([sys.executable, str(CLI), "--repo", str(outside)],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 6)
        self.assertEqual(json.loads(result.stdout)["code"], "MW_HOME_GIT")

    def test_symlinked_repo_cannot_hide_force_added_override(self):
        alias = self.repo.parent / "alias"
        alias.symlink_to(self.repo, target_is_directory=True)
        override = self.repo / "alternate"
        override.mkdir(mode=0o700)
        (override / "site.json").write_text("{}")
        self.git("add", "-f", "alternate/site.json")
        self.cli(6, "MW_HOME_TRACKED", "--repo", str(alias), "--home", str(override))

    def test_symlinked_repo_cannot_hide_unignored_override(self):
        alias = self.repo.parent / "alias"
        alias.symlink_to(self.repo, target_is_directory=True)
        self.cli(6, "MW_HOME_NOT_IGNORED", "--repo", str(alias),
                 "--home", str(self.repo / "alternate"))

    def test_home_symlink_and_ancestor_refused_before_git(self):
        alias = self.repo.parent / "alias"
        alias.symlink_to(self.repo, target_is_directory=True)
        # Invalid Git root distinguishes path admission from Git checking.
        for candidate in (alias, alias / "new-home"):
            with self.subTest(candidate=candidate):
                self.cli(6, "MW_HOME_SYMLINK", "--repo", str(self.repo.parent),
                         "--home", str(candidate))

    def test_nested_repository_with_committed_file_refused(self):
        self.cli(0)
        nested = self.repo / "memoryweb" / "nested"
        nested.mkdir()
        subprocess.run(["git", "init", "-q", str(nested)], check=True, capture_output=True)
        (nested / "public.txt").write_text("committed")
        self.git("-C", str(nested), "add", "public.txt")
        # commit-tree creates the fixture commit without altering this worktree.
        tree = self.git("-C", str(nested), "write-tree").stdout.decode().strip()
        result = self.git("-C", str(nested), "-c", "user.name=Fixture",
                          "-c", "user.email=fixture@example.invalid", "commit-tree",
                          tree, "-m", "fixture")
        self.git("-C", str(nested), "update-ref", "HEAD", result.stdout.decode().strip())
        self.cli(6, "MW_HOME_NESTED_REPO")

    def test_missing_required_argument_is_usage(self):
        result = subprocess.run([sys.executable, str(CLI)], capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
