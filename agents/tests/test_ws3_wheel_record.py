"""Installed wheel RECORD integrity, exercised through public admission."""
import base64
import csv
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.perception.deps_lock import DependencyLockError, resolve_locked_component


class WheelRecordTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.prefix = self.root / "venv"
        self.site = self.prefix / "lib" / "python3.12" / "site-packages"
        self.info = self.site / "vision_engine-0.2.0.dist-info"
        self.info.mkdir(parents=True)
        commit = "a" * 40
        (self.info / "direct_url.json").write_text(json.dumps({
            "vcs_info": {"vcs": "git", "commit_id": commit}}))
        (self.site / "engine.py").write_bytes(b"VALUE = 1\n")
        self.lock = self.root / "deps.lock"
        self.lock.write_text(json.dumps({"components": [
            {"name": name, "commit": commit}
            for name in ("vision-engine", "wender-agent")]}))
        self.record = self.info / "RECORD"
        self.rows = []
        for file in (self.site / "engine.py", self.info / "direct_url.json"):
            data = file.read_bytes()
            digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            self.rows.append([str(file.relative_to(self.site)), "sha256=" + digest, str(len(data))])
        self.rows.append([str(self.record.relative_to(self.site)), "", ""])
        self.write_record()
        patch = mock.patch.dict(os.environ, {"VQA_VE_ROOT": str(self.prefix)})
        patch.start()
        self.addCleanup(patch.stop)
        self.assertEqual(self.resolve(), self.prefix)

    def write_record(self):
        with self.record.open("w", newline="") as stream:
            csv.writer(stream).writerows(self.rows)

    def resolve(self):
        return resolve_locked_component("vision-engine", lock_path=self.lock)

    def refused(self):
        with self.assertRaises(DependencyLockError) as caught:
            self.resolve()
        self.assertEqual(caught.exception.code, "dirty_tree")

    def test_record_digest_tamper_refused(self):
        self.rows[0][1] = "sha256=" + "0" * 64
        self.write_record()
        self.refused()

    def test_record_size_tamper_refused(self):
        self.rows[0][2] = str(int(self.rows[0][2]) + 1)
        self.write_record()
        self.refused()

    def test_unrecorded_python_refused(self):
        (self.site / "evil.py").write_text("pass")
        self.refused()

    def test_startup_hooks_refused(self):
        for name in ("evil.pth", "sitecustomize.py"):
            with self.subTest(name=name):
                file = self.site / name
                file.write_text("pass")
                try:
                    self.refused()
                finally:
                    file.unlink()

    def test_symlink_directory_refused(self):
        (self.site / "linked").symlink_to(self.info, target_is_directory=True)
        self.refused()

    def test_orphan_bytecode_refused(self):
        cache = self.site / "__pycache__"
        cache.mkdir()
        (cache / "evil.cpython-312.pyc").write_bytes(b"orphan")
        self.refused()
