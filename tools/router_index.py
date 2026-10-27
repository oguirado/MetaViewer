#!/usr/bin/env python3
"""Repository router coverage compiler (W0-ROUTER-INDEX).

Build mode compiles one ctx.node.v2 record per tracked source file into
catalogue/nodes.jsonl. Check mode (--check) rebuilds the same bytes in
memory and fails when the committed artifact is stale, when a tracked
source is missing or unrouted, when a routed document links to a missing
path, when the published mount or its SHA evidence disagrees with the
nodes, or when the kit builder leg cannot run deterministically.

Source universe: the git tracked manifest (git ls-files -z --cached),
minus the generated set below. No filesystem recursion and no untracked
discovery. Node identities are deterministic per path, collision-checked,
and never clipped: semantic-first with a digest-anchored fallback so the
32-byte composite width law holds for every path.

Generated set (hashed node coverage would be circular for these):
  catalogue/nodes.jsonl  proven reachable by the check-mode byte compare
  catalogue/routes.tsv   proven reachable by the check-mode byte compare
  router/index/**        derived builder output, proven by the check leg
  catalogue/router/**    derived builder output, proven by the check leg
Only these paths are excluded; every other tracked path needs a node.

Stdlib only. Importing this module performs no I/O and starts no process.
"""
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import unquote

CORPUS = "metaviewer"
SCHEMA_NAME = "ctx.node.v2"
MAX_COMPOSITE = 32
GIT_TIMEOUT_S = 60.0
KIT_TIMEOUT_S = 60.0
KIT_BUILDER = Path("router/kit/tools/build_index_v2.py")
KIT_SCHEMA = Path("router/kit/standards/schemas/ctx.node.v2.schema.json")
KIT_THESAURUS = Path("router/kit/standards/thesaurus.json")
KIT_VALIDATOR = Path("router/kit/tools/jsonschema_lite.py")
NODES_REL = "catalogue/nodes.jsonl"
ROUTES_REL = "catalogue/routes.tsv"
PROTOCOL_REL = "catalogue/protocol.json"
LLMS_REL = "llms.txt"
MOUNT_PATH = "catalogue/router"
MOUNT_DOCS_DIR = "catalogue/router/docs"
INDEX_SHA_REL = "router/index/SHA256SUMS"
GENERATED_EXACT = frozenset({NODES_REL, ROUTES_REL})
GENERATED_PREFIXES = ("router/index/", "catalogue/router/")
PROHIBITED_BASENAMES = frozenset({"operator.token", "launch.token", "auth.json", ".env"})
ID_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9._:-]{0,31}")
CORPUS_PATTERN = re.compile(r"[a-z][a-z0-9_]{0,15}")
SCHEME_PATTERN = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*):")
EXTERNAL_SCHEMES = frozenset({
    "http", "https", "ftp", "ftps", "mailto", "tel", "file",
    "data", "irc", "git", "ssh", "gopher", "ws", "wss",
})
MD_SUFFIXES = (".md", ".markdown")
DEF_RE = re.compile(r" {0,3}\[([^\]\n]+)\]:\s*(?:<([^<>\n]+)>|(\S+))")
HTML_RE = re.compile(
    r"<(a|img)\b[^<>]*?(href|src)\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s<>]+))",
    re.IGNORECASE,
)

Validator = Callable[[object, object], list]


class RouterError(ValueError):
    """Fail-closed router failure; message already carries its prefix."""


@dataclass(frozen=True)
class Material:
    nodes_jsonl: bytes
    routes_tsv: bytes
    source_paths: tuple


def _short(exc):
    return str(exc)[:160]


def _check_canonical(rel):
    bad = (
        not rel or rel.startswith("/") or "\\" in rel or rel in (".", "..")
        or rel.startswith("./") or rel.endswith("/")
        or any(ord(char) < 0x20 or ord(char) == 0x7f for char in rel)
    )
    if not bad:
        bad = any(part in ("", ".", "..") for part in rel.split("/"))
    if bad:
        raise RouterError("Router error: non-canonical manifest path %r" % rel[:160])


