"""Only P18F's own dev window on :97; one owned human capsule."""
import json,os,subprocess,time
from pathlib import Path
from p18f_live import STATE,OUT,rpc,descendants
from p18f_verify import record
os.environ['DISPLAY']=':97'
state=json.loads(STATE.read_text())
original_popen=subprocess.Popen
def owned_popen(*args,**kwargs):
 process=original_popen(*args,**kwargs);record(process.pid,'own live check tool',root=state['root']);return process
subprocess.Popen=owned_popen
def evaluate(source):return rpc(state,'eval',source=source)
def wait(source,timeout=40):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  value=evaluate(source)
  if value:return value
  time.sleep(.1)
 raise RuntimeError('LIVE_GATE_UNPROVEN '+source[:120])
def click(id):
 assert evaluate('(()=>{const el=document.getElementById('+json.dumps(id)+');if(!el||el.disabled)return false;el.click();return true})()'),id
 time.sleep(.3)
def current_view(timeout=10):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  expected=evaluate("(()=>{const r=[...document.querySelectorAll('.mv-role-viewport')].map(e=>e.getBoundingClientRect()).find(r=>r.width>0&&r.height>0);return r?{x:Math.ceil(r.x),y:Math.ceil(r.y),width:Math.floor(r.right)-Math.ceil(r.x),height:Math.floor(r.bottom)-Math.ceil(r.y)}:null})()")
  views=rpc(state,'view-bounds')
  if expected and len(views)==1 and views[0]['visible'] and all(abs(views[0]['bounds'][key]-expected[key])<=2 for key in expected):return views[0]
  time.sleep(.1)
 raise RuntimeError('NATIVE_BOUNDS_NOT_SETTLED '+str(dict(expected=expected,views=views)))

def ports():
 pid=next(p['pid'] for p in state['processes'] if p['kind']=='live-app')
 lines=subprocess.check_output(['ss','-ltnpH'],text=True).splitlines()
 addresses=sorted({line.split()[3] for line in lines if f'pid={pid},' in line})
 assert addresses and all(address.startswith('127.0.0.1:') for address in addresses),addresses
 return addresses

def snapshot(label):
 from PIL import ImageGrab
 evaluate('(()=>{getSelection()?.removeAllRanges();return true})()')
 app_pid=next(p['pid'] for p in state['processes'] if p['kind']=='live-app')
 own_windows=subprocess.check_output(['xdotool','search','--pid',str(app_pid),'--name','MetaViewer'],text=True).split()
 subprocess.run(['xdotool','windowraise',own_windows[0]],check=True)
 target=OUT/'screenshots'/('native-'+label+'.png');target.parent.mkdir(exist_ok=True)
 # BrowserWindow.capturePage omits WebContentsView children. Capture only our
 # :97 dev window through X so the native xpra pixels are in the evidence.
 geometry=evaluate('({x:screenX,y:screenY,width:outerWidth,height:outerHeight})')
 image=ImageGrab.grab(xdisplay=':97')
 left=max(0,geometry['x']);top=max(0,geometry['y'])
 image.crop((left,top,min(image.width,left+geometry['width']),min(image.height,top+geometry['height']))).save(target)
 return str(target)

evaluate("(()=>{document.getElementById('view-human').click();return true})()")
choices=evaluate('metaviewerRoles.choices()');assert len(choices)==1 and choices[0]['profileId']=='mv-live-3' and choices[0]['currentMode']=='human',choices
surface=choices[0]['surfaceId']
wait('(async()=>{const s=await metaviewerRoles.status('+json.dumps(surface)+');return s.view?.state==="ready"})()')
if evaluate('document.getElementById("desktop-human-2")?.getAttribute("aria-pressed")==="true"'):
 if not evaluate('document.getElementById('+json.dumps('tile-menu-'+surface)+').getAttribute("aria-expanded")==="true"'):click('tile-menu-'+surface)
 click('tile-move-go-'+surface+'-1');time.sleep(.3)
 click('desktop-human-2');click('desktop-remove');time.sleep(.3)
