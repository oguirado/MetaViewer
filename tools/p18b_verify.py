"""Run the isolated native smoke with cleanup in the same memory scope."""
import json
from pathlib import Path
import subprocess
import sys
import time
import p18b_live as live

def run(args):
    p = subprocess.Popen(args)
    live.record(pid=p.pid, kind='P18B R2 live supervisor child')
    rc = p.wait()
    print(json.dumps({'command': args, 'rc': rc}), flush=True)
    if rc: raise RuntimeError('LIVE_SUBCOMMAND_FAILED')

previous_state = live.STATE.read_bytes() if live.STATE.exists() else None
try:
    run([sys.executable, 'tools/p18b_live.py', 'start'])
    state = json.loads(live.STATE.read_text())
    root = Path(state['root'])
    deadline = time.monotonic()+150
    while True:
        choices = live.rpc(root, 'eval', source='metaviewerRoles.choices()')
        if not choices or choices[0].get('profileId') != 'mv-live-3': raise RuntimeError('OWN_PROFILE_UNPROVEN')
        choice = choices[0]
        if choice.get('surfaceId'): break
        if not choice.get('busy'):
            result = live.rpc(root, 'eval', source="metaviewerRoles.open({profileId:'mv-live-3',role:'human'})")
            if not result.get('ok'): raise RuntimeError('OWN_HUMAN_OPEN_REFUSED '+str(result.get('code')))
        if time.monotonic()>deadline:
            print(json.dumps({'ownChoices': choices}), flush=True)
            print(live.rpc(root,'eval',source="document.body.innerText"),flush=True)
            raise RuntimeError('OWN_HUMAN_START_UNPROVEN')
        time.sleep(.25)
    print(json.dumps({'ownChoices': choices}), flush=True)
    run([sys.executable, 'tools/p18b_smoke.py'])
finally:
    # This state was emitted only by our startup; cleanup verifies starttime
    # before signalling any recorded PID and names only our reserved capsule.
    if live.STATE.exists() and live.STATE.read_bytes() != previous_state: run([sys.executable, 'tools/p18b_live.py', 'stop'])