def tracked_paths(root):
    """Return the sorted git tracked manifest for root (UTF-8, canonical)."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--cached"],
            capture_output=True, timeout=GIT_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired as exc:
        raise RouterError("Router error: git manifest timed out") from exc
    except OSError as exc:
        raise RouterError("Router error: git manifest failed: %s" % _short(exc)) from exc
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace")[:200]
        raise RouterError(
            "Router error: git manifest failed rc=%d: %s" % (proc.returncode, detail))
    paths = []
    for chunk in proc.stdout.split(b"\0"):
        if not chunk:
            continue
        try:
            rel = chunk.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RouterError("Router error: non-UTF-8 manifest entry") from exc
        _check_canonical(rel)
        paths.append(rel)
    if len(set(paths)) != len(paths):
        raise RouterError("Router error: duplicate manifest entry")
    paths.sort(key=lambda item: item.encode("utf-8"))
    if not paths:
        raise RouterError("Router error: empty source universe")
    return tuple(paths)


def _safe_read(root, rel):
    """Read a manifest path after inspecting it and every ancestor."""
    _check_canonical(rel)
    base = rel.rsplit("/", 1)[-1]
    if base in PROHIBITED_BASENAMES or base.endswith(".key"):
        raise RouterError("Router error: prohibited path %s" % rel)
    node = root
    fstat = None
    for part in rel.split("/"):
        node = node / part
        try:
            fstat = os.lstat(node)
        except OSError as exc:
            raise RouterError("Stale or incomplete router: missing source %s" % rel) from exc
        if stat.S_ISLNK(fstat.st_mode):
            raise RouterError("Router error: symlink refused %s" % rel)
    if fstat is None or not stat.S_ISREG(fstat.st_mode):
        raise RouterError("Router error: not a regular file %s" % rel)
    try:
        return node.read_bytes()
    except OSError as exc:
        raise RouterError("Stale or incomplete router: missing source %s" % rel) from exc


def _is_generated(rel):
    return rel in GENERATED_EXACT or rel.startswith(GENERATED_PREFIXES)


def _sanitize_id_part(part):
    return re.sub(r"[^A-Za-z0-9._:-]", "-", part) or "-"


def _ascii_alpha(char):
    return "A" <= char <= "Z" or "a" <= char <= "z"


def _derive_ids(paths, corpus):
    """Derive one deterministic collision-checked id per path.

    Semantic-first: the shortest trailing-segment form that fits the width
    law and is still unused wins. Paths that cannot fit semantically fall
    back to a stem-anchored digest suffix. Collisions and overflows refuse
    instead of clipping.
    """
    if CORPUS_PATTERN.fullmatch(corpus) is None:
        raise RouterError("Router error: bad corpus %r" % corpus[:64])
    max_id = MAX_COMPOSITE - len(corpus.encode("utf-8")) - 1
    assigned = {}
    used = set()
    for rel in sorted(paths, key=lambda item: item.encode("utf-8")):
        parts = [_sanitize_id_part(part) for part in rel.split("/")]
        ident = None
        for size in range(1, len(parts) + 1):
            cand = "-".join(parts[-size:])
            if not _ascii_alpha(cand[0]):
                cand = "f" + cand
            if (len(cand.encode("utf-8")) <= max_id
                    and ID_PATTERN.fullmatch(cand) is not None and cand not in used):
                ident = cand
                break
        if ident is None:
            leaf = parts[-1]
            stem = leaf.rsplit(".", 1)[0] if "." in leaf else leaf
            stem = re.sub(r"[^A-Za-z0-9]", "", stem)
            if not stem or not _ascii_alpha(stem[0]):
                stem = "f" + stem
            digest = hashlib.sha256(rel.encode("utf-8")).hexdigest()[:12]
            ident = "%s-%s" % (stem[:7], digest)
            if (len(ident.encode("utf-8")) > max_id or ident in used
                    or ID_PATTERN.fullmatch(ident) is None):
                raise RouterError("Router error: node id collision for %s" % rel)
        assigned[rel] = ident
        used.add(ident)
    return assigned


_GENERIC_STEMS = frozenset({"mod", "lib", "main", "__init__", "index"})
_SINGULAR_MAP = {
    "workflows": "workflow",
    "frames": "frame",
    "subscriptions": "subscription",
    "capsules": "capsule",
    "contracts": "contract",
    "schemas": "schema",
    "standards": "standard",
    "tools": "tool",
    "agents": "agent",
    "docs": "doc",
}
_STOPWORDS = frozenset({
    "the", "and", "for", "with", "from", "that", "this", "into", "over", "under",
    "when", "where", "which", "while", "must", "only", "every", "each", "file",
    "files", "routed", "repository", "src", "internal", "pkg", "cmd", "lib", "mod",
    "true", "false", "none", "null", "self", "super", "crate", "pub", "use", "let",
    "mut", "const", "static", "return", "async", "await", "def", "class", "function",
    "export", "import", "var", "type", "struct", "enum", "trait", "impl", "func",
    "package", "interface", "string", "int", "bool", "usize", "u64", "u32", "u8",
    "i64", "i32", "f64", "str", "vec", "option", "result", "err", "new", "default",
})
_TEST_TOKENS = frozenset({
    "test", "tests", "testing", "e2e", "spec", "specs",
    "fixture", "fixtures", "testdata", "mock", "mocks", "stub", "stubs",
})
_TEST_CODE_TOKEN_RE = re.compile(r"(?:t|ac|u|w)\d+[a-z0-9]*")
_SYM_PATTERNS = {
    "py": (
        re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", re.M),
        re.compile(r"^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b", re.M),
    ),
    "rs": (
        re.compile(
            r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?"
            r"fn\s+([A-Za-z_][A-Za-z0-9_]*)\b",
            re.M,
        ),
        re.compile(
            r"^\s*(?:pub(?:\([^)]*\))?\s+)?"
            r"(?:struct|enum|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)\b",
            re.M,
        ),
        re.compile(
            r"^\s*(?:pub(?:\([^)]*\))?\s+)?"
            r"const\s+([A-Za-z_][A-Za-z0-9_]*)\s*:",
            re.M,
        ),
    ),
    "go": (
        re.compile(
            r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(",
            re.M,
        ),
        re.compile(r"^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\b", re.M),
    ),
    "js": (
        re.compile(
            r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?"
            r"function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(",
            re.M,
        ),
        re.compile(
            r"^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b",
            re.M,
        ),
        re.compile(
            r"^\s*export\s+(?:const|let|var|type|interface)\s+"
            r"([A-Za-z_$][A-Za-z0-9_$]*)\b",
            re.M,
        ),
    ),
}
for _ext in ("mjs", "cjs", "ts", "tsx", "jsx"):
    _SYM_PATTERNS[_ext] = _SYM_PATTERNS["js"]


def _ident_tokens(text):
    out = []
    for raw_tok in re.findall(r"[A-Za-z0-9]+", text):
        parts = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", raw_tok).lower().split()
        for tok in parts:
            if len(tok) >= 2 and tok not in _STOPWORDS and tok not in out:
                out.append(tok)
        low = raw_tok.lower()
        if len(low) >= 2 and low not in _STOPWORDS and low not in out:
            out.append(low)
    return out


def _is_test_token(tok):
    low = tok.lower()
    return low in _TEST_TOKENS or _TEST_CODE_TOKEN_RE.fullmatch(low) is not None


def _is_test_path(rel):
    parts = rel.lower().split("/")
    base = parts[-1]
    for seg in parts[:-1]:
        if seg in ("test", "tests", "__tests__", "testdata", "fixtures", "examples", "e2e"):
            return True
    if ".invalid." in base:
        return True
    if base.startswith(("test_", "tests.")):
        return True
    if base.endswith(("_test.go", "_test.py", "_tests.py", "_test.rs", "_tests.rs")):
        return True
    if base.endswith((
        ".test.js", ".test.mjs", ".test.cjs", ".test.ts",
        ".spec.js", ".spec.mjs", ".spec.cjs", ".spec.ts",
    )):
        return True
    return False


_RUST_CFG_TEST_RE = re.compile(r"#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]")
_RUST_RAW_STR_RE = re.compile(r'b?r(#*)"')
_RUST_CHAR_LIT_RE = re.compile(r"b?'(?:\\.|[^'\\\n])'")


def _skip_rust_comment_or_literal(text, i):
    n = len(text)
    if text.startswith("//", i):
        nl = text.find("\n", i + 2)
        return n if nl == -1 else nl + 1
    if text.startswith("/*", i):
        depth = 1
        j = i + 2
        while j < n and depth > 0:
            if text.startswith("/*", j):
                depth += 1
                j += 2
            elif text.startswith("*/", j):
                depth -= 1
                j += 2
            else:
                j += 1
        return j
    if text[i] in ("b", "r", '"'):
        prev_ok = (i == 0) or not (text[i - 1].isalnum() or text[i - 1] == "_")
        if prev_ok:
            m = _RUST_RAW_STR_RE.match(text, i)
            if m is not None:
                closing = '"' + m.group(1)
                end = text.find(closing, m.end())
                return n if end == -1 else end + len(closing)
            if text.startswith('b"', i) or text[i] == '"':
                j = i + (2 if text.startswith('b"', i) else 1)
                while j < n:
                    if text[j] == "\\":
                        j += 2
                    elif text[j] == '"':
                        return j + 1
                    else:
                        j += 1
                return n
    if text[i] == "'" or (
        text.startswith("b'", i) and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_"))
    ):
        m = _RUST_CHAR_LIT_RE.match(text, i)
        if m is not None:
            return m.end()
    return i


def _strip_rust_cfg_test(text):
    out = []
    i = 0
    n = len(text)
    while i < n:
        nxt = _skip_rust_comment_or_literal(text, i)
        if nxt > i:
            out.append(text[i:nxt])
            i = nxt
            continue
        if text[i] == "#":
            m = _RUST_CFG_TEST_RE.match(text, i)
            if m is not None:
                j = m.end()
                brace = bracket = paren = angle = 0
                in_body_brace = False
                semi_only = None
                while j < n:
                    nxt = _skip_rust_comment_or_literal(text, j)
                    if nxt > j:
                        j = nxt
                        continue
                    ch = text[j]
                    if brace == 0 and bracket == 0 and paren == 0 and angle == 0 and semi_only is None:
                        if ch.isalpha() or ch == "_":
                            ident_m = re.match(r"[A-Za-z_][A-Za-z0-9_]*", text[j:])
                            if ident_m:
                                kw = ident_m.group(0)
                                if kw in ("use", "static", "type"):
                                    semi_only = True
                                elif kw == "const":
                                    if re.match(
                                        r"^const\s+(?:unsafe\s+)?(?:extern\s+(?:\"[^\"]*\"\s+)?)?fn\b",
                                        text[j:],
                                    ):
                                        semi_only = False
                                    else:
                                        semi_only = True
                                elif kw in ("mod", "fn", "struct", "enum", "union", "trait", "impl"):
                                    semi_only = False
                                j += len(kw)
                                continue
                        elif ch == "=":
                            semi_only = True
                    if brace == 0 and bracket == 0 and paren == 0 and not in_body_brace:
                        if text.startswith(("->", "=>", "<<", ">>", "<=", ">="), j):
                            j += 2
                            continue
                        if ch == "<":
                            angle += 1
                            j += 1
                            continue
                        if ch == ">":
                            angle = max(0, angle - 1)
                            j += 1
                            continue
                    if ch == "[":
                        bracket += 1
                    elif ch == "]":
                        bracket = max(0, bracket - 1)
                    elif ch == "(":
                        paren += 1
                    elif ch == ")":
                        paren = max(0, paren - 1)
                    elif ch == "{":
                        if brace == 0 and bracket == 0 and paren == 0 and angle == 0 and not semi_only:
                            in_body_brace = True
                        brace += 1
                    elif ch == "}":
                        brace = max(0, brace - 1)
                        if in_body_brace and brace == 0:
                            j += 1
                            break
                    elif ch == ";" and brace == 0 and bracket == 0 and paren == 0 and angle == 0 and not in_body_brace:
                        j += 1
                        break
                    j += 1
                i = j
                continue
        out.append(text[i])
        i += 1
    return "".join(out)


def _extract_symbols_and_docs(rel, suffix, raw):
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return [], []
    ext = suffix.lower()
    scan_text = _strip_rust_cfg_test(text) if ext == "rs" else text
    syms = []
    for pat in _SYM_PATTERNS.get(ext, ()):
        for match in pat.finditer(scan_text):
            name = match.group(1)
            if name in ("main", "new", "default", "fmt", "drop", "from", "into", "init"):
                continue
            if len(name) < 3 or (name.startswith("_") and not name.startswith("__")):
                continue
            if name not in syms:
                syms.append(name)
    doc_lines = []
    lines = scan_text.splitlines()[:80]
    if ext in ("md", "markdown", "txt"):
        for line in lines[:40]:
            s = line.strip()
            if s.startswith("#") or (len(doc_lines) < 4 and s and not s.startswith("```")):
                doc_lines.append(s)
    elif ext == "py":
        in_doc = False
        for line in lines[:35]:
            s = line.strip()
            if not in_doc and (s.startswith('"""') or s.startswith("'''")):
                doc_lines.append(s.strip("\"'"))
                if s.count('"""') == 1 and s.count("'''") == 0:
                    in_doc = True
                elif s.count("'''") == 1 and s.count('"""') == 0:
                    in_doc = True
            elif in_doc:
                doc_lines.append(s.strip("\"'"))
                if '"""' in s or "'''" in s:
                    break
            elif s.startswith("#") and not s.startswith("#!"):
                doc_lines.append(s.lstrip("# "))
    elif ext in ("rs", "go", "js", "mjs", "cjs", "ts"):
        for line in lines[:40]:
            s = line.strip()
            if s.startswith(("!", "//", "/*", "*")):
                doc_lines.append(s.lstrip("!/ *"))
            elif s and not s.startswith(("#", "package ", "import ", "use ", "mod ")):
                break
    elif ext in ("yml", "yaml", "sh", "toml"):
        for line in lines[:25]:
            s = line.strip()
            if s.startswith("#") and not s.startswith("#!"):
                doc_lines.append(s.lstrip("# "))
            elif ext in ("yml", "yaml") and s.startswith("name:"):
                doc_lines.append(s[5:].strip())
    elif ext == "json" and rel.endswith(".schema.json"):
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                for key in ("title", "description", "$id"):
                    val = obj.get(key)
                    if isinstance(val, str):
                        doc_lines.append(val)
        except ValueError:
            pass
    doc_tokens = _ident_tokens(" ".join(doc_lines))
    return syms, doc_tokens


