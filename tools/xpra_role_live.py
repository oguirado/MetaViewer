#!/usr/bin/env python3
"""Own dev app only. No operator displays, identities, or container actions."""
import json, os, pathlib, signal, subprocess, sys, time, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
EVIDENCE=ROOT/'.xpra-evidence'
STATE=EVIDENCE/'role-live-processes.json'
PIDS=pathlib.Path('/home/admin/Música/TeamWork_Antigravity2/campaigns/metaviewer-0/out/pids.log')
OSROOT=pathlib.Path('/home/admin/Documentos/OpenSuperficies-wt-xverb')
def record(pid,label):
 with PIDS.open('a') as f:f.write(f'XPRA-ROLE-TILES PID {pid} {label}\n')
def spawn(argv,env,label):
 log=open(EVIDENCE/(label+'.log'),'w')
 p=subprocess.Popen([str(a) for a in argv],env=env,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 record(p.pid,label);return p
if sys.argv[1]=='start':
 recovering=STATE.exists()
 oldstate=json.loads(STATE.read_text()) if recovering else None
 root=pathlib.Path(json.loads((EVIDENCE/'role-runtime.json').read_text())['root'])
 for name in ['runtime','state','store','native-state','recordings']:(root/name).mkdir(mode=0o700,exist_ok=True)
 registry=root/'registry.json'
 if not registry.exists():registry.write_text('{}');registry.chmod(0o600)
 env=dict(os.environ);env.pop('MV_WENDER_ROOT',None)
 for k in list(env):
  if k.startswith(('DYLD_','ELECTRON_','LD_','NODE_','PYTHON')) or k in {'BASH_ENV','ENV','GCONV_PATH','HOSTALIASES','ZDOTDIR'}:env.pop(k,None)
 ram=pathlib.Path(oldstate['ram']) if recovering else pathlib.Path('/dev/shm')/('xpra-role-'+uuid.uuid4().hex[:12])
 ram.mkdir(mode=0o700,exist_ok=True)
 commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
 sys.path.insert(0,str(ROOT/'tests/e2e/e2e1_slice'));import live
 regs={c:live.registration(c,commit,uuid.uuid4().hex) for c in ['core','ui','agent','daemon']}
 config={'session_id':'role-'+uuid.uuid4().hex,'core':regs['core'],'peers':[regs[c] for c in ['ui','agent','daemon']]}
 cfg=root/'core-config.json'
 if recovering:
  config=json.loads(cfg.read_text());regs={r['endpoint']['component']:r for r in [config['core'],*config['peers']]}
 else:cfg.write_text(json.dumps(config));cfg.chmod(0o600)
 env.update(HOME=str(root),XDG_CONFIG_HOME=str(root/'config'),XDG_RUNTIME_DIR=str(root/'runtime'),XDG_STATE_HOME=str(root/'state'),DISPLAY=':97',
  MV_CORE_CONFIG=str(cfg),MV_SESSION_ID=config['session_id'],MV_CORE_INSTANCE=regs['core']['endpoint']['instance'],MV_DAEMON_INSTANCE=regs['daemon']['endpoint']['instance'],
  MV_COMPONENT_COMMIT=commit,MV_CONTRACT_DIR=str(ROOT/'contracts/v0.2'),MV_SRF_LIVE_PROFILE='mv-live-4',MV_SRF_LIVE_RAM_ROOT=str(ram),
  MV_SRF_PROFILES=json.dumps({'mv-live-4':{'Kind':'browser','NativeKind':'browser','RAMRoot':str(ram),'Display':':100','Width':1280,'Height':900,'role':'human'}}),
  MV_SRF_STATE_DIR=str(root/'native-state'),MV_SRF_BIN_DIR=str(EVIDENCE/'role-bin'),SRF_IDENTITY_STORE_ROOT=str(root/'store'),SRF_PROXY_REGISTRY=str(registry),
  MV_RECORDING_DESTINATION=str(root/'recordings'),MV_XPRA_JQUERY='/usr/share/javascript/jquery/jquery.js',
  MV_ADAPTER_BIN=str(EVIDENCE/'bin/mv-daemon-adapter'),MV_CORE_BOOTSTRAP=str(EVIDENCE/'role-bootstrap.mjs'),
  MV_MW_WENDER_ROOT='/home/admin/Documentos/wender-agent-wt-pin')
 if recovering:
  state=oldstate; core=None
 else:
  p=spawn([OSROOT/'bin/srf-identity-admin','create','--store-root',root/'store','--id','mv-live-4','--label','Isolated role spike','--domains','example.com'],env,'role-live-provision')
  if p.wait()!=0:raise SystemExit('own identity provision failed')
  core=spawn(['/home/admin/.cache/cargo-target/mv-wt-xtile/debug/metaviewer-core'],env,'role-live-core')
  state={'root':str(root),'ram':str(ram),'pids':[core.pid],'containers':[],'config':str(cfg)};STATE.write_text(json.dumps(state))
 if not pathlib.Path('/tmp/.X11-unix/X97').exists() or subprocess.run(['xdpyinfo','-display',':97'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
  xvfb=spawn(['/usr/bin/Xvfb',':97','-nolock','-screen','0','1600x1100x24','-nolisten','tcp','-ac'],env,'role-live-xvfb')
  state['xvfb_pid']=xvfb.pid;state['pids'].append(xvfb.pid);STATE.write_text(json.dumps(state));time.sleep(1)
 for _ in range(100):
  if (root/'runtime/metaviewer/core.sock').exists():break
  if core and core.poll() is not None:raise SystemExit('own core failed')
  time.sleep(.1)
 app=spawn(['/home/admin/Documentos/Games/Holdings-int/app/shell/node_modules/electron/dist/electron','--no-sandbox',EVIDENCE/'role-live-entry.mjs'],env,'role-live-app')
 state['app_pid']=app.pid;state['pids'].append(app.pid);STATE.write_text(json.dumps(state))
 print(json.dumps({'core_pid':state['pids'][0],'app_pid':app.pid,'root':str(root)}))
elif sys.argv[1]=='status':
 state=json.loads(STATE.read_text());root=pathlib.Path(state['root'])
 # Read only the host's credential-free adapter records, never native session files.
 for file in (root/'native-state/human-bindings').glob('*.json'):
  binding=json.loads(file.read_text());container=binding['container']
  if container not in state['containers']:
   state['containers'].append(container)
   with PIDS.open('a') as f:f.write('XPRA-ROLE-TILES CONTAINER '+container+' profile mv-live-3\n')
 STATE.write_text(json.dumps(state));print(json.dumps(state))
elif sys.argv[1]=='stop':
 state=json.loads(STATE.read_text());root=pathlib.Path(state['root'])
 # Ask only the recorded own app to quit; its adapter performs native teardown.
 if len(state['pids'])>1:
  try:os.kill(state.get('app_pid',state['pids'][1]),signal.SIGTERM)
  except ProcessLookupError:pass
  time.sleep(2)
 for pid in reversed(state['pids']):
  try:
   command=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().replace(b'\x00',b' ').decode()
   if ('/home/admin/.cache/cargo-target/mv-wt-xtile/debug/metaviewer-core' in command or
       str(ROOT) in command or command.startswith('/usr/bin/Xvfb :97 ')):
    os.kill(pid,signal.SIGTERM)
  except (FileNotFoundError,ProcessLookupError):pass
 # Native stop is allowed only for explicitly recorded own containers.
 env=dict(os.environ,SRF_IDENTITY_STORE_ROOT=str(root/'store'),SRF_PROXY_REGISTRY=str(root/'registry.json'))
 for container in state['containers']:
  if not container.startswith('srf-id-') or container in {'srf-id-mv-live-1'}:raise SystemExit('unsafe own container')
  p=spawn([OSROOT/'bin/srf-identity-surface','stop','--container',container,'--state-dir',root/'native-state'],env,'role-live-stop-native');p.wait(timeout=40)
 names=subprocess.check_output(['docker','ps','--format','{{.Names}}'],text=True).splitlines()
 remaining=[c for c in state['containers'] if c in names]
 print(json.dumps({'remaining_own_capsules':remaining}))
 if remaining:raise SystemExit(1)
