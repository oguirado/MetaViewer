"""Offline negative controls for private MemoryWeb home admission."""

import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents import mw_home as home


class HomeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name)
        self.root = home.resolve_home(self.repo)
        home.ensure_home(self.root)

    def refuse(self, code, operation=None):
        with self.assertRaises(home.HomeError) as caught:
            (operation or (lambda: home.check_home(self.root, lambda _: False)))()
        self.assertEqual(caught.exception.code, code)

    def test_resolve_and_create_private_home(self):
        self.assertEqual(self.root, self.repo / "memoryweb")
        metadata = self.root.lstat()
        self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o700)
        self.assertEqual(metadata.st_uid, os.getuid())
        self.assertEqual(home.ensure_home(self.root), self.root)
        self.assertEqual(home.check_home(self.root, lambda _: False), self.root)
        self.assertEqual(home.resolve_home(self.repo, self.repo / "other"), self.repo / "other")
        self.refuse("MW_HOME_PATH", lambda: home.resolve_home(self.repo, "relative"))
        self.refuse("MW_HOME_PATH", lambda: home.resolve_home(self.repo, self.repo / ".." / "x"))

    def test_tracked_home_refused(self):
        seen = []
        def tracked(path):
            seen.append(path)
            return True
        self.refuse("MW_HOME_TRACKED", lambda: home.check_home(self.root, tracked))
        self.assertEqual(seen, [self.root])

    def test_0755_home_refused_and_not_repaired(self):
        self.root.chmod(0o755)
        self.refuse("MW_HOME_MODE")
        self.refuse("MW_HOME_MODE", lambda: home.ensure_home(self.root))
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o755)

    def test_wrong_owner_refused(self):
        with patch.object(home.os, "getuid", return_value=os.getuid() + 1):
            self.refuse("MW_HOME_MODE")
            self.refuse("MW_HOME_MODE", lambda: home.ensure_home(self.root))

    def test_missing_and_regular_file_home_refused(self):
        self.root.rmdir()
        self.refuse("MW_HOME_MODE")
        self.root.write_text("not a directory")
        self.refuse("MW_HOME_MODE")
        self.refuse("MW_HOME_MODE", lambda: home.ensure_home(self.root))

    def test_symlinked_subdirectory_refused_without_reading_outside(self):
        outside = self.repo / "outside"
        outside.mkdir()
        (outside / "safe.txt").write_text("public text")
        (self.root / "escape").symlink_to(outside, target_is_directory=True)
        self.refuse("MW_HOME_SYMLINK")

    def test_symlinked_home_and_ancestor_refused(self):
        alias = self.repo / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        for operation in (lambda: home.check_home(alias, lambda _: False),
                          lambda: home.ensure_home(alias),
                          lambda: home.ensure_home(alias / "child")):
            self.refuse("MW_HOME_SYMLINK", operation)
        self.assertFalse((self.root / "child").exists())

    def test_symlink_file_and_broken_link_refused(self):
        link = self.root / "link"
        for target in (self.repo / "missing", self.repo / "ordinary"):
            link.symlink_to(target)
            self.refuse("MW_HOME_SYMLINK")
            link.unlink()

    def test_deep_profile_names_refused(self):
        folder = self.root / "sites" / "x" / "nodes"
        folder.mkdir(parents=True)
        for name in (
            "Cookies", "Cookies-journal", "Login Data", "Login Data-journal",
            "Web Data", "History", "Preferences", "Secure Preferences", "Local Storage",
            "IndexedDB", "Session Storage", "Sessions", "Current Session", "Current Tabs",
            "Network Persistent State", "cookies.sqlite", "key4.db", "logins.json",
        ):
            for directory in (False, True):
                with self.subTest(name=name, directory=directory):
                    artifact = folder / name
                    if directory:
                        artifact.mkdir()
                    else:
                        artifact.write_bytes(b"innocent-looking")
                    self.refuse("MW_HOME_PROFILE")
                    artifact.rmdir() if directory else artifact.unlink()

    def test_cookies_literal_refused(self):
        # Literal independent of the implementation's denylist: MUT-PROFILE-NAME.
        folder = self.root / "sites" / "x"
        folder.mkdir(parents=True)
        (folder / "Cookies").write_text("private")
        self.refuse("MW_HOME_PROFILE")

    def test_advocate_profile_scenarios(self):
        import shutil
        scenarios = (
            "cookies", "COOKIES", "Network/cookies", "default/cookies",
            "Cookies-wal", "Cookies-shm", "cookies.sqlite-wal", "cookies.sqlite-shm",
            "History-wal", "Login Data-wal", "Web Data-journal",
            "Default/000003.log", "Default/CURRENT", "Default/LOCK",
            "local storage/leveldb/CURRENT", "storage/public.txt",
            "Profile 12/public.txt", "PROFILE 0/public.txt", "leveldb/LOG.old",
            "Session Storage/public.txt", "IndexedDB/public.txt",
            "Service Worker/public.txt", "Cache/public.txt", "Code Cache/public.txt",
            "GPUCache/public.txt",
        )
        for relative in scenarios:
            with self.subTest(relative=relative):
                artifact = self.root / relative
                artifact.parent.mkdir(parents=True, exist_ok=True)
                artifact.write_text("private")
                try:
                    self.refuse("MW_HOME_PROFILE")
                finally:
                    for entry in self.root.iterdir():
                        shutil.rmtree(entry) if entry.is_dir() else entry.unlink()

    def test_renamed_wal_headers_refused(self):
        for magic in (b"\x37\x7f\x06\x82", b"\x37\x7f\x06\x83"):
            with self.subTest(magic=magic):
                (self.root / "public.bin").write_bytes(magic + b"private payload")
                self.refuse("MW_HOME_PROFILE")

    def test_nested_git_file_and_directory_refused(self):
        nested = self.root / "nested"
        nested.mkdir()
        marker = nested / ".git"
        marker.write_text("gitdir: elsewhere")
        self.refuse("MW_HOME_NESTED_REPO")
        marker.unlink()
        marker.mkdir()
        self.refuse("MW_HOME_NESTED_REPO")

    def test_public_site_names_and_non_wal_prefix_accepted(self):
        folder = self.root / "sites" / "google-stitch" / "nodes"
        folder.mkdir(parents=True)
        for name in ("site.json", "CURRENT", "LOCK", "LOG", "LOG.old", "MANIFEST-1",
                     "public.ldb", "public.log", "public-wal"):
            (folder / name).write_bytes(b"\x37\x7f\x06\x81public")
        home.check_home(self.root, lambda _: False)

    def test_renamed_sqlite_refused(self):
        (self.root / "innocent.txt").write_bytes(b"SQLite format 3\0" + b"x" * 32)
        self.refuse("MW_HOME_PROFILE")

    def test_file_and_workflow_size_boundaries(self):
        workflows = self.root / "sites" / "x" / "workflows"
        workflows.mkdir(parents=True)
        for artifact, limit in ((self.root / "public.txt", 1024 * 1024),
                                (workflows / "public.json", 65536)):
            with self.subTest(artifact=artifact):
                artifact.write_bytes(b"x" * limit)
                home.check_home(self.root, lambda _: False)
                with artifact.open("ab") as stream:
                    stream.write(b"x")
                self.refuse("MW_HOME_SIZE")
                artifact.unlink()

    def test_entry_capacity_boundary(self):
        for name in ("a", "b", "c"):
            (self.root / name).write_text("safe")
        with patch.object(home, "MAX_ENTRIES", 3):
            home.check_home(self.root, lambda _: False)
            (self.root / "d").write_text("safe")
            self.refuse("MW_HOME_CAPACITY")

    def test_depth_capacity_boundary(self):
        (self.root / "a" / "b").mkdir(parents=True)
        with patch.object(home, "MAX_DEPTH", 2):
            home.check_home(self.root, lambda _: False)
            (self.root / "a" / "b" / "c").mkdir()
            self.refuse("MW_HOME_CAPACITY")

    def test_fifo_refused_without_blocking(self):
        os.mkfifo(self.root / "fifo")
        self.refuse("MW_HOME_MODE")


if __name__ == "__main__":
    unittest.main()
