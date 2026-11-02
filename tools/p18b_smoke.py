"""Exercise only this unit's dev app and dedicated capsule on its own display."""
import json
import os
from pathlib import Path
import struct
import subprocess
import time
import p18b_live as live

state = live.refresh_bindings(json.loads(live.STATE.read_text()))
root = Path(state['root'])
assert str(root).startswith('/tmp/claude-1000/xpra-spike/p18-live-')

def evaluate(source):
    return live.rpc(root, 'eval', source=source)

def wait(source, timeout=90):
    end = time.monotonic()+timeout
    while time.monotonic()<end:
        result = evaluate(source)
        if result: return result
        time.sleep(.15)
    raise RuntimeError('LIVE_GATE_UNPROVEN '+source[:160])

def run(argv):
    p=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=dict(os.environ,DISPLAY=':97'))
    live.record(pid=p.pid,kind='P18B owned screenshot fixture',root=str(root))
    output,error=p.communicate(timeout=20)
    if p.returncode: raise RuntimeError('OWN_SCREENSHOT_FAILED '+error.decode()[:200])
    return output

def capture(label):
    pid=next(p['pid'] for p in state['processes'] if p['kind']=='dev-app')
    window=run(['xdotool','search','--onlyvisible','--pid',str(pid)]).decode().splitlines()[0]
    data=run(['xwd','-display',':97','-id',window,'-silent'])
    header=struct.unpack('>25I',data[:100])
    size,_,_,depth,width,height,_,order,_,_,_,bits,stride,_,red,green,blue,_,_,colors,*_=header
    assert depth==24 and bits==32 and order==0 and (red,green,blue)==(0xff0000,0xff00,0xff)
    offset=size+colors*12
    (live.EVIDENCE/(label+'.xwd')).write_bytes(data)
    def pixel(x,y):
        assert 0<=x<width and 0<=y<height
        b,g,r,_=data[offset+int(y)*stride+int(x)*4:offset+int(y)*stride+int(x)*4+4]
        return [r,g,b]
    return pixel

def current():
    global state
    state=live.refresh_bindings(state)
    value=evaluate('(async()=> (await metaviewerRoles.choices())[0])()')
    assert value['profileId']=='mv-live-3' and value['surfaceId']
    return value

def click_id(identifier):
    assert evaluate('(()=>{const e=document.getElementById('+json.dumps(identifier)+');if(!e)return false;e.click();return true})()')
    time.sleep(.25)

def click_text(label):
    assert evaluate('(()=>{const e=[...document.querySelectorAll("button")].find(e=>e.innerText==='+json.dumps(label)+');if(!e)return false;e.click();return true})()')
    time.sleep(.25)

def connected():
    end=time.monotonic()+45
    while time.monotonic()<end:
        value=live.rpc(root,'tile-status')
        if value and value.get('connected'):
            status=evaluate('(async()=>{const c=(await metaviewerRoles.choices())[0];return c.surfaceId ? await metaviewerRoles.status(c.surfaceId) : null})()')
            if status and status.get('view',{}).get('state')=='ready': return value
        time.sleep(.15)
    print(json.dumps(dict(lastClient=value,roleStatus=evaluate('(async()=>{const c=(await metaviewerRoles.choices())[0];return c.surfaceId ? await metaviewerRoles.status(c.surfaceId) : null})()'))),flush=True)
    raise RuntimeError('OWN_NATIVE_CONNECTION_UNPROVEN')

def menu_open():
    click_text('⋮')
    return wait('(()=>{const e=document.querySelector(".mv-role-menu-host [role=menu]");return e?.matches(":popover-open") && {text:e.innerText,rect:e.getBoundingClientRect().toJSON(),background:getComputedStyle(e).backgroundColor,frame:outerHeight-innerHeight,flag:document.body.getAttribute("data-mv-modal")}})()')

def stage_counts():
    text=(live.EVIDENCE/'dev-app.log').read_text()
    return {name:text.count(name) for name in ['stage=CLIENT_CONNECTED','stage=CLOSED']}

initial=wait('(async()=>{const c=(await metaviewerRoles.choices())[0];if(!c.surfaceId)return false;const s=await metaviewerRoles.status(c.surfaceId);return ["connecting","ready"].includes(s.view?.state)&&s.view.state})()')
click_id('shell-more')
early=wait('(()=>{const e=document.getElementById("shell-more-menu");return e?.matches(":popover-open")&&{rect:e.getBoundingClientRect().toJSON(),background:getComputedStyle(e).backgroundColor,frame:outerHeight-innerHeight}})()')
assert connected()['readonly'] is False
r=early['rect'];point=(int(r['right']-4),int(r['bottom']-4+early['frame']))
expected=[int(n) for n in early['background'].removeprefix('rgb(').removesuffix(')').split(',')]
assert capture('connecting-more')(*point)==expected, 'CONNECTING_NATIVE_COVERED_MENU'
click_id('shell-more');wait('!document.body.hasAttribute("data-mv-modal")')
print(json.dumps(dict(gate='More survives initial native readiness',openedDuring=initial,visibleThroughReadiness=True)),flush=True)
assert connected()['readonly'] is False
start=stage_counts()
click_id('shell-more')
more=wait('(()=>{const e=document.querySelector(".mv-more-menu [role=menu]");return e?.matches(":popover-open")&&{text:e.innerText,flag:document.body.getAttribute("data-mv-modal")}})()')
assert more['text'].splitlines()==['Storyboard','Settings','Terminal']
assert more['flag']=='open' and connected()['readonly'] is False
click_id('shell-more')
wait('!document.body.hasAttribute("data-mv-modal")')
assert connected()['readonly'] is False and stage_counts()==start
print(json.dumps(dict(gate='More over retained human view',sameConnection=True,menu=more)),flush=True)