def _build_search(rel, name, stem, trigger, suffix, raw):
    is_test = _is_test_path(rel)
    parts = [p for p in rel.split("/") if p]
    dir_parts = parts[:-1]
    if is_test:
        test_trigs = []
        test_kws = ["test"]
        neg_terms = []
        for tok in _ident_tokens(rel):
            if _is_test_token(tok):
                if tok not in test_trigs and len(test_trigs) < 12:
                    test_trigs.append(tok[:64])
                if tok not in test_kws and len(test_kws) < 24:
                    test_kws.append(tok[:64])
            elif tok not in neg_terms:
                neg_terms.append(tok[:64])
        if not test_trigs:
            test_trigs.append("test")
        if suffix and suffix not in test_kws and len(test_kws) < 24:
            test_kws.append(suffix[:64])
        search = {"triggers": test_trigs[:12], "keywords": test_kws[:24]}
        if neg_terms:
            exclusions = list(dict.fromkeys(t for t in neg_terms if t))[:12]
            if exclusions:
                search["exclusions"] = exclusions
        return search

    triggers = []
    keywords = []
    problem_names = []
    tasks = []
    questions = []

    def add_trig(val):
        val = val.strip()[:64]
        if val and val not in triggers and len(triggers) < 12:
            triggers.append(val)

    def add_kw(val):
        val = val.strip()[:64]
        if val and val not in keywords and len(keywords) < 24:
            keywords.append(val)

    def add_prob(val):
        val = val.strip()[:64]
        if val and val not in problem_names and len(problem_names) < 5:
            problem_names.append(val)

    def add_task(val):
        val = val.strip()[:200]
        if val and val not in tasks and len(tasks) < 8:
            tasks.append(val)

    def add_q(val):
        val = val.strip()[:200]
        if val and val not in questions and len(questions) < 12:
            questions.append(val)

    is_mod_entry = stem.lower() in _GENERIC_STEMS
    if not is_mod_entry:
        add_trig(trigger)
        if name != trigger:
            add_trig(name)
        for tok in _ident_tokens(stem):
            add_trig(tok)
            add_kw(tok)
            add_prob(tok)
    for seg in reversed(dir_parts):
        for tok in _ident_tokens(seg):
            add_trig(tok)
            add_kw(tok)
            add_prob(tok)
            sing = _SINGULAR_MAP.get(tok)
            if sing:
                add_trig(sing)
                add_kw(sing)
                add_prob(sing)
    if is_mod_entry:
        add_trig(trigger)

    if suffix:
        add_kw(suffix)
        if suffix == "md":
            add_kw("guide")
            add_kw("documentation")
        elif suffix in ("yml", "yaml"):
            add_kw("workflow")
            add_kw("ci")
    else:
        add_kw("file")

    if rel.endswith(".schema.json"):
        base_schema = name[:-len(".schema.json")]
        add_trig(base_schema)
        add_trig(base_schema + " schema")
        add_prob(base_schema + " schema")
        add_kw("schema")

    syms, doc_toks = _extract_symbols_and_docs(rel, suffix, raw)
    is_submod_entry = stem.lower() in ("mod", "__init__", "index")
    is_overview_doc = stem.lower() in ("readme", "lib", "main")
    if is_submod_entry:
        for sym in syms:
            for stok in _ident_tokens(sym):
                add_trig(stok)
                add_kw(stok)
                add_prob(stok)
        for dtok in doc_toks[:64]:
            add_trig(dtok)
            add_kw(dtok)
            add_prob(dtok)
    elif not is_overview_doc and suffix.lower() in ("md", "markdown", "yml", "yaml", "json"):
        for dtok in doc_toks[:8]:
            add_trig(dtok)
            add_kw(dtok)
            add_prob(dtok)
    for sym in syms:
        add_trig(sym)
        add_kw(sym)
        add_prob(sym)
        for stok in _ident_tokens(sym):
            add_kw(stok)
    for dtok in doc_toks[:24]:
        add_kw(dtok)
        if not is_overview_doc:
            add_prob(dtok)

    concept_words = []
    for seg in dir_parts:
        for tok in _ident_tokens(seg):
            if tok not in concept_words:
                concept_words.append(tok)
            sing = _SINGULAR_MAP.get(tok)
            if sing and sing not in concept_words:
                concept_words.append(sing)
    if not is_mod_entry:
        for tok in _ident_tokens(stem):
            if tok not in concept_words:
                concept_words.append(tok)
    if not is_overview_doc:
        for sym in syms[:12]:
            for stok in _ident_tokens(sym):
                if stok not in concept_words:
                    concept_words.append(stok)
        for dtok in doc_toks[:128]:
            if dtok not in concept_words:
                concept_words.append(dtok)
    if concept_words:
        phrase = " ".join(concept_words[:24])
        add_task(phrase)
        add_q(phrase)
    if syms:
        sym_cur = []
        for sym in syms[:64]:
            cand = " ".join(sym_cur + [sym])
            if sym_cur and len(cand) > 200:
                add_task(" ".join(sym_cur))
                add_q(" ".join(sym_cur))
                sym_cur = [sym]
            else:
                sym_cur.append(sym)
        if sym_cur:
            add_task(" ".join(sym_cur))
            add_q(" ".join(sym_cur))
    rem_cur = []
    for word in concept_words[24:192]:
        cand = " ".join(rem_cur + [word])
        if rem_cur and len(cand) > 200:
            add_task(" ".join(rem_cur))
            add_q(" ".join(rem_cur))
            rem_cur = [word]
        else:
            rem_cur.append(word)
    if rem_cur:
        add_task(" ".join(rem_cur))
        add_q(" ".join(rem_cur))

    if not triggers:
        triggers.append(trigger)
    if not keywords:
        keywords.append(suffix or "file")

    search = {"triggers": triggers[:12], "keywords": keywords[:24]}
    if problem_names:
        search["problem_names"] = problem_names[:5]
    if tasks:
        search["tasks"] = tasks[:8]
    if questions:
        search["questions"] = questions[:12]
    return search


