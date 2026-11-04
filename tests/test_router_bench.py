"""Integrity and anti-memorisation controls for tests/fixtures/router_bench.jsonl.

The fixture is the router benchmark used by cloud-audit/ROUTER_PLAN.md. These
tests do not gate ranking quality; they keep the yardstick honest: every gold
path exists and holds its evidence text, natural-language queries never name
their gold file, both splits are populated, and no query text leaks into the
router code or index data.
"""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
sys.path.insert(0, str(ROOT / 'route'))
import router_bench as bench
import route_query

LEAK_SCAN = ('route/route_query.py', 'route/nodes.jsonl', 'route/symbols.jsonl',
             'tools/router_index.py', 'catalogue/nodes.jsonl')


class RouterBenchFixtureTest(unittest.TestCase):
    rows = bench.load()

    def test_rows_are_well_formed_and_split(self):
        ids = [row['id'] for row in self.rows]
        self.assertEqual(len(ids), len(set(ids)))
        for row in self.rows:
            self.assertIn(row['mode'], ('locate', 'find', 'error'))
            self.assertIn(row['split'], ('dev', 'held'))
            self.assertTrue(row['gold'])
        for mode in ('locate', 'find', 'error'):
            splits = {row['split'] for row in self.rows if row['mode'] == mode}
            self.assertEqual(splits, {'dev', 'held'}, mode)

    def test_gold_exists_and_holds_evidence(self):
        for row in self.rows:
            for path in row['gold']:
                self.assertTrue((ROOT / path).is_file(), (row['id'], path))
            text = (ROOT / row['gold'][0]).read_text(encoding='utf-8')
            self.assertIn(row['evidence'], text, row['id'])

    def test_locate_queries_never_name_their_gold_file(self):
        for row in self.rows:
            if row['mode'] != 'locate':
                continue
            asked = set(route_query.words(row['query']))
            for path in row['gold']:
                named = set(route_query.words(path.replace('.', ' ')))
                self.assertFalse(asked & named, (row['id'], path, sorted(asked & named)))

    def test_query_text_is_not_in_router_code_or_data(self):
        blobs = {rel: (ROOT / rel).read_text(encoding='utf-8', errors='replace').lower()
                 for rel in LEAK_SCAN if (ROOT / rel).is_file()}
        for row in self.rows:
            if row['mode'] != 'locate':
                continue
            for rel, blob in blobs.items():
                self.assertNotIn(row['query'].lower(), blob, (row['id'], rel))

    def test_scoring_negative_control(self):
        self.assertEqual(bench.rank_of(['a', 'b', 'gold'], {'gold'}), 3)
        self.assertIsNone(bench.rank_of(['x'] * 20 + ['gold'], {'gold'}))
        self.assertEqual(bench.summary([None, None])['top5'], 0)
        perfect = bench.summary([1, 1])
        self.assertEqual((perfect['top1'], perfect['mrr10']), (2, 1.0))


if __name__ == '__main__':
    unittest.main()
