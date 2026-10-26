"""Shared G-SECRETS runner: full-history scan plus runtime negative controls.

Standard library only. The scanner writes JSON reports into a private
scratch directory; public output is fixed phase lines, sanitized rule
counts and fixed diagnostics. Reports and scanner streams never reach
the console and are removed with the scratch directory.
"""

import base64
import collections
import json
import math
import os
import re
import secrets
import shutil
import string
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Sequence

GITLEAKS_VERSION = "v8.18.4"
GITLEAKS_SHA256 = (
    "ba6dbb656933921c775ee5a2d1c13a91"
    "046e7952e9d919f9bac4cec61d628e7d"
)
GITLEAKS_URL = (
    "https://github.com/gitleaks/gitleaks/releases/download/"
    "v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz"
)
CONFIG_TEXT = "[extend]\nuseDefault = true\n"
CONTROL_IDS = ("github", "entropy", "appended", "pem")
SCAN_TIMEOUT = 120
GIT_TIMEOUT = 60
MAX_SUMMARY_ROWS = 25
FINDING_EXIT_HISTORY = 1
FINDING_EXIT_CONTROL = 7
EXIT_OK = 0
EXIT_REJECT = 1
EXIT_USAGE = 2
UNKNOWN_RULE = "unknown"
USAGE = ("usage: gate.py {history|controls|gate} "
         "--gitleaks <absolute-executable> --repo <absolute-root>")

_RULE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")


class GateFailure(Exception):
    """Internal failure; public diagnostics must not expose its raw text."""


def write_default_config(destination: Path) -> None:
    """Write the default-rules-only scanner config (constant bytes)."""
    try:
        destination.write_text(CONFIG_TEXT, encoding="ascii")
    except OSError as exc:
        raise GateFailure("config write failed") from exc


def _token_suffix(length: int) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _github_shaped_token() -> str:
    # Split marker keeps this committed source inert under the scan.
    return "gh" + "p_" + _token_suffix(36)


def _shannon_entropy(text: str) -> float:
    if not text:
        return 0.0
    length = len(text)
    return -sum(count / length * math.log2(count / length)
                for count in collections.Counter(text).values())


def _entropy_control() -> str:
    # Fixed mixed-case alphabet: above the default generic-api-key entropy
    # threshold, with no random stopword collisions or SHA-shaped allowlisting.
    # Construct at runtime so the committed source is inert under history scans.
    return "".join(chr(n) for n in range(65, 91)) + "".join(
        chr(n) for n in range(97, 123)) + "".join(chr(n) for n in range(48, 58))


def _pem_block() -> str:
    # Split markers keep this committed source inert under the scan.
    body = base64.b64encode(secrets.token_bytes(96)).decode("ascii")
    fence = "-----"
    lines = [fence + "BEGIN RS" + "A PRIVATE KEY" + fence]
    lines.extend(body[pos:pos + 64] for pos in range(0, len(body), 64))
    lines.append(fence + "END RS" + "A PRIVATE KEY" + fence)
    return "\n".join(lines) + "\n"


def generate_controls(destination: Path, context_file: Path) -> dict[str, Path]:
    """Create the four control plants under separate directories.

    Returns exactly CONTROL_IDS mapped to their directories. Raises
    GateFailure on missing/empty context or generation exhaustion.
    """
    if destination.is_symlink():
        raise GateFailure("scratch is a symlink")
    try:
        context_text = context_file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise GateFailure("context unreadable") from exc
    if not context_text.strip():
        raise GateFailure("context empty")
    context_line = ""
    for line in context_text.splitlines():
        if GITLEAKS_SHA256 in line:
            context_line = line[:200]
            break
    if not context_line:
        raise GateFailure("context lacks checksum line")
    plants = {
        "github": 'token = "' + _github_shaped_token() + '"\n',
        "entropy": 'secret_key = "' + _entropy_control() + '"\n',
        "appended": context_line + " " + _github_shaped_token() + "\n",
        "pem": _pem_block(),
    }
    filenames = {"github": "creds.txt", "entropy": "settings.txt",
                 "appended": "appended.txt", "pem": "key.pem"}
    try:
        destination.mkdir(parents=True, exist_ok=True)
        os.chmod(destination, 0o700)
    except OSError as exc:
        raise GateFailure("scratch setup failed") from exc
    result: dict[str, Path] = {}
    for control_id in CONTROL_IDS:
        control_dir = destination / control_id
        target = control_dir / filenames[control_id]
        try:
            control_dir.mkdir(mode=0o700, exist_ok=False)
            os.chmod(control_dir, 0o700)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, plants[control_id].encode("utf-8"))
            finally:
                os.close(fd)
        except OSError as exc:
            raise GateFailure("plant write failed") from exc
        result[control_id] = control_dir
    return result


def summarize_findings(report: Path) -> list[tuple[str, int]]:
    """Count findings per sanitized rule id, sorted by count then rule.

    Raises GateFailure on missing/malformed reports. Never returns paths,
    matches or secret bytes.
    """
    try:
        raw = report.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise GateFailure("report unreadable") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GateFailure("report malformed") from exc
    if not isinstance(data, list):
        raise GateFailure("report wrong type")
    counts: dict[str, int] = {}
    for entry in data:
        if not isinstance(entry, dict):
            raise GateFailure("report entry wrong type")
        rule = entry.get("RuleID")
        if not isinstance(rule, str):
            raise GateFailure("report RuleID wrong type")
        clean = rule if _RULE_RE.fullmatch(rule) else UNKNOWN_RULE
        counts[clean] = counts.get(clean, 0) + 1
    return sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))


def _print_counts(findings: list[tuple[str, int]]) -> None:
    for rule, count in findings[:MAX_SUMMARY_ROWS]:
        print(str(count) + " " + rule)


