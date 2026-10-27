"""Documentation fenced-shell python3 command verification tests (U-R4).

Extracts `python3 <path>` invocations from fenced shell blocks in repository
markdown documentation, verifies that every referenced script exists and responds
to `--help` (or its per-tool allowlisted probe where `--help` exits non-zero by
design), and proves negative controls on bogus paths and unprefixed kit paths.
"""
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FENCE_OPEN_RE = re.compile(r"^ {0,3}(```+|~~~+)\s*(sh|bash|shell)\b", re.IGNORECASE)
PYTHON_CMD_RE = re.compile(
    r"(?:^|[;&|]\s*)\bpython3(?:\s+-[BIuE]+)*\s+([^\s;&|\"'`]+)"
)

# Per-tool allowlist where `--help` does not exit 0 because the CLI catches
# argparse SystemExit (rc=2 with usage on stdout) or uses a custom flag parser.
HELP_ALLOWLIST = {
    "tools/router_index.py": (2, "Router error: unknown option"),
    "router/kit/tools/build_index_v2.py": (2, "usage:"),
    "router/kit/tools/route_v2.py": (2, "usage:"),
    "router/kit/tools/make_pool_v2.py": (2, "usage:"),
    "router/kit/tools/tune_v2.py": (2, "usage:"),
    "router/kit/tools/eval_v2.py": (2, "usage:"),
    "router/kit/tools/gates_v2.py": (2, "usage:"),
    "router/kit/v1_frozen/build_index.py": (2, "usage:"),
}


def extract_fenced_sh_python_paths(markdown_text):
    """Return (lineno, script_rel_path) for python3 <script.py> in sh fences."""
    found = []
    fence = None
    for lineno, line in enumerate(markdown_text.splitlines(), 1):
        stripped = line.lstrip(" ")
        indent = len(line) - len(stripped)
        if fence is None:
            match = FENCE_OPEN_RE.match(line)
            if match:
                marker = match.group(1)
                fence = (marker[0], len(marker))
            continue
        char, size = fence
        token = stripped.split()[0] if stripped.split() else ""
        if (indent < 4 and token and set(token) == {char} and len(token) >= size
                and re.fullmatch(r"[%s\s]+" % re.escape(char), stripped)):
            fence = None
            continue
        if stripped.startswith("#"):
            continue
        for match in PYTHON_CMD_RE.finditer(stripped):
            candidate = match.group(1)
            if candidate.startswith(("-", "$", "<")):
                continue
            if candidate.endswith(".py"):
                found.append((lineno, candidate))
    return found


def verify_doc_python_paths(markdown_text, *, doc_name="<fixture>", search_roots=(REPO_ROOT,)):
    """Verify every extracted python3 script path resolves under search_roots."""
    extracted = extract_fenced_sh_python_paths(markdown_text)
    resolved = []
    missing = []
    for lineno, rel in extracted:
        if rel.startswith("/") or ".." in rel.split("/"):
            missing.append("%s:%d: non-canonical path %s" % (doc_name, lineno, rel))
            continue
        target = None
        for base in search_roots:
            cand = base / rel
            if cand.is_file() and not cand.is_symlink():
                target = cand
                break
        if target is None:
            missing.append("%s:%d: missing script %s" % (doc_name, lineno, rel))
        else:
            resolved.append((lineno, rel, target))
    if missing:
        raise AssertionError("; ".join(missing))
    return resolved


def verify_script_help(root, script_path):
    """Run `python3 <script_path> --help` and check rc / allowlisted output."""
    rel = script_path.resolve().relative_to(root.resolve()).as_posix()
    proc = subprocess.run(
        [sys.executable, "-B", str(script_path), "--help"],
        cwd=root, capture_output=True, text=True, timeout=30, check=False,
    )
    combined = (proc.stdout or "") + (proc.stderr or "")
    if rel in HELP_ALLOWLIST:
        expected_rc, expected_token = HELP_ALLOWLIST[rel]
        if proc.returncode != expected_rc or expected_token.lower() not in combined.lower():
            raise AssertionError(
                "%s --help: expected rc=%d with %r, got rc=%d output=%r"
                % (rel, expected_rc, expected_token, proc.returncode, combined[:200])
            )
        return
    if proc.returncode != 0:
        raise AssertionError(
            "%s --help: expected rc=0, got rc=%d output=%r"
            % (rel, proc.returncode, combined[:200])
        )


