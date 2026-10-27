"""Hygiene gates: router coverage, commit laws, secrets runner, privacy sweep.

AC-12 coverage for G-ROUTER, G-LAWS and G-SECRETS, with a non-vacuity
(G-NOVAC) mutant for every gate: each gate below has a passing control and
at least one refusal case that must fail. Standard library only. A
missing prerequisite fails its test; nothing passes by default.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(os.environ.get("MV_TEST_REPO_ROOT") or Path(__file__).resolve().parent.parent)
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
SECRETS_DIR = REPO_ROOT / "tests" / "fixtures" / "secrets"
if str(SECRETS_DIR) not in sys.path:
    sys.path.insert(0, str(SECRETS_DIR))
from tools import check_laws as laws  # noqa: E402
import gate  # noqa: E402

ROUTER_PY = REPO_ROOT / "tools" / "router_index.py"
LAWS_PY = REPO_ROOT / "tools" / "check_laws.py"
GATE_PY = SECRETS_DIR / "gate.py"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "secrets.yml"
HOOK = REPO_ROOT / ".githooks" / "pre-push"

GIT_TIMEOUT = 60
CLI_TIMEOUT = 180

# Split marker keeps this committed source inert under history scans.
_TOKEN_A = "gh"
_TOKEN_B = "p_"

# Stub scanner: same environment contract as the one exercised by the
# committed secrets fixture suite (STUB_STATUS/STUB_REPORT for history,
# STUB_NOGIT_* for controls, STUB_BLIND to hide one control directory).
_STUB = r"""#!/usr/bin/env python3
import json
import os
import sys


def _value(argv, flag):
    for pos, token in enumerate(argv):
        if token == flag and pos + 1 < len(argv):
            return argv[pos + 1]
    return ""


