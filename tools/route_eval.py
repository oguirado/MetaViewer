#!/usr/bin/env python3
"""Measure route_query.py docs and any on route/eval/questions.jsonl: top 1 and top 5.

Rows are the CLI shortlist (default 8 rows, under 2000 bytes). A row hits when any coordinate it carries starts with one of the question's expected
prefixes. Expected targets are written before the run. Standard library only.
"""
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
        if any(value.startswith(prefix) for value in coordinates(row) for prefix in expect):
            return position
    return None


def main():
    spec = importlib.util.spec_from_file_location('route_query', ROOT / 'route' / 'route_query.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    route = module.Map()
    questions = [json.loads(line) for line in (ROOT / 'route' / 'eval' / 'questions.jsonl').read_text(encoding='utf-8').splitlines() if line]
    totals = {'docs': [0, 0], 'any': [0, 0]}
    for item in questions:
        ranks = {}
        for command in totals:
            rows = json.loads(module.shortlist(getattr(route, command)(item['q'], 8)))['rows']
            position = rank_of(rows, item['expect'])
            ranks[command] = position
            totals[command][0] += position == 1
            totals[command][1] += position is not None and position <= 5
        print(json.dumps({'q': item['q'], 'docs_rank': ranks['docs'], 'any_rank': ranks['any']}))
    for command, (top1, top5) in totals.items():
        print(f'{command}: top1 {top1}/{len(questions)} top5 {top5}/{len(questions)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
