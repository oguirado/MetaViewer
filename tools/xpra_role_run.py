#!/usr/bin/env python3
"""Bounded command receipts for the isolated role-tile verification."""
import json, os, pathlib, subprocess, sys, time
ROOT = pathlib.Path(__file__).resolve().parents[1]
label, *argv = sys.argv[1:]
if argv and argv[0] == '--': argv.pop(0)
logs = ROOT / '.xpra-evidence'
logs.mkdir(exist_ok=True)
start = time.time()
env = dict(os.environ)
env.pop('MV_WENDER_ROOT', None)
env['PATH'] = '/usr/local/go/bin:/home/admin/.nvm/versions/node/v24.14.0/bin:/home/admin/.cargo/bin:' + env.get('PATH','')
env.update(CAPSULE_UI_KIT_REPO='/home/admin/.cache/metaviewer-kit/kit-v0.2.1', ELECTRON_OVERRIDE_DIST_PATH='/home/admin/Documentos/Games/Holdings-int/app/shell/node_modules/electron/dist', MV_MW_WENDER_ROOT='/home/admin/Documentos/wender-agent-wt-pin', CARGO_TARGET_DIR='/home/admin/.cache/cargo-target/mv-wt-xtile')
with open(logs / (label + '.log'), 'w') as output:
    p = subprocess.Popen(argv, stdout=output, stderr=subprocess.STDOUT, env=env)
    with open('/home/admin/Música/TeamWork_Antigravity2/campaigns/metaviewer-0/out/pids.log','a') as f:
        f.write(f'XPRA-ROLE-TILES PID {p.pid} {label}\n')
    rc = p.wait()
row = dict(label=label, cwd=os.getcwd(), argv=argv, rc=rc, elapsed_s=round(time.time()-start,3), pid=p.pid)
with open(logs / 'role-commands.jsonl','a') as f: f.write(json.dumps(row)+'\n')
print(json.dumps(row))
sys.exit(rc)
