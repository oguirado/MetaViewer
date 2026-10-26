"""Router coverage gate tests (W0-ROUTER-INDEX).

Every fixture lives under a TemporaryDirectory created by the test. The
script under test is copied into the scratch tree, git is replaced by a
stub on PATH, and the router kit is replaced by pinned fixture bytes, so
no test reads or mutates the live repository.
"""
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_SRC = Path(__file__).resolve().parent.parent / "tools" / "router_index.py"

# Pinned fixture bytes (verbatim copies of the kit contract files; the
# placeholders are replaced by exact file bytes before the suite runs).
SCHEMA_JSON = '{"$id":"ctx.node.v2","$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,"properties":{"anchors":{"items":{"additionalProperties":false,"properties":{"a":{"maxLength":64,"minLength":1,"type":"string"},"intent":{"enum":["find_method","find_structure","find_bound","find_prerequisite","check_claim","find_limit"]},"role":{"enum":["section","statement","symbol","asset","scene"]}},"required":["a","role"],"type":"object"},"maxItems":16,"minItems":1,"type":"array"},"corpus":{"pattern":"^[a-z][a-z0-9_]{0,15}$","type":"string"},"domains":{"items":{"additionalProperties":false,"properties":{"domain":{"maxLength":40,"type":"string"},"strength":{"enum":["strong","moderate","weak"]}},"required":["domain","strength"],"type":"object"},"maxItems":11,"type":"array"},"family":{"maxLength":32,"type":"string"},"id":{"pattern":"^[A-Za-z][A-Za-z0-9._:-]{0,31}$","type":"string"},"kind":{"enum":["paper","section","symbol","asset","scene","hyperbook"]},"purpose":{"maxLength":600,"minLength":1,"type":"string"},"schema":{"const":"ctx.node.v2"},"search":{"additionalProperties":false,"properties":{"exclusions":{"items":{"maxLength":200,"type":"string"},"maxItems":12,"type":"array"},"keywords":{"items":{"maxLength":64,"type":"string"},"maxItems":24,"type":"array"},"problem_names":{"items":{"maxLength":64,"type":"string"},"maxItems":5,"type":"array"},"questions":{"items":{"maxLength":200,"type":"string"},"maxItems":12,"type":"array"},"tasks":{"items":{"maxLength":200,"type":"string"},"maxItems":8,"type":"array"},"triggers":{"items":{"maxLength":64,"type":"string"},"maxItems":12,"type":"array"}},"required":["triggers","keywords"],"type":"object"},"source_sha256":{"pattern":"^[0-9a-f]{64}$","type":"string"},"status":{"enum":["active","sealed","deprecated","withdrawn"]},"superseded_by":{"maxLength":32,"type":"string"},"title":{"maxLength":240,"minLength":1,"type":"string"}},"required":["schema","id","corpus","kind","title","purpose","anchors","search","status","source_sha256"],"type":"object"}\n'
VALIDATOR_PY = '#!/usr/bin/env python3\n"""Stdlib JSON-Schema subset validator (draft 2020-12 keywords used by the v2 contracts)."""\nimport json, re\n\n\ndef _type_ok(v, t):\n    if t == "null":\n        return v is None\n    if t == "boolean":\n        return isinstance(v, bool)\n    if t == "integer":\n        return isinstance(v, int) and not isinstance(v, bool)\n    if t == "number":\n        return isinstance(v, (int, float)) and not isinstance(v, bool)\n    if t == "string":\n        return isinstance(v, str)\n    if t == "array":\n        return isinstance(v, list)\n    if t == "object":\n        return isinstance(v, dict)\n    return False\n\n\ndef validate(v, s, path="$"):\n    """Return a list of error strings (empty = valid)."""\n    e = []\n    if "const" in s and not (v == s["const"] and type(v) == type(s["const"])):\n        e.append("%s: const" % path)\n    if "enum" in s and not any(v == x and type(v) == type(x) for x in s["enum"]):\n        e.append("%s: enum" % path)\n    if "type" in s:\n        ts = s["type"] if isinstance(s["type"], list) else [s["type"]]\n        if not any(_type_ok(v, t) for t in ts):\n            return e + ["%s: type %s" % (path, ts)]\n    if isinstance(v, str):\n        if "minLength" in s and len(v) < s["minLength"]:\n            e.append("%s: minLength" % path)\n        if "maxLength" in s and len(v) > s["maxLength"]:\n            e.append("%s: maxLength" % path)\n        if "pattern" in s and not re.search(s["pattern"], v):\n            e.append("%s: pattern" % path)\n    if isinstance(v, (int, float)) and not isinstance(v, bool):\n        if "minimum" in s and v < s["minimum"]:\n            e.append("%s: minimum" % path)\n        if "maximum" in s and v > s["maximum"]:\n            e.append("%s: maximum" % path)\n    if isinstance(v, list):\n        if "minItems" in s and len(v) < s["minItems"]:\n            e.append("%s: minItems" % path)\n        if "maxItems" in s and len(v) > s["maxItems"]:\n            e.append("%s: maxItems" % path)\n        if s.get("uniqueItems") and len({json.dumps(x, sort_keys=True) for x in v}) != len(v):\n            e.append("%s: uniqueItems" % path)\n        pi = s.get("prefixItems", [])\n        for i, x in enumerate(v):\n            if i < len(pi):\n                e += validate(x, pi[i], "%s[%d]" % (path, i))\n            elif s.get("items") is False:\n                e.append("%s[%d]: items false" % (path, i))\n            elif isinstance(s.get("items"), dict):\n                e += validate(x, s["items"], "%s[%d]" % (path, i))\n    if isinstance(v, dict):\n        for r in s.get("required", []):\n            if r not in v:\n                e.append("%s: required %s" % (path, r))\n        props = s.get("properties", {})\n        for k, x in v.items():\n            if k in props:\n                e += validate(x, props[k], "%s.%s" % (path, k))\n            elif s.get("additionalProperties") is False:\n                e.append("%s: additional %s" % (path, k))\n            elif isinstance(s.get("additionalProperties"), dict):\n                e += validate(x, s["additionalProperties"], "%s.%s" % (path, k))\n    return e\n'

