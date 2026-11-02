#!/usr/bin/env python3
"""Own dev app and one dedicated identity; no operator state or display access."""
import json
import os
from pathlib import Path
import signal
import re
import subprocess
import sys
import tempfile
import time
import uuid

REPO=Path(__file__).resolve().parents[1]
OSROOT=Path('/home/admin/Documentos/OpenSuperficies-wt-xverb')
EVIDENCE=REPO/'.p18c-evidence'
LEDGER=Path('/home/admin/Música/TeamWork_Antigravity2/campaigns/metaviewer-0/out/pids.log')
STATE=EVIDENCE/'live.json'
ELECTRON='/home/admin/Documentos/Games/Holdings-int/app/shell/node_modules/electron/dist/electron'

def record(**row):
 with LEDGER.open('a') as f:f.write(json.dumps(dict(unit='P18C-VIEWS-DESKTOPS',**row))+'\n')

def rpc(root,op,timeout=150,**body):
 request=dict(id=uuid.uuid4().hex,op=op,**body)
 temporary=root/'request.tmp';temporary.write_text(json.dumps(request));temporary.rename(root/'request.json')
 deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  try:reply=json.loads((root/'reply.json').read_text())
  except (FileNotFoundError,json.JSONDecodeError):reply={}
  if reply.get('id')==request['id']:
   if 'error' in reply:raise RuntimeError(reply['error'])
   return reply.get('result')
  time.sleep(.05)
 raise RuntimeError('DEV_RPC_TIMEOUT')

def reap(state):
 """Record and stop only still-matching descendants of this supervisor's PIDs."""
 owned={}
 def visit(pid,expected=None):
  try:
   fields=(Path('/proc')/str(pid)/'stat').read_text().rsplit(') ',1)[1].split()
   if expected is not None and fields[19]!=expected:return
   if pid in owned:return
   owned[pid]=fields[19]
   children=(Path('/proc')/str(pid)/'task'/str(pid)/'children').read_text().split()
   for child in children:visit(int(child))
  except (FileNotFoundError,ProcessLookupError):pass
 for item in state['processes']:visit(item['pid'],item['starttime'])
 for pid,starttime in owned.items():record(pid=pid,starttime=starttime,kind='owned cleanup descendant',root=state['root'])
 def send(sig):
  for pid,starttime in reversed(list(owned.items())):
   if type(pid) is not int or pid <= 1:continue
   try:
    if os.getpgid(pid) == os.getpgrp():continue
    current=(Path('/proc')/str(pid)/'stat').read_text().rsplit(') ',1)[1].split()
    if current[19]==starttime:os.kill(pid,sig)
   except (FileNotFoundError,ProcessLookupError):pass
 send(signal.SIGTERM);time.sleep(1);send(signal.SIGKILL)

def refresh_bindings(state):
 root=Path(state['root'])
 containers=set(state.get('containers',[]))
 for file in (root/'native-state/human-bindings').glob('*.json'):
  binding=json.loads(file.read_text())
  if binding.get('schema')!='metaviewer.human_binding/v0.3' or binding.get('profile_id')!='mv-live-3':raise RuntimeError('OWN_BINDING_REFUSED')
  container=binding['container']
  if not container.startswith('srf-id-') or container in ['srf-id-mv-live-1'] or container.startswith(('srf-id-cuentas-','srf-id-perplexity-')):raise RuntimeError('OWN_CONTAINER_REFUSED')
  if container not in containers:record(container=container,kind='own binding capsule',root=str(root))
  containers.add(container)
 state['containers']=sorted(containers)
 STATE.write_text(json.dumps(state))
 return state

