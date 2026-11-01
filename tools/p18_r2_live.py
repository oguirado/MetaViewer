#!/usr/bin/env python3
"""P18 R2 fixtures, restricted to the current supervisor's own dev lifetime."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import p18_live as live

state = live.refresh_bindings(json.loads(live.STATE.read_text()))
root = Path(state['root'])
assert str(root).startswith('/tmp/claude-1000/xpra-spike/p18-live-')

def evaluate(source):
    return live.rpc(root, 'eval', source=source)

def run(argv, data=None):
    p = subprocess.Popen(argv, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                         stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, env=dict(os.environ, DISPLAY=':97'))
    live.record(pid=p.pid, kind='P18-R2 owned fixture', root=str(root))
    output = p.communicate(data.encode() if data is not None else None)[0].decode()
    print(json.dumps(dict(command=argv, rc=p.returncode, output=output[:2000])), flush=True)
    if p.returncode:
        raise RuntimeError('OWN_FIXTURE_COMMAND_FAILED')
    return output

def current():
    global state
    state = live.refresh_bindings(state)
    deadline=time.monotonic()+45
    while True:
        choice = evaluate('metaviewerRoles.choices()')[0]
        if choice.get('surfaceId'):break
        if time.monotonic()>deadline:raise RuntimeError('OWN_SURFACE_UNPROVEN')
        time.sleep(.1)
    assert choice['profileId'] == 'mv-live-3' and choice['surfaceId']
    binding = json.loads((root/'native-state/human-bindings'/(choice['surfaceId']+'.json')).read_text())
    assert binding['profile_id'] == 'mv-live-3' and binding['container'] in state['containers']
    return choice, binding['container']

def native(container, *argv, data=None):
    assert container in state['containers']
    return run(['docker','exec',*(['-i'] if data is not None else []),container,*argv], data)

def title(container):
    return native(container,'env','DISPLAY=:100','xdotool','search','--onlyvisible','--class','chromium','getwindowname')

def navigate(container, url):
    native(container,'env','DISPLAY=:100','xdotool','search','--onlyvisible','--class','chromium','windowfocus','--sync','key','--clearmodifiers','ctrl+l')
    native(container,'env','DISPLAY=:100','xdotool','type','--clearmodifiers',url)
    native(container,'env','DISPLAY=:100','xdotool','key','Return')

PAGE = '''<!doctype html><meta charset="utf-8"><title>P18-LOADING</title>
<style>body{font:28px sans-serif;background:#def}input{position:absolute;left:20px;top:120px;width:900px;height:60px;font:32px sans-serif}</style>
<h1>P18 R2 controlled loopback fixture</h1><input id="typed" autocomplete="off" autofocus>
<script>typed.oninput=()=>{document.title='P18-TYPED:'+typed.value;};</script>'''

def wait_title(container, expected):
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        value=title(container)
        if expected in value:return value
        time.sleep(.25)
    raise RuntimeError('CONTROLLED_PAGE_UNPROVEN '+expected)

def cycles():
    choice,container=current()
    def file_marker(container,seed=False):
        page="<!doctype html><title>P18-FILE-LOADING</title><script>"+(
            "localStorage.setItem('p18-r2-marker','preserved');" if seed else '')+(
            "document.title=localStorage.getItem('p18-r2-marker')==='preserved'?'P18-FILE-PERSISTED':'P18-FILE-MISSING';</script>")
        native(container,'python3','-c',"import sys;from pathlib import Path;Path('/tmp/p18-r2-state.html').write_text(sys.stdin.read())",data=page)
        navigate(container,'file:///tmp/p18-r2-state.html')
        wait_title(container,'P18-FILE-PERSISTED')
    def cookie_marker(container,seed=False):
        # file/data origins do not support persistent cookies. Use only our
        # synthetic marker on the fresh profile's reserved example.org origin.
        navigate(container,'https://example.org/')
        wait_title(container,'Example Domain')
        script=("localStorage.setItem('p18-r2-marker','preserved');document.cookie='p18_r2=preserved; Max-Age=3600; Path=/; SameSite=Strict';" if seed else '')+(
            "document.title=localStorage.getItem('p18-r2-marker')==='preserved'&&document.cookie.split('; ').includes('p18_r2=preserved')?'P18-COOKIE-PERSISTED':'P18-COOKIE-MISSING'")
        navigate(container,'javascript:void((()=>{'+script+'})())')
        wait_title(container,'P18-COOKIE-PERSISTED')
    file_marker(container,True)
    cookie_marker(container,True)
    for index in range(6):
        choice,old=current()
        target='agent' if choice['currentMode']=='human' else 'human'
        duplicate=evaluate("metaviewerRoles.open({profileId:'mv-live-3',role:"+json.dumps(target)+"})")
        assert duplicate['code']=='PROFILE_ALREADY_BOUND' and duplicate['surfaceId']==choice['surfaceId']
        # Click the real tile action and observe its progress while IPC awaits.
        assert evaluate("(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Switch to "+target+" mode');if(!b)return false;b.click();return true})()")
        deadline=time.monotonic()+60;progress=False
        while time.monotonic()<deadline:
            text=evaluate('document.body.innerText')
            progress |= 'Switching to '+target+'…' in text
            new=evaluate('metaviewerRoles.choices()')[0]
            if new.get('currentMode')==target and new.get('surfaceId')!=choice['surfaceId']:break
            time.sleep(.1)
        else:raise RuntimeError('SWITCH_UI_UNPROVEN')
        assert progress, 'SWITCH_PROGRESS_UNPROVEN'
        choice,container=current();assert container!=old
        assert not run(['docker','ps','-q','--filter','name=^/'+old+'$']).strip()
        file_marker(container)
        cookie_marker(container)
        panes=evaluate("document.querySelectorAll('.mv-role-viewport').length")
        assert panes==1,'ENDED_LIFETIME_PANE_RETAINED'
        print(json.dumps(dict(switch=index+1,mode=target,progress=True,localStorageAndCookie=True,panes=panes,revealOffer=duplicate)),flush=True)
    print('P18_R2_SIX_SWITCHES_PERSISTED',flush=True)

def assets():
    _,container=current()
    source="""from pathlib import Path
