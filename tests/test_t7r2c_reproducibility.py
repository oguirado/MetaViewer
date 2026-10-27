"""T7 round-2: package.js reproducibility, R1-104 manifest mode bits, R1-096 Electron dist checksum binding, R1-097 atomic publish, and flake hunt."""
import hashlib
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from urllib.request import pathname2url

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE_JS = ROOT / "ui" / "tools" / "package.js"


def find_node() -> str:
    node = shutil.which("node")
    if node:
        res = subprocess.run([node, "-p", "process.versions.node.split('.')[0]"], capture_output=True, text=True)
        if res.returncode == 0 and res.stdout.strip().isdigit() and int(res.stdout.strip()) >= 24:
            return node
    nvm_base = pathlib.Path.home() / ".nvm" / "versions" / "node"
    if nvm_base.is_dir():
        for cand in sorted(nvm_base.glob("v24*/bin/node"), reverse=True):
            if cand.is_file():
                return str(cand)
    return "node"


def package_js_url() -> str:
    return "file://" + pathname2url(str(PACKAGE_JS.resolve()))


class TestT7R2CReproducibility(unittest.TestCase):
    def test_o8_r1_104_real_write_manifest_deterministic_and_exec_bit_sensitive(self):
        """Regression test for R1-104: real writeManifest from ui/tools/package.js is byte-deterministic and records mode drift."""
        node = find_node()
        script = f"""
import * as fs from 'node:fs/promises';
import {{ join }} from 'node:path';
import {{ tmpdir }} from 'node:os';
import {{ writeManifest }} from {json.dumps(package_js_url()) if 'json' in globals() else repr(package_js_url())};

const base = await fs.mkdtemp(join(tmpdir(), 't7r2c-r1104-'));
try {{
  const d1 = join(base, 'd1');
  const d1b = join(base, 'd1b');
  const d2 = join(base, 'd2');
  await fs.mkdir(join(d1, 'sub'), {{ recursive: true }});
  await fs.mkdir(join(d1b, 'sub'), {{ recursive: true }});
  await fs.mkdir(join(d2, 'sub'), {{ recursive: true }});
  for (const dir of [d1, d1b, d2]) {{
    await fs.writeFile(join(dir, 'a.txt'), 'alpha\\n');
    await fs.chmod(join(dir, 'a.txt'), 0o644);
    await fs.writeFile(join(dir, 'sub/run.sh'), '#!/bin/sh\\nexit 0\\n');
  }}
  await fs.chmod(join(d1, 'sub/run.sh'), 0o644);
  await fs.chmod(join(d1b, 'sub/run.sh'), 0o644);
  await fs.chmod(join(d2, 'sub/run.sh'), 0o755);

  const m1 = join(base, 'm1.sha256');
  const m1b = join(base, 'm1b.sha256');
  const m2 = join(base, 'm2.sha256');
  await writeManifest(d1, m1);
  await writeManifest(d1b, m1b);
  await writeManifest(d2, m2);
  const t1 = await fs.readFile(m1, 'utf8');
  const t1b = await fs.readFile(m1b, 'utf8');
  const t2 = await fs.readFile(m2, 'utf8');
  if (t1 !== t1b) process.exit(10);
  if (t1 === t2) process.exit(11);
  if (!t2.includes(' 0755  sub/run.sh')) process.exit(12);
  console.log('EXEC_BIT_SENSITIVE');
}} finally {{
  await fs.rm(base, {{ recursive: true, force: true }});
}}
"""
        res = subprocess.run([node, "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=15)
        self.assertEqual(res.returncode, 0, res.stderr + res.stdout)
        self.assertIn("EXEC_BIT_SENSITIVE", res.stdout)

    def test_r1_096_verify_electron_dist_rejects_tampered_file_and_admits_pristine(self):
        """Regression test for R1-096: verifyElectronDist binds local unpacked Electron dist to checksums.json."""
        node = find_node()
        script = f"""
import * as fs from 'node:fs/promises';
import {{ join }} from 'node:path';
import {{ tmpdir }} from 'node:os';
import {{ ELECTRON_PIN, computeElectronDistTreeDigest, verifyElectronDist }} from {repr(package_js_url())};

const base = await fs.mkdtemp(join(tmpdir(), 't7r2c-r1096-'));
try {{
  const dist = join(base, 'dist');
  await fs.mkdir(dist, {{ recursive: true }});
  const elf = Buffer.alloc(128);
  Buffer.from('7f454c46', 'hex').copy(elf, 0);
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(process.arch === 'arm64' ? 183 : 62, 18);
  await fs.writeFile(join(dist, 'electron'), elf);
  await fs.chmod(join(dist, 'electron'), 0o755);
  await fs.writeFile(join(dist, 'version'), ELECTRON_PIN + '\\n');
  await fs.writeFile(join(dist, 'resources.pak'), 'pristine-pak-payload');

  const {{ treeSha256 }} = await computeElectronDistTreeDigest(dist);
  const archive = `electron-v${{ELECTRON_PIN}}-linux-${{process.arch}}.zip`;
  const checksumsPath = join(base, 'checksums.json');
  await fs.writeFile(checksumsPath, JSON.stringify({{
    [archive]: 'a'.repeat(64),
    [`${{archive}}:tree`]: treeSha256,
  }}));

  // Negative control: pristine dist passes verification.
  const ok = await verifyElectronDist(dist, process.arch, {{ checksumsPath }});
  if (ok.treeSha256 !== treeSha256) process.exit(10);

  // Positive regression: tampering a single file in dist fails closed with PKG_ELECTRON_CHECKSUM.
  await fs.writeFile(join(dist, 'resources.pak'), 'tampered-pak-payload');
  let rejected = false;
  try {{
    await verifyElectronDist(dist, process.arch, {{ checksumsPath }});
  }} catch (err) {{
    rejected = err instanceof Error && err.message === 'PKG_ELECTRON_CHECKSUM';
  }}
  if (!rejected) process.exit(11);
  console.log('R1_096_VERIFIED');
}} finally {{
  await fs.rm(base, {{ recursive: true, force: true }});
}}
"""
        res = subprocess.run([node, "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=15)
        self.assertEqual(res.returncode, 0, res.stderr + res.stdout)
        self.assertIn("R1_096_VERIFIED", res.stdout)

    def test_r1_097_publish_staged_package_atomic_rollback_on_fault_and_normal_publish(self):
        """Regression test for R1-097: crash/fault between renames leaves no partial final directory or manifest."""
        node = find_node()
        script = f"""
import * as fs from 'node:fs/promises';
import {{ join }} from 'node:path';
import {{ tmpdir }} from 'node:os';
import {{ publishStagedPackage }} from {repr(package_js_url())};

const base = await fs.mkdtemp(join(tmpdir(), 't7r2c-r1097-'));
try {{
  const out = join(base, 'out');
  const work = join(base, 'work');
  const staged = join(work, 'built');
  await fs.mkdir(out, {{ recursive: true }});
  await fs.mkdir(staged, {{ recursive: true }});
  await fs.writeFile(join(staged, 'metaviewer'), 'binary');
  await fs.chmod(join(staged, 'metaviewer'), 0o755);

  const finalDir = join(out, 'MetaViewer-linux-arm64');
  let calls = 0;
  let faulted = false;
  try {{
    await publishStagedPackage(staged, work, finalDir, {{
      rename: async (src, dst) => {{
        calls++;
        if (calls === 2) throw new Error('INJECTED_RENAME_CRASH');
        await fs.rename(src, dst);
      }},
    }});
  }} catch (err) {{
    faulted = err instanceof Error && err.message === 'INJECTED_RENAME_CRASH';
  }}
  if (!faulted) process.exit(10);
  const remainingAfterCrash = await fs.readdir(out);
  if (remainingAfterCrash.length !== 0) process.exit(11);

  // Negative control: normal publish succeeds and leaves both directory and .sha256 manifest.
  const work2 = join(base, 'work2');
  const staged2 = join(work2, 'built');
  await fs.mkdir(staged2, {{ recursive: true }});
  await fs.writeFile(join(staged2, 'metaviewer'), 'binary');
  await fs.chmod(join(staged2, 'metaviewer'), 0o755);
  await publishStagedPackage(staged2, work2, finalDir);
  const published = (await fs.readdir(out)).sort();
  if (JSON.stringify(published) !== JSON.stringify(['MetaViewer-linux-arm64', 'MetaViewer-linux-arm64.sha256'])) {{
    process.exit(12);
  }}

  // Destination-exists refusal preserved.
  let refused = false;
  try {{
    await publishStagedPackage(staged2, work2, finalDir);
  }} catch (err) {{
    refused = err instanceof Error && err.message === 'Package destination already exists';
  }}
  if (!refused) process.exit(13);
  console.log('R1_097_VERIFIED');
}} finally {{
  await fs.rm(base, {{ recursive: true, force: true }});
}}
"""
        res = subprocess.run([node, "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=15)
        self.assertEqual(res.returncode, 0, res.stderr + res.stdout)
        self.assertIn("R1_097_VERIFIED", res.stdout)

    def test_o8_tar_reproducibility_flags_produce_identical_sha256(self):
        with tempfile.TemporaryDirectory(prefix="t7r2c-tar-") as tmp:
            tpath = pathlib.Path(tmp)
            for idx in (1, 2):
                root = tpath / f"run{idx}" / "MetaViewer-linux-arm64"
                (root / "resources").mkdir(parents=True)
                (root / "metaviewer").write_bytes(b"\x7fELF-stub-binary")
                (root / "resources" / "app.asar").write_bytes(b"asar-payload-bytes")
                (tpath / f"run{idx}" / "MetaViewer-linux-arm64.sha256").write_text("deadbeef  metaviewer\n", encoding="utf-8")
                os.utime(root / "metaviewer", (1000 * idx, 1000 * idx))
                os.utime(root / "resources" / "app.asar", (2000 * idx, 2000 * idx))
                tar_out = tpath / f"run{idx}" / "MetaViewer-linux-arm64.tar"
                subprocess.run(
                    [
                        "tar",
                        "--sort=name",
                        "--mtime=@0",
                        "--owner=0",
                        "--group=0",
                        "--numeric-owner",
                        "--format=gnu",
                        "--mode=u+rwX,go+rX,go-w",
                        "-cf",
                        str(tar_out),
                        "-C",
                        str(tpath / f"run{idx}"),
                        "MetaViewer-linux-arm64",
                        "MetaViewer-linux-arm64.sha256",
                    ],
                    check=True,
                    timeout=15,
                )
            h1 = hashlib.sha256((tpath / "run1" / "MetaViewer-linux-arm64.tar").read_bytes()).hexdigest()
            h2 = hashlib.sha256((tpath / "run2" / "MetaViewer-linux-arm64.tar").read_bytes()).hexdigest()
            self.assertEqual(h1, h2)

    def test_o8_flake_hunt_3x_under_cpu_stress_passes_deterministically(self):
        stress_code = "import time; end = time.monotonic() + 8\nwhile time.monotonic() < end: _ = sum(i*i for i in range(500))"
        stress_procs = [
            subprocess.Popen([sys.executable, "-c", stress_code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(2)
        ]
        try:
            for iteration in range(3):
                with self.subTest(iteration=iteration):
                    res = subprocess.run(
                        [
                            sys.executable,
                            "-m",
                            "unittest",
                            "tests/ci/test_t7r2c_workflow_pins.py",
                            "tests/ci/test_t7r2c_offline_enforcement.py",
                            "tests/ci/test_t7r2c_receipt_identity.py",
                        ],
                        cwd=ROOT,
                        capture_output=True,
                        text=True,
                        timeout=45,
                    )
                    self.assertEqual(res.returncode, 0, res.stderr + res.stdout)
        finally:
            for p in stress_procs:
                p.terminate()
            for p in stress_procs:
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()


if __name__ == "__main__":
    unittest.main()