THESAURUS_JSON = '{"entries": []}\n'

BUILDER_STUB = r'''#!/usr/bin/env python3
"""Fixture stand-in for the kit index builder CLI contract."""
import argparse
import json
import os
import shutil
import sys
import time

if os.environ.get("MV_BUILDER_MODE") == "sleep":
    time.sleep(5)
if os.environ.get("MV_BUILDER_MODE") == "fail":
    print("fixture builder refused", file=sys.stderr)
    sys.exit(3)

ap = argparse.ArgumentParser()
ap.add_argument("--root")
ap.add_argument("--out", required=True)
ap.add_argument("--thesaurus", default="standards/thesaurus.json")
ap.add_argument("--nodes")
ap.add_argument("--corpus", default="math")
ap.add_argument("--cap", type=int, default=1000000)
ap.add_argument("--check", action="store_true")
try:
    a = ap.parse_args()
except SystemExit:
    sys.exit(2)

record = os.environ.get("MV_BUILDER_RECORD")
if record:
    with open(record, "a", encoding="utf-8") as fh:
        fh.write(" ".join(sys.argv[1:]) + "\n")

if not a.nodes and not (a.root and os.path.isfile(os.path.join(a.root, "catalogue", "routes.tsv"))):
    print("input missing", file=sys.stderr)
    sys.exit(3)


class BuildError(ValueError):
    pass


def build(out):
    try:
        with open(a.thesaurus, "r", encoding="utf-8") as fh:
            json.load(fh)
        with open(a.nodes, "r", encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
    except (OSError, ValueError) as exc:
        raise BuildError("bad input: %s" % exc)
    ids = sorted(r["id"] for r in rows)
    if len(ids) != len(set(ids)):
        raise BuildError("duplicate id")
    if len(ids) > a.cap:
        raise BuildError("over cap")
    os.makedirs(out, exist_ok=True)
    payload = json.dumps({"corpus": a.corpus, "ids": ids}, sort_keys=True, separators=(",", ":"))
    with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as fh:
        fh.write(payload + "\n")
    return out


def tree(root):
    out = {}
    for base, _dirs, files in os.walk(root):
        for name in files:
            full = os.path.join(base, name)
            with open(full, "rb") as fh:
                out[os.path.relpath(full, root)] = fh.read()
    return out


try:
    if a.check:
        chk = a.out.rstrip("/") + ".chk"
        build(chk)
        try:
            ok = os.path.isdir(a.out) and tree(chk) == tree(a.out)
        finally:
            shutil.rmtree(chk, ignore_errors=True)
        print("byte-identical" if ok else "MISMATCH")
        sys.exit(0 if ok else 5)
    print(build(a.out))
except BuildError as exc:
    print(exc, file=sys.stderr)
    sys.exit(3)
'''

FAKE_GIT = r'''#!/usr/bin/env python3
"""Fixture git replacing ls-files with a canned manifest."""
import os
import sys

if len(sys.argv) != 6 or sys.argv[1] != "-C" or sys.argv[3:6] != ["ls-files", "-z", "--cached"]:
    sys.exit(128)
record = os.environ.get("MV_FAKEGIT_RECORD")
if record:
    with open(record, "w", encoding="utf-8") as fh:
        fh.write("\n".join(sys.argv))
mode = os.environ.get("MV_FAKEGIT", "ok")
if mode == "fail":
    sys.exit(128)
if mode == "empty":
    sys.exit(0)
with open(os.environ["MV_FAKEGIT_MANIFEST"], "rb") as fh:
    sys.stdout.buffer.write(fh.read())
'''

