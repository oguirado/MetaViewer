"""Router query smoke and lookup resolution tests (U-R3 / W3-ROUTER-B).

Runs the 25 golden queries from ROUTER_AUDIT against the router index
(catalogue/router when fresh, or a scratch build from tools/router_index.py)
with k=3, verifies >= 23/25 top-3 file hits, verifies every missed query is
reported with (query, expected, got) on failure, verifies planting ten extra
test files mentioning "admission control" does not push core/src/admission/
out of the top 3, verifies every returned id resolves to a tracked file via
lookup, verifies garbage query abstention with empty rows, and verifies
fail-closed exit on an empty index directory and on non-abstaining garbage
regressions.
"""
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ROUTER_INDEX_PATH = REPO_ROOT / "tools" / "router_index.py"
BUILD_INDEX_V2_PATH = REPO_ROOT / "router" / "kit" / "tools" / "build_index_v2.py"
ROUTE_V2_PATH = REPO_ROOT / "router" / "kit" / "tools" / "route_v2.py"
THESAURUS_PATH = REPO_ROOT / "router" / "kit" / "standards" / "thesaurus.json"
SCHEMA_PATH = REPO_ROOT / "router" / "kit" / "standards" / "schemas" / "ctx.node.v2.schema.json"
VALIDATOR_PATH = REPO_ROOT / "router" / "kit" / "tools" / "jsonschema_lite.py"
INDEX_DIR = REPO_ROOT / "catalogue" / "router"
NODES_PATH = REPO_ROOT / "catalogue" / "nodes.jsonl"
ROUTES_PATH = REPO_ROOT / "catalogue" / "routes.tsv"
PURPOSE_PREFIX = "Routed repository file "
GOLDEN_FLOOR = 23

GOLDEN_QUERIES = (
    ("check_mount_freshness", "tools/router_index.py"),
    ("compile_material", "tools/router_index.py"),
    ("authorityWire", "ui/electron/authorityWire.js"),
    ("frameReader", "ui/electron/frameReader.js"),
    ("wender_bridge", "agents/metaviewer_agents/wender_bridge.py"),
    ("router_index", "tools/router_index.py"),
    ("route_v2", "router/kit/tools/route_v2.py"),
    ("build_index_v2", "router/kit/tools/build_index_v2.py"),
    ("mvctl", "agents/metaviewer_agents/mvctl.py"),
    ("gate.sh", "tools/gate.sh"),
    ("llms.txt", "llms.txt"),
    ("admission control", "core/src/admission/"),
    ("journal replay", "core/src/journal/"),
    ("supervisor", "core/src/supervisor/"),
    ("capsule liveness", "daemon-adapter/internal/capsule/"),
    ("frame subscriptions", "daemon-adapter/internal/frames/"),
    ("router bootstrap", "docs/ROUTER_BOOTSTRAP.md"),
    ("architecture", "docs/ARCHITECTURE.md"),
    ("testing guide", "docs/TESTING.md"),
    ("envelope schema", "contracts/v0.2/envelope.schema.json"),
    ("ctx.node.v2 schema", "router/kit/standards/schemas/ctx.node.v2.schema.json"),
    ("thesaurus", "router/kit/standards/thesaurus.json"),
    ("T3 route test", "router/kit/tests/test_T3_route.py"),
    ("e2e control test", "tests/e2e/ac04_control.test.js"),
    ("ci workflow", ".github/workflows/ci.yml"),
)


def _load_route_v2():
    spec = importlib.util.spec_from_file_location("mv_route_v2_under_test", ROUTE_V2_PATH)
    mod = importlib.util.module_from_spec(spec)
    old, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.dont_write_bytecode = old
    return mod


def _load_router_index():
    spec = importlib.util.spec_from_file_location("mv_router_index_under_test", ROUTER_INDEX_PATH)
    mod = importlib.util.module_from_spec(spec)
    old, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.dont_write_bytecode = old
    return mod


def _compile_fresh_material(root=REPO_ROOT):
    mod = _load_router_index()
    schema = json.loads(SCHEMA_PATH.read_bytes())
    validate = mod._load_validator(VALIDATOR_PATH)
    manifest = mod.tracked_paths(root)
    sources = tuple(path for path in manifest if not mod._is_generated(path))
    ids = mod._derive_ids(sources, mod.CORPUS)
    material = mod.compile_material(
        root, sources, corpus=mod.CORPUS, ids=ids, schema=schema, validate=validate
    )
    return mod, material, schema, validate


