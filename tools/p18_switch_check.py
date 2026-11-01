#!/usr/bin/env python3
"""Own profile persistence across a real clean capsule replacement."""
import json
from pathlib import Path
import subprocess
import time
import p18_live as live

state=json.loads(live.STATE.read_text());root=Path(state['root'])
def evaluate(source):return live.rpc(root,'eval',source=source)
def run(argv,data=None):
 p=subprocess.Popen(argv,stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 live.record(pid=p.pid,kind='own switch fixture',root=str(root));out,err=p.communicate(data.encode() if data is not None else None)
 print(json.dumps(dict(command=argv,rc=p.returncode,output=out.decode()[:400],error=err.decode()[:200])),flush=True)
 if p.returncode:raise RuntimeError('OWN_FIXTURE_COMMAND_FAILED')
 return out.decode()
deadline=time.monotonic()+60
while True:
 choice=evaluate('metaviewerRoles.choices()')[0]
 if choice['currentMode']=='human':break
 if time.monotonic()>deadline:raise RuntimeError('HUMAN_OPEN_UNPROVEN')
 time.sleep(.2)
state=live.refresh_bindings(state)
binding=json.loads((root/'native-state/human-bindings'/(choice['surfaceId']+'.json')).read_text());old=binding['container'];assert old in state['containers']
def page(container,source):
 run(['docker','exec','-i',container,'python3','-c',"import sys;open('/tmp/p18-state.html','w').write(sys.stdin.read())"],source)
 # Fixture navigation in the owned capsule only; this is not an agent proposal.
 run(['docker','exec',container,'env','DISPLAY=:100','xdotool','search','--onlyvisible','--class','chromium','windowfocus','--sync','key','--clearmodifiers','ctrl+l'])
 run(['docker','exec',container,'env','DISPLAY=:100','xdotool','type','--clearmodifiers','file:///tmp/p18-state.html'])
 run(['docker','exec',container,'env','DISPLAY=:100','xdotool','key','Return']);time.sleep(1)
 return run(['docker','exec',container,'env','DISPLAY=:100','xdotool','search','--onlyvisible','--class','chromium','getwindowname'])
title=page(old,"<script>localStorage.setItem('p18-switch-marker','preserved');document.title='P18-SAVED';</script>")
assert 'P18-SAVED' in title
refusal=evaluate("metaviewerRoles.open({profileId:'mv-live-3',role:'agent'})");print('DUPLICATE '+json.dumps(refusal),flush=True);assert refusal['code']=='PROFILE_ALREADY_BOUND'
result=evaluate("metaviewerRoles.switchMode("+json.dumps(choice['surfaceId'])+")");print('SWITCH '+json.dumps(result),flush=True)
state=live.refresh_bindings(state)
if not result.get('ok'):raise RuntimeError('SWITCH_UNPROVEN '+result.get('code',''))
assert result['surfaceId']!=choice['surfaceId'] and result['role']=='agent'
new=json.loads((root/'native-state/human-bindings'/(result['surfaceId']+'.json')).read_text())['container'];assert new in state['containers'];assert old!=new
assert not run(['docker','ps','-q','--filter','name=^/'+old+'$']).strip()
title=page(new,"<script>document.body.style.background=localStorage.getItem('p18-switch-marker')==='preserved'?'#00dd44':'#dd2200';document.title=localStorage.getItem('p18-switch-marker')==='preserved'?'P18-PERSISTED':'P18-MISSING';</script>")
assert 'P18-PERSISTED' in title
deadline=time.monotonic()+20
while True:
 buttons=evaluate("Array.from(document.querySelectorAll('button')).map(b=>b.innerText)")
 if 'Watch read-only' in buttons:break
 if time.monotonic()>deadline:raise RuntimeError('AGENT_TILE_UNPROVEN')
 time.sleep(.2)
evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.innerText==='Watch read-only').click();true")
deadline=time.monotonic()+40
while True:
 status=live.rpc(root,'tile-status')
 if status and status.get('connected') and status.get('readonly'):break
 if time.monotonic()>deadline:raise RuntimeError('AGENT_WATCH_UNPROVEN')
 time.sleep(.2)
print(json.dumps(dict(oldCapsule=old,newCapsule=new,oldSurface=choice['surfaceId'],newSurface=result['surfaceId'],persisted=True,watch=status)),flush=True)
