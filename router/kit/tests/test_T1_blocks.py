import json, os, unittest
from common import *
import blocks, census, repo_gen

# Adapted for MetaViewer: the foreign census receipt (out/census.json with
# pilot counts) is replaced by a census receipt generated from a scratch
# fixture with hardcoded independent expectations. No skips.

# Expected census for make_repo(n_synth=2), derived from repo_gen HAND rows
# plus two seeded synth papers (2 triggers, 2 keywords, 1 task, 1 resolved
# question each; weak algorithms domain, no edges). search_field_json_bytes
# is asserted for shape and determinism, not pinned, to stay robust across
# interpreters.
EXPECTED_N2 = {
    "domain_entries": 6, "edge_papers": 3,
    "edge_relations": {"contradicts": 1, "shared_technique": 1, "supersedes": 1, "uses": 1},
    "edge_targets_distinct": 3, "edge_targets_in_corpus": 4, "edges": 4,
    "exclusions": 2, "exclusions_papers": 2, "keywords": 11, "keywords_papers": 6,
    "papers": 6, "papers_with_required_blocks": 0, "prereq_items": 2, "prereq_papers": 2,
    "prereq_pm_ids": 0, "prereq_with_pm_ids": 0, "qa_anchor_resolved": 5,
    "questions": 5, "questions_papers": 5, "reading_slices": 0,
    "reading_slices_max": 0, "reading_slices_p50": 0, "software_ish_papers": 2,
    "syn_aliases": 1, "syn_papers": 2, "syn_terms": 2, "task_anchor_resolved": 5,
    "task_maturity": {"adaptable": 5}, "tasks": 5, "tasks_papers": 5,
    "trigger_words": {"1": 0, "2": 12, "3": 0, "4": 0, "5+": 0},
    "triggers": 12, "triggers_papers": 6,
}


class T1(unittest.TestCase):
    def test_two_blocks_and_fence(self):
        d, root, out = build_fixture()
        p = os.path.join(root, "papers", "EN-0000_PM-001.1.md")
        b = blocks.read_blocks(p)
        self.assertIn("pm.search.v1", b)
        self.assertIn("pm.edges.v2", b)
        self.assertEqual(b["pm.search.v1"]["note"], "a fence ``` inside a string")
        self.assertEqual(blocks.anchors(p) & {"pm-s0", "stmt-main"}, {"pm-s0", "stmt-main"})

    def test_malformed_json(self):
        root = repo_gen.make_repo(os.path.join(tmp(), "repo"), bad_json=True)
        p = os.path.join(root, "papers", "EN-0001_PM-001.2.md")
        with self.assertRaises(blocks.BlockError) as c:
            blocks.read_blocks(p)
        self.assertEqual(c.exception.code, "E_BLOCK_JSON")
        self.assertEqual(c.exception.path, p)
        with self.assertRaises(B.BuildError) as c2:  # builder reports the same code with the path
            B.build(root, os.path.join(tmp(), "ix"), None)
        self.assertEqual(c2.exception.code, "E_BLOCK_JSON")

    def test_census_fixture_exact(self):
        d, root, out = build_fixture()
        import glob
        c = census.census(sorted(glob.glob(os.path.join(root, "papers", "*.md"))))
        self.assertEqual(c["papers"], 4)
        self.assertEqual(c["triggers"], 3 + 2 + 2 + 1)
        self.assertEqual(c["keywords"], 2 + 2 + 2 + 1)
        self.assertEqual(c["questions"], 3)
        self.assertEqual(c["qa_anchor_resolved"], 3)
        self.assertEqual(c["tasks"], 3)
        self.assertEqual(c["edges"], 4)
        self.assertEqual(c["edge_relations"]["supersedes"], 1)
        self.assertEqual(c["software_ish_papers"], 2)  # PM-001.1 strong software, PM-001.2 moderate algorithms
        self.assertEqual(c["trigger_words"]["2"], 8)

    def test_generated_census_receipt_exact(self):
        import glob
        receipts = []
        for _ in range(2):
            d = tmp()
            root = repo_gen.make_repo(os.path.join(d, "repo"), n_synth=2)
            out = os.path.join(d, "census.json")
            self.assertEqual(census.main(["--root", root, "--out", out]), 0)
            papers = sorted(glob.glob(os.path.join(root, "papers", "*.md")))
            direct = census.census(papers)
            filed = json.load(open(out, encoding="utf-8"))
            self.assertEqual(filed, direct)
            receipts.append(filed)
        got = dict(receipts[0])
        byte_stats = got.pop("search_field_json_bytes")
        self.assertEqual(got, EXPECTED_N2)
        self.assertEqual(sorted(byte_stats), ["max", "p50", "total"])
        self.assertTrue(all(isinstance(byte_stats[k], int) and byte_stats[k] > 0 for k in byte_stats))
        self.assertEqual(receipts[0], receipts[1])

    def test_census_rejects_malformed_blocks(self):
        import glob
        root = repo_gen.make_repo(os.path.join(tmp(), "repo"), bad_json=True)
        papers = sorted(glob.glob(os.path.join(root, "papers", "*.md")))
        with self.assertRaises(blocks.BlockError) as c:
            census.census(papers)
        self.assertEqual(c.exception.code, "E_BLOCK_JSON")
        self.assertEqual(census.main(["--root", root, "--out", os.path.join(tmp(), "c.json")]), 3)


if __name__ == "__main__":
    unittest.main()
