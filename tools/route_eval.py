#!/usr/bin/env python3
"""Measure route_query.py docs and any on route/eval/questions.jsonl: top 1 and top 5.

Rows are the CLI shortlist (default 8 rows, under 2000 bytes). A row hits when any coordinate it carries starts with one of the question's expected
prefixes. Expected targets are written before the run. Standard library only.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def coordinates(row):
    out = [row.get('ref', ''), row.get('at', ''), row.get('path', '')]
    out.extend(row.get('code', []))
    return [value for value in out if value]


def rank_of(rows, expect):
    for position, row in enumerate(rows, 1):
        if any(value == prefix or (prefix.endswith('/') and value.startswith(prefix))
               or any(value.startswith(prefix + separator) for separator in ('#', '@', ':'))
               for value in coordinates(row) for prefix in expect):
            return position
    return None


def evaluate(module, route, questions, commands):
    details = []
    totals = {name: {'positive': 0, 'top1': 0, 'top5': 0, 'negative': 0,
                     'abstained': 0, 'max_bytes': 0} for name in commands}
    for item in questions:
        result = {'id': item.get('id'), 'q': item['q']}
        for command in commands:
            rows = getattr(route, command)(item['q'], 8)
            reason = 'unsupported_query' if route.unsupported(item['q']) else 'no_query_term'
            rendered = module.shortlist(rows, None if rows else reason)
            rows = json.loads(rendered)['rows']
            position = rank_of(rows, item['expect'])
            stats = totals[command]
            stats['max_bytes'] = max(stats['max_bytes'], len(rendered.encode('utf-8')) + 1)
            if item.get('abstain', False):
                stats['negative'] += 1
                stats['abstained'] += not rows
            else:
                stats['positive'] += 1
                stats['top1'] += position == 1
                stats['top5'] += position is not None and position <= 5
            result[command] = {'rank': position, 'abstained': not rows}
        details.append(result)
    return {'unit': 'bytes', 'results': details, 'totals': totals}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, default=ROOT / 'route/eval/questions.jsonl')
    parser.add_argument('--commands', nargs='+', choices=['docs', 'any'], default=['docs', 'any'])
    parser.add_argument('--min-top5', type=int, default=0)
    parser.add_argument('--min-abstain', type=int, default=0)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    spec = importlib.util.spec_from_file_location('route_query', ROOT / 'route' / 'route_query.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    route = module.Map()
    questions = [json.loads(line) for line in args.dataset.read_text(encoding='utf-8').splitlines() if line]
    if not questions or len({item.get('id', item['q']) for item in questions}) != len(questions):
        parser.error('dataset must be nonempty with unique questions or ids')
    report = evaluate(module, route, questions, args.commands)
    for row in report['results']:
        print(json.dumps(row))
    print(json.dumps({'totals': report['totals']}))
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    return int(any(stats['top5'] < args.min_top5 or stats['abstained'] < args.min_abstain
                   or stats['max_bytes'] > module.SHORTLIST_BYTES for stats in report['totals'].values()))


if __name__ == '__main__':
    sys.exit(main())
