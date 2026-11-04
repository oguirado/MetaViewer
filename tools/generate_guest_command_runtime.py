#!/usr/bin/env python3
"""Keep the private Python provider's closed schemas equal to canonical data."""
import argparse
import json
from pathlib import Path
import pprint

ROOT=Path(__file__).resolve().parents[1]
NAMES=('guest_command_request','guest_command_event','guest_command_session','guest_transport_metadata')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
    data={name+'.schema.json':json.loads((ROOT/'contracts/v0.2'/(name+'.schema.json')).read_text()) for name in NAMES}
    expected='"""Frozen guest-command schemas; canonical parity required before shipping."""\nSCHEMAS = '+pprint.pformat(data,width=110,sort_dicts=True)+'\n'
    target=ROOT/'daemon-adapter/guest_command_runtime/_schemas.py'
    if args.check:
        if target.read_text()!=expected:raise SystemExit('private guest-command schema mirror is stale')
    else:target.write_text(expected)

if __name__=='__main__':main()