def main():
 global LAST_ENV
 if sys.argv[1]=='rpc':
  state=refresh_bindings(json.loads(STATE.read_text()));root=Path(state['root']);result=rpc(root,sys.argv[2],**json.loads(sys.argv[3] if len(sys.argv)>3 else '{}'));refresh_bindings(state);print(json.dumps(result));return
 if sys.argv[1]=='stop':
  state=refresh_bindings(json.loads(STATE.read_text()));root=Path(state['root'])
  if (root/'ready.json').exists():
   try:rpc(root,'quit',timeout=10)
   except Exception as error:print('QUIT '+str(error))
  time.sleep(2)
  reap(state)
  remaining=[]
  for capsule in state.get('containers',[]):
   active=subprocess.check_output(['docker','ps','-q','--filter','name=^/'+capsule+'$'],text=True).strip()
   if active:
    env=dict(os.environ,SRF_IDENTITY_STORE_ROOT=str(root/'identities'),SRF_PROXY_REGISTRY=str(root/'registry.json'))
    p=subprocess.Popen([str(root/'bin/srf-identity-surface'),'stop','--container',capsule,'--state-dir',str(root/'native-state')],env=env);record(pid=p.pid,kind='own capsule cleanup');rc=p.wait(timeout=150);print('native stop rc='+str(rc))
   if subprocess.check_output(['docker','ps','-q','--filter','name=^/'+capsule+'$'],text=True).strip():remaining.append(capsule)
  print(json.dumps(dict(remainingOwnCapsules=remaining)))
  if remaining:raise RuntimeError('OWN_CAPSULE_REMAINS')
  return
 root=Path(tempfile.mkdtemp(prefix='p18-live-',dir='/tmp/claude-1000/xpra-spike'))
 for name in ['runtime','state','native-state','identities','recordings','config','cache','data','home','tmp','bin']:(root/name).mkdir(mode=0o700)
 capsule='srf-id-mv-live-3'
 if subprocess.check_output(['docker','ps','-aq','--filter','name=^/'+capsule+'$'],text=True).strip():raise RuntimeError('BLOCKED dedicated capsule name occupied')
 env={k:v for k,v in os.environ.items() if not k.startswith(('MV_','SRF_','ELECTRON_','DBUS_','WAYLAND_','PYTHON','NODE_','LD_','DYLD_')) and k not in ['BASH_ENV','ENV','GCONV_PATH','HOSTALIASES','ZDOTDIR']}
 for key,name in [('HOME','home'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache'),('XDG_DATA_HOME','data'),('XDG_RUNTIME_DIR','runtime'),('XDG_STATE_HOME','state'),('TMPDIR','tmp')]:env[key]=str(root/name)
 env.update(CARGO_TARGET_DIR='/home/admin/.cache/cargo-target/mv-wt-p18c',DISPLAY=':97',P18_ROOT=str(root),MV_MW_WENDER_ROOT='/home/admin/Documentos/wender-agent-wt-pin')
 processes=[]
 def spawn(argv,label,cwd=REPO):
  p=subprocess.Popen([str(x) for x in argv],cwd=cwd,env=env,start_new_session=True,stdout=(EVIDENCE/(label+'.log')).open('w'),stderr=subprocess.STDOUT)
  starttime=(Path('/proc')/str(p.pid)/'stat').read_text().rsplit(') ',1)[1].split()[19]
  processes.append(dict(pid=p.pid,starttime=starttime,kind=label));STATE.write_text(json.dumps(dict(root=str(root),processes=processes)));record(pid=p.pid,starttime=starttime,kind=label,root=str(root));return p
 for name in ['srf-identity-surface','srf-identity-admin']:
  p=spawn(['/usr/local/go/bin/go','build','-o',root/'bin'/name,'./cmd/'+name],'build-'+name,cwd=OSROOT)
  rc=p.wait()
  if rc:raise RuntimeError('NATIVE_BUILD_FAILED '+name)
 p=spawn(['/usr/local/go/bin/go','build','-o',root/'bin/mv-daemon-adapter','./cmd/mv-daemon-adapter'],'build-adapter',cwd=REPO/'daemon-adapter')
 if p.wait():raise RuntimeError('ADAPTER_BUILD_FAILED')
 (root/'registry.json').write_text('{}');(root/'registry.json').chmod(0o600)
 STATE.write_text(json.dumps(dict(root=str(root),containers=[],processes=processes)))
 env.update(SRF_IDENTITY_STORE_ROOT=str(root/'identities'),SRF_PROXY_REGISTRY=str(root/'registry.json'))
 p=spawn([root/'bin/srf-identity-admin','create','--store-root',root/'identities','--id','mv-live-3','--label','P18 dedicated test','--domains','example.org'],'provision')
 if p.wait():raise RuntimeError('OWN_IDENTITY_PROVISION_FAILED')
 helper='p18-profile-owner-'+uuid.uuid4().hex[:12]
 record(container=helper,kind='own profile provision helper')
 p=spawn(['docker','run','--rm','--name',helper,'--network','none','--user','0:0','--read-only','--cap-drop','ALL','--cap-add','CHOWN','--mount','type=bind,src='+str(root/'identities/profiles/mv-live-3')+',dst=/profile','--entrypoint','/bin/chown','opensuperficies-identity-browser-arm64:0.1.0','10001:10001','/profile'],'provision-owner')
 if p.wait():raise RuntimeError('OWN_PROFILE_OWNER_UNPROVEN')
 # Normal native startup uses its existing network/egress configuration.
 # The native browser frame sink has a fixed producer root. A made-up private
 # root passes human startup (no capture) but rejects the first agent frame.
 # Bind admission to the producer allocation; never relax Capture's path gate.
 native_source=(OSROOT/'src/browserid/surface/surface.go').read_text()
 native_root=re.search(r'RAMRoot\s*=\s*"([^"]+)"',native_source)
 if not native_root:raise RuntimeError('NATIVE_FRAME_ROOT_UNPROVEN')
 ram=Path(native_root[1])
 if not ram.is_absolute() or not str(ram).startswith('/dev/shm/'):raise RuntimeError('NATIVE_FRAME_ROOT_REFUSED')
 commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
 sys.path.insert(0,str(REPO/'tests/e2e/e2e1_slice'));import live
 regs={c:live.registration(c,commit,uuid.uuid4().hex) for c in ['core','ui','agent','daemon']}
 config=dict(session_id='p18-'+uuid.uuid4().hex,core=regs['core'],peers=[regs[c] for c in ['ui','agent','daemon']])
 (root/'core.json').write_text(json.dumps(config));(root/'core.json').chmod(0o600)
 env.update(MV_CORE_CONFIG=str(root/'core.json'),MV_SESSION_ID=config['session_id'],MV_CORE_INSTANCE=regs['core']['endpoint']['instance'],MV_DAEMON_INSTANCE=regs['daemon']['endpoint']['instance'],MV_COMPONENT_COMMIT=commit,MV_CONTRACT_DIR=str(REPO/'contracts/v0.2'),MV_SRF_LIVE_PROFILE='mv-live-3',MV_SRF_LIVE_RAM_ROOT=str(ram),
  MV_SRF_PROFILES=json.dumps({'mv-live-3':dict(Kind='browser',NativeKind='browser',RAMRoot=str(ram),Display=':100',Width=1280,Height=900,default_mode='human')}),MV_SRF_STATE_DIR=str(root/'native-state'),MV_SRF_BIN_DIR=str(root/'bin'),MV_RECORDING_DESTINATION=str(root/'recordings'),MV_ADAPTER_BIN=str(root/'bin/mv-daemon-adapter'))
 if subprocess.run(['xdpyinfo','-display',':97'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
  if Path('/tmp/.X97-lock').exists():raise RuntimeError('BLOCKED unowned X97 lock')
  spawn(['Xvfb',':97','-screen','0','1600x1100x24','-nolisten','tcp'],'dev-xvfb');time.sleep(.5)
 spawn(['/home/admin/.cache/cargo-target/mv-wt-p18c/debug/metaviewer-core'],'dev-core')
 for _ in range(100):
  if (root/'runtime/metaviewer/core.sock').exists():break
  time.sleep(.1)
 record(container=capsule,kind='own capsule reserved',root=str(root))
 state=dict(root=str(root),container=capsule,processes=processes,ram=str(ram));STATE.write_text(json.dumps(state))
 LAST_ENV=env
 spawn([ELECTRON,REPO/'tools/p18c_dev.cjs'],'dev-app');STATE.write_text(json.dumps(state))
 for _ in range(300):
  output=(EVIDENCE/'dev-app.log').read_text()
  if 'SINGLE_INSTANCE' in output or 'BOOT_REFUSED' in output:raise RuntimeError('BLOCKED isolated dev startup refused')
  if (root/'ready.json').exists():print(json.dumps(state));return
  time.sleep(.1)
 raise RuntimeError('DEV_START_TIMEOUT')

if __name__=='__main__':main()
