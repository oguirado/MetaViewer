#!/usr/bin/env python3
"""Synthetic local page through the own native human tile; never reads cookies."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import p18_live as live

state=live.refresh_bindings(json.loads(live.STATE.read_text()));root=Path(state['root'])
def evaluate(source):return live.rpc(root,'eval',source=source)
choice=evaluate('globalThis.metaviewerRoles.choices()')[0]
binding=json.loads((root/'native-state/human-bindings'/(choice['surfaceId']+'.json')).read_text())
capsule=binding['container']
assert capsule in state['containers'] and binding['profile_id']=='mv-live-3'
target='<>@ñ¿áéíóú'
page="<!doctype html><meta charset=utf-8><title>P18 local test</title>\n<style>body{background:#dd2200;font:28px sans-serif}input{position:absolute;left:20px;top:120px;width:900px;height:60px;font:32px sans-serif}button{position:absolute;left:20px;top:220px;height:60px}</style>\n<h1>P18 synthetic local test</h1><input id=typed autofocus autocomplete=off><button id=persist>Persist synthetic marker</button>\n<script>\nconst persisted=localStorage.getItem('p18-synthetic-marker')==='preserved';\nif(persisted){document.body.style.background='#00dd44';document.title='P18-PERSISTED';}else document.title='P18-FRESH';\ntyped.oninput=()=>{document.title='P18-TYPED:'+typed.value;};\npersist.onclick=()=>{localStorage.setItem('p18-synthetic-marker','preserved');document.body.style.background='#00dd44';document.title='P18-SAVED';};\n</script>"
server='''import http.server,json
PAGE=PAGE_VALUE
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  data=PAGE.encode();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def do_POST(self):
  size=int(self.headers.get('Content-Length','0'));data=json.loads(self.rfile.read(min(size,4096)));print(json.dumps(data),flush=True);self.send_response(200);self.end_headers()
http.server.HTTPServer(('127.0.0.1',8765),Handler).serve_forever()
'''.replace('PAGE_VALUE',repr(page))
log=live.EVIDENCE/'local-page.log'
if '--resume' not in sys.argv:
 p=subprocess.Popen(['docker','exec','-i',capsule,'python3','-u','-c',server],stdout=log.open('w'),stderr=subprocess.STDOUT,start_new_session=True)
 live.record(pid=p.pid,kind='own local page server',container=capsule,root=str(root))
 print(json.dumps(dict(serverPid=p.pid,container=capsule,profile='mv-live-3')),flush=True)
time.sleep(.5)
env=dict(os.environ,DISPLAY=':97')
if '--spanish' in sys.argv:
 change=subprocess.Popen(['setxkbmap','-display',':97','es']);live.record(pid=change.pid,kind='own display97 keymap',root=str(root));assert change.wait()==0
 evaluate("(async()=>{const c=(await metaviewerRoles.choices())[0];await metaviewerRoles.close(c.surfaceId);const r=document.querySelector('.mv-role-viewport').getBoundingClientRect();return await metaviewerRoles.mount(c.surfaceId,{x:Math.ceil(r.x),y:Math.ceil(r.y),width:Math.floor(r.width),height:Math.floor(r.height)});})()")
def xdo(*args):
 child=subprocess.Popen(['xdotool',*args],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE);live.record(pid=child.pid,kind='own display97 input',root=str(root));out,err=child.communicate();
 print(json.dumps(dict(command=['xdotool',*args],rc=child.returncode)),flush=True)
 if child.returncode:raise RuntimeError(err.decode())
 return out.decode().strip()
mainpid=next(p['pid'] for p in state['processes'] if p['kind']=='dev-app')
window=xdo('search','--onlyvisible','--pid',str(mainpid)).splitlines()[0]
metrics=evaluate('(()=>{const r=document.querySelector(".mv-role-viewport").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,screenX,screenY,frame:outerHeight-innerHeight};})()')
scale=min(metrics['width']/1280,metrics['height']/900)
def click(x,y):
 px=round(metrics['screenX']+metrics['x']+(metrics['width']-1280*scale)/2+x*scale)
 py=round(metrics['screenY']+metrics['frame']+metrics['y']+(metrics['height']-900*scale)/2+y*scale)
 xdo('mousemove',str(px),str(py),'click','1')
deploy=subprocess.Popen(['docker','exec','-i',capsule,'python3','-c',"import sys;open('/tmp/p18-keymap.html','w').write(sys.stdin.read())"],stdin=subprocess.PIPE)
live.record(pid=deploy.pid,kind='own synthetic page deployment',container=capsule,root=str(root));deploy.communicate(page.encode());assert deploy.returncode==0
xdo('windowfocus','--sync',window)
click(300,150)
xdo('key','--clearmodifiers','ctrl+l');xdo('type','--clearmodifiers','--delay','30','file:///tmp/p18-keymap.html');xdo('key','Return');time.sleep(2)
click(200,250);xdo('type','--clearmodifiers','--delay','120',target);time.sleep(1)
probe=subprocess.Popen(['docker','exec',capsule,'env','DISPLAY=:100','xdotool','search','--onlyvisible','--class','chromium','getwindowname'],stdout=subprocess.PIPE)
live.record(pid=probe.pid,kind='own synthetic page title',container=capsule,root=str(root));output=probe.communicate()[0].decode();print('KEYBOARD '+output,flush=True)
# Click the synthetic page button; no profile or cookie files are read.
xdo('key','--clearmodifiers','Tab','space');time.sleep(.5)
probe=subprocess.Popen(['docker','exec',capsule,'env','DISPLAY=:100','xdotool','search','--onlyvisible','--class','chromium','getwindowname'],stdout=subprocess.PIPE)
live.record(pid=probe.pid,kind='own synthetic persistence title',container=capsule,root=str(root));persistence=probe.communicate()[0].decode();print('PERSIST '+persistence,flush=True)
for preset in ['single','side-by-side','grid','focus-strip']:
 result=evaluate("(()=>{document.getElementById('tile-preset-"+preset+"').click();return true})()")
 time.sleep(.3)
 rect=evaluate('(()=>{const r=document.querySelector(".mv-role-viewport").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()')
 print(json.dumps(dict(preset=preset,rectangle=rect)),flush=True)
refusal=evaluate("globalThis.metaviewerRoles.open({profileId:'mv-live-3',role:'agent'})")
print('DUPLICATE '+json.dumps(refusal),flush=True)
assert refusal['code']=='PROFILE_ALREADY_BOUND'
assert target in output, 'NATIVE_KEYMAP_MISMATCH'
assert 'P18-SAVED' in persistence, 'SYNTHETIC_PERSISTENCE_NOT_CONFIRMED'
print('HUMAN_CHECK_COMPLETE',flush=True)
