"""First tests for the G-SECRETS shared runner (W0-CI-SECRETS).

Stub-driven unit tests (GateUnitTests) plus pinned-tool integration tests
(GateIntegrationTests). Standard library only. A missing runner fails its
tests; nothing here skips.
"""

import base64
import collections
import contextlib
import io
import json
import math
import os
import re
import secrets
import shutil
import stat
import string
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
import gate  # noqa: E402

REPO_ROOT = _HERE.parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "secrets.yml"
HOOK = REPO_ROOT / ".githooks" / "pre-push"

_TOKEN_A = "gh"
_TOKEN_B = "p_"


def _token_prefix():
    return _TOKEN_A + _TOKEN_B


def _token_suffix(length):
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


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


def _scratch(case):
    path = Path(tempfile.mkdtemp(prefix="mv-secrets-test-"))
    case.addCleanup(shutil.rmtree, path, True)
    return path


def _require_git():
    if shutil.which("git") is None:
        raise AssertionError("git is required on PATH")


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


def _run_git(repo, *args, env):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, timeout=60, env=env)


def _make_repo(path, payloads=()):
    _require_git()
    env = _git_env()
    path.mkdir(parents=True, exist_ok=True)
    assert _run_git(path, "init", "-q", env=env).returncode == 0
    _run_git(path, "config", "user.email", "tctx@example.invalid", env=env)
    _run_git(path, "config", "user.name", "tctx", env=env)
    _run_git(path, "config", "commit.gpgsign", "false", env=env)
    for name, body in payloads:
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
    assert _run_git(path, "add", "-A", env=env).returncode == 0
    assert _run_git(path, "commit", "-qm", "init", env=env).returncode == 0


def _write_context_repo(root):
    workflow = root / ".github" / "workflows" / "secrets.yml"
    workflow.parent.mkdir(parents=True, exist_ok=True)
    workflow.write_text(
        "name: Secrets\n# pinned digest " + gate.GITLEAKS_SHA256 + "\n",
        encoding="utf-8")


def _stdout_of(func, *args, **kwargs):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        func(*args, **kwargs)
    return buf.getvalue()


