"""Own :95 panel check. A refused native open never counts as a painted tile.

The header permits only one own live capsule; stop it before any other opening.
All created identities are removed through the app even when a live gate fails.
"""
import json
from pathlib import Path
import time
from p18d_live import STATE, OUT, rpc

state = json.loads(STATE.read_text())
identities = ['p18d-a', 'p18d-b']


def evaluate(source):
    return rpc(state, 'eval', source=source)


def wait(source, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = evaluate(source)
        if result:
            return result
        time.sleep(.05)
    raise RuntimeError('OWN_PANEL_TIMEOUT ' + source)


def panel():
    if not evaluate("!!document.getElementById('identities-dialog')"):
        evaluate("document.getElementById('shell-identities').click();true")
    wait("!!document.querySelector('#identities-dialog input[aria-label=Name]:not(:disabled)')")


def row_action(identity, label):
    return f"(()=>{{const row=[...document.querySelectorAll('.identity-row')].find(n=>n.querySelector('code').textContent==={json.dumps(identity)});return [...(row?.querySelectorAll('button')||[])].find(n=>n.textContent.trim()==={json.dumps(label)});}})()"


def delete(identity):
    panel()
    evaluate(f"({row_action(identity,'Delete')}).click();true")
    wait("!!document.getElementById('identity-delete-dialog-confirm')")
    evaluate("document.getElementById('identity-delete-dialog-confirm').click();true")
    wait(f"![...document.querySelectorAll('#identities-dialog code')].some(n=>n.textContent==={json.dumps(identity)})")
    profile = Path(state['identityRoot'])/'profiles'/identity
    if profile.exists() or profile.is_symlink(): raise RuntimeError('OWN_PROFILE_REMAINS')
    print(json.dumps(dict(deletedThroughPanel=identity,profileRemoved=True)), flush=True)


def stop_own():
    for choice in evaluate('metaviewerRoles.choices()'):
        if choice['profileId'] in identities and choice.get('surfaceId'):
            result = evaluate(f"metaviewerRoles.stop({json.dumps(choice['surfaceId'])})")
            if not result.get('ok'):
                raise RuntimeError('OWN_CAPSULE_STOP_REFUSED')
            print(json.dumps(dict(stopped=choice['profileId'])), flush=True)


log = (OUT/'live-app.log').read_text()
assert 'P18D_DEV_LOCK_ISOLATED' in log
assert not any(marker in log for marker in ['SINGLE_INSTANCE', 'BOOT_REFUSED'])
print(json.dumps(dict(lockIsolated=True, display=':95')), flush=True)
blocked = []
try:
    # Recover the previous interrupted check through the same product UI.
    existing = evaluate('metaviewer.operator.identity.list()')
    if not existing.get('ok'):
        raise RuntimeError('OWN_LIST_REFUSED')
    for row in existing['rows']:
        if row['id'] in identities:
            delete(row['id'])
    panel()
    for identity in identities:
        evaluate(f"(()=>{{const input=document.querySelector('#identities-dialog input[aria-label=Name]');input.value={json.dumps(identity)};input.dispatchEvent(new Event('input',{{bubbles:true}}));return true;}})()")
        wait("!!document.querySelector('#identities-dialog-confirm:not(:disabled)')")
        evaluate("document.getElementById('identities-dialog-confirm').click();true")
        wait(f"[...document.querySelectorAll('#identities-dialog code')].some(n=>n.textContent==={json.dumps(identity)}) && !document.querySelector('#identities-dialog input[aria-label=Name]').value")
        st = (Path(state['identityRoot'])/'profiles'/identity).stat()
        if st.st_uid != 10001 or st.st_gid != 10001 or st.st_mode & 0o7777 != 0o700:
            raise RuntimeError('OWN_PROFILE_STAT_FAILED')
        print(json.dumps(dict(createdThroughPanel=identity,profileUID=st.st_uid,profileGID=st.st_gid,profileMode=oct(st.st_mode & 0o7777))), flush=True)
    choices = evaluate('metaviewerRoles.choices()')
    print(json.dumps(dict(runtimeChoices=[row for row in choices if row['profileId'] in identities], modal=evaluate("document.body.hasAttribute('data-mv-modal')"))), flush=True)
    # One capsule identity, sequential modes, never simultaneous capsules.
    identity = 'p18d-a'
    panel()
    wait(f"({row_action(identity,'Open as human')})?.disabled === false")
    evaluate(f"({row_action(identity,'Open as human')}).click();true")
    wait("!document.getElementById('identities-dialog')")
    wait(f"metaviewerRoles.choices().then(rows=>rows.some(row=>row.profileId==={json.dumps(identity)} && !row.busy))")
    choice = next(row for row in evaluate('metaviewerRoles.choices()') if row['profileId'] == identity)
    owner = (Path(state['identityRoot'])/'profiles'/identity).stat().st_uid
    print(json.dumps(dict(openAttempt=identity, requestedMode='human', choice=choice, profileOwnerUID=owner)), flush=True)
    if not choice.get('surfaceId'):
        blocked.append('PROFILE_NOT_PROVISIONED' if owner != 10001 else 'NATIVE_OPEN_REFUSED')
    else:
        wait("[...document.querySelectorAll('.mv-role-surface')].length > 0")
        def painted(role):
            deadline = time.monotonic()+25
            native = None
            while time.monotonic()<deadline:
                native = rpc(state, 'tile-status')
                if native and native.get('connected') and native.get('remoteWindows'):
                    box = evaluate("(()=>{const r=[...document.querySelectorAll('.mv-role-viewport')].find(n=>n.getBoundingClientRect().width>0)?.getBoundingClientRect();return r?{w:r.width,h:r.height}:null})()")
                    if not box: raise RuntimeError('OWN_TILE_BOUNDS_ABSENT')
                    samples = [rpc(state,'pixel',x=int(box['w']/2),y=int(box['h']*f)) for f in [.33,.5,.67]]
                    # A fresh browser may paint a uniform blank page. Its opaque
                    # pixels must differ from the wrapper/reconnect background.
                    if (all(len(pixel)==4 and pixel[3]>0 for pixel in samples) and
                            any(pixel[:3] != [48,35,24] for pixel in samples) and
                            native.get('readonly') is (role == 'agent')):
                        print(json.dumps(dict(paintedMode=role,native=native,distinctPixelSamples=len({tuple(p) for p in samples}))),flush=True)
                        return
                time.sleep(.1)
            print(json.dumps(dict(paintFailure=role,native=native,lastSamples=locals().get('samples'))),flush=True)
            raise RuntimeError('PAINT_UNPROVEN '+role)
        painted('human')
        panel()
        evaluate(f"({row_action(identity,'Delete')}).click();true")
        wait("[...document.querySelectorAll('#identities-dialog [role=alert]')].some(n=>n.textContent.includes('Stop it first'))")
        if evaluate("!!document.getElementById('identity-delete-dialog')"):
            raise RuntimeError('OPEN_IDENTITY_DELETE_OFFERED')
        print(json.dumps(dict(deleteWhileOpen='refused')), flush=True)
        evaluate("[...document.querySelectorAll('#identities-dialog button')].find(n=>n.textContent.trim()==='Close').click();true")
        wait("!document.getElementById('identities-dialog')")
        # Mode switching stops before restart; only this identity is opened.
        evaluate("[...document.querySelectorAll('.mv-role-surface button')].find(n=>n.textContent.trim()==='Switch to agent mode').click();true")
        wait("metaviewerRoles.choices().then(rows=>rows.some(row=>row.profileId==='p18d-a' && row.currentMode==='agent' && row.surfaceId && !row.busy))",seconds=35)
        # Agent mode has a normal captured canvas and an explicit read-only watch.
        wait("!![...document.querySelectorAll('.mv-role-surface button')].find(n=>n.textContent.trim()==='Watch read-only')")
        evaluate("[...document.querySelectorAll('.mv-role-surface button')].find(n=>n.textContent.trim()==='Watch read-only').click();true")
        painted('agent')
finally:
    stop_own()
    listed = evaluate('metaviewer.operator.identity.list()')
    if not listed.get('ok'):
        raise RuntimeError('OWN_CLEANUP_LIST_REFUSED')
    for row in listed['rows']:
        if row['id'] in identities:
            delete(row['id'])
    rows = evaluate('metaviewer.operator.identity.list()')
    registry = json.loads((Path(state['root'])/'registry.json').read_text())
    leftovers = [row['id'] for row in rows.get('rows',[]) if row['id'].startswith('p18d-')]
    registry_leftovers = [name for name in registry if name in state['containers'] or 'p18d-' in name]
    print(json.dumps(dict(storeLeftovers=leftovers, registryLeftovers=registry_leftovers)), flush=True)
    if leftovers or registry_leftovers:
        raise RuntimeError('OWN_IDENTITY_LEFTOVERS')
if blocked:
    raise SystemExit('LIVE_GATE_BLOCKED ' + ','.join(blocked))