def main(argv):
    log = os.environ.get("STUB_ARGV_LOG", "")
    if log:
        with open(log, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(argv) + "\n")
    nap = float(os.environ.get("STUB_SLEEP", "0") or 0)
    if nap:
        import time
        time.sleep(nap)
    prefix = "STUB_NOGIT" if "--no-git" in argv else "STUB"
    status = int(os.environ.get(prefix + "_STATUS", "0"))
    body = os.environ.get(prefix + "_REPORT", "[]")
    blind = os.environ.get("STUB_BLIND", "")
    if blind and os.path.basename(_value(argv, "--source")) == blind:
        status, body = 0, "[]"
    report = _value(argv, "--report-path")
    if os.environ.get("STUB_NO_WRITE", "") != "1" and report:
        with open(report, "w", encoding="utf-8") as handle:
            handle.write(body)
    trouble = os.environ.get(prefix + "_STDERR", "")
    if trouble:
        sys.stderr.write(trouble)
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
"""


def _finding(rule="test-rule", secret="SENTINEL-SECRET",
             match="SENTINEL-MATCH", file="SENTINEL-FILE"):
    return json.dumps([{
        "RuleID": rule, "Secret": secret, "Match": match,
        "File": file, "StartLine": 1,
    }])


def _write_stub(directory):
    path = directory / "gitleaks-stub"
    path.write_text(_STUB, encoding="utf-8")
    os.chmod(path, 0o700)
    return path


def _scratch(case, prefix="mv-hygiene-"):
    path = Path(tempfile.mkdtemp(prefix=prefix))
    case.addCleanup(shutil.rmtree, path, True)
    os.chmod(path, 0o700)
    return path


def _git_env(extra=None):
    env = dict(os.environ)
    env.update({
        "GIT_AUTHOR_NAME": "tctx",
        "GIT_AUTHOR_EMAIL": "tctx@example.invalid",
        "GIT_COMMITTER_NAME": "tctx",
        "GIT_COMMITTER_EMAIL": "tctx@example.invalid",
        "GIT_CONFIG_NOSYSTEM": "1",
    })
    if extra:
        env.update(extra)
    return env


def _run_git(repo, *args, env=None):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, timeout=GIT_TIMEOUT,
        env=_git_env() if env is None else env)


def _make_repo(case, path, payloads):
    if shutil.which("git") is None:
        raise AssertionError("git is required on PATH")
    env = _git_env()
    path.mkdir(parents=True, exist_ok=True)
    case.assertEqual(_run_git(path, "init", "-q", env=env).returncode, 0)
    case.assertEqual(_run_git(path, "config", "user.email", "tctx@example.invalid", env=env).returncode, 0)
    case.assertEqual(_run_git(path, "config", "user.name", "tctx", env=env).returncode, 0)
    case.assertEqual(_run_git(path, "config", "commit.gpgsign", "false", env=env).returncode, 0)
    for name, body in payloads:
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
    case.assertEqual(_run_git(path, "add", "-A", env=env).returncode, 0)
    case.assertEqual(_run_git(path, "commit", "-qm", "init", env=env).returncode, 0)


def _gate_cli(command, stub, repo, extra):
    env = dict(os.environ)
    env.update(extra)
    return subprocess.run(
        [sys.executable, "-I", str(GATE_PY), command,
         "--gitleaks", str(stub), "--repo", str(repo)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, timeout=CLI_TIMEOUT, env=env)


def _mirror(case):
    """Copy HEAD into a fresh scratch git repo (router reads git ls-files)."""
    dest = _scratch(case, prefix="mv-hygiene-router-")
    archive = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "archive", "HEAD"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=CLI_TIMEOUT)
    case.assertEqual(archive.returncode, 0, archive.stderr.decode("utf-8", "replace")[:400])
    extract = subprocess.run(
        ["tar", "-x", "-C", str(dest)], input=archive.stdout,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=CLI_TIMEOUT)
    case.assertEqual(extract.returncode, 0, extract.stderr.decode("utf-8", "replace")[:400])
    case.assertEqual(_run_git(dest, "init", "-q").returncode, 0)
    case.assertEqual(_run_git(dest, "add", "-A").returncode, 0)
    return dest


def _router_check(root):
    # The script resolves its root from its own path, so the scratch copy
    # must be the invoked one.
    return subprocess.run(
        [sys.executable, "-I", str(root / "tools" / "router_index.py"), "--check"],
        cwd=str(root), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, timeout=CLI_TIMEOUT)


class RouterHygieneTests(unittest.TestCase):
    """G-ROUTER: live coverage plus scratch-tree mutants."""

    def test_check_live_passes(self):
        proc = _router_check(REPO_ROOT)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertIn("METAVIEWER_ROUTER_COVERAGE 100%", proc.stdout)

    def test_check_rejects_unknown_option(self):
        proc = subprocess.run(
            [sys.executable, "-I", str(ROUTER_PY), "--bogus"],
            cwd=str(REPO_ROOT), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=CLI_TIMEOUT)
        self.assertEqual(proc.returncode, 2)

    def test_mirror_passes_then_unrouted_plant_rejected(self):
        mirror = _mirror(self)
        clean = _router_check(mirror)
        self.assertEqual(clean.returncode, 0, clean.stderr[-2000:])
        plant = mirror / "UNROUTED_PROBE.txt"
        plant.write_text("probe\n", encoding="utf-8")
        self.assertEqual(_run_git(mirror, "add", "UNROUTED_PROBE.txt").returncode, 0)
        proc = _router_check(mirror)
        self.assertEqual(proc.returncode, 1, proc.stdout[-2000:])
        self.assertIn("Stale or incomplete router", proc.stderr)

    def test_mirror_passes_then_stale_removal_rejected(self):
        mirror = _mirror(self)
        clean = _router_check(mirror)
        self.assertEqual(clean.returncode, 0, clean.stderr[-2000:])
        victim = mirror / "README.md"
        self.assertTrue(victim.is_file())
        self.assertEqual(_run_git(mirror, "rm", "--cached", "README.md").returncode, 0)
        victim.unlink()
        proc = _router_check(mirror)
        self.assertEqual(proc.returncode, 1, proc.stdout[-2000:])
        self.assertIn("Stale or incomplete router", proc.stderr)


class CommitLawTests(unittest.TestCase):
    """G-LAWS: version, message, identity and range checks."""

    def _laws(self, *args):
        return subprocess.run(
            [sys.executable, "-I", str(LAWS_PY), *args],
            cwd=str(REPO_ROOT), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=CLI_TIMEOUT)

    def test_version_live_passes(self):
        proc = self._laws("--version")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Laws check: OK", proc.stdout)

    def test_message_file_valid_passes(self):
        tmp = _scratch(self)
        msg = tmp / "good.msg"
        msg.write_text("core: add replay journal tests\n", encoding="utf-8")
        proc = self._laws("--message-file", str(msg))
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_message_file_mutants_rejected(self):
        # Forbidden markers are built at runtime so this source stays clean.
        bad = {
            "scope": "other: add widgets\n",
            "imperative": "core: added widgets\n",
            "length": "core: add " + "x" * 70 + "\n",
            "token_a": "core: add widgets\n\n" + "Generated " + "with tooling\n",
            "token_b": "core: add widgets\n\n" + "Co-" + "Authored-By: t <t@e.i>\n",
        }
        for name, body in bad.items():
            with self.subTest(name=name):
                tmp = _scratch(self)
                msg = tmp / "bad.msg"
                msg.write_text(body, encoding="utf-8")
                proc = self._laws("--message-file", str(msg))
                self.assertEqual(proc.returncode, 1, body)
                self.assertIn("ERROR:", proc.stderr)

    def test_ident_cli_passes_and_rejects(self):
        good = "%s <%s> 100 +0200" % (laws.NAME, laws.EMAIL)
        proc = self._laws("--check-ident", good)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        proc = self._laws("--check-ident", "someone <s@e.i> 100 +0200")
        self.assertEqual(proc.returncode, 1)

    def test_invalid_range_rejected(self):
        proc = self._laws("--range", "invalid..range")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("ERROR:", proc.stderr)


class SecretsGateTests(unittest.TestCase):
    """G-SECRETS: pins, CLI shape, stub-driven scans, runtime plants."""

    def _repo_with_context(self, parent):
        repo = parent / "repo"
        _make_repo(self, repo, [("note.txt", "clean content\n")])
        workflow = repo / ".github" / "workflows" / "secrets.yml"
        workflow.parent.mkdir(parents=True, exist_ok=True)
        workflow.write_text(
            "name: Secrets\n# pinned digest " + gate.GITLEAKS_SHA256 + "\n",
            encoding="utf-8")
        return repo

    def test_pins_match_workflow_and_hook(self):
        workflow_text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn(gate.GITLEAKS_VERSION, workflow_text)
        self.assertIn(gate.GITLEAKS_SHA256, workflow_text)
        self.assertTrue(HOOK.is_file())
        self.assertTrue(os.access(HOOK, os.X_OK))
        hook_text = HOOK.read_text(encoding="utf-8")
        self.assertIn("tests/fixtures/secrets/gate.py", hook_text)
        self.assertIn("stays blocked", hook_text)

    def test_help_and_usage_shape(self):
        proc = subprocess.run(
            [sys.executable, "-I", str(GATE_PY), "--help"],
            cwd=str(REPO_ROOT), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=CLI_TIMEOUT)
        self.assertEqual(proc.returncode, 0)
        self.assertTrue(proc.stdout.startswith("usage: gate.py"))
        cases = [
            [],
            ["bogus", "--gitleaks", "/x", "--repo", "/y"],
            ["history", "--gitleaks", "relative-tool", "--repo", "/y"],
        ]
        for argv in cases:
            with self.subTest(argv=argv):
                proc = subprocess.run(
                    [sys.executable, "-I", str(GATE_PY), *argv],
                    cwd=str(REPO_ROOT), stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, timeout=CLI_TIMEOUT)
                self.assertEqual(proc.returncode, 2)

    def test_missing_or_broken_tool_rejects(self):
        tmp = _scratch(self)
        repo = self._repo_with_context(tmp)
        missing = _gate_cli("history", tmp / "no-such-tool", repo, {})
        self.assertEqual(missing.returncode, 1)
        self.assertIn("history: rejected", missing.stdout)
        broken = tmp / "plain-file"
        broken.write_text("not executable\n", encoding="utf-8")
        os.chmod(broken, 0o600)
        proc = _gate_cli("history", broken, repo, {})
        self.assertEqual(proc.returncode, 1)

    def test_history_clean_passes_and_finding_rejects(self):
        tmp = _scratch(self)
        repo = self._repo_with_context(tmp)
        stub = _write_stub(tmp)
        clean = _gate_cli("history", stub, repo, {"STUB_STATUS": "0", "STUB_REPORT": "[]"})
        self.assertEqual(clean.returncode, 0, clean.stdout + clean.stderr)
        self.assertIn("history: clean", clean.stdout)
        dirty = _gate_cli("history", stub, repo, {"STUB_STATUS": "1", "STUB_REPORT": _finding()})
        self.assertEqual(dirty.returncode, 1)
        self.assertIn("1 test-rule", dirty.stdout)
        self.assertNotIn("SENTINEL", dirty.stdout + dirty.stderr)

    def test_controls_all_detected_then_blind_rejected(self):
        tmp = _scratch(self)
        repo = self._repo_with_context(tmp)
        stub = _write_stub(tmp)
        ok_env = {"STUB_NOGIT_STATUS": "7", "STUB_NOGIT_REPORT": _finding()}
        ok = _gate_cli("controls", stub, repo, ok_env)
        self.assertEqual(ok.returncode, 0, ok.stdout)
        self.assertIn("controls: clean", ok.stdout)
        blind_env = dict(ok_env, STUB_BLIND="entropy")
        blind = _gate_cli("controls", stub, repo, blind_env)
        self.assertEqual(blind.returncode, 1)
        self.assertIn("control entropy: NOT detected", blind.stdout)

    def test_gate_combines_history_and_controls(self):
        tmp = _scratch(self)
        repo = self._repo_with_context(tmp)
        stub = _write_stub(tmp)
        base = {"STUB_STATUS": "0", "STUB_REPORT": "[]",
                "STUB_NOGIT_STATUS": "7", "STUB_NOGIT_REPORT": _finding()}
        ok = _gate_cli("gate", stub, repo, base)
        self.assertEqual(ok.returncode, 0, ok.stdout)
        self.assertIn("gate: clean", ok.stdout)
        bad = dict(base, STUB_STATUS="1", STUB_REPORT=_finding())
        proc = _gate_cli("gate", stub, repo, bad)
        self.assertEqual(proc.returncode, 1)

    def test_runtime_plants_live_in_scratch_only(self):
        tmp = _scratch(self)
        first = gate.generate_controls(tmp / "run-a", WORKFLOW)
        second = gate.generate_controls(tmp / "run-b", WORKFLOW)
        self.assertEqual(set(first), set(gate.CONTROL_IDS))
        self.assertEqual(set(second), set(gate.CONTROL_IDS))

        def _only(mapping, control_id):
            files = list(mapping[control_id].iterdir())
            self.assertEqual(len(files), 1)
            return files[0]

        for mapping in (first, second):
            for control_id, control_dir in mapping.items():
                with self.subTest(control_id=control_id):
                    self.assertTrue(str(control_dir).startswith(str(tmp) + os.sep))
                    target = _only(mapping, control_id)
                    self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
                    self.assertTrue(target.stat().st_size > 0)
        prefix = (_TOKEN_A + _TOKEN_B).encode("utf-8")
        self.assertIn(prefix, _only(first, "github").read_bytes())
        self.assertNotEqual(_only(first, "github").read_bytes(),
                            _only(second, "github").read_bytes())
        self.assertEqual(_only(first, "entropy").read_bytes(),
                         _only(second, "entropy").read_bytes())
        self.assertNotEqual(_only(first, "pem").read_bytes(),
                            _only(second, "pem").read_bytes())

    def test_generate_controls_rejects_bad_context(self):
        tmp = _scratch(self)
        empty = tmp / "empty.yml"
        empty.write_text("", encoding="utf-8")
        with self.assertRaises(gate.GateFailure):
            gate.generate_controls(tmp / "x", empty)
        nohash = tmp / "nohash.yml"
        nohash.write_text("name: Secrets\nno digest here\n", encoding="utf-8")
        with self.assertRaises(gate.GateFailure):
            gate.generate_controls(tmp / "y", nohash)

    def test_report_sanitizer_counts_and_rejects(self):
        tmp = _scratch(self)
        report = tmp / "r.json"
        report.write_text(
            '[{"RuleID": "b-rule"}, {"RuleID": "a-rule"}, {"RuleID": "b-rule"}]',
            encoding="utf-8")
        self.assertEqual(gate.summarize_findings(report), [("b-rule", 2), ("a-rule", 1)])
        for body in ("{oops", '{"a": 1}', '[{"RuleID": 7}]', '[42]'):
            with self.subTest(body=body):
                report.write_text(body, encoding="utf-8")
                with self.assertRaises(gate.GateFailure):
                    gate.summarize_findings(report)


class PrivacySweepTests(unittest.TestCase):
    """L5: no operator home path in tracked bytes, with a planted mutant."""

    def _tracked_files(self):
        proc = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "ls-files", "-z", "--cached"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=GIT_TIMEOUT)
        self.assertEqual(proc.returncode, 0)
        rels = [chunk.decode("utf-8") for chunk in proc.stdout.split(b"\0") if chunk]
        self.assertTrue(rels)
        return [REPO_ROOT / rel for rel in rels]

    @staticmethod
    def _sweep(paths, needle):
        return sorted(str(path) for path in paths if needle in path.read_bytes())

    def test_tracked_tree_has_no_operator_home(self):
        needle = str(Path.home()).encode("utf-8")
        hits = self._sweep(self._tracked_files(), needle)
        self.assertEqual(hits, [])

    def test_sweep_catches_planted_home(self):
        tmp = _scratch(self)
        home = str(Path.home())
        plant = tmp / "plant.txt"
        plant.write_text("see " + home + "/secret/file for details\n", encoding="utf-8")
        self.assertEqual(self._sweep([plant], home.encode("utf-8")), [str(plant)])


if __name__ == "__main__":
    unittest.main(verbosity=2)
