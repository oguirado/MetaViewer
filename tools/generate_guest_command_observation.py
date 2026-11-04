#!/usr/bin/env python3
"""Generate the additive read-only observation validator from canonical schemas."""
import argparse,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
NAMES=('guest_command_observation','guest_command_observation_envelope')
def generated():
    schemas={name+'.schema.json':json.loads((ROOT/'contracts/v0.2'/f'{name}.schema.json').read_text()) for name in NAMES}
    return "import {createRewindChecks} from './rewindChecks.js';\n// Generated from canonical read-only observation contracts.\nconst schemas="+json.dumps(schemas,separators=(',',':'),ensure_ascii=False)+";\nconst {rewindValid}=createRewindChecks(schemas);\n/** @param {unknown} value */\nexport const observationValid=value=>rewindValid('guest_command_observation.schema.json',value);\n/** @param {unknown} value */\nexport const observationEnvelopeValid=value=>rewindValid('guest_command_observation_envelope.schema.json',value);\n"
def main():
    p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');a=p.parse_args();path=ROOT/'ui/electron/guestCommandObservationValues.js';text=generated()
    if a.check:
        if path.read_text()!=text:raise SystemExit('observation validator drift')
    else:path.write_text(text)
if __name__=='__main__':main()