class GateUnitTests(unittest.TestCase):
    """Stub-driven controller behaviour; never touches the network."""

    def test_history_clean_passes(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n")])
        stub = _write_stub(tmp)
        env = {"STUB_STATUS": "0", "STUB_REPORT": "[]"}
        with mock.patch.dict(os.environ, env):
            text = _stdout_of(gate.run_history, stub, repo, tmp)
        self.assertIn("history: clean", text)

    def test_history_missing_report_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n")])
        stub = _write_stub(tmp)
        env = {"STUB_STATUS": "0", "STUB_REPORT": "[]", "STUB_NO_WRITE": "1"}
        with mock.patch.dict(os.environ, env):
            with self.assertRaises(gate.GateFailure):
                gate.run_history(stub, repo, tmp)

    def test_history_malformed_report_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n")])
        stub = _write_stub(tmp)
        env = {"STUB_STATUS": "0", "STUB_REPORT": "{oops"}
        with mock.patch.dict(os.environ, env):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                with self.assertRaises(gate.GateFailure):
                    gate.run_history(stub, repo, tmp)
        self.assertNotIn("oops", buf.getvalue())

    def test_history_wrong_type_report_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n")])
        stub = _write_stub(tmp)
        bad = ['{"a": 1}', '["x"]', '[{"RuleID": 7}]',
               '[{"RuleID": null}]', '[42]']
        for body in bad:
            with self.subTest(body=body):
                env = {"STUB_STATUS": "0", "STUB_REPORT": body}
                with mock.patch.dict(os.environ, env):
                    with self.assertRaises(gate.GateFailure):
                        gate.run_history(stub, repo, tmp)

    def test_history_clean_status_with_findings_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n")])
        stub = _write_stub(tmp)
        env = {"STUB_STATUS": "0", "STUB_REPORT": _finding()}
        with mock.patch.dict(os.environ, env):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                with self.assertRaises(gate.GateFailure):
                    gate.run_history(stub, repo, tmp)
        self.assertIn("1 test-rule", buf.getvalue())

    def test_history_finding_exit_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n")])
        stub = _write_stub(tmp)
        env = {"STUB_STATUS": "1", "STUB_REPORT": _finding()}
        with mock.patch.dict(os.environ, env):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                with self.assertRaises(gate.GateFailure):
                    gate.run_history(stub, repo, tmp)
        self.assertIn("1 test-rule", buf.getvalue())

    def test_history_finding_exit_empty_report_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n")])
        stub = _write_stub(tmp)
        env = {"STUB_STATUS": "1", "STUB_REPORT": "[]"}
        with mock.patch.dict(os.environ, env):
            with self.assertRaises(gate.GateFailure):
                gate.run_history(stub, repo, tmp)

    def test_history_crash_status_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n")])
        stub = _write_stub(tmp)
        for body in ("[]", _finding()):
            with self.subTest(body=body[:10]):
                env = {"STUB_STATUS": "2", "STUB_REPORT": body}
                with mock.patch.dict(os.environ, env):
                    with self.assertRaises(gate.GateFailure):
                        gate.run_history(stub, repo, tmp)

    def test_history_timeout_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n")])
        stub = _write_stub(tmp)
        env = {"STUB_STATUS": "0", "STUB_REPORT": "[]", "STUB_SLEEP": "5"}
        with mock.patch.dict(os.environ, env):
            with mock.patch.object(gate, "SCAN_TIMEOUT", 1):
                with self.assertRaises(gate.GateFailure):
                    gate.run_history(stub, repo, tmp)

    def test_history_argv_shape(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n")])
        stub = _write_stub(tmp)
        log = tmp / "argv.log"
        env = {"STUB_STATUS": "0", "STUB_REPORT": "[]",
               "STUB_ARGV_LOG": str(log)}
        with mock.patch.dict(os.environ, env):
            _stdout_of(gate.run_history, stub, repo, tmp)
        calls = [json.loads(line) for line in
                 log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(calls), 1)
        argv = calls[0]
        self.assertEqual(argv[0], "detect")
        self.assertNotIn("--no-git", argv)
        self.assertIn("--source", argv)
        self.assertEqual(argv[argv.index("--source") + 1], str(repo))
        self.assertIn("--redact", argv)
        self.assertIn("--no-banner", argv)
        self.assertEqual(argv[argv.index("--exit-code") + 1], "1")
        self.assertEqual(argv[argv.index("--report-format") + 1], "json")
        self.assertTrue(argv[argv.index("--config") + 1].endswith(".toml"))
        self.assertTrue(argv[argv.index("--report-path") + 1].endswith(".json"))

    def test_history_not_a_repo_rejects(self):
        tmp = _scratch(self)
        plain = tmp / "plain"
        plain.mkdir()
        stub = _write_stub(tmp)
        with mock.patch.dict(os.environ, {"STUB_STATUS": "0"}):
            with self.assertRaises(gate.GateFailure):
                gate.run_history(stub, plain, tmp)

    def test_history_empty_repo_rejects(self):
        _require_git()
        tmp = _scratch(self)
        repo = tmp / "repo"
        repo.mkdir(parents=True)
        env = _git_env()
        self.assertEqual(
            _run_git(repo, "init", "-q", env=env).returncode, 0)
        stub = _write_stub(tmp)
        with mock.patch.dict(os.environ, {"STUB_STATUS": "0"}):
            with self.assertRaises(gate.GateFailure):
                gate.run_history(stub, repo, tmp)

    def test_history_shallow_rejects_before_scanner(self):
        _require_git()
        tmp = _scratch(self)
        src = tmp / "src"
        _make_repo(src, [("note.txt", "clean\n")])
        clone = tmp / "clone"
        proc = subprocess.run(
            ["git", "clone", "-q", "--depth", "1",
             "file://" + str(src), str(clone)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=60, env=_git_env())
        self.assertEqual(proc.returncode, 0)
        shallow = _run_git(
            clone, "rev-parse", "--is-shallow-repository", env=_git_env())
        self.assertEqual(shallow.stdout.strip(), "true")
        stub = _write_stub(tmp)
        log = tmp / "argv.log"
        env = {"STUB_STATUS": "0", "STUB_REPORT": "[]",
               "STUB_ARGV_LOG": str(log)}
        with mock.patch.dict(os.environ, env):
            with self.assertRaises(gate.GateFailure):
                gate.run_history(stub, clone, tmp)
        self.assertFalse(log.exists())

    def test_controls_all_detected_pass(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _write_context_repo(repo)
        stub = _write_stub(tmp)
        env = {"STUB_NOGIT_STATUS": "7", "STUB_NOGIT_REPORT": _finding()}
        with mock.patch.dict(os.environ, env):
            text = _stdout_of(gate.run_controls, stub, repo, tmp)
        for control in ("github", "entropy", "appended", "pem"):
            self.assertIn(
                "control " + control + ": detected (1 finding(s))", text)
        self.assertIn("controls: clean", text)

    def test_controls_single_blind_rejects_after_running_all(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _write_context_repo(repo)
        stub = _write_stub(tmp)
        env = {"STUB_NOGIT_STATUS": "7", "STUB_NOGIT_REPORT": _finding(),
               "STUB_BLIND": "entropy"}
        with mock.patch.dict(os.environ, env):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                with self.assertRaises(gate.GateFailure):
                    gate.run_controls(stub, repo, tmp)
        text = buf.getvalue()
        self.assertIn("control entropy: NOT detected", text)
        for control in ("github", "appended", "pem"):
            self.assertIn("control " + control + ": detected", text)

    def test_controls_stale_report_is_deleted_before_run(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _write_context_repo(repo)
        stub = _write_stub(tmp)
        stale = tmp / "control-github.json"
        stale.write_text(_finding(), encoding="utf-8")
        env = {"STUB_NOGIT_STATUS": "7", "STUB_NOGIT_REPORT": _finding(),
               "STUB_NO_WRITE": "1"}
        with mock.patch.dict(os.environ, env):
            with self.assertRaises(gate.GateFailure):
                gate.run_controls(stub, repo, tmp)
        self.assertFalse(stale.exists())

    def test_controls_crash_with_findings_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _write_context_repo(repo)
        stub = _write_stub(tmp)
        env = {"STUB_NOGIT_STATUS": "2", "STUB_NOGIT_REPORT": _finding()}
        with mock.patch.dict(os.environ, env):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                with self.assertRaises(gate.GateFailure):
                    gate.run_controls(stub, repo, tmp)
        self.assertIn("control github: NOT detected", buf.getvalue())

    def test_controls_clean_status_with_findings_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _write_context_repo(repo)
        stub = _write_stub(tmp)
        env = {"STUB_NOGIT_STATUS": "0", "STUB_NOGIT_REPORT": _finding()}
        with mock.patch.dict(os.environ, env):
            with self.assertRaises(gate.GateFailure):
                gate.run_controls(stub, repo, tmp)

    def test_controls_missing_context_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        repo.mkdir()
        stub = _write_stub(tmp)
        with mock.patch.dict(os.environ, {"STUB_NOGIT_STATUS": "7"}):
            with self.assertRaises(gate.GateFailure):
                gate.run_controls(stub, repo, tmp)

    def test_controls_context_without_checksum_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        workflow = repo / ".github" / "workflows" / "secrets.yml"
        workflow.parent.mkdir(parents=True, exist_ok=True)
        workflow.write_text("name: Secrets\n# no digest here\n",
                            encoding="utf-8")
        stub = _write_stub(tmp)
        with mock.patch.dict(os.environ, {"STUB_NOGIT_STATUS": "7"}):
            with self.assertRaises(gate.GateFailure):
                gate.run_controls(stub, repo, tmp)

    def test_controls_argv_shape(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _write_context_repo(repo)
        stub = _write_stub(tmp)
        log = tmp / "argv.log"
        env = {"STUB_NOGIT_STATUS": "7", "STUB_NOGIT_REPORT": _finding(),
               "STUB_ARGV_LOG": str(log)}
        with mock.patch.dict(os.environ, env):
            _stdout_of(gate.run_controls, stub, repo, tmp)
        calls = [json.loads(line) for line in
                 log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(calls), 4)
        configs = set()
        reports = set()
        sources = set()
        for argv in calls:
            self.assertIn("--no-git", argv)
            self.assertEqual(argv[argv.index("--exit-code") + 1], "7")
            sources.add(os.path.basename(argv[argv.index("--source") + 1]))
            configs.add(argv[argv.index("--config") + 1])
            reports.add(argv[argv.index("--report-path") + 1])
        self.assertEqual(sources, {"github", "entropy", "appended", "pem"})
        self.assertEqual(len(configs), 1)
        self.assertEqual(len(reports), 4)

    def test_generate_shapes(self):
        tmp = _scratch(self)
        context = tmp / "ctx" / "secrets.yml"
        context.parent.mkdir(parents=True, exist_ok=True)
        line = "pinned " + gate.GITLEAKS_SHA256 + " end"
        context.write_text("first\n" + line + "\nlast\n", encoding="utf-8")
        result = gate.generate_controls(tmp / "plants", context)
        self.assertEqual(set(result), {"github", "entropy", "appended", "pem"})
        self.assertEqual(len({p.resolve() for p in result.values()}), 4)
        github = (result["github"] / "creds.txt").read_text(encoding="utf-8")
        head = 'token = "' + _TOKEN_A + _TOKEN_B
        self.assertTrue(github.startswith(head))
        self.assertTrue(github.endswith('"\n'))
        suffix = github[len(head):-2]
        self.assertEqual(len(suffix), 36)
        alphabet = string.ascii_letters + string.digits
        self.assertTrue(all(c in alphabet for c in suffix))
        entropy = (result["entropy"] / "settings.txt").read_text(
            encoding="utf-8")
        key_head = 'secret_key = "'
        self.assertTrue(entropy.startswith(key_head))
        hexpart = entropy[len(key_head):-2]
        self.assertEqual(len(hexpart), 64)
        int(hexpart, 16)
        counts = collections.Counter(hexpart)
        observed = -sum(v / 64 * math.log2(v / 64)
                        for v in counts.values())
        self.assertGreaterEqual(observed, 3.7)
        appended = (result["appended"] / "appended.txt").read_text(
            encoding="utf-8")
        self.assertTrue(appended.startswith(line[:200] + " "))
        tail = appended[len(line[:200]) + 1:-1]
        self.assertTrue(tail.startswith(_token_prefix()))
        self.assertEqual(len(tail), 4 + 36)
        pem = (result["pem"] / "key.pem").read_text(
            encoding="utf-8").splitlines()
        self.assertEqual(pem[0], "-----BEGIN RS" + "A PRIVATE KEY-----")
        self.assertEqual(pem[-1], "-----END RS" + "A PRIVATE KEY-----")
        body = "".join(pem[1:-1])
        self.assertTrue(len(body) > 0)
        base64.b64decode(body)
        for control in result.values():
            self.assertEqual(stat.S_IMODE(os.stat(control).st_mode), 0o700)
            for child in control.iterdir():
                self.assertEqual(stat.S_IMODE(os.stat(child).st_mode), 0o600)

    def test_generate_exhaustion_rejects(self):
        tmp = _scratch(self)
        context = tmp / "secrets.yml"
        context.write_text("digest " + gate.GITLEAKS_SHA256 + "\n",
                           encoding="utf-8")
        with mock.patch.object(gate, "_random_hex", return_value="00" * 32):
            with self.assertRaises(gate.GateFailure):
                gate.generate_controls(tmp / "plants", context)

    def test_generate_missing_or_empty_context_rejects(self):
        tmp = _scratch(self)
        with self.assertRaises(gate.GateFailure):
            gate.generate_controls(tmp / "a", tmp / "absent.yml")
        empty = tmp / "empty.yml"
        empty.write_text("  \n", encoding="utf-8")
        with self.assertRaises(gate.GateFailure):
            gate.generate_controls(tmp / "b", empty)

    def test_generate_context_without_checksum_rejects(self):
        tmp = _scratch(self)
        context = tmp / "secrets.yml"
        context.write_text("name: Secrets\nnothing to see\n", encoding="utf-8")
        with self.assertRaises(gate.GateFailure):
            gate.generate_controls(tmp / "plants", context)

    def test_generate_symlink_destination_rejects(self):
        tmp = _scratch(self)
        context = tmp / "secrets.yml"
        context.write_text("digest " + gate.GITLEAKS_SHA256 + "\n",
                           encoding="utf-8")
        real = tmp / "real"
        real.mkdir()
        link = tmp / "link"
        os.symlink(real, link)
        with self.assertRaises(gate.GateFailure):
            gate.generate_controls(link, context)

    def test_generate_twice_into_same_destination_rejects(self):
        tmp = _scratch(self)
        context = tmp / "secrets.yml"
        context.write_text("digest " + gate.GITLEAKS_SHA256 + "\n",
                           encoding="utf-8")
        gate.generate_controls(tmp / "plants", context)
        with self.assertRaises(gate.GateFailure):
            gate.generate_controls(tmp / "plants", context)

    def test_summarize_counts_sorted_sanitized(self):
        tmp = _scratch(self)
        report = tmp / "r.json"
        entries = [
            {"RuleID": "zeta-rule"}, {"RuleID": "bad rule!"},
            {"RuleID": "alpha"}, {"RuleID": "zeta-rule"},
            {"RuleID": "../x"}, {"RuleID": ""},
        ]
        report.write_text(json.dumps(entries), encoding="utf-8")
        self.assertEqual(
            gate.summarize_findings(report),
            [("unknown", 3), ("zeta-rule", 2), ("alpha", 1)])

    def test_summarize_rejects_defects(self):
        tmp = _scratch(self)
        with self.assertRaises(gate.GateFailure):
            gate.summarize_findings(tmp / "absent.json")
        bad = ['{oops', '{"a": 1}', '["x"]', '[{"RuleID": 7}]',
               '[{"RuleID": null}]', '[42]']
        for pos, body in enumerate(bad):
            with self.subTest(body=body):
                report = tmp / ("r%d.json" % pos)
                report.write_text(body, encoding="utf-8")
                with self.assertRaises(gate.GateFailure):
                    gate.summarize_findings(report)

    def test_workflow_identity(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("name: Secrets", text)
        self.assertRegex(text, r"(?m)^  secrets:$")
        for token in ("push:", "pull_request", "workflow_dispatch",
                      "permissions:", "contents: read",
                      "runs-on: ubuntu-24.04", "timeout-minutes: 15",
                      "fetch-depth: 0", "--max-time 120",
                      "sha256sum -c -", "tar -xzf",
                      "unittest discover -s tests/fixtures/secrets",
                      "gate.py gate --gitleaks", "$RUNNER_TEMP/gitleaks",
                      "$GITHUB_WORKSPACE", gate.GITLEAKS_SHA256,
                      gate.GITLEAKS_URL,
                      "11bd71901bbe5b1630ceea73d27597364c9af683",
                      "# v4.2.2"):
            self.assertIn(token, text)
        for banned in ("ubuntu-latest", "continue-on-error", "|| true",
                       "upload-artifact", "gl.json", "@v", "@main", "@master"):
            self.assertNotIn(banned, text)
        uses = [line.strip() for line in text.splitlines()
                if re.match(r"\s*-\s+uses:", line)]
        self.assertTrue(uses)
        for line in uses:
            self.assertRegex(line, r"uses:\s*\S+@[0-9a-f]{40}\b")
        curl_at = text.index("curl ")
        sum_at = text.index("sha256sum -c -")
        tar_at = text.index("tar -xzf")
        self.assertLess(curl_at, sum_at)
        self.assertLess(sum_at, tar_at)

    def test_pin_constants(self):
        self.assertEqual(gate.GITLEAKS_VERSION, "v8.18.4")
        digest = gate.GITLEAKS_SHA256
        self.assertEqual(len(digest), 64)
        int(digest, 16)
        self.assertEqual(digest[:32], "ba6dbb656933921c775ee5a2d1c13a91")
        self.assertEqual(digest[32:], "046e7952e9d919f9bac4cec61d628e7d")
        self.assertIn(digest, WORKFLOW.read_text(encoding="utf-8"))
        self.assertEqual(
            gate.GITLEAKS_URL,
            "https://github.com/gitleaks/gitleaks/releases/download/"
            "v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz")

    def test_history_output_omits_report_and_scanner_bytes(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n")])
        stub = _write_stub(tmp)
        report = _finding(rule="SENTINEL RULE", secret="SENTINEL-SECRET-X1",
                          match="SENTINEL-MATCH-X1", file="SENTINEL-FILE-X1")
        env = {"STUB_STATUS": "1", "STUB_REPORT": report,
               "STUB_STDERR": "SENTINEL-STDERR-X1"}
        with mock.patch.dict(os.environ, env):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                with self.assertRaises(gate.GateFailure):
                    gate.run_history(stub, repo, tmp)
        text = buf.getvalue()
        for sentinel in ("SENTINEL-SECRET-X1", "SENTINEL-MATCH-X1",
                         "SENTINEL-FILE-X1", "SENTINEL-STDERR-X1",
                         "SENTINEL RULE"):
            self.assertNotIn(sentinel, text)
        self.assertIn("1 unknown", text)

    def test_malformed_report_output_omits_bytes(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n")])
        stub = _write_stub(tmp)
        env = {"STUB_STATUS": "0", "STUB_REPORT": "{oops SENTINEL-JSON-X2"}
        with mock.patch.dict(os.environ, env):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = gate.main(["gate.py", "history", "--gitleaks",
                                str(stub), "--repo", str(repo)])
        self.assertEqual(rc, 1)
        self.assertEqual(out.getvalue(), "history: rejected\n")

    def test_main_missing_tool_rejects(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        repo.mkdir()
        rc = gate.main(["gate.py", "history", "--gitleaks",
                        "/nonexistent-tool-1", "--repo", str(repo)])
        self.assertEqual(rc, 1)
        plain = tmp / "plain"
        plain.write_text("x", encoding="utf-8")
        os.chmod(plain, 0o600)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = gate.main(["gate.py", "history", "--gitleaks",
                            str(plain), "--repo", str(repo)])
        self.assertEqual(rc, 1)
        self.assertEqual(out.getvalue(), "history: rejected\n")

    def test_main_malformed_returns_two(self):
        tmp = _scratch(self)
        stub = _write_stub(tmp)
        repo = tmp / "repo"
        repo.mkdir()
        good_g = ["--gitleaks", str(stub)]
        good_r = ["--repo", str(repo)]
        cases = [
            [], ["gate.py"], ["gate.py", "bogus", *good_g, *good_r],
            ["gate.py", "history"], ["gate.py", "history", *good_g],
            ["gate.py", "history", *good_g, *good_r, "extra"],
            ["gate.py", "history", "--gitleaks", "relative/bin", *good_r],
            ["gate.py", "history", *good_g, "--repo", "relative/root"],
            ["gate.py", "history", *good_g, *good_g],
            ["gate.py", "SENTINEL-ARGV-UNIQUE-9", *good_g, *good_r],
        ]
        for argv in cases:
            with self.subTest(argv=argv):
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), \
                        contextlib.redirect_stderr(err):
                    rc = gate.main(argv if argv else ["gate.py"])
                self.assertEqual(rc, 2)
                self.assertIn("usage: gate.py", err.getvalue())
                self.assertNotIn("SENTINEL-ARGV-UNIQUE-9",
                                 out.getvalue() + err.getvalue())

    def test_main_help(self):
        for argv in (["gate.py", "--help"], ["gate.py", "-h"]):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), \
                    contextlib.redirect_stderr(err):
                rc = gate.main(argv)
            self.assertEqual(rc, 0)
            self.assertIn("usage: gate.py", out.getvalue())

    def test_main_gate_clean(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean\n")])
        _write_context_repo(repo)
        stub = _write_stub(tmp)
        env = {"STUB_STATUS": "0", "STUB_REPORT": "[]",
               "STUB_NOGIT_STATUS": "7", "STUB_NOGIT_REPORT": _finding()}
        with mock.patch.dict(os.environ, env):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = gate.main(["gate.py", "gate", "--gitleaks",
                                str(stub), "--repo", str(repo)])
        self.assertEqual(rc, 0)
        self.assertIn("gate: clean", out.getvalue())

    def test_main_gate_runs_controls_after_history_failure(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean\n")])
        _write_context_repo(repo)
        stub = _write_stub(tmp)
        env = {"STUB_STATUS": "1", "STUB_REPORT": _finding(),
               "STUB_NOGIT_STATUS": "7", "STUB_NOGIT_REPORT": _finding()}
        with mock.patch.dict(os.environ, env):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = gate.main(["gate.py", "gate", "--gitleaks",
                                str(stub), "--repo", str(repo)])
        self.assertEqual(rc, 1)
        text = out.getvalue()
        self.assertIn("control github: detected", text)
        self.assertIn("gate: rejected", text)

    def test_main_internal_error_stays_fixed(self):
        tmp = _scratch(self)
        stub = _write_stub(tmp)
        repo = tmp / "repo"
        repo.mkdir()
        with mock.patch.object(
                gate, "run_history",
                side_effect=RuntimeError("SENTINEL-REPR-LEAK")):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = gate.main(["gate.py", "history", "--gitleaks",
                                str(stub), "--repo", str(repo)])
        self.assertEqual(rc, 1)
        text = out.getvalue()
        self.assertIn("history: internal error", text)
        self.assertNotIn("SENTINEL-REPR-LEAK", text)
        self.assertNotIn("RuntimeError", text)

    def test_main_cleans_scratch_on_success_and_failure(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean\n")])
        stub = _write_stub(tmp)
        created = []
        real_mkdtemp = tempfile.mkdtemp

        def recording(*args, **kwargs):
            path = real_mkdtemp(*args, **kwargs)
            created.append(Path(path))
            return path

        argv = ["gate.py", "history", "--gitleaks", str(stub),
                "--repo", str(repo)]
        with mock.patch.object(tempfile, "mkdtemp", side_effect=recording):
            with mock.patch.dict(os.environ, {"STUB_STATUS": "0",
                                               "STUB_REPORT": "[]"}):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(gate.main(argv), 0)
            with mock.patch.dict(os.environ, {"STUB_STATUS": "1",
                                               "STUB_REPORT": _finding()}):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(gate.main(argv), 1)
        self.assertEqual(len(created), 2)
        for path in created:
            self.assertFalse(path.exists())
            self.assertNotIn(REPO_ROOT.resolve(), path.resolve().parents)

    def test_config_bytes_identical_across_modes(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean\n")])
        _write_context_repo(repo)
        stub = _write_stub(tmp)
        env = {"STUB_STATUS": "0", "STUB_REPORT": "[]",
               "STUB_NOGIT_STATUS": "7", "STUB_NOGIT_REPORT": _finding()}
        with mock.patch.dict(os.environ, env):
            with contextlib.redirect_stdout(io.StringIO()):
                gate.run_history(stub, repo, tmp)
                gate.run_controls(stub, repo, tmp)
        cfgs = sorted(tmp.glob("gitleaks-*.toml"))
        self.assertEqual(len(cfgs), 2)
        for cfg in cfgs:
            self.assertEqual(cfg.read_bytes(),
                             gate.CONFIG_TEXT.encode("ascii"))

    def _hook_bin(self, tmp, stub=None, with_python=True, with_git=True):
        bindir = tmp / "bin"
        bindir.mkdir(parents=True, exist_ok=True)
        if with_python:
            python = shutil.which("python3") or sys.executable
            os.symlink(python, bindir / "python3")
        if with_git:
            real_git = shutil.which("git")
            if real_git is None:
                raise AssertionError("git is required on PATH")
            os.symlink(real_git, bindir / "git")
        if stub is not None:
            os.symlink(stub, bindir / "gitleaks")
        return bindir

    def _hook_repo(self, tmp):
        repo = tmp / "hookrepo"
        fixture = repo / "tests" / "fixtures" / "secrets"
        fixture.mkdir(parents=True, exist_ok=True)
        shutil.copy(_HERE / "gate.py", fixture / "gate.py")
        _write_context_repo(repo)
        (repo / "note.txt").write_text("clean\n", encoding="utf-8")
        _make_repo(repo)
        return repo

    def _run_hook(self, bindir, cwd, *args, extra_env=None):
        env = dict(os.environ)
        env["PATH"] = str(bindir)
        if extra_env:
            env.update(extra_env)
        return subprocess.run(
            [str(HOOK), *args], cwd=str(cwd),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, timeout=120, env=env)

    def test_hook_is_executable_posix(self):
        mode = stat.S_IMODE(os.stat(HOOK).st_mode)
        self.assertEqual(mode, 0o755)
        proc = subprocess.run(
            ["sh", "-n", str(HOOK)], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(proc.returncode, 0)
        text = HOOK.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("#!/bin/sh\n"))
        self.assertIn("set -eu", text)
        self.assertIn("tests/fixtures/secrets/gate.py gate --gitleaks", text)
        self.assertIn(
            "install -m 755 .githooks/pre-push .git/hooks/pre-push", text)
        self.assertNotIn("publication_lint", text)
        self.assertNotIn("claims_check", text)

    def test_hook_clean_passes_from_nested_cwd(self):
        tmp = _scratch(self)
        repo = self._hook_repo(tmp)
        nested = repo / "a" / "b"
        nested.mkdir(parents=True)
        stub = _write_stub(tmp)
        bindir = self._hook_bin(tmp, stub)
        log = tmp / "argv.log"
        env = {"STUB_STATUS": "0", "STUB_REPORT": "[]",
               "STUB_NOGIT_STATUS": "7", "STUB_NOGIT_REPORT": _finding(),
               "STUB_ARGV_LOG": str(log)}
        proc = self._run_hook(bindir, nested, "origin",
                              "git@example.invalid:x.git", extra_env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        self.assertIn("gate: clean", proc.stdout)
        calls = [json.loads(line) for line in
                 log.read_text(encoding="utf-8").splitlines()]
        histories = [c for c in calls if "--no-git" not in c]
        self.assertEqual(len(histories), 1)
        self.assertEqual(
            histories[0][histories[0].index("--source") + 1], str(repo))

    def test_hook_missing_scanner_rejects(self):
        tmp = _scratch(self)
        repo = self._hook_repo(tmp)
        bindir = self._hook_bin(tmp)
        proc = self._run_hook(bindir, repo, "origin", "url")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("gitleaks", proc.stderr)

    def test_hook_missing_python_rejects(self):
        tmp = _scratch(self)
        repo = self._hook_repo(tmp)
        stub = _write_stub(tmp)
        bindir = self._hook_bin(tmp, stub, with_python=False)
        proc = self._run_hook(bindir, repo, "origin", "url")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("python3", proc.stderr)

    def test_hook_missing_git_rejects(self):
        tmp = _scratch(self)
        repo = self._hook_repo(tmp)
        stub = _write_stub(tmp)
        bindir = self._hook_bin(tmp, stub, with_git=False)
        proc = self._run_hook(bindir, repo, "origin", "url")
        self.assertEqual(proc.returncode, 1)

    def test_hook_finding_rejects_without_secret_bytes(self):
        tmp = _scratch(self)
        repo = self._hook_repo(tmp)
        stub = _write_stub(tmp)
        bindir = self._hook_bin(tmp, stub)
        report = _finding(secret="SENTINEL-HOOK-SECRET-1")
        env = {"STUB_STATUS": "1", "STUB_REPORT": report,
               "STUB_NOGIT_STATUS": "7", "STUB_NOGIT_REPORT": _finding()}
        proc = self._run_hook(bindir, repo, "origin", "url", extra_env=env)
        self.assertEqual(proc.returncode, 1)
        combined = proc.stdout + proc.stderr
        self.assertNotIn("SENTINEL-HOOK-SECRET-1", combined)
        self.assertIn("pre-push: secrets gate rejected the push", combined)


class GateIntegrationTests(unittest.TestCase):
    """Pinned-tool evidence; requires absolute GITLEAKS_BIN, never skips."""

    @classmethod
    def setUpClass(cls):
        raw = os.environ.get("GITLEAKS_BIN", "")
        if not raw:
            raise AssertionError(
                "GITLEAKS_BIN is not set; pinned scanner required")
        path = Path(raw)
        if not path.is_absolute() or not path.is_file():
            raise AssertionError("GITLEAKS_BIN must be an absolute file")
        cls.gitleaks = path

    def _runtime_token_line(self):
        return ('token = "' + _token_prefix() + _token_suffix(36) + '"\n')

    def test_tool_version_pinned(self):
        proc = subprocess.run(
            [str(self.gitleaks), "version"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("8.18.4", proc.stdout)

    def test_real_history_clean_passes(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean content\n"),
                          ("doc.md", "# title\n")])
        text = _stdout_of(gate.run_history, self.gitleaks, repo, tmp)
        self.assertIn("history: clean", text)

    def test_real_history_deleted_secret_rejects(self):
        _require_git()
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("key.txt", self._runtime_token_line())])
        env = _git_env()
        self.assertEqual(
            _run_git(repo, "rm", "-q", "key.txt", env=env).returncode, 0)
        self.assertEqual(
            _run_git(repo, "commit", "-qm", "remove", env=env).returncode, 0)
        with self.assertRaises(gate.GateFailure):
            with contextlib.redirect_stdout(io.StringIO()):
                gate.run_history(self.gitleaks, repo, tmp)
        tip = tmp / "tip"
        shutil.copytree(repo, tip, ignore=shutil.ignore_patterns(".git"))
        report = tmp / "tip.json"
        proc = subprocess.run(
            [str(self.gitleaks), "detect", "--no-git", "--source", str(tip),
             "--redact", "--no-banner", "--exit-code", "1",
             "--report-format", "json", "--report-path", str(report)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=120)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(report.read_text(encoding="utf-8")), [])

    def test_real_history_side_ref_rejects(self):
        _require_git()
        tmp = _scratch(self)
        repo = tmp / "repo"
        _make_repo(repo, [("note.txt", "clean\n")])
        env = _git_env()
        main_branch = _run_git(
            repo, "branch", "--show-current", env=env).stdout.strip()
        self.assertTrue(main_branch)
        self.assertEqual(
            _run_git(repo, "checkout", "-qb", "side", env=env).returncode, 0)
        (repo / "side.txt").write_text(self._runtime_token_line(),
                                       encoding="utf-8")
        self.assertEqual(
            _run_git(repo, "add", "-A", env=env).returncode, 0)
        self.assertEqual(
            _run_git(repo, "commit", "-qm", "side", env=env).returncode, 0)
        self.assertEqual(
            _run_git(repo, "checkout", "-q", main_branch, env=env).returncode,
            0)
        with self.assertRaises(gate.GateFailure):
            with contextlib.redirect_stdout(io.StringIO()):
                gate.run_history(self.gitleaks, repo, tmp)

    def test_real_shallow_rejects(self):
        _require_git()
        tmp = _scratch(self)
        src = tmp / "src"
        _make_repo(src, [("note.txt", "clean\n")])
        clone = tmp / "clone"
        proc = subprocess.run(
            ["git", "clone", "-q", "--depth", "1",
             "file://" + str(src), str(clone)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=60, env=_git_env())
        self.assertEqual(proc.returncode, 0)
        with self.assertRaises(gate.GateFailure):
            gate.run_history(self.gitleaks, clone, tmp)

    def test_real_controls_all_detected(self):
        tmp = _scratch(self)
        repo = tmp / "repo"
        _write_context_repo(repo)
        text = _stdout_of(gate.run_controls, self.gitleaks, repo, tmp)
        for control in ("github", "entropy", "appended", "pem"):
            self.assertIn("control " + control + ": detected", text)
        self.assertIn("controls: clean", text)

    def test_real_committed_source_clean(self):
        tmp = _scratch(self)
        owned = {"gate.py", "test_gate.py", "README.md", "secrets.yml",
                 "pre-push"}
        config = tmp / "cfg.toml"
        gate.write_default_config(config)
        for source in (_HERE, WORKFLOW.parent, HOOK.parent):
            report = tmp / (source.name + ".json")
            proc = subprocess.run(
                [str(self.gitleaks), "detect", "--no-git",
                 "--source", str(source), "--config", str(config),
                 "--redact", "--no-banner", "--exit-code", "1",
                 "--report-format", "json", "--report-path", str(report)],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=120)
            self.assertIn(proc.returncode, (0, 1))
            findings = json.loads(report.read_text(encoding="utf-8"))
            mine = [entry for entry in findings
                    if os.path.basename(entry.get("File", "")) in owned]
            self.assertEqual(mine, [])


if __name__ == "__main__":
    unittest.main()

