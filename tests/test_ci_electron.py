"""Exercise CI binary admission without downloading or launching Electron."""
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile
import unittest


class CIElectronTests(unittest.TestCase):
    def test_hosted_sandbox_precedes_electron_and_fails_closed(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github/workflows/ci.yml").read_text()
        for job_name, consumer in (("js", "Run JS gates"),
                                   ("e2e", "Install and verify pinned Electron binary")):
            job = re.split(r"\n  [a-z][\w-]*:\n",
                           workflow.split(f"  {job_name}:\n", 1)[1], 1)[0]
            step = job.split("      - name: Permit Chromium user namespace sandbox on hosted Ubuntu\n", 1)[1]
            step, rest = step.split("      - name:", 1)
            self.assertTrue(rest.startswith(" " + consumer))
            # Strip YAML comments after the shell block (present in E2E).
            script = "\n".join(line[10:] for line in step.split("        run: |\n", 1)[1].splitlines()
                               if line.startswith("          "))
            with self.subTest(job=job_name), tempfile.TemporaryDirectory() as directory:
                scratch = Path(directory)
                log = scratch / "commands"
                for tool in ("sudo", "sysctl", "unshare"):
                    binary = scratch / tool
                    binary.write_text('#!/bin/sh\n'
                                      'printf "%s\\n" "' + tool + ' $*" >> "$COMMAND_LOG"\n'
                                      '[ "${FAIL_TOOL:-}" != "' + tool + '" ] || exit 9\n' +
                                      ('exec "$@"\n' if tool == "sudo" else
                                       'if [ "$1" = -n ]; then echo "${SYSCTL_VALUE:-0}"; fi\n'
                                       if tool == "sysctl" else 'exit 0\n'))
                    binary.chmod(0o755)
                env = dict(os.environ, PATH=str(scratch) + os.pathsep + os.environ["PATH"],
                           COMMAND_LOG=str(log))
                def run(extra=None):
                    return subprocess.run(["bash", "-c", script], env=dict(env, **(extra or {})),
                                          capture_output=True, text=True, timeout=10)
                proc = run()
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(log.read_text().splitlines(), [
                    "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
                    "sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
                    "sysctl -n kernel.apparmor_restrict_unprivileged_userns",
                    "unshare --user --map-root-user true"])
                for extra in ({"FAIL_TOOL": "sudo"}, {"FAIL_TOOL": "sysctl"},
                              {"FAIL_TOOL": "unshare"}, {"SYSCTL_VALUE": "1"}):
                    self.assertNotEqual(run(extra).returncode, 0)

    def test_installer_and_negative_controls(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "CI installer tests require Node")
        root = Path(__file__).resolve().parents[1]
        proc = subprocess.run([node, "--test", "tests/ci/install_electron.test.cjs"],
                              cwd=root, capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
