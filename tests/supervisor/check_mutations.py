"""Reject permissive reaper mutations without ever sending a host signal."""
import pathlib
import subprocess
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "core/src/supervisor/reaper.py"
TESTS = ROOT / "core/src/supervisor/reaper_tests.py"
MUTATIONS = (
    ("integer-type", "type(pid) is int", "True"),
    ("pid-floor", "1 < pid", "0 <= pid"),
    ("pid-ceiling", "pid <= 2147483647", "pid <= 2147483648"),
    ("ownership", "and owned", "and True"),
    ("own-pid", "and pid != os.getpid()", "and True"),
    ("own-group", "and pid != os.getpgrp()", "and True"),
    ("send-guard", "if not signalable(pid, pid in self.owned):", "if False:"),
    ("signal-permission", "except ProcessLookupError:", "except OSError:"),
    ("retained-proc-permission", "except (FileNotFoundError, ProcessLookupError):  # retained identity",
     "except (FileNotFoundError, ProcessLookupError, PermissionError):  # retained identity"),
    ("candidate-proc-permission", "except (FileNotFoundError, ProcessLookupError):  # candidate identity",
     "except (FileNotFoundError, ProcessLookupError, PermissionError):  # candidate identity"),
    ("parent-proc-permission", "except (FileNotFoundError, ProcessLookupError):  # parent traversal",
     "except (FileNotFoundError, ProcessLookupError, PermissionError):  # parent traversal"),
    ("capacity-failure", "self.failed = True", "self.failed = False"),
    ("reap-evidence", "print(pid, flush=True)", "pass"),
)


def run(directory):
    return subprocess.run(
        [sys.executable, "-I", "-S", "-B", str(directory / "reaper_tests.py")],
        capture_output=True, text=True, timeout=20, check=False,
    )


def apply_mutation(source, name, before, after):
    if source.count(before) != 1:
        raise RuntimeError(f"mutation anchor must be unique: {name} (count={source.count(before)})")
    return source.replace(before, after, 1)


def main():
    source = SOURCE.read_text(encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="supervisor-mutations-") as temporary:
        directory = pathlib.Path(temporary)
        (directory / "reaper_tests.py").write_bytes(TESTS.read_bytes())
        candidate = directory / "reaper.py"
        candidate.write_text(source, encoding="utf-8")
        baseline = run(directory)
        if baseline.returncode != 0:
            sys.stderr.write(baseline.stdout + baseline.stderr)
            raise RuntimeError("unmodified reaper failed")
        for name, before, after in MUTATIONS:
            changed = apply_mutation(source, name, before, after)
            compile(changed, name, "exec")
            candidate.write_text(changed, encoding="utf-8")
            result = run(directory)
            if result.returncode != 1 or "FAILED (failures=" not in result.stderr:
                sys.stderr.write(result.stdout + result.stderr)
                raise RuntimeError(f"mutation was not rejected by assertions: {name}")
            print(f"REJECTED {name}", flush=True)
    print(f"PASS: {len(MUTATIONS)} mutation controls rejected", flush=True)


if __name__ == "__main__":
    main()
