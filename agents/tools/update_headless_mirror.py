"""Regenerate only the additive headless slice of the embedded Python contracts."""
import argparse
import json
from pathlib import Path
import pprint

ROOT = Path(__file__).resolve().parents[2]
MARKER = '\n# HEADLESS_CONTRACT_EXTENSION_BEGIN\n'

def clean(schema):
    if isinstance(schema, list):
        return [clean(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    out = {}
    for key, value in schema.items():
        if key in ('$schema', '$id', 'title', 'description'):
            continue
        if key in ('properties', '$defs'):
            out[key] = {name: clean(item) for name, item in value.items()}
        else:
            out[key] = clean(value)
    return out

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    target = ROOT / 'agents/metaviewer_agents/_contracts_v02.py'
    current = target.read_text()
    if current.count(MARKER) > 1:
        raise ValueError('ambiguous generated region')
    names = ('headless_event', 'headless_request', 'headless_session', 'envelope')
    schemas = {name + '.schema.json': clean(json.loads(
        (ROOT / 'contracts/v0.2' / (name + '.schema.json')).read_text())) for name in names}
    expected = current.split(MARKER)[0] + MARKER + 'FILES.update(' + pprint.pformat(
        schemas, width=100, sort_dicts=False) + ')\n# HEADLESS_CONTRACT_EXTENSION_END\n'
    if args.check:
        if current != expected:
            raise SystemExit('headless Python mirror drift')
    else:
        target.write_text(expected)

if __name__ == '__main__':
    main()
