#!/usr/bin/env python3
"""Generate only the new rewind validator mirrors; frozen schemas stay intact."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAMES = ('rewind_request', 'rewind_event', 'rewind_session', 'rewind_point')


def main():
    schemas = {name+'.schema.json': json.loads((ROOT/'contracts/v0.2'/f'{name}.schema.json').read_text()) for name in NAMES}
    checks = (ROOT/'ui/electron/rewindChecks.js').read_text()
    head = '// Generated from new rewind contracts and rewindChecks.js.\nconst RW_SCHEMAS = '+json.dumps(schemas,separators=(',', ':'),ensure_ascii=False)+';\n'
    module = "import {createRewindChecks} from './rewindChecks.js';\n"+head+'export const {rewindValid,rewindAction,rewindSnapshot}=createRewindChecks(RW_SCHEMAS);\n'
    (ROOT/'ui/electron/rewindValues.js').write_text(module)
    preload = ROOT/'ui/electron/preload.js'
    text = preload.read_text()
    start, end = '// REWIND_VALIDATORS_BEGIN', '// REWIND_VALIDATORS_END'
    block = start+'\n'+head+checks.replace('export function createRewindChecks','function createRewindChecks',1)+'\nconst {rewindValid,rewindAction,rewindSnapshot}=createRewindChecks(RW_SCHEMAS);\n'+end+'\n'
    if start in text:
        a=text.index(start); b=text.index(end,a)+len(end)+1
        text=text[:a]+block+text[b:]
    else:
        text=text.replace('const WIRE_NAMES = ',block+'const WIRE_NAMES = ',1)
    preload.write_text(text)


if __name__ == '__main__':
    main()
