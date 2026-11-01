"""Only this unit's isolated dev app. No operator display, profile or capsule."""
import json
import time
from p18e_live import STATE, OUT, rpc

state=json.loads(STATE.read_text())
def evaluate(source):
    return rpc(state,'eval',source=source)
def wait(source,timeout=60):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        value=evaluate(source)
        if value:return value
        time.sleep(.1)
    raise RuntimeError('LIVE_GATE_UNPROVEN '+source[:100])
def click(id):
    assert evaluate('(()=>{const e=document.getElementById('+json.dumps(id)+');if(!e||e.disabled)return false;e.click();return true})()'),id
    time.sleep(.1)

evaluate('(()=>{const c=[...document.querySelectorAll("#identities-dialog button")].find(e=>e.textContent.trim()==="Close");if(c)c.click();return true})()')
choices=evaluate('metaviewerRoles.choices()')
assert len(choices)==1 and choices[0]['profileId']=='mv-live-3' and choices[0]['currentMode']=='agent', choices
surface=choices[0]['surfaceId']
click('view-agent')
click('tile-menu-'+surface)
wait('!!document.getElementById('+json.dumps('tile-watch-'+surface)+')')
started=time.monotonic()
click('tile-watch-'+surface)
initial=evaluate('document.querySelector(".mv-role-status")?.textContent')
assert initial!='Reconnecting…',initial
wait('(async()=>{const s=await metaviewerRoles.status('+json.dumps(surface)+');return s.view?.state==="ready"})()')
ready_ms=round((time.monotonic()-started)*1000)
tile=rpc(state,'tile-status')
assert tile['connected'] is True and tile['readonly'] is True and tile['remoteWindows']>0,tile
assert evaluate('!document.body.hasAttribute("data-mv-modal")')
click('tile-menu-'+surface);click('tile-watch-'+surface)
wait('(async()=>{const s=await metaviewerRoles.status('+json.dumps(surface)+');return s.view?.state==="closed"})()')
assert rpc(state,'tile-status') is None

# Name, Display name, creation and deletion through the panel, own private store.
click('shell-identities')
wait('!!document.querySelector("#identities-dialog input[aria-label=Name]")')
def name_input(value):
    evaluate('(()=>{const e=document.querySelector("#identities-dialog input[aria-label=Name]");e.value='+json.dumps(value)+';e.dispatchEvent(new Event("input",{bubbles:true}));return true})()')
name_input('P18e Prueba1!')
wait('document.querySelector("#identities-dialog input[aria-label=Name]").value==="p18e-prueba1"')
assert evaluate('document.querySelector(`#identities-dialog input[aria-label="Display name"]`).value')=='P18e Prueba1!'
assert evaluate('document.getElementById("identity-normalized").textContent')=='Will be saved as p18e-prueba1'
# Rejected punctuation must disappear even when the normalized model is unchanged.
name_input('p18e-prueba1!')
wait('document.querySelector("#identities-dialog input[aria-label=Name]").value==="p18e-prueba1"')
click('identities-dialog-confirm')
wait('[...document.querySelectorAll("#identities-dialog code")].some(e=>e.textContent==="p18e-prueba1")')
assert evaluate('[...document.querySelectorAll(".identity-row")].find(e=>e.querySelector("code")?.textContent==="p18e-prueba1").querySelector("strong").textContent')=='P18e Prueba1!!'
# The only configured live identity is protected; never click its Delete action.
assert evaluate('(()=>{const b=[...document.querySelectorAll(".identity-row")].find(e=>e.querySelector("code")?.textContent==="mv-live-3")?.querySelector(`button[title="Managed outside MetaViewer"]`);return b?.disabled===true})()')
evaluate('(()=>{const row=[...document.querySelectorAll(".identity-row")].find(e=>e.querySelector("code")?.textContent==="p18e-prueba1");[...row.querySelectorAll("button")].find(e=>e.textContent.trim()==="Delete").click();return true})()')
wait('!!document.getElementById("identity-delete-dialog-confirm")')
click('identity-delete-dialog-confirm')
wait('![...document.querySelectorAll("#identities-dialog code")].some(e=>e.textContent==="p18e-prueba1")')
evaluate('[...document.querySelectorAll("#identities-dialog button")].find(e=>e.textContent.trim()==="Close").click();true')
result=dict(profile='mv-live-3',surface=surface,initial=initial,watchReadyMs=ready_ms,
            tile=tile,watchClosed=True,identityCreated='p18e-prueba1',identityDeleted=True)
(OUT/'live-result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