for name in ['/usr/share/xpra/www/index.html','/usr/share/xpra/www/js/Client.js']:
 lines=Path(name).read_text().splitlines()
 print(name)
 hits=set()
 for n,line in enumerate(lines):
  if any(x in line for x in ['keyboard_layout','keymap','keycode','key_shortcuts','key_action']):
   hits.update(range(max(0,n-2),min(len(lines),n+4)))
 for n in sorted(hits):print(str(n+1)+': '+lines[n])
"""
    # Full bounded asset excerpt stays in local evidence, never profile storage.
    p=subprocess.Popen(['docker','exec',container,'python3','-c',source],stdout=(live.EVIDENCE/'r2-xpra-keyboard-assets.log').open('w'),stderr=subprocess.STDOUT)
    live.record(pid=p.pid,kind='P18-R2 owned asset inspection',container=container)
    rc=p.wait();print('assets rc='+str(rc));assert rc==0

def keyboard():
    choice,container=current()
    if choice['currentMode']!='human':
        result=evaluate('metaviewerRoles.switchMode('+json.dumps(choice['surfaceId'])+')')
        print('HUMAN '+json.dumps(result),flush=True);assert result['ok']
    choice,container=current()
    run(['setxkbmap','-display',':97','es'])
    evaluate("(()=>{document.getElementById('tile-preset-single').click();return true})()")
    time.sleep(.3)
    viewport="""(()=>{const el=[...document.querySelectorAll('.mv-role-surface[data-capsule-role=human] .mv-role-viewport')].find(el=>el.getClientRects().length&&el.getBoundingClientRect().width>0);if(!el)throw Error('ACTIVE_VIEWPORT_ABSENT');const r=el.getBoundingClientRect(),x=Math.ceil(Math.max(0,r.x)),y=Math.ceil(Math.max(0,r.y));return {x,y,width:Math.floor(Math.min(innerWidth,r.right))-x,height:Math.floor(Math.min(innerHeight,r.bottom))-y}})()"""
    # Remount after the own host layout changes, so hello advertises that layout.
    mounted=evaluate("(async()=>{const c=(await metaviewerRoles.choices())[0];await metaviewerRoles.close(c.surfaceId);return await metaviewerRoles.mount(c.surfaceId,"+viewport+");})()")
    print('KEYBOARD_MOUNT '+json.dumps(mounted),flush=True);assert mounted['ok']
    page=PAGE
    native(container,'python3','-c',"import sys;from pathlib import Path;Path('/tmp/p18-r2-keyboard.html').write_text(sys.stdin.read())",data=page)
    navigate(container,'file:///tmp/p18-r2-keyboard.html')
    time.sleep(1)
    mainpid=next(p['pid'] for p in state['processes'] if p['kind']=='dev-app')
    window=run(['xdotool','search','--onlyvisible','--pid',str(mainpid)]).splitlines()[0]
    run(['xdotool','windowfocus','--sync',window])
    metrics=evaluate('({...'+viewport+',screenX,screenY,frame:outerHeight-innerHeight})')
    scale=min(metrics['width']/1280,metrics['height']/900)
    x=round(metrics['screenX']+metrics['x']+(metrics['width']-1280*scale)/2+200*scale)
    y=round(metrics['screenY']+metrics['frame']+metrics['y']+(metrics['height']-900*scale)/2+250*scale)
    run(['xdotool','mousemove',str(x),str(y),'click','1'])
    run(['xdotool','key','--clearmodifiers','ctrl+a'])
    # XTest physical positions: xdotool's keysym lookup picks alternate levels
    # (e.g. less on Shift+AltGr+Z) and cannot represent those modifiers reliably.
    # Derive keycodes from this display, then press the actual Spanish positions.
    physical = '''import ctypes,ctypes.util,re,subprocess,time
source=subprocess.check_output(['xkbcomp','-xkb',':97','-'],stderr=subprocess.DEVNULL,text=True)
codes={n:int(c) for n,c in re.findall(r'<([A-Z0-9]+)>\\s*=\\s*(\\d+)\\s*;',source)}
x11=ctypes.CDLL(ctypes.util.find_library('X11'));xtst=ctypes.CDLL(ctypes.util.find_library('Xtst'))
x11.XOpenDisplay.argtypes=[ctypes.c_char_p];x11.XOpenDisplay.restype=ctypes.c_void_p
x11.XFlush.argtypes=[ctypes.c_void_p];x11.XCloseDisplay.argtypes=[ctypes.c_void_p]
xtst.XTestFakeKeyEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
d=x11.XOpenDisplay(b':97');assert d
def key(name,down):
 assert xtst.XTestFakeKeyEvent(d,codes[name],down,0);x11.XFlush(d);time.sleep(.06)
def press(name,modifier=None):
 if modifier:key(modifier,1)
 key(name,1);key(name,0)
 if modifier:key(modifier,0)
 time.sleep(.12)
press('AC10');press('AE12','LFSH');press('AE12')
for letter in ['AC01','AD03','AD08','AD09','AD07']:
 press('AC11');press(letter)
press('AC11','LFSH');press('AD07');press('LSGT');press('LSGT','LFSH');press('AE02','RALT')
x11.XCloseDisplay(d)
'''
    run(['python3','-c',physical])
    time.sleep(1)
    value=title(container);print('KEYBOARD_READBACK '+value,flush=True)
    assert 'P18-TYPED:ñ¿¡áéíóúü<>@' in value,'SPANISH_KEYMAP_MISMATCH'

if __name__=='__main__':
    {'cycles':cycles,'assets':assets,'keyboard':keyboard}[sys.argv[1]]()