class RouterDocCommandTests(unittest.TestCase):
    def test_doc_python3_paths_exist(self):
        # Root entry and general docs must resolve strictly against REPO_ROOT.
        strict_docs = ("README.md", "AGENTS.md", "llms.txt", "docs/TESTING.md",
                       "docs/USER_GUIDE.md", "docs/COMMIT_LAWS.md", "docs/ARCHITECTURE.md")
        all_resolved = []
        for rel in strict_docs:
            path = REPO_ROOT / rel
            if path.is_file():
                all_resolved.extend(
                    verify_doc_python_paths(
                        path.read_text(encoding="utf-8"),
                        doc_name=rel,
                        search_roots=(REPO_ROOT,),
                    )
                )
        self.assertGreater(len(all_resolved), 0)
        # ROUTER_BOOTSTRAP.md fenced sh blocks resolve when kit-relative paths
        # are mapped to router/kit/ (or when prefixed with router/kit/ in a repaired copy).
        bootstrap_text = (REPO_ROOT / "docs" / "ROUTER_BOOTSTRAP.md").read_text(encoding="utf-8")
        bootstrap_resolved = verify_doc_python_paths(
            bootstrap_text,
            doc_name="docs/ROUTER_BOOTSTRAP.md",
            search_roots=(REPO_ROOT, REPO_ROOT / "router" / "kit"),
        )
        self.assertGreaterEqual(len(bootstrap_resolved), 8)
        repaired_text = re.sub(
            r"\bpython3 (tools/|v1_frozen/)",
            r"python3 router/kit/\1",
            bootstrap_text,
        )
        repaired_resolved = verify_doc_python_paths(
            repaired_text,
            doc_name="docs/ROUTER_BOOTSTRAP.md(repaired)",
            search_roots=(REPO_ROOT,),
        )
        self.assertEqual(len(repaired_resolved), len(bootstrap_resolved))

    def test_each_help_rc_and_negative_control(self):
        bootstrap_text = (REPO_ROOT / "docs" / "ROUTER_BOOTSTRAP.md").read_text(encoding="utf-8")
        resolved = verify_doc_python_paths(
            bootstrap_text,
            doc_name="docs/ROUTER_BOOTSTRAP.md",
            search_roots=(REPO_ROOT, REPO_ROOT / "router" / "kit"),
        )
        unique_targets = sorted({target for _line, _rel, target in resolved} | {
            REPO_ROOT / "tools" / "router_index.py",
            REPO_ROOT / "tools" / "check_laws.py",
            REPO_ROOT / "tools" / "check_contracts.py",
        })
        self.assertGreaterEqual(len(unique_targets), 10)
        for target in unique_targets:
            with self.subTest(script=target.relative_to(REPO_ROOT).as_posix()):
                verify_script_help(REPO_ROOT, target)
        # Negative control: a script that exits non-zero on --help without allowlist fails.
        with tempfile.TemporaryDirectory(prefix="mv-doc-help-neg-") as tmp:
            root = Path(tmp)
            bad_script = root / "bad_tool.py"
            bad_script.write_text("import sys\nsys.exit(7)\n", encoding="utf-8")
            with self.assertRaises(AssertionError) as ctx:
                verify_script_help(root, bad_script)
            self.assertIn("bad_tool.py", str(ctx.exception))

    def test_bogus_path_fixture_fails(self):
        bogus_md = (
            "# Bogus doc\n\n"
            "```sh\n"
            "python3 tools/check_laws.py --version\n"
            "python3 tools/bogus_nonexistent_script.py --help\n"
            "```\n"
        )
        with self.assertRaises(AssertionError) as ctx:
            verify_doc_python_paths(bogus_md, doc_name="fixture.md", search_roots=(REPO_ROOT,))
        self.assertIn("tools/bogus_nonexistent_script.py", str(ctx.exception))
        # Also verify strict root-only check catches unprefixed kit paths (S3 reproduction).
        unprefixed_md = "```sh\npython3 tools/route_v2.py --q test --index catalogue/router\n```\n"
        with self.assertRaises(AssertionError) as ctx2:
            verify_doc_python_paths(unprefixed_md, doc_name="s3.md", search_roots=(REPO_ROOT,))
        self.assertIn("tools/route_v2.py", str(ctx2.exception))


if __name__ == "__main__":
    unittest.main()
