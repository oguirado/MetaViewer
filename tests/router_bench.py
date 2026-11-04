#!/usr/bin/env python3
"""Measure both repository routers on tests/fixtures/router_bench.jsonl.

Routers: the catalogue router (router/kit/tools/route_v2.py over a scratch
index compiled from the current tools/router_index.py material, so the
numbers describe the code under test, not a stale published index) and the
code map (route/route_query.py, in process). Prints one JSON report with
hits at 1/3/5, MRR@10 and per-query ranks, per router, split and mode.
Reads the tree; writes only a temporary directory. Standard library only.
"""
import argparse
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / 'tests' / 'fixtures' / 'router_bench.jsonl'
DEPTH = 10
sys.path.insert(0, str(ROOT / 'tests'))
sys.path.insert(0, str(ROOT / 'route'))


def load(path=BENCH):
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def rank_of(paths, gold):
    for position, path in enumerate(paths[:DEPTH], 1):
        if path in gold:
            return position
    return None


def summary(ranks):
    count = len(ranks)
    def hits(cut):
        return sum(1 for value in ranks if value is not None and value <= cut)
    mrr = sum(1 / value for value in ranks if value is not None) / count if count else 0.0
    return {'n': count, 'top1': hits(1), 'top3': hits(3), 'top5': hits(5), 'mrr10': round(mrr, 3)}


def unique(paths):
    return list(dict.fromkeys(paths))


class CatalogueRouter:
    """route_v2 over a scratch index of freshly compiled catalogue material."""

    name = 'catalogue'

    def __init__(self):
        import test_router_queries as helpers
        self.scratch = Path(tempfile.mkdtemp(prefix='mv-router-bench-'))
        mod, material, _, _ = helpers._compile_fresh_material(ROOT)
        nodes = self.scratch / 'nodes.jsonl'
        routes = self.scratch / 'routes.tsv'
        nodes.write_bytes(material.nodes_jsonl)
        routes.write_bytes(material.routes_tsv)
        index = helpers._build_index_from_nodes_bytes(material.nodes_jsonl, self.scratch / 'index', corpus=mod.CORPUS)
        self.lookup = helpers.load_lookup(ROOT, nodes_path=nodes, routes_path=routes)
        self.route_v2 = helpers._load_route_v2()
        self.index = self.route_v2.Index(str(index))

    def query(self, row):
        answer = self.route_v2.route(self.index, row['query'], k=DEPTH)
        return unique(self.lookup[item[0]] for item in answer.get('r', []))

    def close(self):
        shutil.rmtree(self.scratch, ignore_errors=True)


class CodeMap:
    """route/route_query.py with the subcommand named by the row mode."""

    name = 'code_map'

    def __init__(self):
        import route_query
        self.map = route_query.Map()

    def query(self, row):
        rows = getattr(self.map, row['mode'])(row['query'], DEPTH * 4)
        return unique(item['path'] for item in rows)

    def close(self):
        pass


def measure(router, rows):
    per_query, timings = {}, []
    for row in rows:
        started = time.perf_counter()
        paths = router.query(row)
        timings.append(time.perf_counter() - started)
        per_query[row['id']] = {'rank': rank_of(paths, set(row['gold'])), 'got': paths[:3]}
    groups = {}
    for row in rows:
        rank = per_query[row['id']]['rank']
        for key in ('all', 'split:' + row['split'], 'mode:' + row['mode'], row['split'] + ':' + row['mode']):
            groups.setdefault(key, []).append(rank)
    return {'summary': {key: summary(value) for key, value in sorted(groups.items())},
            'mean_ms': round(1000 * sum(timings) / len(timings), 1) if timings else 0.0,
            'queries': per_query}


def run(names=('catalogue', 'code_map'), rows=None):
    rows = load() if rows is None else rows
    report = {}
    for router_class in (CatalogueRouter, CodeMap):
        if router_class.name not in names:
            continue
        router = router_class()
        try:
            report[router_class.name] = measure(router, rows)
        finally:
            router.close()
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--router', choices=['catalogue', 'code_map', 'both'], default='both')
    parser.add_argument('--summary', action='store_true', help='omit per-query ranks')
    args = parser.parse_args(argv)
    names = ('catalogue', 'code_map') if args.router == 'both' else (args.router,)
    report = run(names)
    if args.summary:
        report = {name: {'summary': value['summary'], 'mean_ms': value['mean_ms']} for name, value in report.items()}
    print(json.dumps(report, indent=1, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