def compile_material(root, paths, *, corpus, ids, schema, validate):
    """Compile validated canonical nodes plus the in-memory lookup."""
    if CORPUS_PATTERN.fullmatch(corpus) is None:
        raise RouterError("Router error: bad corpus %r" % corpus[:64])
    if set(ids) != set(paths):
        raise RouterError("Router error: id map keys must equal source paths exactly")
    if len(set(ids.values())) != len(ids):
        raise RouterError("Router error: duplicate node id")
    ordered = sorted(paths, key=lambda item: item.encode("utf-8"))
    if not ordered:
        raise RouterError("Router error: empty source universe")
    lines = []
    routes = ["id\tpath\n"]
    for rel in ordered:
        _check_canonical(rel)
        ident = ids[rel]
        if not isinstance(ident, str) or ID_PATTERN.fullmatch(ident) is None:
            raise RouterError("Router error: bad node id for %s" % rel)
        width = len(corpus.encode("utf-8")) + 1 + len(ident.encode("utf-8"))
        if width > MAX_COMPOSITE:
            raise RouterError("Router error: id width overflow for %s" % rel)
        raw = _safe_read(root, rel)
        digest = hashlib.sha256(raw).hexdigest()
        name = rel.rsplit("/", 1)[-1]
        if not 1 <= len(name) <= 240:
            raise RouterError("Router error: bad title length for %s" % rel)
        purpose = "Routed repository file %s" % rel
        if len(purpose) > 600:
            raise RouterError("Router error: purpose overflow for %s" % rel)
        stem = name.rsplit(".", 1)[0] if "." in name else name
        trigger = (stem or name)[:64]
        if not trigger:
            raise RouterError("Router error: empty trigger for %s" % rel)
        suffix = name.rsplit(".", 1)[1] if "." in name else ""
        search = _build_search(rel, name, stem, trigger, suffix, raw)
        node = {
            "schema": SCHEMA_NAME,
            "id": ident,
            "corpus": corpus,
            "kind": "asset",
            "title": name,
            "purpose": purpose,
            "anchors": [{"a": "file", "role": "section"}],
            "search": search,
            "status": "active",
            "source_sha256": digest,
        }
        errors = validate(node, schema)
        if not isinstance(errors, list):
            raise RouterError("Router error: validator contract violated for %s" % rel)
        if errors:
            raise RouterError(
                "Router error: invalid node for %s: %s" % (rel, str(errors[0])[:160]))
        lines.append(json.dumps(node, sort_keys=True, separators=(",", ":"),
                                ensure_ascii=False).encode("utf-8") + b"\n")
        routes.append("%s\t%s\n" % (ident, rel))
    return Material(nodes_jsonl=b"".join(lines),
                    routes_tsv="".join(routes).encode("utf-8"),
                    source_paths=tuple(ordered))


