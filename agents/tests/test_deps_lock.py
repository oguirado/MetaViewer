"""Dependency provenance checks with paired positive and negative controls."""

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

from metaviewer_agents.perception import deps_lock
from metaviewer_agents.perception.deps_lock import (
    DependencyLockError,
    resolve_locked_component,
)


class DependencyLockTests(unittest.TestCase):
    def setUp(self):
        # Linux runtime contract: Git fixtures live in RAM, never private repos.
        self.temporary = tempfile.TemporaryDirectory(prefix="mv-lock-", dir="/dev/shm")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "Música checkout"
        self.repo.mkdir()
        self.git = shutil.which("git")
        self.assertIsNotNone(self.git, "git is required to exercise checkout verification")
        self.git_env = {
            "PATH": os.environ.get("PATH", os.defpath), "HOME": str(self.root),
            "LANG": "C", "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        }
        self.run_git("init", "--quiet")
        self.tracked = self.repo / "tracked.txt"
        self.tracked.write_text("original\n")
        blob = self.run_git("hash-object", "-w", "tracked.txt")
        self.run_git("update-index", "--add", "--cacheinfo", "100644", blob, "tracked.txt")
        tree = self.run_git("write-tree")
        # Plumbing builds a fixture commit without git commit or checkout.
        self.commit = self.run_git("commit-tree", tree, "-m", "fixture")
        self.run_git("update-ref", "HEAD", self.commit)
        self.lock = self.root / "deps.lock"
        self.payload = {"components": [
            {"name": name, "commit": self.commit} for name in
            ("vision-engine", "wender-agent")
        ]}
        self.write_lock()
        self.environment = mock.patch.dict(os.environ, {
            "VQA_VE_ROOT": str(self.repo), "MV_WENDER_ROOT": str(self.repo),
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def run_git(self, *args):
        return subprocess.run([self.git, "-C", str(self.repo), *args],
                              env=self.git_env, check=True, capture_output=True,
                              text=True, timeout=5).stdout.strip()

    def write_lock(self):
        self.lock.write_text(json.dumps(self.payload))

    def resolve(self, name="vision-engine", **kwargs):
        return resolve_locked_component(name, lock_path=self.lock, **kwargs)

    def assert_code(self, code, function=None):
        with self.assertRaises(DependencyLockError) as caught:
            (function or self.resolve)()
        self.assertEqual(caught.exception.code, code)
        self.assertTrue(caught.exception.message)

    def wheel(self, name="vision-engine", prefix=None):
        root = prefix or self.root / "site-packages"
        info = root / (name.replace("-", "_") + "-0.2.0.dist-info")
        info.mkdir(parents=True, exist_ok=True)
        metadata = info / "direct_url.json"
        metadata.write_text(json.dumps({
            "url": "https://example.invalid/private.git",
            "vcs_info": {"vcs": "git", "commit_id": self.commit},
        }))
        os.environ[deps_lock._ROOT_VARIABLES[name]] = str(root)
        return root, info, metadata

    def test_clean_checkouts_and_wrong_commit_for_each_component(self):
        for name in ("vision-engine", "wender-agent"):
            with self.subTest(name=name):
                self.assertEqual(self.resolve(name), self.repo.resolve())
                original = self.payload["components"][0]["commit"]
                for entry in self.payload["components"]:
                    entry["commit"] = "0" * 40
                self.write_lock()
                self.assert_code("commit_mismatch", lambda: self.resolve(name))
                for entry in self.payload["components"]:
                    entry["commit"] = original
                self.write_lock()

    def test_untracked_allowed_tracked_dirty_refused(self):
        (self.repo / "untracked.txt").write_text("ignored\n")
        self.assertEqual(self.resolve(), self.repo)
        self.tracked.write_text("dirty\n")
        self.assert_code("dirty_tree")

    def test_staged_change_and_deleted_tracked_file_refused(self):
        self.assertEqual(self.resolve(), self.repo)
        self.tracked.write_text("staged\n")
        self.run_git("add", "tracked.txt")
        self.assert_code("dirty_tree")
        self.tracked.unlink()
        self.assert_code("dirty_tree")

    def test_missing_empty_nonexistent_and_file_roots(self):
        self.assertEqual(self.resolve(), self.repo)
        for value in (None, "", "  ", str(self.root / "absent"), str(self.tracked)):
            with self.subTest(value=value):
                with mock.patch.dict(os.environ):
                    if value is None:
                        os.environ.pop("VQA_VE_ROOT")
                    else:
                        os.environ["VQA_VE_ROOT"] = value
                    self.assert_code("unavailable")

    def test_lock_shape_sha_duplicates_and_missing_components(self):
        self.assertEqual(self.resolve(), self.repo)
        invalid = [[], {}, {"components": {}}, {"components": [None]},
                   {"components": [{"name": "vision-engine", "commit": "short"}]},
                   {"components": [self.payload["components"][0]]},
                   {"components": self.payload["components"] * 2}]
        for payload in invalid:
            with self.subTest(payload=payload):
                self.lock.write_text(json.dumps(payload))
                self.assert_code("bad_lockfile")
        for raw in ('{', '{"components": [], "components": []}', '\udcff'):
            self.lock.write_bytes(raw.encode("utf-8", errors="surrogateescape"))
            self.assert_code("bad_lockfile")
        self.lock.unlink()
        self.assert_code("bad_lockfile")

    def test_unsupported_component_fails_closed(self):
        self.assertEqual(self.resolve(), self.repo)
        self.assert_code("bad_lockfile", lambda: self.resolve("untrusted"))

    def test_wheel_provenance_for_both_components_and_mismatch(self):
        for name in ("vision-engine", "wender-agent"):
            with self.subTest(name=name):
                root, _, metadata = self.wheel(name)
                self.assertEqual(self.resolve(name), root)
                payload = json.loads(metadata.read_text())
                payload["vcs_info"]["commit_id"] = "0" * 40
                metadata.write_text(json.dumps(payload))
                self.assert_code("commit_mismatch", lambda: self.resolve(name))

    def test_wheel_missing_malformed_and_non_git_provenance(self):
        root, _, metadata = self.wheel()
        self.assertEqual(self.resolve(), root)
        for payload in ({}, [], {"vcs_info": {"vcs": "git", "commit_id": "short"}},
                        {"vcs_info": {"vcs": "hg", "commit_id": self.commit}}):
            metadata.write_text(json.dumps(payload))
            self.assert_code("unavailable")
        metadata.write_text("{")
        self.assert_code("unavailable")
        metadata.unlink()
        self.assert_code("unavailable")

    def test_ambiguous_or_unrelated_wheel_metadata_refused(self):
        root, info, _ = self.wheel()
        self.assertEqual(self.resolve(), root)
        other = root / "vision_engine-0.3.0.dist-info"
        shutil.copytree(info, other)
        self.assert_code("unavailable")
        shutil.rmtree(other)
        info.rename(root / "vision_engine_impostor-0.2.0.dist-info")
        self.assert_code("unavailable")

    def test_venv_and_direct_dist_info_roots_with_negative_controls(self):
        prefix = self.root / "venv"
        site = prefix / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
        _, info, metadata = self.wheel(prefix=site)
        for root in (prefix, info):
            os.environ["VQA_VE_ROOT"] = str(root)
            self.assertEqual(self.resolve(), root)
            original = metadata.read_text()
            metadata.write_text("{}")
            self.assert_code("unavailable")
            metadata.write_text(original)

    def test_git_environment_is_scrubbed_and_failures_are_typed(self):
        hostile = {"GIT_DIR": str(self.root / "absent"),
                   "GIT_WORK_TREE": str(self.root), "PYTHONPATH": "secret",
                   "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.bare",
                   "GIT_CONFIG_VALUE_0": "true"}
        real_run = subprocess.run
        with mock.patch.dict(os.environ, hostile):
            with mock.patch.object(deps_lock.subprocess, "run", wraps=real_run) as run:
                self.assertEqual(self.resolve(), self.repo)
                for call in run.call_args_list:
                    env = call.kwargs["env"]
                    self.assertFalse(set(hostile) & set(env))
                    self.assertEqual(env["HOME"], os.devnull)
                    self.assertEqual(env["LANG"], "C")
                    self.assertEqual(call.kwargs["timeout"], 2.0)
        for error in (FileNotFoundError(), subprocess.TimeoutExpired("git", 2)):
            with mock.patch.object(deps_lock.subprocess, "run", side_effect=error):
                self.assert_code("unavailable")

    def test_broken_checkout_cannot_fall_back_to_wheel(self):
        self.assertEqual(self.resolve(), self.repo)
        _, info, _ = self.wheel(prefix=self.repo)
        (self.repo / ".git" / "HEAD").unlink()
        self.assert_code("unavailable")
        self.assertTrue(info.is_dir())

    def test_fake_subprocess_observes_scrubbed_environment_and_negative_control(self):
        # Executable fixtures use the default temp filesystem: /dev/shm may
        # be mounted noexec. No private component code is read or imported.
        with tempfile.TemporaryDirectory(prefix="mv-lock-cli-") as temporary:
            tool = Path(temporary) / "git"
            tool.write_text(
                f"#!{sys.executable}\n"
                "import os, pathlib, sys\n"
                "if any(k in os.environ for k in "
                "('GIT_DIR', 'GIT_CONFIG_COUNT', 'PYTHONPATH', 'MV_SECRET')):\n"
                "    sys.exit(20)\n"
                "if os.environ['HOME'] != os.devnull or os.environ['LANG'] != 'C':\n"
                "    sys.exit(21)\n"
                "root = pathlib.Path(sys.argv[sys.argv.index('-C') + 1])\n"
                "if 'rev-parse' in sys.argv:\n"
                "    print((root / 'fake-head').read_text())\n"
                "elif 'ls-files' in sys.argv:\n"
                "    print((root / 'fake-ls-files').read_text(), end='')\n"
                "elif 'ls-tree' in sys.argv:\n"
                "    print((root / 'fake-ls-tree').read_text(), end='')\n"
                "elif 'status' in sys.argv:\n"
                "    print((root / 'fake-status').read_text())\n"
                "else:\n"
                "    sys.exit(22)\n"
            )
            tool.chmod(0o700)
            blob = self.run_git("hash-object", "tracked.txt")
            (self.repo / "fake-head").write_text(self.commit)
            (self.repo / "fake-ls-files").write_text("H tracked.txt\0")
            (self.repo / "fake-ls-tree").write_text(
                f"100644 blob {blob}\ttracked.txt\0"
            )
            status = self.repo / "fake-status"
            status.write_text("")
            with mock.patch.dict(os.environ, {"PATH": temporary, "MV_SECRET": "canary",
                                              "PYTHONPATH": "canary"}):
                self.assertEqual(self.resolve(), self.repo)
                status.write_text(" M tracked.txt")
                self.assert_code("dirty_tree")

    def test_parent_repository_is_not_dependency_evidence(self):
        self.assertEqual(self.resolve(), self.repo)
        child = self.repo / "child"
        child.mkdir()
        os.environ["VQA_VE_ROOT"] = str(child)
        self.assert_code("unavailable")

    def test_default_lock_has_real_pins_and_refuses_fixture_revision(self):
        self.assertEqual(self.resolve(), self.repo)
        self.assertEqual(deps_lock._locked_commit("vision-engine", deps_lock._LOCK_PATH),
                         "3bb54835db8a2e545311cfcc45185a0dfbd9313a")
        self.assertEqual(deps_lock._locked_commit("wender-agent", deps_lock._LOCK_PATH),
                         "96120967b435b72fc6d29635f3844dae140388a9")
        self.assert_code("commit_mismatch", lambda: resolve_locked_component("vision-engine"))


if __name__ == "__main__":
    unittest.main()
