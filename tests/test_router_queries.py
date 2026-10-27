"""Router query smoke and lookup resolution tests (U-R3).

Runs the 25 golden queries from ROUTER_AUDIT against the published mount
(catalogue/router) with k=3, verifies >= 20/25 top-3 file hits, verifies
every returned id resolves to a tracked file via lookup (catalogue/routes.tsv
when present, or catalogue/nodes.jsonl purpose fallback), verifies garbage
query abstention with empty rows, and verifies fail-closed exit on an empty
index directory and on non-abstaining garbage regressions.
"""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ROUTE_V2_PATH = REPO_ROOT / "router" / "kit" / "tools" / "route_v2.py"
INDEX_DIR = REPO_ROOT / "catalogue" / "router"
NODES_PATH = REPO_ROOT / "catalogue" / "nodes.jsonl"
ROUTES_PATH = REPO_ROOT / "catalogue" / "routes.tsv"
PURPOSE_PREFIX = "Routed repository file "

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


def load_lookup(root=REPO_ROOT):
    """Load id -> path from catalogue/routes.tsv if present, else nodes.jsonl purpose."""
    routes_path = root / "catalogue" / "routes.tsv"
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


def resolve_shortlist_paths(ans, lookup, root=REPO_ROOT):
    """Resolve every shortlist row id to its repository path and verify existence."""
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
        if not (root / rel).is_file():
            raise FileNotFoundError("resolved path missing on disk: %s" % rel)
        paths.append(rel)
    return paths


def matches_expected(paths, expected):
    if expected.endswith("/"):
        return any(path.startswith(expected) for path in paths)
    return expected in paths


def evaluate_golden_queries(ans_by_query, lookup, root=REPO_ROOT, min_hits=20):
    hits = 0
    for query, expected in GOLDEN_QUERIES:
        ans = ans_by_query[query]
        paths = resolve_shortlist_paths(ans, lookup, root=root)
        if matches_expected(paths, expected):
            hits += 1
    if hits < min_hits:
        raise AssertionError("golden top-3 hits %d/%d below floor %d"
                             % (hits, len(GOLDEN_QUERIES), min_hits))
    return hits


def assert_garbage_abstains(ans):
    abstain = ans.get("abstain", {})
    if abstain.get("flag") is not True:
        raise AssertionError("expected abstain.flag=True, got %r" % (abstain,))
    if ans.get("r") != []:
        raise AssertionError("expected empty shortlist r=[], got %r" % (ans.get("r"),))


class RouterQuerySmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.route_v2 = _load_route_v2()
        cls.index = cls.route_v2.Index(str(INDEX_DIR))
        cls.lookup = load_lookup(REPO_ROOT)

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
        cli = self._run_route_cli("--index", str(INDEX_DIR), "--q", "router_index", "--k", "3")
        self.assertEqual(cli.returncode, 0, cli.stderr)
        self.assertEqual(json.loads(cli.stdout), ans_by_query["router_index"])
        hits = evaluate_golden_queries(ans_by_query, self.lookup, root=REPO_ROOT, min_hits=20)
        self.assertGreaterEqual(hits, 20)
        # Negative control: degraded answers falling below 20/25 must fail the oracle.
        degraded = {q: {"schema": "ctx.shortlist.v2", "r": []} for q, _ in GOLDEN_QUERIES}
        with self.assertRaises(AssertionError):
            evaluate_golden_queries(degraded, self.lookup, root=REPO_ROOT, min_hits=20)

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
        proc = self._run_route_cli("--index", str(INDEX_DIR), "--q", "zxqv-theorem-ww", "--k", "3")
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