# Contract-first fixture data: one schema-positive node plus single-fault
# mutants. Written before the producer per the architecture contract rule.
VALID_NODE = {
    "schema": "ctx.node.v2",
    "id": "readme",
    "corpus": "metaviewer",
    "kind": "asset",
    "title": "README.md",
    "purpose": "Routed repository file README.md",
    "anchors": [{"a": "file", "role": "section"}],
    "search": {"triggers": ["README"], "keywords": ["md"]},
    "status": "active",
    "source_sha256": "0" * 64,
}

REQUIRED_KEYS = {
    "schema", "id", "corpus", "kind", "title", "purpose",
    "anchors", "search", "status", "source_sha256",
}


def _mutant(**overrides):
    node = json.loads(json.dumps(VALID_NODE))
    node.update(overrides)
    return node


class RouterIndexTests(unittest.TestCase):
    maxDiff = 4000

    def setUp(self):
        self.harness = tempfile.mkdtemp(prefix="mv-router-harness-")
        self.addCleanup(shutil.rmtree, self.harness, True)

    # -- scratch-tree builders -------------------------------------------
    def _write_file(self, root, rel, content):
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, str):
            content = content.encode("utf-8")
        path.write_bytes(content)
        return path

    def _write_kit(self, root, *, schema=SCHEMA_JSON, validator=VALIDATOR_PY,
                   builder=BUILDER_STUB, thesaurus=THESAURUS_JSON,
                   drop=()):
        if "schema" not in drop:
            self._write_file(root, "router/kit/standards/schemas/ctx.node.v2.schema.json", schema)
        if "validator" not in drop:
            self._write_file(root, "router/kit/tools/jsonschema_lite.py", validator)
        if "builder" not in drop:
            self._write_file(root, "router/kit/tools/build_index_v2.py", builder)
        if "thesaurus" not in drop:
            self._write_file(root, "router/kit/standards/thesaurus.json", thesaurus)

    def _set_manifest(self, root, entries):
        data = b"".join(e.encode("utf-8") + b"\0" for e in entries)
        (root / "bin" / "manifest.bin").write_bytes(data)

    def _set_manifest_bytes(self, root, data):
        (root / "bin" / "manifest.bin").write_bytes(data)

    def _tree(self, files, *, manifest=None, kit=True, drop=()):
        root = Path(tempfile.mkdtemp(prefix="mv-router-"))
        self.addCleanup(shutil.rmtree, root, True)
        (root / "tools").mkdir(parents=True)
        (root / "bin").mkdir()
        shutil.copy(SCRIPT_SRC, root / "tools" / "router_index.py")
        git = self._write_file(root, "bin/git", FAKE_GIT)
        git.chmod(0o755)
        for rel, content in files.items():
            self._write_file(root, rel, content)
        if kit:
            self._write_kit(root, drop=drop)
        if manifest is None:
            manifest = sorted(
                p.relative_to(root).as_posix()
                for p in root.rglob("*")
                if p.is_file() and not p.is_symlink() and p.parts[len(root.parts)] != "bin"
            )
        self._set_manifest(root, manifest)
        env = {
            "MV_FAKEGIT": "ok",
            "MV_FAKEGIT_MANIFEST": str(root / "bin" / "manifest.bin"),
        }
        return root, env

    def _run_cli(self, root, *args, extra_env=None):
        env = dict(os.environ)
        env["PATH"] = str(root / "bin") + os.pathsep + env.get("PATH", "")
        env.update(extra_env or {})
        return subprocess.run(
            [sys.executable, "-B", "tools/router_index.py", *args],
            cwd=root, capture_output=True, text=True, timeout=120, env=env,
        )

    def _load_mod(self, root):
        spec = importlib.util.spec_from_file_location(
            "mv_router_under_test", root / "tools" / "router_index.py")
        mod = importlib.util.module_from_spec(spec)
        old, sys.dont_write_bytecode = sys.dont_write_bytecode, True
        try:
            spec.loader.exec_module(mod)
        finally:
            sys.dont_write_bytecode = old
        return mod

    def _load_validate(self, root):
        spec = importlib.util.spec_from_file_location(
            "mv_fixture_validate", root / "router" / "kit" / "tools" / "jsonschema_lite.py")
        mod = importlib.util.module_from_spec(spec)
        old, sys.dont_write_bytecode = sys.dont_write_bytecode, True
        try:
            spec.loader.exec_module(mod)
        finally:
            sys.dont_write_bytecode = old
        return mod.validate

    def _snapshot(self, root):
        snap = {}
        for path in sorted(root.rglob("*")):
            rel = path.relative_to(root).as_posix()
            if rel == "bin" or rel.startswith("bin/"):
                continue
            if path.is_symlink() or path.is_file():
                snap[rel] = path.read_bytes() if path.is_file() and not path.is_symlink() else None
            elif path.is_dir():
                snap[rel + "/"] = None
        return snap

    def _base_files(self):
        return {
            "a.md": "# A\n\nSee [B](b.md).\n",
            "b.md": "# B\n",
            "sub/c.txt": "hello\n",
        }

    def _coverage_line(self, root):
        manifest = (root / "bin" / "manifest.bin").read_bytes().decode("utf-8").split("\0")
        generated = {"catalogue/nodes.jsonl"}
        prefixes = ("router/index/", "catalogue/router/")
        count = sum(1 for e in manifest if e and e not in generated
                    and not e.startswith(prefixes))
        return "METAVIEWER_ROUTER_COVERAGE 100%% %d files\n" % count

    # -- contract fixtures (positive plus single-fault mutants) ----------
    def test_contract_fixtures(self):
        root, _env = self._tree({"a.md": "x\n"})
        schema = json.loads((root / "router/kit/standards/schemas/ctx.node.v2.schema.json").read_text())
        self.assertEqual(set(schema["required"]), REQUIRED_KEYS)
        self.assertEqual(schema["properties"]["schema"], {"const": "ctx.node.v2"})
        self.assertFalse(schema["additionalProperties"])
        validate = self._load_validate(root)
        self.assertEqual(validate(VALID_NODE, schema), [])
        bad_cases = {
            "extra property": _mutant(path="a.md"),
            "short digest": _mutant(source_sha256="abc"),
            "17 anchors": _mutant(anchors=[{"a": "s%d" % i, "role": "section"} for i in range(17)]),
            "bad id": _mutant(id="0bad"),
            "bad kind": _mutant(kind="router"),
            "missing title": {k: v for k, v in VALID_NODE.items() if k != "title"},
            "empty purpose": _mutant(purpose=""),
        }
        for name, node in bad_cases.items():
            with self.subTest(name=name):
                self.assertTrue(validate(node, schema), name)

    def test_module_contract(self):
        root, _env = self._tree({"a.md": "x\n"})
        before = self._snapshot(root)
        mod = self._load_mod(root)
        self.assertTrue(issubclass(mod.RouterError, ValueError))
        self.assertEqual(mod.Material.__dataclass_fields__["nodes_jsonl"].type, bytes)
        self.assertEqual(mod.CORPUS, "metaviewer")
        for name in ("tracked_paths", "compile_material", "check_doc_links",
                     "check_nodes", "verify_kit", "main"):
            self.assertTrue(callable(getattr(mod, name)), name)
        self.assertEqual(self._snapshot(root), before)

    # -- build then check ------------------------------------------------
    def test_build_then_check(self):
        root, env = self._tree(self._base_files())
        built = self._run_cli(root, extra_env=env)
        self.assertEqual(built.returncode, 0, built.stderr)
        self.assertEqual(built.stdout, self._coverage_line(root))
        nodes = root / "catalogue" / "nodes.jsonl"
        self.assertTrue(nodes.is_file())
        checked = self._run_cli(root, "--check", extra_env=env)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(checked.stdout, self._coverage_line(root))
        nodes.unlink()
        missing = self._run_cli(root, "--check", extra_env=env)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("Stale or incomplete router", missing.stderr)
        self.assertEqual(missing.stdout, "")

    def test_tracked_unrouted_file(self):
        files = self._base_files()
        root, env = self._tree(files)
        self.assertEqual(self._run_cli(root, extra_env=env).returncode, 0)
        self._write_file(root, "planted.md", "# P\n")
        manifest = (root / "bin" / "manifest.bin").read_bytes().decode("utf-8")
        entries = sorted(e for e in manifest.split("\0") if e) + ["planted.md"]
        self._set_manifest(root, sorted(entries))
        checked = self._run_cli(root, "--check", extra_env=env)
        self.assertNotEqual(checked.returncode, 0)
        self.assertIn("Stale or incomplete router", checked.stderr)
        self.assertIn("coverage mismatch", checked.stderr)

    def test_removed_source(self):
        root, env = self._tree(self._base_files())
        self.assertEqual(self._run_cli(root, extra_env=env).returncode, 0)
        (root / "b.md").unlink()
        checked = self._run_cli(root, "--check", extra_env=env)
        self.assertNotEqual(checked.returncode, 0)
        self.assertIn("missing source", checked.stderr)
        manifest = (root / "bin" / "manifest.bin").read_bytes().decode("utf-8")
        entries = sorted(e for e in manifest.split("\0") if e and e != "b.md")
        self._set_manifest(root, entries)
        dropped = self._run_cli(root, "--check", extra_env=env)
        self.assertNotEqual(dropped.returncode, 0)
        self.assertIn("coverage mismatch", dropped.stderr)

    def test_modified_source_bytes(self):
        root, env = self._tree(self._base_files())
        self.assertEqual(self._run_cli(root, extra_env=env).returncode, 0)
        path = root / "sub" / "c.txt"
        path.write_bytes(b"HELLO\n")
        checked = self._run_cli(root, "--check", extra_env=env)
        self.assertNotEqual(checked.returncode, 0)
        self.assertIn("Stale or incomplete router", checked.stderr)

    def test_canonical_and_deterministic(self):
        files = self._base_files()
        root_a, env_a = self._tree(files)
        root_b, env_b = self._tree(files)
        manifest = (root_a / "bin" / "manifest.bin").read_bytes().decode("utf-8")
        entries = sorted(e for e in manifest.split("\0") if e)
        self._set_manifest(root_b, list(reversed(entries)))
        self.assertEqual(self._run_cli(root_a, extra_env=env_a).returncode, 0)
        self.assertEqual(self._run_cli(root_b, extra_env=env_b).returncode, 0)
        text_a = (root_a / "catalogue" / "nodes.jsonl").read_bytes()
        text_b = (root_b / "catalogue" / "nodes.jsonl").read_bytes()
        self.assertEqual(text_a, text_b)
        self.assertTrue(text_a.endswith(b"\n") and not text_a.endswith(b"\n\n"))
        rows = text_a.split(b"\n")
        mutants = {
            "reordered rows": b"\n".join([rows[1], rows[0]] + rows[2:]),
            "padded byte": text_a + b" ",
            "stripped newline": text_a[:-1],
        }
        for name, payload in mutants.items():
            with self.subTest(name=name):
                (root_a / "catalogue" / "nodes.jsonl").write_bytes(payload)
                checked = self._run_cli(root_a, "--check", extra_env=env_a)
                self.assertNotEqual(checked.returncode, 0, name)
                self.assertIn("Stale or incomplete router", checked.stderr)

    def test_paths_and_symlinks(self):
        faults = {
            "absolute": (["/etc/hostname"], None),
            "traversal": (["sub/../../escape.md"], None),
            "backslash": (["a\\b.md"], None),
            "empty segment": (["sub//x.md"], None),
            "duplicate": (["a.md", "a.md"], None),
            "non-utf8": (None, b"\xff.md\0a.md\0"),
        }
        for name, (entries, raw) in faults.items():
            with self.subTest(name=name):
                root, env = self._tree({"a.md": "x\n", "sub/y.md": "y\n"})
                if raw is None:
                    base = (root / "bin" / "manifest.bin").read_bytes().decode("utf-8")
                    entries = sorted(e for e in base.split("\0") if e) + entries
                    self._set_manifest(root, entries)
                else:
                    self._set_manifest_bytes(root, raw)
                built = self._run_cli(root, extra_env=env)
                self.assertNotEqual(built.returncode, 0, name)
                self.assertFalse((root / "catalogue" / "nodes.jsonl").exists(), name)
        link_cases = {
            "symlink file": ("link.md", "a.md", False),
            "broken symlink": ("dead.md", "nowhere.md", False),
            "directory entry": ("sub", None, True),
        }
        for name, (entry, target, is_dir) in link_cases.items():
            with self.subTest(name=name):
                root, env = self._tree({"a.md": "x\n", "sub/y.md": "y\n"})
                if not is_dir:
                    (root / entry).symlink_to(target)
                base = (root / "bin" / "manifest.bin").read_bytes().decode("utf-8")
                entries = sorted(e for e in base.split("\0") if e) + [entry]
                self._set_manifest(root, sorted(entries))
                built = self._run_cli(root, extra_env=env)
                self.assertNotEqual(built.returncode, 0, name)
                self.assertFalse((root / "catalogue" / "nodes.jsonl").exists(), name)
        with self.subTest(name="symlink ancestor"):
            root, env = self._tree({"a.md": "x\n", "sub/y.md": "y\n"})
            (root / "alias").symlink_to("sub", target_is_directory=True)
            base = (root / "bin" / "manifest.bin").read_bytes().decode("utf-8")
            entries = sorted(e for e in base.split("\0") if e) + ["alias/y.md"]
            self._set_manifest(root, sorted(entries))
            built = self._run_cli(root, extra_env=env)
            self.assertNotEqual(built.returncode, 0)
            self.assertFalse((root / "catalogue" / "nodes.jsonl").exists())

    def test_identity_inverse(self):
        files = {
            "README.md": "root\n",
            "agents/README.md": "a\n",
            "core/README.md": "c\n",
            "contracts/examples/" + "y" * 26 + ".json": "{}\n",
            "dir/nested/deep/file.txt": "t\n",
            ".gitignore": "*\n",
            "sp ace.md": "s\n",
        }
        root, _env = self._tree(files)
        mod = self._load_mod(root)
        schema = json.loads((root / "router/kit/standards/schemas/ctx.node.v2.schema.json").read_text())
        validate = self._load_validate(root)
        paths = sorted(files)
        ids = mod._derive_ids(paths, "metaviewer")
        self.assertEqual(set(ids), set(paths))
        self.assertEqual(len(set(ids.values())), len(paths))
        pattern = re.compile(r"^[A-Za-z][A-Za-z0-9._:-]{0,31}$")
        for rel, ident in ids.items():
            self.assertTrue(pattern.match(ident), (rel, ident))
            self.assertLessEqual(len(b"metaviewer") + 1 + len(ident.encode("utf-8")), 32, rel)
        material = mod.compile_material(root, paths, corpus="metaviewer",
                                        ids=ids, schema=schema, validate=validate)
        rows = material.routes_tsv.decode("utf-8").splitlines()
        self.assertEqual(rows[0], "id\tpath")
        pairs = [line.split("\t") for line in rows[1:]]
        self.assertEqual({p: i for i, p in pairs}, ids)
        self.assertEqual(len(material.nodes_jsonl.decode("utf-8").splitlines()), len(paths))
        with self.assertRaises(mod.RouterError):
            short = dict(ids)
            short.pop(paths[0])
            mod.compile_material(root, paths, corpus="metaviewer", ids=short,
                                 schema=schema, validate=validate)
        with self.assertRaises(mod.RouterError):
            long_ids = dict(ids)
            long_ids["extra.md"] = "extra"
            mod.compile_material(root, paths, corpus="metaviewer", ids=long_ids,
                                 schema=schema, validate=validate)
        with self.assertRaises(mod.RouterError):
            dup = dict(ids)
            dup[paths[1]] = dup[paths[0]]
            mod.compile_material(root, paths, corpus="metaviewer", ids=dup,
                                 schema=schema, validate=validate)

    def test_schema_and_width(self):
        root, _env = self._tree({"a.md": "x\n"})
        mod = self._load_mod(root)
        schema = json.loads((root / "router/kit/standards/schemas/ctx.node.v2.schema.json").read_text())
        validate = self._load_validate(root)
        with self.assertRaises(mod.RouterError):
            mod.compile_material(root, ["a.md"], corpus="metaviewer", ids={"a.md": "0bad"},
                                 schema=schema, validate=validate)
        with self.assertRaises(mod.RouterError):
            mod.compile_material(root, ["a.md"], corpus="metaviewer", ids={"a.md": "i" * 22},
                                 schema=schema, validate=validate)
        ok = mod.compile_material(root, ["a.md"], corpus="metaviewer", ids={"a.md": "i" * 21},
                                  schema=schema, validate=validate)
        self.assertEqual(ok.source_paths, ("a.md",))
        with self.assertRaises(mod.RouterError):
            mod.compile_material(root, ["a.md"], corpus="Bad!", ids={"a.md": "amd"},
                                 schema=schema, validate=validate)
        with self.assertRaises(mod.RouterError):
            mod.compile_material(root, ["a.md"], corpus="metaviewer", ids={"a.md": "amd"},
                                 schema=schema, validate=lambda _n, _s: ["boom"])

    def _doc_files(self, index_body):
        return {
            "index.md": index_body,
            "other.md": "# Other\n",
            "sub/page.md": "# Page\n",
        }

    def _passing_index(self):
        return (
            "# I\n\n"
            "[page](sub/page.md)\n"
            "[page frag](sub/page.md#sec)\n"
            "[page query](sub/page.md?x=1)\n"
            "![img](sub/page.md)\n"
            "[ref][other-ref]\n"
            "[collapsed][]\n"
            "[shortcut-alone]\n"
            "[TARGET] [CITED] literal brackets\n"
            "<https://example.com/x> <mail@example.com> <PLACEHOLDER>\n"
            '<a href="other.md">t</a> <img src=\'sub/page.md\'>\n'
            "[frag](#sec)\n"
            "[ext](https://example.com) [mail](mailto:a@b.c)\n"
            "[dir](sub) [rooted](/other.md)\n"
            "[encoded](sub%2Fpage.md)\n"
            "[dot](./other.md)\n"
            "```\n[broken](nope.md)\n```\n"
            "`[inline](nope.md)`\n"
            "<!-- [comment](nope.md) -->\n"
            "\n[other-ref]: other.md\n"
            "[collapsed]: sub/page.md \"a title\"\n"
            "[shortcut-alone]: other.md\n"
        )

    def test_doc_link_targets(self):
        root, env = self._tree(self._doc_files(self._passing_index()))
        built = self._run_cli(root, extra_env=env)
        self.assertEqual(built.returncode, 0, built.stderr)
        checked = self._run_cli(root, "--check", extra_env=env)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        mutants = {
            "inline missing": "[page](sub/missing.md)",
            "image missing": "![img](sub/missing.md)",
            "reference missing": "[ref][gone-ref]\n\n[gone-ref]: sub/missing.md\n",
            "collapsed missing": "[collapsed2][]\n\n[collapsed2]: sub/missing.md\n",
            "undefined reference": "[ref][nosuchref]",
            "html href missing": '<a href="sub/missing.md">t</a>',
            "html src missing": "<img src='sub/missing.md'>",
            "escaping": "[e](../../etc/hostname)",
            "empty destination": "[e]()",
            "ambiguous scheme": "[w](file.md:12)",
        }
        for name, snippet in mutants.items():
            with self.subTest(name=name):
                mutant_root, mutant_env = self._tree(
                    self._doc_files(self._passing_index() + "\n" + snippet + "\n"))
                built = self._run_cli(mutant_root, extra_env=mutant_env)
                self.assertEqual(built.returncode, 0, built.stderr)
                checked = self._run_cli(mutant_root, "--check", extra_env=mutant_env)
                self.assertNotEqual(checked.returncode, 0, name)
                self.assertIn("broken doc link", checked.stderr, name)
        with self.subTest(name="deleted target still fails after rebuild"):
            mutant_root, mutant_env = self._tree(self._doc_files(self._passing_index()))
            self.assertEqual(self._run_cli(mutant_root, extra_env=mutant_env).returncode, 0)
            (mutant_root / "other.md").unlink()
            manifest = (mutant_root / "bin" / "manifest.bin").read_bytes().decode("utf-8")
            entries = sorted(e for e in manifest.split("\0") if e and e != "other.md")
            self._set_manifest(mutant_root, entries)
            rebuilt = self._run_cli(mutant_root, extra_env=mutant_env)
            self.assertEqual(rebuilt.returncode, 0, rebuilt.stderr)
            checked = self._run_cli(mutant_root, "--check", extra_env=mutant_env)
            self.assertNotEqual(checked.returncode, 0)
            self.assertIn("broken doc link", checked.stderr)

    def test_kit_dependency_and_exit(self):
        for missing in ("schema", "validator", "builder", "thesaurus"):
            with self.subTest(missing=missing):
                root, env = self._tree(self._base_files(), drop=(missing,))
                built = self._run_cli(root, extra_env=env)
                self.assertNotEqual(built.returncode, 0, missing)
                self.assertTrue(built.stderr.startswith("Router error:"), built.stderr)
                self.assertFalse((root / "catalogue" / "nodes.jsonl").exists(), missing)
        root, env = self._tree(self._base_files())
        env_fail = dict(env, MV_BUILDER_MODE="fail")
        failed = self._run_cli(root, extra_env=env_fail)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("kit builder failed", failed.stderr)
        mod = self._load_mod(root)
        schema = json.loads((root / "router/kit/standards/schemas/ctx.node.v2.schema.json").read_text())
        validate = self._load_validate(root)
        material = mod.compile_material(
            root, ["a.md"], corpus="metaviewer", ids={"a.md": "amd"},
            schema=schema, validate=validate)
        with mock.patch.dict(os.environ, {"MV_BUILDER_MODE": "sleep"}):
            with self.assertRaises(mod.RouterError):
                mod.verify_kit(root, material, corpus="metaviewer", timeout_s=0.1)

    def test_builder_argv_and_check_scope(self):
        root, env = self._tree(self._base_files())
        record = os.path.join(self.harness, "builder_argv.txt")
        env_rec = dict(env, MV_BUILDER_RECORD=record)
        self.assertEqual(self._run_cli(root, extra_env=env_rec).returncode, 0)
        self.assertEqual(self._run_cli(root, "--check", extra_env=env_rec).returncode, 0)
        with open(record, encoding="utf-8") as fh:
            lines = [line for line in fh.read().splitlines() if line]
        self.assertEqual(len(lines), 4)
        for index, line in enumerate(lines):
            want_check = index % 2 == 1
            with self.subTest(line=line):
                parts = line.split(" ")
                self.assertIn("--nodes", parts)
                self.assertIn("--out", parts)
                self.assertIn("--thesaurus", parts)
                self.assertIn("--corpus", parts)
                self.assertEqual(parts[parts.index("--corpus") + 1], "metaviewer")
                self.assertNotIn("--gate", parts)
                out = parts[parts.index("--out") + 1]
                nodes = parts[parts.index("--nodes") + 1]
                self.assertFalse(out.startswith(str(root)), out)
                self.assertFalse(nodes.startswith(str(root)), nodes)
                if want_check:
                    self.assertIn("--check", parts)
                else:
                    self.assertNotIn("--check", parts)
        self.assertFalse((root / "router" / "index").exists())
        leftovers = [p for p in root.rglob("*.chk")]
        self.assertEqual(leftovers, [])

    def test_check_is_read_only(self):
        root, env = self._tree(self._base_files())
        self.assertEqual(self._run_cli(root, extra_env=env).returncode, 0)
        before = self._snapshot(root)
        checked = self._run_cli(root, "--check", extra_env=env)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(self._snapshot(root), before)
        (root / "sub" / "c.txt").write_bytes(b"dirty\n")
        failing = self._run_cli(root, "--check", extra_env=env)
        self.assertNotEqual(failing.returncode, 0)
        (root / "sub" / "c.txt").write_bytes(b"hello\n")
        self.assertEqual(self._snapshot(root), before)
        shutil.rmtree(root / "catalogue")
        absent = self._run_cli(root, "--check", extra_env=env)
        self.assertNotEqual(absent.returncode, 0)
        self.assertFalse((root / "catalogue").exists())

    def test_self_artifact_policy(self):
        files = dict(self._base_files())
        files["catalogue/nodes.jsonl"] = "placeholder\n"
        files["router/index/i.json"] = "{}\n"
        files["catalogue/router/r.json"] = "{}\n"
        root, env = self._tree(files)
        built = self._run_cli(root, extra_env=env)
        self.assertEqual(built.returncode, 0, built.stderr)
        self.assertEqual(built.stdout, self._coverage_line(root))
        rows = (root / "catalogue" / "nodes.jsonl").read_bytes().decode("utf-8").splitlines()
        generated_digests = {
            hashlib.sha256((root / rel).read_bytes()).hexdigest()
            for rel in ("router/index/i.json", "catalogue/router/r.json")
        }
        self.assertEqual(len(rows), len(self._base_files()) + 5)
        for row in rows:
            self.assertNotIn(json.loads(row)["source_sha256"], generated_digests)
        checked = self._run_cli(root, "--check", extra_env=env)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        (root / "b.md").unlink()
        dropped = self._run_cli(root, "--check", extra_env=env)
        self.assertNotEqual(dropped.returncode, 0)

    def test_git_argv_and_manifest_rules(self):
        root, env = self._tree(self._base_files())
        record = os.path.join(self.harness, "git_argv.txt")
        env_rec = dict(env, MV_FAKEGIT_RECORD=record)
        self.assertEqual(self._run_cli(root, extra_env=env_rec).returncode, 0)
        with open(record, encoding="utf-8") as fh:
            argv = fh.read().split("\n")
        self.assertEqual(argv[0], str(root / "bin" / "git"))
        self.assertEqual(argv[1:], ["-C", str(root), "ls-files", "-z", "--cached"])
        failing = self._run_cli(root, extra_env=dict(env, MV_FAKEGIT="fail"))
        self.assertNotEqual(failing.returncode, 0)
        empty = self._run_cli(root, extra_env=dict(env, MV_FAKEGIT="empty"))
        self.assertNotEqual(empty.returncode, 0)
        mod = self._load_mod(root)
        with mock.patch.object(mod.subprocess, "run",
                               side_effect=subprocess.TimeoutExpired("git", 60)):
            with self.assertRaises(mod.RouterError):
                mod.tracked_paths(root)

    def test_corpus_agreement(self):
        root, env = self._tree(self._base_files())
        self.assertEqual(self._run_cli(root, "--check", extra_env=env).returncode, 1)
        self.assertEqual(self._run_cli(root, extra_env=env).returncode, 0)
        self._write_file(root, "catalogue/protocol.json", '{"corpus": "metaviewer"}\n')
        manifest = (root / "bin" / "manifest.bin").read_bytes().decode("utf-8")
        entries = sorted(e for e in manifest.split("\0") if e) + ["catalogue/protocol.json"]
        self._set_manifest(root, sorted(entries))
        self.assertEqual(self._run_cli(root, extra_env=env).returncode, 0)
        self.assertEqual(self._run_cli(root, "--check", extra_env=env).returncode, 0)
        self._write_file(root, "catalogue/protocol.json", '{"corpus": "other"}\n')
        mismatch_build = self._run_cli(root, extra_env=env)
        self.assertNotEqual(mismatch_build.returncode, 0)
        self.assertIn("corpus mismatch", mismatch_build.stderr)
        mismatch = self._run_cli(root, "--check", extra_env=env)
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertIn("corpus mismatch", mismatch.stderr)
        self._write_file(root, "catalogue/protocol.json", "{broken\n")
        broken_build = self._run_cli(root, extra_env=env)
        self.assertNotEqual(broken_build.returncode, 0)
        broken = self._run_cli(root, "--check", extra_env=env)
        self.assertNotEqual(broken.returncode, 0)

    def test_usage_errors(self):
        root, env = self._tree(self._base_files())
        for args in (("--bogus",), ("--help",), ("a.md",)):
            with self.subTest(args=args):
                result = self._run_cli(root, *args, extra_env=env)
                self.assertEqual(result.returncode, 2, args)
                self.assertTrue(result.stderr.startswith("Router error:"), result.stderr)
        self.assertEqual(self._run_cli(root, extra_env=env).returncode, 0)
        twice = self._run_cli(root, "--check", "--check", extra_env=env)
        self.assertEqual(twice.returncode, 0, twice.stderr)


if __name__ == "__main__":
    unittest.main()