def _strip_inline_code(line):
    out = []
    pos, size = 0, len(line)
    while pos < size:
        if line[pos] != "`":
            out.append(line[pos])
            pos += 1
            continue
        end = pos
        while end < size and line[end] == "`":
            end += 1
        run = line[pos:end]
        closer = line.find(run, end)
        if closer == -1:
            out.append(line[pos:])
            break
        out.append(" " * (closer + len(run) - pos))
        pos = closer + len(run)
    return "".join(out)


def _strip_md_code(text):
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    out = []
    fence = None
    for line in text.split("\n"):
        stripped = line.lstrip(" ")
        indent = len(line) - len(stripped)
        if fence is None:
            opener = re.match(r"(```+|~~~+)", stripped)
            if opener and indent < 4:
                fence = (opener.group(1)[0], len(opener.group(1)))
                out.append("")
                continue
            out.append(_strip_inline_code(line))
            continue
        char, size = fence
        body = stripped.split()[0] if stripped.split() else ""
        if (indent < 4 and body and set(body) == {char} and len(body) >= size
                and re.fullmatch(r"[%s\s]+" % re.escape(char), stripped)):
            fence = None
        out.append("")
    return "\n".join(out)


def _collect_defs(text):
    defs = {}
    for line in text.split("\n"):
        mark = DEF_RE.match(line)
        if mark:
            label = mark.group(1).strip().lower()
            dest = mark.group(2) if mark.group(2) is not None else mark.group(3)
            if label and label not in defs:
                defs[label] = dest
    return defs


def _iter_inline_dests(line):
    """Yield (kind, label, payload) for bracket links outside code spans."""
    pos, size = 0, len(line)
    while pos < size:
        opener = line.find("[", pos)
        if opener == -1:
            return
        pair = line.find("](", opener)
        if pair != -1:
            depth, cur = 1, pair + 2
            while cur < size and depth:
                if line[cur] == "(":
                    depth += 1
                elif line[cur] == ")":
                    depth -= 1
                cur += 1
            if depth == 0:
                yield ("paren", line[opener + 1:pair], line[pair + 2:cur - 1])
                pos = cur
                continue
            pos = pair + 2
            continue
        closer = line.find("]", opener + 1)
        if closer == -1:
            return
        if closer + 1 < size and line[closer + 1] == "[":
            end = line.find("]", closer + 2)
            if end != -1:
                yield ("ref", line[opener + 1:closer], line[closer + 2:end])
                pos = end + 1
                continue
        yield ("lone", line[opener + 1:closer], None)
        pos = closer + 1