def _build_index_from_nodes_bytes(nodes_bytes, out_dir, corpus="metaviewer"):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    nodes_file = out_dir.parent / "nodes.jsonl"
    nodes_file.write_bytes(nodes_bytes)
    subprocess.run(
        [
            sys.executable, "-B", str(BUILD_INDEX_V2_PATH),
            "--nodes", str(nodes_file),
            "--out", str(out_dir),
            "--thesaurus", str(THESAURUS_PATH),
            "--corpus", corpus,
        ],
        check=True,
        timeout=60,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    return out_dir


def load_lookup(root=REPO_ROOT, *, nodes_path=None, routes_path=None):
    """Load id -> path from catalogue/routes.tsv if present, else nodes.jsonl purpose."""
    if routes_path is None:
        routes_path = root / "catalogue" / "routes.tsv"
    if nodes_path is None:
        nodes_path = root / "catalogue" / "nodes.jsonl"
    purpose_map = {}
    for line in nodes_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        ident = row["id"]
        purpose = row["purpose"]
        if not purpose.startswith(PURPOSE_PREFIX):
            raise ValueError("unexpected purpose prefix for %s: %r" % (ident, purpose))
        purpose_map[ident] = purpose[len(PURPOSE_PREFIX):]
    if routes_path.is_file():
        lines = [line for line in routes_path.read_text(encoding="utf-8").splitlines() if line]
        if not lines or lines[0] != "id\tpath":
            raise ValueError("invalid routes.tsv header")
        tsv_map = {}
        for line in lines[1:]:
            ident, rel = line.split("\t")
            tsv_map[ident] = rel
        if tsv_map != purpose_map:
            raise ValueError("routes.tsv disagrees with nodes.jsonl purpose map")
        return tsv_map
    return purpose_map


def resolve_shortlist_paths(ans, lookup, root=REPO_ROOT, extra_paths=()):
    """Resolve every shortlist row id to its repository path and verify existence."""
    extra_set = set(extra_paths)
    paths = []
    for row in ans.get("r", []):
        if not isinstance(row, list) or len(row) < 3:
            raise ValueError("malformed shortlist row: %r" % (row,))
        ident, anchor = row[0], row[1]
        if anchor != "file":
            raise ValueError("unexpected anchor %r for %s" % (anchor, ident))
        if ident not in lookup:
            raise KeyError("unresolvable shortlist id: %s" % ident)
        rel = lookup[ident]
        if rel not in extra_set and not (root / rel).is_file():
            raise FileNotFoundError("resolved path missing on disk: %s" % rel)
        paths.append(rel)
    return paths


def matches_expected(paths, expected):
    if expected.endswith("/"):
        return any(path.startswith(expected) for path in paths)
    return expected in paths


def evaluate_golden_queries(ans_by_query, lookup, root=REPO_ROOT, min_hits=GOLDEN_FLOOR,
                            extra_paths=()):
    hits = 0
    misses = []
    for query, expected in GOLDEN_QUERIES:
        ans = ans_by_query[query]
        paths = resolve_shortlist_paths(ans, lookup, root=root, extra_paths=extra_paths)
        if matches_expected(paths, expected):
            hits += 1
        else:
            misses.append((query, expected, paths))
    if hits < min_hits:
        miss_lines = [
            "query=%r expected=%r got=%r" % (query, expected, got)
            for query, expected, got in misses
        ]
        raise AssertionError(
            "golden top-3 hits %d/%d below floor %d; missed queries:\n%s"
            % (hits, len(GOLDEN_QUERIES), min_hits, "\n".join(miss_lines))
        )
    return hits


def assert_garbage_abstains(ans):
    abstain = ans.get("abstain", {})
    if abstain.get("flag") is not True:
        raise AssertionError("expected abstain.flag=True, got %r" % (abstain,))
    if ans.get("r") != []:
        raise AssertionError("expected empty shortlist r=[], got %r" % (ans.get("r"),))


class RouterQuerySmokeTests(unittest.TestCase):
    _scratch_dir = None

    @classmethod
    def setUpClass(cls):
        cls.route_v2 = _load_route_v2()
        cls.router_mod, cls.fresh_material, cls.schema, cls.validate = _compile_fresh_material(
            REPO_ROOT
        )
        disk_nodes = NODES_PATH.read_bytes() if NODES_PATH.is_file() else b""
        if disk_nodes == cls.fresh_material.nodes_jsonl and (INDEX_DIR / "meta.json").is_file():
            cls.index_dir = INDEX_DIR
            cls.lookup = load_lookup(REPO_ROOT)
        else:
            cls._scratch_dir = Path(tempfile.mkdtemp(prefix="mv-router-query-smoke-"))
            nodes_path = cls._scratch_dir / "nodes.jsonl"
            routes_path = cls._scratch_dir / "routes.tsv"
            nodes_path.write_bytes(cls.fresh_material.nodes_jsonl)
            routes_path.write_bytes(cls.fresh_material.routes_tsv)
            cls.index_dir = _build_index_from_nodes_bytes(
                cls.fresh_material.nodes_jsonl,
                cls._scratch_dir / "index",
                corpus=cls.router_mod.CORPUS,
            )
            cls.lookup = load_lookup(
                REPO_ROOT, nodes_path=nodes_path, routes_path=routes_path
            )
        cls.index = cls.route_v2.Index(str(cls.index_dir))

    @classmethod
    def tearDownClass(cls):
        if cls._scratch_dir is not None:
            shutil.rmtree(cls._scratch_dir, ignore_errors=True)
            cls._scratch_dir = None

    def _run_route_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-B", str(ROUTE_V2_PATH), *args],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=30, check=False,
        )

    def test_25_query_golden_top3_and_negative_control(self):
        self.assertEqual(len(GOLDEN_QUERIES), 25)
        ans_by_query = {}
        for query, _expected in GOLDEN_QUERIES:
            ans = self.route_v2.route(self.index, query, k=3)
            self.assertEqual(ans["schema"], "ctx.shortlist.v2")
            self.assertLessEqual(len(ans["r"]), 3)
            ans_by_query[query] = ans
        # CLI parity check on a representative query.
        cli = self._run_route_cli("--index", str(self.index_dir), "--q", "router_index", "--k", "3")
        self.assertEqual(cli.returncode, 0, cli.stderr)
        self.assertEqual(json.loads(cli.stdout), ans_by_query["router_index"])
        hits = evaluate_golden_queries(
            ans_by_query, self.lookup, root=REPO_ROOT, min_hits=GOLDEN_FLOOR
        )
        self.assertGreaterEqual(hits, GOLDEN_FLOOR)
        # Negative control: degraded answers falling below 23/25 must fail the oracle
        # and report every missed query (query, expected, got) in the failure message.
        degraded = {q: {"schema": "ctx.shortlist.v2", "r": []} for q, _ in GOLDEN_QUERIES}
        with self.assertRaises(AssertionError) as ctx:
            evaluate_golden_queries(degraded, self.lookup, root=REPO_ROOT, min_hits=GOLDEN_FLOOR)
        msg = str(ctx.exception)
        self.assertIn("below floor %d" % GOLDEN_FLOOR, msg)
        for query, expected in GOLDEN_QUERIES:
            self.assertIn("query=%r expected=%r got=[]" % (query, expected), msg)

    def test_planted_admission_control_tests_do_not_crowd_out_product_source(self):
        planted_rels = [
            "tests/test_admission_control_planted_%02d.py" % idx for idx in range(10)
        ]
        all_paths = sorted(
            list(self.fresh_material.source_paths) + planted_rels,
            key=lambda item: item.encode("utf-8"),
        )
        ids = self.router_mod._derive_ids(all_paths, self.router_mod.CORPUS)
        base_rows = {
            json.loads(line)["purpose"][len(PURPOSE_PREFIX):]: line.encode("utf-8") + b"\n"
            for line in self.fresh_material.nodes_jsonl.decode("utf-8").splitlines()
            if line.strip()
        }
        lines = []
        lookup = dict(self.lookup)
        for rel in all_paths:
            ident = ids[rel]
            lookup[ident] = rel
            if rel in base_rows and ident == json.loads(base_rows[rel].decode("utf-8"))["id"]:
                lines.append(base_rows[rel])
                continue
            if rel in planted_rels:
                raw = (
                    b'"""Planted admission control regression test."""\n'
                    b"def test_admission_control_planted():\n"
                    b'    """Verify admission control lifecycle and admission control matrix."""\n'
                    b"    assert True\n"
                )
            else:
                raw = (REPO_ROOT / rel).read_bytes()
            name = rel.rsplit("/", 1)[-1]
            stem = name.rsplit(".", 1)[0] if "." in name else name
            trigger = (stem or name)[:64]
            suffix = name.rsplit(".", 1)[1] if "." in name else ""
            node = {
                "schema": self.router_mod.SCHEMA_NAME,
                "id": ident,
                "corpus": self.router_mod.CORPUS,
                "kind": "asset",
                "title": name,
                "purpose": PURPOSE_PREFIX + rel,
                "anchors": [{"a": "file", "role": "section"}],
                "search": self.router_mod._build_search(rel, name, stem, trigger, suffix, raw),
                "status": "active",
                "source_sha256": hashlib.sha256(raw).hexdigest(),
            }
            self.assertEqual(self.validate(node, self.schema), [])
            lines.append(
                json.dumps(node, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
                    "utf-8"
                )
                + b"\n"
            )
        with tempfile.TemporaryDirectory(prefix="mv-planted-admission-") as tmp:
            idx_dir = _build_index_from_nodes_bytes(
                b"".join(lines), Path(tmp) / "index", corpus=self.router_mod.CORPUS
            )
            planted_index = self.route_v2.Index(str(idx_dir))
            ans = self.route_v2.route(planted_index, "admission control", k=3)
            got_paths = resolve_shortlist_paths(
                ans, lookup, root=REPO_ROOT, extra_paths=planted_rels
            )
            self.assertTrue(
                matches_expected(got_paths, "core/src/admission/"),
                "core/src/admission/ pushed out of top-3 by planted tests: got %r" % (got_paths,),
            )
            ans_by_query = {
                q: self.route_v2.route(planted_index, q, k=3) for q, _ in GOLDEN_QUERIES
            }
            hits = evaluate_golden_queries(
                ans_by_query,
                lookup,
                root=REPO_ROOT,
                min_hits=GOLDEN_FLOOR,
                extra_paths=planted_rels,
            )
            self.assertGreaterEqual(hits, GOLDEN_FLOOR)
            # Negative control: if a shortlist only returned planted test files,
            # matches_expected and evaluate_golden_queries must reject it.
            planted_only_rows = [[ids[rel], "file", 1000 - i] for i, rel in enumerate(planted_rels[:3])]
            planted_only_paths = resolve_shortlist_paths(
                {"r": planted_only_rows}, lookup, root=REPO_ROOT, extra_paths=planted_rels
            )
            self.assertFalse(matches_expected(planted_only_paths, "core/src/admission/"))
            bad_ans_by_query = {
                q: {"schema": "ctx.shortlist.v2", "r": planted_only_rows if q == "admission control" else []}
                for q, _ in GOLDEN_QUERIES
            }
            with self.assertRaises(AssertionError) as ctx:
                evaluate_golden_queries(
                    bad_ans_by_query,
                    lookup,
                    root=REPO_ROOT,
                    min_hits=GOLDEN_FLOOR,
                    extra_paths=planted_rels,
                )
            self.assertIn("query='admission control' expected='core/src/admission/'", str(ctx.exception))

    def test_ids_resolve_via_lookup_and_negative_control(self):
        # Every id in the published index cols.json and all 25 query results must resolve.
        self.assertGreater(len(self.index.ids), 0)
        for ident in self.index.ids:
            self.assertIn(ident, self.lookup)
            self.assertTrue((REPO_ROOT / self.lookup[ident]).is_file(), ident)
        sample = self.route_v2.route(self.index, "router_index", k=3)
        resolved = resolve_shortlist_paths(sample, self.lookup, root=REPO_ROOT)
        self.assertIn("tools/router_index.py", resolved)
        # Negative control 1: missing id in lookup raises KeyError.
        broken_lookup = dict(self.lookup)
        broken_lookup.pop(sample["r"][0][0])
        with self.assertRaises(KeyError):
            resolve_shortlist_paths(sample, broken_lookup, root=REPO_ROOT)
        # Negative control 2: lookup pointing to missing file raises FileNotFoundError.
        dangling_lookup = dict(self.lookup)
        dangling_lookup[sample["r"][0][0]] = "nonexistent/missing_target.py"
        with self.assertRaises(FileNotFoundError):
            resolve_shortlist_paths(sample, dangling_lookup, root=REPO_ROOT)

    def test_garbage_query_abstains_and_s4_regression_negative_control(self):
        proc = self._run_route_cli("--index", str(self.index_dir), "--q", "zxqv-theorem-ww", "--k", "3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        ans = json.loads(proc.stdout)
        assert_garbage_abstains(ans)
        self.assertEqual(ans["abstain"]["reason"], "no_query_term")
        # Negative control (S4 regression class): a query/response that returns rows
        # without abstaining must fail assert_garbage_abstains.
        s4_ans = self.route_v2.route(self.index, "check_mount_freshness", k=3)
        with self.assertRaises(AssertionError):
            assert_garbage_abstains(s4_ans)
        with self.assertRaises(AssertionError):
            assert_garbage_abstains({
                "abstain": {"flag": True, "reason": "no_query_term"},
                "r": [["router_index.py", "file", 1000]],
            })

    def test_empty_index_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix="mv-empty-index-") as tmp:
            proc = self._run_route_cli("--index", tmp, "--q", "router_index", "--k", "3")
            self.assertNotEqual(proc.returncode, 0)
            self.assertEqual(proc.returncode, 3)
            self.assertEqual(proc.stdout, "")
            self.assertIn("missing/invalid", proc.stderr)


if __name__ == "__main__":
    unittest.main()
