"""One owned capsule; isolated dev display; cleanup even on an assertion failure."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import p18c_live as live

_popen=subprocess.Popen
def recorded_popen(*args,**kwargs):
    child=_popen(*args,**kwargs)
    try:stamp=(Path('/proc')/str(child.pid)/'stat').read_text().rsplit(') ',1)[1].split()[19]
    except FileNotFoundError:stamp=None
    live.record(pid=child.pid,starttime=stamp,kind='owned smoke child')
    return child
subprocess.Popen=recorded_popen

state = None
peak_ui_kib = 0

def evaluate(source):
    return live.rpc(Path(state['root']),'eval',source=source)

def wait(source,timeout=90):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        value=evaluate('(async()=>Boolean(await ('+source+')))()')
        if value:return value
        time.sleep(.15)
    raise RuntimeError('LIVE_GATE_UNPROVEN '+source[:150])

def click(identifier):
    assert evaluate('(()=>{const e=document.getElementById('+json.dumps(identifier)+');if(!e)return false;e.click();return true})()')
    time.sleep(.25)

def connections(pid):
    # Retain only endpoint pairs for our own bridge, never other host sockets.
    text=subprocess.check_output(['ss','-tnp'],text=True)
    established=sorted(set(tuple(line.split()[3:5]) for line in text.splitlines() if 'pid='+str(pid)+',' in line and line.startswith('ESTAB')))
    listening=subprocess.check_output(['ss','-ltnp'],text=True)
    ports=sorted(set(line.split()[3] for line in listening.splitlines() if 'pid='+str(pid)+',' in line))
    assert all(endpoint.startswith(('127.0.0.1:','[::1]:')) for endpoint in ports), 'NONLOCAL_LISTENER'
    return dict(ports=ports,established=established)

def rss(pid):
    global peak_ui_kib
    seen=set()
    def visit(current):
        if current in seen:return 0
        seen.add(current)
        try:
            base=Path('/proc')/str(current)
            own=int((base/'statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')//1024
            children=(base/'task'/str(current)/'children').read_text().split()
            return own+sum(visit(int(child)) for child in children)
        except (FileNotFoundError,ProcessLookupError):return 0
    value=visit(pid);peak_ui_kib=max(peak_ui_kib,value)
    return value

def active():
    return evaluate('(()=>({view:document.querySelector(".mv-view-button[aria-pressed=true]")?.id,desktop:document.querySelector(".mv-desktop-numbers [aria-pressed=true]")?.id,visible:[...document.querySelectorAll("[data-desktop]")].filter(e=>e.getBoundingClientRect().width>0&&getComputedStyle(e).display!=="none").map(e=>e.dataset.desktop),roles:[...document.querySelectorAll(".mv-role-surface")].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.dataset.capsuleRole)}))()')

try:
    sys.argv=['p18c_live.py','start'];live.main()
    state=live.refresh_bindings(json.loads(live.STATE.read_text()));root=Path(state['root'])
    pid=next(p['pid'] for p in state['processes'] if p['kind']=='dev-app')
    wait('document.getElementById("view-human") && document.querySelector("[data-desktop=human-1] .mv-role-surface")')
    wait('(async()=>{const c=(await metaviewerRoles.choices())[0];if(!c.surfaceId)return false;const s=await metaviewerRoles.status(c.surfaceId);return s.view?.state==="ready"})()')
    assert active()['roles']==['human']
    before=connections(pid);assert before['ports'] and before['established'],'OWN_BRIDGE_CONNECTION_ABSENT'
    start=(live.EVIDENCE/'dev-app.log').read_text()
    before_counts={stage:start.count(stage) for stage in ['stage=CLIENT_CONNECTED','stage=CLOSED']}
    click('desktop-add');assert active()['desktop']=='desktop-human-2';assert not active()['roles']
    click('desktop-human-1')
    for _ in range(5):
        click('view-agent');assert active()['visible']==['agent-1'];assert not active()['roles'];assert live.rpc(root,'visibility')==[False]
        click('view-human');assert active()['visible']==['human-1'];assert active()['roles']==['human'];assert live.rpc(root,'visibility')==[True];rss(pid)
    click('shell-more');click('shell-creative');assert live.rpc(root,'visibility')==[False]
    click('view-human');assert active()['roles']==['human'];assert live.rpc(root,'visibility')==[True]
    after=connections(pid);assert after['ports']==before['ports'],'BRIDGE_LISTENER_CHANGED'
    assert set(after['established']) & set(before['established']), 'PERSISTENT_BRIDGE_CONNECTION_CHANGED'
    end=(live.EVIDENCE/'dev-app.log').read_text()
    after_counts={stage:end.count(stage) for stage in before_counts};assert after_counts==before_counts,'SESSION_REOPENED'
    print(json.dumps(dict(gate='retained views',switches=5,sameBridgePorts=True,persistentBridgeConnection=True,counts=after_counts,uiTreeRssKiB=rss(pid))),flush=True)
    # Inject the chord into this dev app's own focused native child.
    live.rpc(root,'shortcut',key='2');wait('document.getElementById("desktop-human-2")?.getAttribute("aria-pressed")=="true"')
    assert live.rpc(root,'visibility')==[False];click('desktop-human-1')
    live.rpc(root,'shortcut',key='Tab');wait('document.getElementById("view-agent").getAttribute("aria-pressed")==="true"')
    click('desktop-add');assert active()['desktop']=='desktop-agent-2'
    click('view-human');click('desktop-human-2')
    # Leave Agents 2 active, Humans 2 remembered, and restart the actual app.
    click('view-agent')
    wait('(async()=>{const s=JSON.parse(await metaviewer.load());return s.schema==="metaviewer.desktops/v1"&&s.activeView==="agent"&&s.views.agent.active===2&&s.views.human.active===2})()')
    before_restart=active()
    live.rpc(root,'quit',timeout=20)
    deadline=time.monotonic()+20
    while Path('/proc',str(pid)).exists() and time.monotonic()<deadline:time.sleep(.1)
    (root/'ready.json').unlink(missing_ok=True)
    with (live.EVIDENCE/'restart-app.log').open('w') as output:
        app=subprocess.Popen([live.ELECTRON,str(live.REPO/'tools/p18c_dev.cjs')],env=live.LAST_ENV,cwd=live.REPO,stdout=output,stderr=subprocess.STDOUT)
    stamp=(Path('/proc')/str(app.pid)/'stat').read_text().rsplit(') ',1)[1].split()[19]
    live.record(pid=app.pid,starttime=stamp,kind='restarted dev-app',root=str(root))
    state['processes'].append(dict(pid=app.pid,starttime=stamp,kind='restarted dev-app'));live.STATE.write_text(json.dumps(state))
    deadline=time.monotonic()+40
    while time.monotonic()<deadline:
        log=(live.EVIDENCE/'restart-app.log').read_text()
        if 'SINGLE_INSTANCE' in log or 'BOOT_REFUSED' in log:raise RuntimeError('BLOCKED restart refused')
        if (root/'ready.json').exists():break
        time.sleep(.1)
    else:raise RuntimeError('RESTART_NOT_READY')
    wait('document.getElementById("view-agent")?.getAttribute("aria-pressed")==="true"')
    assert active()['desktop']=='desktop-agent-2';assert active()['visible']==['agent-2']
    click('view-human');assert active()['desktop']=='desktop-human-2';assert not active()['roles']
    click('desktop-human-1')
    wait('(async()=>{const s=JSON.parse(await metaviewer.load());return Object.keys(s.assignments).length===0 && s.views.human.desktops.every(d=>!Object.keys(d.layout?.dockview?.panels||{}).length)})()')
    print(json.dumps(dict(gate='actual app restart',restoredViews=True,restoredDesktops=True,prunedEndedCapsule=True,uiTreeRssKiB=rss(app.pid),peakSampledUiTreeRssKiB=peak_ui_kib)),flush=True)
finally:
    if live.STATE.exists():
        sys.argv=['p18c_live.py','stop'];live.main()