def _paren_dest(content):
    text = content.strip()
    if not text:
        return None
    if text.startswith("<"):
        end = text.find(">")
        if end == -1:
            return None
        return text[1:end].strip() or None
    return text.split()[0]


def _resolve_local(root, rel, dest):
    parts = [] if dest.startswith("/") else rel.split("/")[:-1]
    parts = list(parts)
    for part in dest.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                return None
            parts.pop()
            continue
        parts.append(part)
    target = root
    for part in parts:
        target = target / part
    return target


def _check_dest(root, rel, lineno, dest):
    where = "%s:%d" % (rel, lineno)
    text = dest.strip()
    if not text:
        raise RouterError(
            "Stale or incomplete router: broken doc link %s: empty destination" % where)
    if text.startswith("#"):
        return
    path_text = unquote(text.split("#", 1)[0].split("?", 1)[0])
    if not path_text:
        return
    scheme = SCHEME_PATTERN.match(path_text)
    if scheme:
        name = scheme.group(1).lower()
        if name in EXTERNAL_SCHEMES or path_text[scheme.end():].startswith("//"):
            return
        raise RouterError(
            "Stale or incomplete router: broken doc link %s: ambiguous destination %r"
            % (where, dest[:96]))
    target = _resolve_local(root, rel, path_text)
    if target is None:
        raise RouterError(
            "Stale or incomplete router: broken doc link %s: escaping %r" % (where, dest[:96]))
    if target.is_dir() or target.is_file():
        return
    raise RouterError(
        "Stale or incomplete router: broken doc link %s: missing %r" % (where, dest[:96]))


def check_doc_links(root, paths):
    """Refuse when a routed document links to a missing local path."""
    for rel in sorted(paths, key=lambda item: item.encode("utf-8")):
        if not rel.lower().endswith(MD_SUFFIXES):
            continue
        try:
            text = _safe_read(root, rel).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RouterError("Router error: non-UTF-8 document %s" % rel) from exc
        stripped = _strip_md_code(text)
        defs = _collect_defs(stripped)
        for lineno, line in enumerate(stripped.split("\n"), 1):
            for kind, label, payload in _iter_inline_dests(line):
                if kind == "paren":
                    dest = _paren_dest(payload)
                    if dest is None:
                        raise RouterError(
                            "Stale or incomplete router: broken doc link %s:%d: "
                            "empty destination" % (rel, lineno))
                    _check_dest(root, rel, lineno, dest)
                elif kind == "ref":
                    ref = (payload or label).strip().lower()
                    if ref not in defs:
                        raise RouterError(
                            "Stale or incomplete router: broken doc link %s:%d: "
                            "undefined reference %r" % (rel, lineno, (payload or label)[:64]))
                    _check_dest(root, rel, lineno, defs[ref])
                elif label.strip().lower() in defs:
                    _check_dest(root, rel, lineno, defs[label.strip().lower()])
            for mark in HTML_RE.finditer(line):
                dest = mark.group(4)
                if dest is None:
                    dest = mark.group(5) if mark.group(5) is not None else mark.group(6)
                _check_dest(root, rel, lineno, dest)


def check_nodes(path, expected):
    """Byte-compare the committed artifact; never writes."""
    display = path.as_posix()
    try:
        actual = path.read_bytes()
    except OSError as exc:
        raise RouterError("Stale or incomplete router: %s" % display) from exc
    if actual != expected:
        raise RouterError("Stale or incomplete router: %s" % display)


def _coverage_diagnostic(path, material):
    try:
        disk = path.read_bytes()
    except OSError:
        return " (committed artifact missing)"
    try:
        rows = [json.loads(line) for line in disk.decode("utf-8").split("\n") if line.strip()]
        disk_digests = {row["source_sha256"] for row in rows}
    except (ValueError, KeyError, AttributeError, TypeError):
        return " (committed artifact unparsable)"
    fresh = {json.loads(line)["source_sha256"]
             for line in material.nodes_jsonl.decode("utf-8").split("\n") if line.strip()}
    return " (coverage mismatch: %d sources vs %d committed nodes; %d digests differ)" % (
        len(material.source_paths), len(rows), len(fresh ^ disk_digests))


def _read_kit_file(path, rel):
    try:
        fstat = os.lstat(path)
    except OSError as exc:
        raise RouterError("Router error: missing kit input %s" % rel) from exc
    if stat.S_ISLNK(fstat.st_mode) or not stat.S_ISREG(fstat.st_mode):
        raise RouterError("Router error: invalid kit input %s" % rel)
    try:
        return path.read_bytes()
    except OSError as exc:
        raise RouterError("Router error: missing kit input %s" % rel) from exc


def _load_validator(path):
    rel = KIT_VALIDATOR.as_posix()
    _read_kit_file(path, rel)
    spec = importlib.util.spec_from_file_location("mv_router_jsonschema_lite", path)
    if spec is None or spec.loader is None:
        raise RouterError("Router error: missing kit input %s" % rel)
    try:
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        validate = mod.validate
    except (OSError, ValueError, AttributeError, ImportError, SyntaxError) as exc:
        raise RouterError("Router error: invalid kit input %s" % rel) from exc
    if not callable(validate):
        raise RouterError("Router error: invalid kit input %s" % rel)
    return validate


