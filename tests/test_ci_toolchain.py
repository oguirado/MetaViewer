"""Run the hosted toolchain-selection step against an offline Go fixture."""
import os
import re
from pathlib import Path
import subprocess
import tempfile
import unittest


class CIToolchainTests(unittest.TestCase):
    def test_selected_binary_reaches_later_steps_and_bad_selection_fails(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github/workflows/ci.yml").read_text()
        job = workflow.split("  laws-contracts:\n", 1)[1].split("  router:\n", 1)[0]
        selector, rest = job.split("      - name: Select adapter Go toolchain\n", 1)
        step, gates = rest.split("      - name: Run laws and contracts gates\n", 1)
        script = "\n".join(line[10:] for line in step.split("        run: |\n", 1)[1].splitlines())
        self.assertIn("unittest discover", gates)
        with tempfile.TemporaryDirectory(prefix="mv-ci-go-") as directory:
            scratch = Path(directory)
            (scratch / "daemon-adapter").mkdir()
            (scratch / "daemon-adapter/go.mod").write_text("module fixture\n\ngo 1.26.0\n")
            bin_dir = scratch / "bootstrap"
            bin_dir.mkdir()
            selected = scratch / "toolchain/bin"
            selected.mkdir(parents=True)
            go = bin_dir / "go"
            go.write_text('#!/bin/sh\n[ "$GOTOOLCHAIN" = go1.26.0 ] || exit 9\n'
                          '[ "$1 $2" = "env GOROOT" ] || exit 10\nprintf "%s\\n" "$TEST_GOROOT"\n')
            go.chmod(0o755)
            binary = selected / "go"
            binary.write_text('#!/bin/sh\n[ "$1" = version ] || exit 11\necho go1.26.0\n')
            binary.chmod(0o755)
            github_path = scratch / "github-path"
            env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
                       TEST_GOROOT=str(selected.parent), GITHUB_PATH=str(github_path))
            def run():
                return subprocess.run(["bash", "-c", script], cwd=scratch, env=env,
                                      capture_output=True, text=True, timeout=10)
            proc = run()
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertEqual(github_path.read_text(), str(selected) + "\n")
            github_path.unlink()
            # Negative control: no usable selected binary must never publish PATH.
            binary.unlink()
            self.assertNotEqual(run().returncode, 0)
            self.assertFalse(github_path.exists())
            # Negative control: an absent module version cannot select a default.
            (scratch / "daemon-adapter/go.mod").write_text("module fixture\n")
            self.assertNotEqual(run().returncode, 0)
            self.assertFalse(github_path.exists())

    def test_rust_prerequisites_execute_before_offline_consumers_and_fail_closed(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github/workflows/ci.yml").read_text()
        for job_name, consumer in (("laws-contracts", "Prime npm cache"),
                                   ("e2e", "Install E2E dependencies")):
            with self.subTest(job=job_name), tempfile.TemporaryDirectory() as directory:
                job = re.split(r"\n  [a-z][\w-]*:\n", workflow.split(f"  {job_name}:\n", 1)[1], 1)[0]
                step = job.split("      - name: Prepare Rust for offline checks\n", 1)[1]
                script, rest = step.split("      - name:", 1)
                self.assertTrue(rest.startswith(" " + consumer))
                script = "\n".join(line[10:] for line in script.split("        run: |\n", 1)[1].splitlines())
                scratch = Path(directory)
                log = scratch / "commands"
                for tool in ('rustup', 'cargo'):
                    binary = scratch / tool
                    binary.write_text('#!/bin/sh\nprintf "%s\\n" "' + tool +
                                      ' $*" >> "$COMMAND_LOG"\n'
                                      '[ "${FAIL_TOOL:-}" != "' + tool + '" ]\n')
                    binary.chmod(0o755)
                env = dict(os.environ, PATH=str(scratch) + os.pathsep + os.environ['PATH'],
                           COMMAND_LOG=str(log))
                def run(extra=None):
                    return subprocess.run(['bash', '-c', script], cwd=root,
                                          env=dict(env, **(extra or {})), capture_output=True,
                                          text=True, timeout=10)
                proc = run()
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(log.read_text().splitlines(), [
                    'rustup toolchain install 1.97.0 --profile minimal',
                    'rustup override set 1.97.0', 'cargo fetch --locked'])
                for tool in ('rustup', 'cargo'):
                    self.assertNotEqual(run({'FAIL_TOOL': tool}).returncode, 0)