def _run_scanner(argv: list[str], report: Path) -> int:
    """Run the scanner privately; stale reports never survive a call."""
    try:
        report.unlink(missing_ok=True)
    except OSError as exc:
        raise GateFailure("report cleanup failed") from exc
    try:
        proc = subprocess.run(
            argv, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=SCAN_TIMEOUT, check=False)
    except subprocess.TimeoutExpired as exc:
        raise GateFailure("scanner timeout") from exc
    except OSError as exc:
        raise GateFailure("scanner launch failed") from exc
    return proc.returncode


def _require_tool(gitleaks: Path) -> None:
    if not gitleaks.is_absolute():
        raise GateFailure("tool path not absolute")
    if not gitleaks.is_file():
        raise GateFailure("tool not a file")
    if not os.access(gitleaks, os.X_OK):
        raise GateFailure("tool not executable")


def _git(repo: Path, *args: str) -> str:
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), *args],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=GIT_TIMEOUT,
            check=False, text=True)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GateFailure("git probe failed") from exc
    if proc.returncode != 0:
        raise GateFailure("git probe rejected")
    return proc.stdout.strip()


def _require_history_ready(repo: Path) -> None:
    if not _git(repo, "rev-parse", "--show-toplevel"):
        raise GateFailure("not a git repository")
    if _git(repo, "rev-parse", "--is-shallow-repository") != "false":
        raise GateFailure("shallow history")
    if not _git(repo, "rev-parse", "HEAD"):
        raise GateFailure("empty history")


def run_history(gitleaks: Path, repo: Path, scratch: Path) -> None:
    """Reject unless the full history scans clean with the given tool."""
    _require_tool(gitleaks)
    _require_history_ready(repo)
    config = scratch / "gitleaks-history.toml"
    report = scratch / "history.json"
    write_default_config(config)
    status = _run_scanner(
        [str(gitleaks), "detect", "--source", str(repo),
         "--config", str(config), "--redact", "--no-banner",
         "--exit-code", str(FINDING_EXIT_HISTORY),
         "--report-format", "json", "--report-path", str(report)],
        report)
    findings = summarize_findings(report)
    if findings:
        _print_counts(findings)
    if status == 0 and not findings:
        print("history: clean")
        return
    raise GateFailure("history rejected")


def run_controls(gitleaks: Path, repo: Path, scratch: Path) -> None:
    """Reject unless every runtime plant is independently detected."""
    _require_tool(gitleaks)
    context = repo / ".github" / "workflows" / "secrets.yml"
    if context.is_symlink():
        raise GateFailure("context is a symlink")
    generated = generate_controls(scratch / "controls", context)
    if set(generated) != set(CONTROL_IDS):
        raise GateFailure("control set mismatch")
    config = scratch / "gitleaks-controls.toml"
    write_default_config(config)
    failures = 0
    for control_id in CONTROL_IDS:
        report = scratch / ("control-" + control_id + ".json")
        try:
            status = _run_scanner(
                [str(gitleaks), "detect", "--no-git",
                 "--source", str(generated[control_id]),
                 "--config", str(config), "--redact", "--no-banner",
                 "--exit-code", str(FINDING_EXIT_CONTROL),
                 "--report-format", "json", "--report-path", str(report)],
                report)
            total = sum(count for _, count in summarize_findings(report))
        except GateFailure:
            status, total = -1, 0
        if status == FINDING_EXIT_CONTROL and total >= 1:
            print("control " + control_id + ": detected ("
                  + str(total) + " finding(s))")
        else:
            print("control " + control_id + ": NOT detected")
            failures += 1
    if failures:
        raise GateFailure("controls rejected")
    print("controls: clean")


def _parse(items: list[str]) -> tuple[str, Path, Path]:
    if len(items) != 6:
        raise GateFailure("arity")
    _, command, first_flag, first_value, second_flag, second_value = items
    if command not in ("history", "controls", "gate"):
        raise GateFailure("command")
    options = {first_flag: first_value, second_flag: second_value}
    if set(options) != {"--gitleaks", "--repo"}:
        raise GateFailure("options")
    gitleaks = Path(options["--gitleaks"])
    repo = Path(options["--repo"])
    if not gitleaks.is_absolute() or (not repo.is_absolute() and repo != Path(".")):
        raise GateFailure("relative path")
    return command, gitleaks, repo.resolve()


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point: 0 clean, 1 rejected, 2 malformed invocation."""
    items = list(sys.argv if argv is None else argv)
    if len(items) == 2 and items[1] in ("-h", "--help"):
        print(USAGE)
        return EXIT_OK
    try:
        command, gitleaks, repo = _parse(items)
    except GateFailure:
        print(USAGE, file=sys.stderr)
        return EXIT_USAGE
    try:
        scratch = Path(tempfile.mkdtemp(prefix="mv-secrets-"))
    except OSError:
        print(command + ": internal error")
        return EXIT_REJECT
    try:
        os.chmod(scratch, 0o700)
        if command == "history":
            run_history(gitleaks, repo, scratch)
        elif command == "controls":
            run_controls(gitleaks, repo, scratch)
        else:
            history_failed = False
            try:
                run_history(gitleaks, repo, scratch)
            except GateFailure:
                history_failed = True
            controls_failed = False
            try:
                run_controls(gitleaks, repo, scratch)
            except GateFailure:
                controls_failed = True
            if history_failed or controls_failed:
                raise GateFailure("gate rejected")
            print("gate: clean")
    except GateFailure:
        print(command + ": rejected")
        return EXIT_REJECT
    except Exception:
        # Fail closed without repr: tracebacks may carry paths or values.
        print(command + ": internal error")
        return EXIT_REJECT
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

