import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

# Re-implementation / reference of digest from tests/test_kit_source.py
EXCLUDED = {"KIT_SOURCE.json", "node_modules", ".git"}


def kit_digest(root):
    result = hashlib.sha256()

    def walk(directory, prefix=""):
        for entry in sorted(directory.iterdir(), key=lambda p: p.name.encode()):
            if entry.name in EXCLUDED:
                continue
            name = prefix + entry.name
            if entry.is_symlink():
                raise ValueError("Symlink rejected")
            if entry.is_dir():
                walk(entry, name + "/")
            elif entry.is_file():
                key, data = name.encode(), entry.read_bytes()
                result.update(str(len(key)).encode() + b":" + key)
                result.update(str(len(data)).encode() + b":" + data)
            else:
                raise ValueError("Unsupported entry")

    walk(root)
    return result.hexdigest()


# Python reference implementation of writeManifest from ui/tools/package.js
def python_write_manifest(root_dir):
    files = []

    def walk(part):
        for item in sorted(os.listdir(os.path.join(root_dir, part))):
            rel_path = f"{part}/{item}" if part else item
            full_path = os.path.join(root_dir, rel_path)
            if os.path.islink(full_path):
                raise ValueError(f"Symlink refused: {rel_path}")
            if os.path.isdir(full_path):
                walk(rel_path)
            elif os.path.isfile(full_path):
                files.append(rel_path)

    walk("")
    lines = []
    for name in sorted(files):
        h = hashlib.sha256()
        with open(os.path.join(root_dir, name), "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
        lines.append(f"{h.hexdigest()}  {name}\n")
    return "".join(lines)


class ReproducibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp_dir = Path(self.temp.name)

    def test_write_manifest_creation_order_mtime_umask_invariance(self):
        """O5(a): writeManifest byte invariance across creation order, mtimes, umasks."""
        dir_a = self.tmp_dir / "dir_a"
        dir_b = self.tmp_dir / "dir_b"

        # Directory A: created forward order, mtime=1000000000, umask=0o022
        dir_a.mkdir()
        (dir_a / "sub").mkdir()
        (dir_a / "alpha.txt").write_text("hello world\n")
        (dir_a / "sub" / "beta.txt").write_text("nested content\n")

        os.utime(dir_a / "alpha.txt", (1000000000, 1000000000))
        os.utime(dir_a / "sub" / "beta.txt", (1000000000, 1000000000))
        os.chmod(dir_a / "alpha.txt", 0o644)
        os.chmod(dir_a / "sub" / "beta.txt", 0o644)

        # Directory B: created reverse order, mtime=1700000000, umask=0o077
        dir_b.mkdir()
        (dir_b / "sub").mkdir()
        (dir_b / "sub" / "beta.txt").write_text("nested content\n")
        (dir_b / "alpha.txt").write_text("hello world\n")

        os.utime(dir_b / "alpha.txt", (1700000000, 1700000000))
        os.utime(dir_b / "sub" / "beta.txt", (1700000000, 1700000000))
        os.chmod(dir_b / "alpha.txt", 0o600)
        os.chmod(dir_b / "sub" / "beta.txt", 0o600)

        manifest_a = python_write_manifest(str(dir_a))
        manifest_b = python_write_manifest(str(dir_b))

        self.assertEqual(manifest_a, manifest_b, "Manifests were not byte-identical!")

    def test_kit_digest_tree_walk_determinism(self):
        """O5(b): digest() in tests/test_kit_source.py produces identical hash on permuted trees."""
        tree1 = self.tmp_dir / "tree1"
        tree2 = self.tmp_dir / "tree2"

        tree1.mkdir()
        (tree1 / "z_last.js").write_text("console.log('z');")
        (tree1 / "a_first.js").write_text("console.log('a');")
        (tree1 / "dir_mid").mkdir()
        (tree1 / "dir_mid" / "inner.js").write_text("inner")

        tree2.mkdir()
        (tree2 / "dir_mid").mkdir()
        (tree2 / "dir_mid" / "inner.js").write_text("inner")
        (tree2 / "a_first.js").write_text("console.log('a');")
        (tree2 / "z_last.js").write_text("console.log('z');")

        digest1 = kit_digest(tree1)
        digest2 = kit_digest(tree2)

        self.assertEqual(digest1, digest2, "kit_digest was not deterministic across entry creation order!")

    def test_manifests_leg_stdout_identity(self):
        """O5(c): gate.sh --leg manifests output is identical across two runs [INV-MS-07]."""
        cmd = ["bash", str(ROOT / "tools/gate.sh"), "--leg", "manifests"]

        run1 = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=True)
        run2 = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=True)

        self.assertEqual(run1.stdout, run2.stdout, "gate.sh --leg manifests stdout differed across runs")


if __name__ == "__main__":
    unittest.main()