wait('(async()=>{const s=await metaviewerRoles.status('+json.dumps(surface)+');return s.view?.state==="ready"})()')
click('tile-preset-floating')
wait('!document.body.hasAttribute("data-mv-modal")')
# A prior renderer reload can reuse a legacy main's hidden view. The current
# renderer must always reconcile the mount response before this visibility gate.
views=[current_view()]
before_ports=ports();before_view=views[0];first=snapshot('floating')
# Actual X input to this dev window's floating titlebar and resize handle.
app_pid=next(p['pid'] for p in state['processes'] if p['kind']=='live-app')
window_ids=subprocess.check_output(['xdotool','search','--pid',str(app_pid),'--name','MetaViewer'],text=True).split()
assert window_ids
subprocess.run(['xdotool','windowraise',window_ids[0]],check=True,env=dict(os.environ,DISPLAY=':97'))
def drag(x,y,dx,dy):
 env=dict(os.environ,DISPLAY=':97')
 origin=evaluate('({x:window.screenX,y:window.screenY+window.outerHeight-window.innerHeight})')
 x+=origin['x'];y+=origin['y']
 subprocess.run(['xdotool','mousemove','--sync',str(round(x)),str(round(y)),'mousedown','1'],check=True,env=env)
 time.sleep(.08)
 subprocess.run(['xdotool','mousemove','--sync',str(round(x+1)),str(round(y+1))],check=True,env=env)
 time.sleep(.08)
 subprocess.run(['xdotool','mousemove','--sync',str(round(x+dx)),str(round(y+dy))],check=True,env=env)
 time.sleep(.15)
 subprocess.run(['xdotool','mouseup','1'],check=True,env=env)
 time.sleep(.5);descendants(state)
box=evaluate("(()=>{const r=document.querySelector('.dv-floating-titlebar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()")
drag(box['x']+box['width']/2,box['y']+box['height']/2,140,-90)
after_move=current_view();assert after_move['visible'],after_move
assert after_move['bounds']['x']>before_view['bounds']['x']+100,(before_view,after_move)
box=evaluate("(()=>{const r=document.querySelector('.dv-resize-handle-right').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()")
drag(box['x']+box['width']/2,box['y']+box['height']/2,100,0)
after_resize=current_view();assert after_resize['visible'];assert after_resize['bounds']['width']>after_move['bounds']['width']+70,(after_move,after_resize)
assert ports()==before_ports
second=snapshot('moved-resized')
# Header sizing: three positive and three negative steps within unconstrained range.
click('tile-size-fit-'+surface)
start=rpc(state,'view-bounds')[0]['bounds']['width']
for _ in range(3):click('tile-size-wider-'+surface)
wider=rpc(state,'view-bounds')[0]['bounds']['width']
for _ in range(3):click('tile-size-narrower-'+surface)
returned=rpc(state,'view-bounds')[0]['bounds']['width']
assert abs(returned-start)<=2,(start,wider,returned)
assert wider>start+100
# Real menu must hide the native view; moving does not follow until chosen.
click('tile-menu-'+surface)
assert rpc(state,'view-bounds')[0]['visible'] is False
click('tile-move-new-'+surface)
wait('!!document.getElementById("desktop-human-2")')
assert evaluate('document.getElementById("desktop-human-1").getAttribute("aria-pressed")') in ['true','page']
assert ports()==before_ports
hidden=rpc(state,'view-bounds');assert len(hidden)==1 and not hidden[0]['visible'],hidden
click('desktop-human-2')
end=time.monotonic()+10
while time.monotonic()<end:
 after_desktop=rpc(state,'view-bounds')
 if len(after_desktop)==1 and after_desktop[0]['visible']:break
 time.sleep(.1)
assert after_desktop[0]['visible'];assert ports()==before_ports
third=snapshot('desktop-2')
client=rpc(state,'tile-status');assert client['connected'] is True and client['readonly'] is False and client['remoteWindows']>0
# Native key events are intercepted before xpra receives the arrow chord.
click('tile-preset-floating');current_view();click('tile-size-fit-'+surface);base=current_view()
origin=evaluate('({x:screenX,y:screenY+outerHeight-innerHeight})')
b=base['bounds'];subprocess.run(['xdotool','mousemove',str(round(origin['x']+b['x']+b['width']/2)),str(round(origin['y']+b['y']+b['height']/2)),'click','1'],check=True)
subprocess.run(['xdotool','key','ctrl+alt+Right'],check=True);time.sleep(.4)
key_wider=current_view()['bounds']['width'];assert key_wider>base['bounds']['width']+100,(base,key_wider)
subprocess.run(['xdotool','key','ctrl+alt+Left'],check=True);time.sleep(.4)
key_returned=current_view()['bounds']['width'];assert abs(key_returned-base['bounds']['width'])<=2
height_before=current_view()['bounds']['height'];click('tile-size-taller-'+surface);height_taller=current_view()['bounds']['height'];click('tile-size-shorter-'+surface);height_returned=current_view()['bounds']['height']
assert height_taller>height_before+30 and abs(height_returned-height_before)<=2,(height_before,height_taller,height_returned)
assert ports()==before_ports
result=dict(surface=surface,portsBefore=before_ports,portsAfter=ports(),before=before_view,afterMove=after_move,afterResize=after_resize,sizing=dict(before=start,wider=wider,after=returned,delta=returned-start),sameBridge=True,client=client,keyboard=dict(before=base['bounds']['width'],wider=key_wider,after=key_returned),height=dict(before=height_before,taller=height_taller,after=height_returned),screenshots=[first,second,third])
(OUT/'live-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
