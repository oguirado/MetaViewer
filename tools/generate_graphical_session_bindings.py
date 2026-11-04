#!/usr/bin/env python3
"""Generate the closed UI validator's schema table from canonical contracts."""
import argparse, json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
FILES=('graphical_session_request.schema.json','graphical_session_event.schema.json','graphical_session.schema.json','graphical_session_envelope.schema.json')
OUT=ROOT/'ui/electron/graphicalSessionValues.js'
PRELOAD=ROOT/'ui/electron/preload.js'
BEGIN='// GRAPHICAL_SESSION_VALIDATORS_BEGIN'
END='// GRAPHICAL_SESSION_VALIDATORS_END'

def render():
    schemas={name:json.loads((ROOT/'contracts/v0.2'/name).read_text(encoding='utf-8')) for name in FILES}
    body=json.dumps(schemas,ensure_ascii=True,separators=(',',':'),sort_keys=True)
    source=json.dumps(body,ensure_ascii=True,separators=(',',':'))
    return "import {createGraphicalSessionChecks} from './graphicalSessionChecks.js';\n// Generated from canonical graphical session contracts.\nconst GRAPHICAL_SCHEMAS_JSON = "+source+";\nlet graphicalSchemas;\nconst getGraphicalSchemas=()=>graphicalSchemas??=(JSON.parse(GRAPHICAL_SCHEMAS_JSON));\nexport const {graphicalValid,graphicalAction,graphicalSnapshot,graphicalPlain}=createGraphicalSessionChecks(getGraphicalSchemas);\n"

def main():
    p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');p.add_argument('--preload',action='store_true');a=p.parse_args();expected=render()
    table=next(line for line in expected.splitlines() if line.startswith('const GRAPHICAL_SCHEMAS_JSON = '))
    checks=(ROOT/'ui/electron/graphicalSessionChecks.js').read_text().replace('export function createGraphicalSessionChecks','function createGraphicalSessionChecks',1)
    block=BEGIN+'\n'+table+'\nlet graphicalSchemas;\nconst getGraphicalSchemas=()=>graphicalSchemas??=(JSON.parse(GRAPHICAL_SCHEMAS_JSON));\n'+checks+'\nconst {graphicalValid,graphicalAction,graphicalSnapshot}=createGraphicalSessionChecks(getGraphicalSchemas);\n'+END+'\n'
    if a.check:
        if not OUT.exists() or OUT.read_text(encoding='utf-8')!=expected: raise SystemExit('graphical bindings stale')
        if a.preload:
            text=PRELOAD.read_text();start=text.find(BEGIN);stop=text.find(END,start)
            if start<0 or stop<0 or text[start:stop+len(END)+1]!=block:raise SystemExit('graphical preload bindings stale')
        print('graphical bindings current');return
    OUT.write_text(expected,encoding='utf-8')
    if a.preload:
        text=PRELOAD.read_text()
        if BEGIN in text:
            start=text.index(BEGIN);stop=text.index(END,start)+len(END)+1;text=text[:start]+block+text[stop:]
        else:
            assert text.count('const WIRE_NAMES = ')==1
            text=text.replace('const WIRE_NAMES = ',block+'const WIRE_NAMES = ',1)
        PRELOAD.write_text(text)

if __name__=='__main__':main()