def verify_kit(root, material, *, corpus, timeout_s):
    """Prove the kit builder accepts the material and rebuilds identically.

    All builder outputs stay under a scratch directory that is removed on
    return; the repository tree is never touched here.
    """
    builder = root / KIT_BUILDER
    thesaurus = root / KIT_THESAURUS
    _read_kit_file(builder, KIT_BUILDER.as_posix())
    _read_kit_file(root / KIT_SCHEMA, KIT_SCHEMA.as_posix())
    _read_kit_file(thesaurus, KIT_THESAURUS.as_posix())
    with tempfile.TemporaryDirectory(prefix="mv-router-kit-") as tmp:
        nodes = Path(tmp) / "nodes.jsonl"
        out = Path(tmp) / "index"
        nodes.write_bytes(material.nodes_jsonl)
        base = [sys.executable, str(builder), "--nodes", str(nodes),
                "--out", str(out), "--thesaurus", str(thesaurus), "--corpus", corpus]
        for argv in (base, base + ["--check"]):
            try:
                subprocess.run(argv, check=True, timeout=timeout_s,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            except subprocess.TimeoutExpired as exc:
                raise RouterError("Router error: kit builder timeout") from exc
            except subprocess.CalledProcessError as exc:
                detail = (exc.stderr or b"").decode("utf-8", "replace")[-200:]
                raise RouterError(
                    "Router error: kit builder failed rc=%d: %s" % (exc.returncode, detail)
                ) from exc
            except OSError as exc:
                raise RouterError("Router error: kit builder failed: %s" % _short(exc)) from exc


def _check_regular_target(root, rel, label, raw_value):
    try:
        _check_canonical(rel)
    except RouterError as exc:
        raise RouterError("Router error: dangling %s %r" % (label, str(raw_value)[:96])) from exc
    node = root
    fstat = None
    for part in rel.split("/"):
        node = node / part
        try:
            fstat = os.lstat(node)
        except OSError as exc:
            raise RouterError("Router error: dangling %s %r" % (label, str(raw_value)[:96])) from exc
        if stat.S_ISLNK(fstat.st_mode):
            raise RouterError("Router error: dangling %s %r" % (label, str(raw_value)[:96]))
    if fstat is None or not stat.S_ISREG(fstat.st_mode):
        raise RouterError("Router error: dangling %s %r" % (label, str(raw_value)[:96]))
    try:
        node.read_bytes()
    except OSError as exc:
        raise RouterError("Router error: dangling %s %r" % (label, str(raw_value)[:96])) from exc


def _is_router_unavailable(root):
    llms = root / LLMS_REL
    try:
        if not llms.is_file() or llms.is_symlink():
            return False
        text = llms.read_bytes().decode("utf-8", "replace")
    except OSError:
        return False
    return "Status: router unavailable." in text


def _is_untracked_mirror_routes(root, manifest):
    return (
        ROUTES_REL not in manifest
        and not (root / ROUTES_REL).exists()
        and (root / "router/index/bootstrap_logs.json").is_file()
        and (root / ".git").is_dir()
        and not (root / ".git/logs").exists()
    )


def _check_corpus_agreement(root, *, check_targets=False, allow_uncalibrated_params=False,
                            allow_untracked_mirror_routes=False):
    path = root / PROTOCOL_REL
    if not os.path.lexists(path):
        return
    try:
        fstat = os.lstat(path)
    except OSError as exc:
        raise RouterError("Router error: unreadable %s" % PROTOCOL_REL) from exc
    if stat.S_ISLNK(fstat.st_mode) or not stat.S_ISREG(fstat.st_mode):
        raise RouterError("Router error: unreadable %s" % PROTOCOL_REL)
    try:
        obj = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as exc:
        raise RouterError("Router error: unreadable %s" % PROTOCOL_REL) from exc
    if not isinstance(obj, dict):
        raise RouterError("Router error: invalid protocol: not an object")
    mounts = obj.get("mounts")
    if not isinstance(mounts, list):
        raise RouterError("Router error: invalid protocol: mounts is not a list")
    if len(mounts) != 1:
        raise RouterError("Router error: protocol must declare exactly one mount, found %d"
                          % len(mounts))
    mount = mounts[0]
    if not isinstance(mount, dict):
        raise RouterError("Router error: invalid protocol: mount is not an object")
    if mount.get("corpus") != CORPUS:
        raise RouterError("Router error: corpus mismatch: protocol %r != %r"
                          % (str(mount.get("corpus"))[:64], CORPUS))
    if mount.get("path") != MOUNT_PATH:
        raise RouterError("Router error: protocol mount path %r != %r"
                          % (str(mount.get("path"))[:64], MOUNT_PATH))
    if not check_targets or "router" not in obj:
        return
    router = obj.get("router")
    if not isinstance(router, dict):
        raise RouterError("Router error: invalid protocol: router is not an object")
    if "path_rule" in router or "params" in router:
        path_rule = router.get("path_rule")
        if not isinstance(path_rule, str) or not path_rule.startswith("lookup:"):
            raise RouterError("Router error: dangling path_rule %r" % str(path_rule)[:96])
        lookup_rel = path_rule[len("lookup:"):]
        if not (allow_untracked_mirror_routes and lookup_rel == ROUTES_REL):
            _check_regular_target(root, lookup_rel, "path_rule", path_rule)
        params_rel = router.get("params")
        if not isinstance(params_rel, str) or not params_rel:
            raise RouterError("Router error: dangling params %r" % str(params_rel)[:96])
        try:
            _check_canonical(params_rel)
        except RouterError as exc:
            raise RouterError("Router error: dangling params %r" % str(params_rel)[:96]) from exc
        if allow_uncalibrated_params and params_rel == "catalogue/router/params.json" and not os.path.lexists(root / params_rel):
            return
        _check_regular_target(root, params_rel, "params", params_rel)


def _read_routes_lookup(root, material):
    routes_path = root / ROUTES_REL
    if routes_path.is_file() and not routes_path.is_symlink():
        try:
            raw = routes_path.read_bytes().decode("utf-8")
        except (OSError, ValueError) as exc:
            raise RouterError("Stale or incomplete router: unreadable %s" % ROUTES_REL) from exc
    else:
        raw = material.routes_tsv.decode("utf-8")
    lines = [line for line in raw.split("\n") if line]
    if not lines or lines[0] != "id\tpath":
        raise RouterError("Stale or incomplete router: unparsable %s header" % ROUTES_REL)
    lookup = {}
    valid_paths = set(material.source_paths)
    for lineno, line in enumerate(lines[1:], 2):
        parts = line.split("\t")
        if len(parts) != 2 or not parts[0] or not parts[1]:
            raise RouterError("Stale or incomplete router: unparsable %s line %d"
                              % (ROUTES_REL, lineno))
        ident, rel = parts
        _check_canonical(rel)
        if ident in lookup:
            raise RouterError("Stale or incomplete router: duplicate id in %s" % ROUTES_REL)
        if rel not in valid_paths:
            raise RouterError("Stale or incomplete router: unknown path in %s: %s"
                              % (ROUTES_REL, rel))
        lookup[ident] = rel
    return lookup


def _read_id_set(path, display):
    try:
        raw = path.read_bytes().decode("utf-8")
    except (OSError, ValueError) as exc:
        raise RouterError("Stale or incomplete router: unreadable %s" % display) from exc
    ids = set()
    for lineno, line in enumerate(raw.split("\n"), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError as exc:
            raise RouterError("Stale or incomplete router: unparsable %s line %d"
                              % (display, lineno)) from exc
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            raise RouterError("Stale or incomplete router: unparsable %s line %d"
                              % (display, lineno))
        if row["id"] in ids:
            raise RouterError("Stale or incomplete router: duplicate id in %s" % display)
        ids.add(row["id"])
    return ids


def check_mount_freshness(root, material):
    """Fail when the published mount or its SHA evidence disagrees.

    Published protocol trees require complete mount and hash evidence.
    Bare compiler fixtures without a protocol or mount have nothing published.
    """
    docs_dir = root / MOUNT_DOCS_DIR
    sha_path = root / INDEX_SHA_REL
    if not any((root / rel).exists() for rel in (PROTOCOL_REL, MOUNT_PATH, INDEX_SHA_REL)):
        return
    try:
        shards = sorted(path for path in docs_dir.iterdir()
                        if path.is_file() and path.suffix == ".jsonl")
    except OSError as exc:
        raise RouterError("Stale or incomplete router: missing mount docs") from exc
    if not shards or not sha_path.is_file():
        raise RouterError("Stale or incomplete router: missing mount or SHA256SUMS")
    try:
        sha_text = sha_path.read_bytes().decode("utf-8")
    except (OSError, ValueError) as exc:
        raise RouterError("Stale or incomplete router: unreadable %s" % INDEX_SHA_REL) from exc
    covered = set()
    for lineno, line in enumerate(sha_text.split("\n"), 1):
        if not line.strip():
            continue
        digest, sep, rel = line.partition("  ")
        if (not sep or len(digest) != 64
                or any(char not in "0123456789abcdef" for char in digest)):
            raise RouterError("Stale or incomplete router: unparsable %s line %d"
                              % (INDEX_SHA_REL, lineno))
        _check_canonical(rel)
        if rel in covered:
            raise RouterError("Stale or incomplete router: duplicate SHA256SUMS entry")
        covered.add(rel)
        try:
            actual = hashlib.sha256((root / rel).read_bytes()).hexdigest()
        except OSError as exc:
            raise RouterError("Stale or incomplete router: SHA256SUMS mismatch for %s" % rel) from exc
        if actual != digest:
            raise RouterError("Stale or incomplete router: SHA256SUMS mismatch for %s" % rel)
    required = {NODES_REL} | {p.relative_to(root).as_posix()
                                 for p in (root / MOUNT_PATH).rglob("*") if p.is_file()}
    if not required <= covered:
        raise RouterError("Stale or incomplete router: incomplete SHA256SUMS")
    want = set()
    for line in material.nodes_jsonl.decode("utf-8").split("\n"):
        if line.strip():
            want.add(json.loads(line)["id"])
    got = set()
    for shard in shards:
        ids = _read_id_set(shard, "%s/%s" % (MOUNT_DOCS_DIR, shard.name))
        if got & ids:
            raise RouterError("Stale or incomplete router: duplicate mount ids")
        got |= ids
    if got != want:
        raise RouterError("Stale or incomplete router: mount ids != nodes ids "
                          "(%d mount vs %d nodes)" % (len(got), len(want)))
    lookup = _read_routes_lookup(root, material)
    unresolved = sorted(got - set(lookup))
    if unresolved:
        raise RouterError("Stale or incomplete router: mount id unresolved in %s: %s"
                          % (ROUTES_REL, unresolved[0]))


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    check = False
    for arg in args:
        if arg == "--check":
            check = True
        else:
            print("Router error: unknown option %r" % arg[:64], file=sys.stderr)
            return 2
    root = Path(__file__).resolve().parent.parent
    try:
        _check_corpus_agreement(root)
        try:
            schema = json.loads(_read_kit_file(root / KIT_SCHEMA, KIT_SCHEMA.as_posix()))
        except ValueError as exc:
            raise RouterError(
                "Router error: invalid kit input %s" % KIT_SCHEMA.as_posix()) from exc
        validate = _load_validator(root / KIT_VALIDATOR)
        manifest = tracked_paths(root)
        sources = tuple(path for path in manifest if not _is_generated(path))
        if not sources:
            raise RouterError("Router error: empty source universe")
        ids = _derive_ids(sources, CORPUS)
        material = compile_material(root, sources, corpus=CORPUS, ids=ids,
                                    schema=schema, validate=validate)
        nodes_path = root / NODES_REL
        routes_path = root / ROUTES_REL
        verify_kit(root, material, corpus=CORPUS, timeout_s=KIT_TIMEOUT_S)
        if check:
            untracked_mirror_routes = _is_untracked_mirror_routes(root, manifest)
            _check_corpus_agreement(
                root, check_targets=True,
                allow_uncalibrated_params=_is_router_unavailable(root),
                allow_untracked_mirror_routes=untracked_mirror_routes)
            try:
                check_nodes(nodes_path, material.nodes_jsonl)
            except RouterError as exc:
                raise RouterError(
                    str(exc) + _coverage_diagnostic(nodes_path, material)) from exc
            if not untracked_mirror_routes:
                check_nodes(routes_path, material.routes_tsv)
            check_mount_freshness(root, material)
            check_doc_links(root, sources)
        else:
            nodes_path.parent.mkdir(parents=True, exist_ok=True)
            nodes_path.write_bytes(material.nodes_jsonl)
            routes_path.write_bytes(material.routes_tsv)
        print("METAVIEWER_ROUTER_COVERAGE 100%% %d files" % len(material.source_paths))
        return 0
    except RouterError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

