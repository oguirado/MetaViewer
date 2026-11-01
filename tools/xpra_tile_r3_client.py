#!/usr/bin/env python3
"""Native input and remote paint witnesses for the sole isolated R3 capsule."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from xpra_tile_r2_client import request, run, LEDGER

ROOT = Path(sys.argv[1]).resolve()
if not str(ROOT).startswith('/tmp/claude-1000/xpra-spike/operator-'):
    raise SystemExit('ROOT_REFUSED')
witness = json.loads((ROOT/'demo.json').read_text())
capsule = witness['capsule']
if not capsule.startswith('srf-id-mv-live-3-xpra-demo-') or not witness['dedicatedDemo']:
    raise SystemExit('CAPSULE_REFUSED')
ready = json.loads((ROOT/'ready.json').read_text())
windows = run(ROOT, '/usr/bin/xdotool', 'search', '--onlyvisible', '--pid', str(ready['pid'])).splitlines()
window = windows[-1]
measurements = []
def note(label, **data):
    row = dict(label=label, **data)
    measurements.append(row)
    (ROOT/'r3-live.json').write_text(json.dumps(measurements, indent=2)+'\n')
    print(json.dumps(row), flush=True)

def native(*args):
    return run(ROOT, '/usr/bin/xdotool', *args)

def sample(seconds=2):
    return request(ROOT, 'cadence', timeout=seconds+10, seconds=seconds)

remote = '''import gi,json,os
from gi.repository import GLib

gi.require_version('Gtk','3.0')
from gi.repository import Gtk,Gdk
print('REMOTE_PID '+str(os.getpid()),flush=True)
w=Gtk.Window();w.set_title('R3 synthetic key and paint witness');w.set_decorated(False);w.move(0,0);w.set_default_size(1280,900)
a=Gtk.Fixed();a.set_can_focus(True);w.add(a);count=0;bits=[]
for i in range(16):
 box=Gtk.EventBox();box.set_size_request(30,30);a.put(box,i*30,100);bits.append(box)

def tick():
 global count
 count+=1
 for i,box in enumerate(bits):
  color=Gdk.RGBA(0,1 if count&(1<<i) else 0,0,1)
  box.override_background_color(Gtk.StateFlags.NORMAL,color)
 return True

def key(widget,e):
 print(json.dumps({'key':Gdk.keyval_name(e.keyval),'ctrl':bool(e.state&Gdk.ModifierType.CONTROL_MASK)}),flush=True)
 return True

w.connect('key-press-event',key);w.connect('delete-event',lambda *args:True)
w.show_all();w.present();a.grab_focus();GLib.timeout_add(33,tick);Gtk.main()
'''
argv = ['docker','exec','-i','-u','10001:10001','-e','DISPLAY=:100',capsule,'/usr/bin/python3','-u','-c',remote]
remote_log = (ROOT/'r3-remote.log').open('w')
p = subprocess.Popen(argv, stdout=remote_log, stderr=subprocess.STDOUT)
remote_pid = None
with LEDGER.open('a') as f:
    f.write(json.dumps(dict(unit='XPRA-ROLE-TILES-R3',pid=p.pid,kind='own-remote-witness-client',root=str(ROOT),container=capsule))+'\n')
try:
    time.sleep(2)
    content=(ROOT/'r3-remote.log').read_text()
    if 'REMOTE_PID ' not in content or p.poll() is not None:
        raise RuntimeError('REMOTE_WITNESS_FAILED '+content[-1000:])
    remote_pid=int(content.split('REMOTE_PID ')[1].splitlines()[0])
    with LEDGER.open('a') as f:
        f.write(json.dumps(dict(unit='XPRA-ROLE-TILES-R3',remote_pid=remote_pid,kind='own-remote-witness',root=str(ROOT),container=capsule))+'\n')
    native('windowfocus','--sync',window)
    native('mousemove','--sync','180','220');native('click','1')
    paint=sample();note('baseline',status=request(ROOT,'status'),paint=paint,source=request(ROOT,'source-check'))
    if paint['changed']<1:raise RuntimeError('BASELINE_PAINT_ABSENT')
    before=request(ROOT,'states');start=time.monotonic()
    note('bridge-cut',result=request(ROOT,'kill-bridge'))
    time.sleep(.32)
    note('reconnecting-overlay-pixel',pixel=request(ROOT,'pixel',x=15,y=105),states=request(ROOT,'states'))
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        states=request(ROOT,'states')
        if states['states'][-1]['state']=='ready' and len(states['states'])>len(before['states']):break
        time.sleep(.1)
    else:raise RuntimeError('RECOVERY_TIMEOUT')
    paint=sample()
    if paint['changed']<1:raise RuntimeError('RECOVERED_PAINT_ABSENT')
    note('reconnected',elapsed_s=round(time.monotonic()-start,3),origin_changed=states['origin']!=before['origin'],states=states,status=request(ROOT,'status'),paint=paint)
    # Click the parent outside the child view, then blur/refocus the native window.
    native('mousemove','--sync','30','15');native('click','1')
    request(ROOT,'blur');time.sleep(1);native('windowfocus','--sync',window)
    request(ROOT,'hide-show');time.sleep(1)
    native('mousemove','--sync','180','220');native('click','1')
    note('blur-refocus',states=request(ROOT,'states'),status=request(ROOT,'status'),paint=sample())
    for key in ['t','w','q']:
        native('key','--clearmodifiers','ctrl+'+key)
        time.sleep(.3)
        rows=[]
        for line in (ROOT/'r3-remote.log').read_text().splitlines():
            if line.startswith('{'):rows.append(json.loads(line))
        delivered=any(row['key'].lower()==key and row['ctrl'] for row in rows)
        note('ctrl-'+key,remote_delivered=delivered,app=request(ROOT,'states')['alive'])
        if not delivered:raise RuntimeError('REMOTE_KEY_MISSING '+key)
    note('final-paint',paint=sample(),status=request(ROOT,'status'))
finally:
    # Stop the recorded synthetic process, then reap its docker client before
    # this supervisor exits. Never leave the client to an unrelated reaper.
    if remote_pid is not None and p.poll() is None:
        run(ROOT, 'docker', 'exec', capsule, 'kill', '-TERM', str(remote_pid))
    rc = p.wait(timeout=10)
    with (ROOT/'commands.jsonl').open('a') as f:
        f.write(json.dumps(dict(command=argv, rc=rc))+'\n')
    remote_log.close()
