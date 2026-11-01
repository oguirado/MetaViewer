"""Stop only the capsule from this unit's own dev app, then its owned PIDs."""
import json
import time
from p18e_live import STATE, rpc, stop

state=json.loads(STATE.read_text())
choices=rpc(state,'eval',source='metaviewerRoles.choices()')
active=[c for c in choices if c.get('surfaceId')]
assert all(c['profileId']=='mv-live-3' for c in active), active
for choice in active:
    surface=choice['surfaceId']
    for prefix in ['tile-menu-','tile-stop-']:
        rpc(state,'eval',source='document.getElementById('+json.dumps(prefix+surface)+').click();true')
        time.sleep(.2)
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        if not any(c.get('surfaceId') for c in rpc(state,'eval',source='metaviewerRoles.choices()')):break
        time.sleep(.1)
    else:raise RuntimeError('OWN_CAPSULE_STOP_TIMEOUT')
stop(state)
