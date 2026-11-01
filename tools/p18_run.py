#!/usr/bin/env python3
"""Run a bounded P18 verification command and record only its owned process tree."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / '.p18-evidence'
LEDGER = Path('/home/admin/Música/TeamWork_Antigravity2/campaigns/metaviewer-0/out/pids.log')

def run(label, argv):
    EVIDENCE.mkdir(exist_ok=True)
    env = dict(os.environ)
    env.pop('MV_WENDER_ROOT', None)
    env.update(CAPSULE_UI_KIT_REPO='/home/admin/.cache/metaviewer-kit/kit-v0.2.1',
               ELECTRON_OVERRIDE_DIST_PATH='/home/admin/Documentos/Games/Holdings-int/app/shell/node_modules/electron/dist',
               MV_MW_WENDER_ROOT='/home/admin/Documentos/wender-agent-wt-pin',
               CARGO_TARGET_DIR='/home/admin/.cache/cargo-target/mv-wt-p18')
    env['PATH'] = '/home/admin/.nvm/versions/node/v24.14.0/bin:/usr/local/go/bin:/home/admin/.cargo/bin:' + env.get('PATH', '')
    start = time.monotonic()
    seen = set()
    with (EVIDENCE / (label + '.log')).open('w') as output:
        p = subprocess.Popen(argv, env=env, stdout=output, stderr=subprocess.STDOUT)
        while True:
            table = {}
            for item in Path('/proc').iterdir():
                if not item.name.isdigit(): continue
                try:
                    fields = (item/'stat').read_text().rsplit(') ',1)[1].split()
                    table[int(item.name)] = (int(fields[1]),fields[19])
                except (OSError, ValueError, IndexError): continue
            own = {p.pid}
            while True:
                more = {pid for pid,(parent,_) in table.items() if parent in own}
                if more <= own: break
                own |= more
            with LEDGER.open('a') as ledger:
                for pid in own-seen:
                    ledger.write(json.dumps(dict(unit='P18-MODES-TILES',pid=pid,starttime=table.get(pid,(None,None))[1],kind=label))+'\n')
            seen |= own
            if p.poll() is not None: break
            time.sleep(.02)
        rc = p.wait()
    receipt = dict(label=label,command=argv,cwd=os.getcwd(),rc=rc,elapsed_s=round(time.monotonic()-start,3))
    with (EVIDENCE/'commands.jsonl').open('a') as f: f.write(json.dumps(receipt)+'\n')
    print(json.dumps(receipt),flush=True)
    return rc

if __name__ == '__main__':
    raise SystemExit(run(sys.argv[1],sys.argv[2:]))
