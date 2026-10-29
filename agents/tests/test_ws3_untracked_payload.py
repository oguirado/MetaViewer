"""Checkout admission refuses planted runnable files, with inert-file control."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.perception.deps_lock import DependencyLockError, resolve_locked_component


class UntrackedPayloadTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "Música checkout"
        self.repo.mkdir()
        self.git = shutil.which("git")
        self.assertIsNotNone(self.git)
        self.env = {"PATH": os.environ.get("PATH", os.defpath), "HOME": str(self.root),
                    "LANG": "C", "GIT_CONFIG_NOSYSTEM": "1",
                    "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
                    "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}
        self.run_git("init", "-q")
        (self.repo / "tracked.txt").write_text("original")
        self.pin("tracked.txt")
        (self.repo / "notes.txt").write_text("inert")
        patch = mock.patch.dict(os.environ, {"VQA_VE_ROOT": str(self.repo)})
        patch.start()
        self.addCleanup(patch.stop)
        self.assertEqual(self.resolve(), self.repo)

    def run_git(self, *args):
        return subprocess.run([self.git, "-C", str(self.repo), *args], env=self.env,
                              check=True, capture_output=True, text=True, timeout=5).stdout.strip()

    def pin(self, name):
        blob = self.run_git("hash-object", "-w", name)
        self.run_git("update-index", "--add", "--cacheinfo", "100644", blob, name)
        tree = self.run_git("write-tree")
        commit = self.run_git("commit-tree", tree, "-m", "fixture")
        self.run_git("update-ref", "HEAD", commit)
        self.lock = self.root / "deps.lock"
        self.lock.write_text(json.dumps({"components": [
            {"name": name, "commit": commit}
            for name in ("vision-engine", "wender-agent")]}))

    def resolve(self):
        return resolve_locked_component("vision-engine", lock_path=self.lock)

    def refused(self):
        with self.assertRaises(DependencyLockError) as caught:
            self.resolve()
        self.assertEqual(caught.exception.code, "dirty_tree")

    def test_untracked_python_native_and_executable_refused(self):
        for name, mode in (("evil.py", 0o644), ("lib.so", 0o644), ("script", 0o755)):
            with self.subTest(name=name):
                file = self.repo / name
                file.write_text("payload")
                file.chmod(mode)
                try:
                    self.refused()
                finally:
                    file.unlink()
        self.assertEqual(self.resolve(), self.repo)

    def test_untracked_symlink_directory_refused(self):
        (self.repo / "linked").symlink_to(self.root, target_is_directory=True)
        self.refused()

    def test_untracked_bytecode_refused(self):
        cache = self.repo / "__pycache__"
        cache.mkdir()
        (cache / "evil.cpython-312.pyc").write_bytes(b"orphan")
        self.refused()

    def test_tracked_startup_hook_refused(self):
        (self.repo / "sitecustomize.py").write_text("pass")
        self.pin("sitecustomize.py")
        self.refused()