# Pixel witness of a real menu covering the owned native human view. The
# screenshot selects the recorded app PID's window, never the operator display.
baseline=capture('human-before-menu')
menu=menu_open();r=menu['rect']
point=(int(r['right']-4),int(r['bottom']-4+menu['frame']))
before=baseline(*point);after=capture('human-menu')(*point)
expected=[int(n) for n in menu['background'].removeprefix('rgb(').removesuffix(')').split(',')]
assert before!=expected, 'PIXEL_CONTRAST_UNPROVEN'
assert after==expected, (before,after,expected)
assert menu['text'].splitlines()==['Switch to agent mode','I logged in','Stop capsule']
print(json.dumps(dict(gate='human menu above native view',before=before,after=after,expected=expected,modal=menu['flag'])),flush=True)

old=current();click_text('Switch to agent mode')
wait('(async()=>{const c=(await metaviewerRoles.choices())[0];return c.currentMode==="agent"&&c.surfaceId!=='+json.dumps(old['surfaceId'])+'&&c})()')
agent=current();menu=menu_open()
assert menu['text'].splitlines()==['Switch to human mode','Watch read-only','Stop capsule','Take control (emergency)']
click_text('Watch read-only');assert connected()['readonly'] is True
click_id('window-hide-panel-'+agent['surfaceId'])
hidden='(()=>{const b=document.querySelector("[data-window-capsule-id=\\"'+agent['surfaceId']+'\\"]");const t=[...document.querySelectorAll(".mv-tile")].find(e=>e.querySelector("#tile-menu-'+agent['surfaceId']+'"));return !!b&&!!t&&t.hidden&&t.getClientRects().length===0})()'
assert wait(hidden)
added=evaluate('(()=>{const api=document.getElementById("workspace-dock-host").__vueParentComponent.exposed.getDockviewApi();api.addPanel({id:"p18b-synthetic-presentation",component:"CapsulePanel",title:"P18B synthetic presentation",params:{capsuleId:"p18b-synthetic-presentation"}});return api.panels.length})()')
time.sleep(.5)
assert evaluate(hidden), 'AGENT_GHOST_FRAME_AFTER_ADD'
evaluate('(()=>{const api=document.getElementById("workspace-dock-host").__vueParentComponent.exposed.getDockviewApi();api.getPanel("p18b-synthetic-presentation").api.close();return true})()')
print(json.dumps(dict(gate='minimized agent survives added presentation',hidden=True,presentationPanels=added,nativeCapsulesAdded=0)),flush=True)
click_id('window-show-panel-'+agent['surfaceId']);menu_open();click_text('Switch to human mode')
wait('(async()=>{const c=(await metaviewerRoles.choices())[0];return c.currentMode==="human"&&c.surfaceId!=='+json.dumps(agent['surfaceId'])+'&&c})()')
human=current();assert connected()['readonly'] is False

# The settings UI persists a valid cap without releasing the sole hidden view.
click_id('shell-more');click_id('shell-settings')
assert wait('(()=>{const e=document.getElementById("settings-hidden-live-sessions");return e?.getClientRects().length>0})()')
evaluate('(()=>{const e=document.getElementById("settings-hidden-live-sessions");e.value="2";e.dispatchEvent(new Event("change",{bubbles:true}));return true})()')
assert evaluate('localStorage.getItem("mv.hiddenLiveSessionLimit")')=='2'
click_id('settings-back');assert connected()['readonly'] is False
evaluate('(()=>{document.querySelector(".mv-tile").__vueParentComponent.appContext.provides.hiddenSessionSettings.set(0);return true})()')
assert connected()['readonly'] is False, 'SHOWN_VIEW_RELEASED'
click_id('window-hide-panel-'+human['surfaceId'])
end=time.monotonic()+15
while live.rpc(root,'tile-status') is not None:
    if time.monotonic()>end: raise RuntimeError('HIDDEN_VIEW_NOT_RELEASED')
    time.sleep(.15)
click_id('window-show-panel-'+human['surfaceId'])
assert wait('document.body.innerText.includes("Disconnected to save resources, click to reconnect")')
assert live.rpc(root,'tile-status') is None, 'RESTORE_AUTOMATICALLY_RECONNECTED'
click_id('tile-reconnect-'+human['surfaceId']);assert connected()['readonly'] is False
assert current()['surfaceId']==human['surfaceId'], 'RECONNECT_REPLACED_CAPSULE'
evaluate('(()=>{document.querySelector(".mv-tile").__vueParentComponent.appContext.provides.hiddenSessionSettings.set(4);return true})()')
print(json.dumps(dict(gate='configured cap releases hidden native view',shownProtected=True,explicitReconnect=True,sameCapsule=True,restoredLimit=4)),flush=True)
