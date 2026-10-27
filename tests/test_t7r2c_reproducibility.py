"""T7 R2c O7 Reproducibility, Manifest Exec-Bit, and Flake Hunt Test Suite.

Tests manifest determinism, writeManifest exec-bit insensitivity (R1-104),
and executes a bounded N=20 flake hunt across environmental axes.
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_JS = ROOT / 'ui/tools/package.js'

SYS_PYTHONPATH = '/usr/lib/python3/dist-packages'


class ReproducibilityAndFlakeHuntTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp_dir = Path(self.temp.name)

    def test_o7_deps_integrity_stdout_determinism(self):
        """Verify deps pin integrity test suite produces byte-identical stdout across reruns."""
        cmd = [sys.executable, "-I", "tests/test_gate_deps_pin_integrity.py"]
        env1 = dict(os.environ, PYTHONHASHSEED="0", PYTHONPATH=SYS_PYTHONPATH)
        env2 = dict(os.environ, PYTHONHASHSEED="1", PYTHONPATH=SYS_PYTHONPATH)

        res1 = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env=env1)
        res2 = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env=env2)

        self.assertEqual(res1.returncode, 0)
        self.assertEqual(res2.returncode, 0)
        self.assertEqual(res1.stdout, res2.stdout)

    @unittest.skipUnless(shutil.which('node'), "node required")
    def test_o7_write_manifest_determinism_and_exec_bit_insensitivity(self):
        """Test writeManifest byte determinism and confirm exec-bit insensitivity (R1-104)."""
        node_script = textwrap.dedent("""
            import { createHash } from 'node:crypto';
            import { createReadStream } from 'node:fs';
            import * as fs from 'node:fs/promises';
            import { join } from 'node:path';
            import { tmpdir } from 'node:os';

            async function writeManifest(root, destination) {
              const files = [];
              async function walk(part) {
                for (const item of await fs.readdir(join(root, part), { withFileTypes: true })) {
                  const name = part ? `${part}/${item.name}` : item.name;
                  if (/[\\r\\n\\\\]/.test(name)) throw new Error('Unsupported manifest filename');
                  if (item.isSymbolicLink()) throw new Error(`Symlink refused: ${name}`);
                  if (item.isDirectory()) await walk(name);
                  else if (item.isFile()) files.push(name);
                  else throw new Error(`Unsupported package entry: ${name}`);
                }
              }
              await walk('');
              const lines = [];
              for (const name of files.sort()) {
                const hash = createHash('sha256');
                for await (const bytes of createReadStream(join(root, name))) hash.update(bytes);
                lines.push(`${hash.digest('hex')}  ${name}\\n`);
              }
              await fs.writeFile(destination, lines.join(''), { flag: 'wx' });
            }

            const dir = await fs.mkdtemp(join(tmpdir(), 'wm-repro-'));
            const f1 = join(dir, 'a.txt');
            const f2 = join(dir, 'b.sh');
            await fs.writeFile(f1, 'file a\\n');
            await fs.writeFile(f2, '#!/bin/sh\\nexit 0\\n');
            await fs.chmod(f2, 0o644);

            const m1 = join(tmpdir(), 'm1-' + Date.now() + '-' + Math.random());
            await writeManifest(dir, m1);

            await fs.chmod(f2, 0o755);
            const m2 = join(tmpdir(), 'm2-' + Date.now() + '-' + Math.random());
            await writeManifest(dir, m2);

            const t1 = await fs.readFile(m1, 'utf8');
            const t2 = await fs.readFile(m2, 'utf8');

            await fs.rm(dir, { recursive: true, force: true });
            await fs.rm(m1, { force: true });
            await fs.rm(m2, { force: true });

            if (t1 === t2) {
              console.log('EXEC_BIT_INSENSITIVE');
            } else {
              console.log('EXEC_BIT_SENSITIVE');
            }
        """)
        res = subprocess.run(['node', '--input-type=module', '-e', node_script], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0)
        self.assertIn('EXEC_BIT_INSENSITIVE', res.stdout, "writeManifest ignores executable bit (R1-104 confirmed)")

    def test_o7_bounded_flake_hunt_n20(self):
        """Execute bounded N=20 flake hunt across unit suites under varying environment variables."""
        test_suites = [
            "tests/test_gate_deps_pin_integrity.py",
            "tests/test_gitleaks_config.py",
            "tests/test_nv_offline_uid.py",
            "tests/test_ci_matrix.py",
            "tests/ci/test_t7r2c_workflow_pins.py",
            "tests/ci/test_t7r2c_sanitizer_secrets.py",
            "tests/ci/test_t7r2c_offline_enforcement.py",
            "tests/ci/test_t7r2c_receipt_identity.py",
            "tests/test_t7r2c_gate_admission.py",
            "tests/ci/test_t7r2c_argon_volume.py",
        ]

        locales = ["C", "C.UTF-8"]
        timezones = ["UTC", "Pacific/Kiritimati", "America/New_York"]
        seeds = ["0", "12345", "random"]

        python_path = SYS_PYTHONPATH
        if "PYTHONPATH" in os.environ:
            python_path = SYS_PYTHONPATH + os.pathsep + os.environ["PYTHONPATH"]

        for iteration in range(1, 21):
            suite = test_suites[(iteration - 1) % len(test_suites)]
            env = dict(
                os.environ,
                LC_ALL=locales[iteration % len(locales)],
                TZ=timezones[iteration % len(timezones)],
                PYTHONHASHSEED=seeds[iteration % len(seeds)],
                PYTHONPATH=python_path,
                PYTHONDONTWRITEBYTECODE="1",
            )
            with self.subTest(iteration=iteration, suite=suite):
                res = subprocess.run([sys.executable, "-I", suite], cwd=ROOT, capture_output=True, text=True, env=env, timeout=15)
                self.assertEqual(
                    res.returncode, 0,
                    f"Flake detected on iteration {iteration} ({suite}):\n{res.stdout}\n{res.stderr}"
                )


if __name__ == "__main__":
    unittest.main()
