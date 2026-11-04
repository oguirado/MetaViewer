#!/usr/bin/env python3
"""Validate the new family, then use the existing whole-registry generator."""
import argparse,importlib.util,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
    schema=json.loads((ROOT/'contracts/v0.2/rewind_envelope.schema.json').read_text())
    if {b['$ref'] for b in schema['properties']['body']['oneOf']}!={'rewind_request.schema.json','rewind_event.schema.json'}:raise SystemExit('rewind family is not closed')
    spec=importlib.util.spec_from_file_location('canonical_sdk_generator',ROOT/'tools/generate_guest_command_sdk.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    expected=module.generated();path=ROOT/'agents/metaviewer_agents/_contracts_v02.py'
    if args.check:
        if path.read_text()!=expected:raise SystemExit('canonical SDK registry drift')
    else:path.write_text(expected)
if __name__=='__main__':main()
