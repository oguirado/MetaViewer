import hashlib, json, os, subprocess, sys, unittest
from common import *

# Adapted for MetaViewer: no external pilot checkout (V1) and no prebuilt
# out/v1_index. Frozen bytes are pinned by hash; the v1 index is rebuilt
# from a generated scratch fixture. No skips.

FROZEN = ("build_index.py", "route.py", "eval_route.py", "make_pool.py", "vocabulary.json")

PINNED = {
    "build_index.py": "2c1d3f8b6554de39a0e090b16ac3ec2cbca519b1e7ff91d9c17dc92a3eb59dfe",
    "route.py": "3795d324839dc18f039c7a890a173f1828381d7a838d726bfe42788e82c12cf5",
    "eval_route.py": "575ccdf2fbb0a733659c4661e2c3538f21dca3ef3535a2483f10a4edd85299b5",
    "make_pool.py": "5623ac93af4415dc42680b1a26cd5ea17c736b78ad1f811a68e23051740bddb4",
    "vocabulary.json": "83a6d8237fd031281c08f4cc71106a538d9a28276a25e9674a32bdf3cf7ecc0c",
}


def sha_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(65536), b""):
            h.update(b)
    return h.hexdigest()


class T0(unittest.TestCase):
    def test_sha256sums(self):
        r = subprocess.run(["sha256sum", "-c", "v1_frozen/SHA256SUMS"], cwd=W, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(r.stdout.strip().split("\n")), 5)

    def test_frozen_bytes_match_pinned_hashes(self):
        for n in FROZEN:
            self.assertEqual(sha_file(os.path.join(W, "v1_frozen", n)), PINNED[n], n)
        sums = {}
        for line in open(os.path.join(W, "v1_frozen", "SHA256SUMS"), encoding="utf-8"):
            line = line.strip()
            if line:
                digest, name = line.split(None, 1)
                sums[os.path.basename(name)] = digest
        self.assertEqual(sums, PINNED)

    def test_v1_index_rebuild_identical(self):
        d = tmp()
        root = repo_gen.make_repo(os.path.join(d, "repo"))
        tool = os.path.join(W, "v1_frozen", "build_index.py")
        vocab = os.path.join(W, "v1_frozen", "vocabulary.json")
        outs = []
        for tag in ("ix1", "ix2"):
            out = os.path.join(d, tag)
            r = subprocess.run([sys.executable, "-B", tool, "--root", root, "--out", out, "--vocab", vocab],
                               capture_output=True, text=True, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr)
            outs.append(out)
        t1 = {p: open(os.path.join(outs[0], p), "rb").read() for a, _, fs in os.walk(outs[0]) for p in
              [os.path.relpath(os.path.join(a, f), outs[0]) for f in fs]}
        t2 = {p: open(os.path.join(outs[1], p), "rb").read() for a, _, fs in os.walk(outs[1]) for p in
              [os.path.relpath(os.path.join(a, f), outs[1]) for f in fs]}
        self.assertTrue(t1)
        self.assertEqual(t1, t2)
        r = subprocess.run([sys.executable, "-B", tool, "--root", root, "--out", outs[0], "--vocab", vocab, "--check"],
                           capture_output=True, text=True, timeout=120)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "byte-identical"))

    def test_v1_check_rejects_corruption_and_missing_input(self):
        d = tmp()
        root = repo_gen.make_repo(os.path.join(d, "repo"))
        tool = os.path.join(W, "v1_frozen", "build_index.py")
        vocab = os.path.join(W, "v1_frozen", "vocabulary.json")
        out = os.path.join(d, "ix")
        r = subprocess.run([sys.executable, "-B", tool, "--root", root, "--out", out, "--vocab", vocab],
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        victim = None
        for a, _, fs in os.walk(out):
            for f in sorted(fs):
                victim = os.path.join(a, f)
                break
            if victim:
                break
        self.assertIsNotNone(victim)
        with open(victim, "r+b") as f:
            b = f.read(1)
            f.seek(0)
            f.write(bytes([b[0] ^ 1]))
        r = subprocess.run([sys.executable, "-B", tool, "--root", root, "--out", out, "--vocab", vocab, "--check"],
                           capture_output=True, text=True, timeout=120)
        self.assertEqual((r.returncode, r.stdout.strip()), (5, "MISMATCH"))
        r = subprocess.run([sys.executable, "-B", tool, "--root", os.path.join(d, "nope"), "--out", os.path.join(d, "ix9"),
                            "--vocab", vocab, "--check"], capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 3)


if __name__ == "__main__":
    unittest.main()
