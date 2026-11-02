"""P18D dev lifetime: only own :95, own userData, own store and registry.

No capsule is provisioned outside the app. Native profile ownership refusals
are evidence, never a reason to relax the native ownership check.
"""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid

from p18d_verify import ROOT, OUT, LEDGER, record

OSROOT = Path('/home/admin/Documentos/OpenSuperficies-wt-xverb')
STATE = OUT / 'live.json'
ELECTRON = '/home/admin/Documentos/Games/Holdings-int/app/shell/node_modules/electron/dist/electron'


def descendants(state):
    bindings=Path(state['root'])/'native-state/human-bindings'
    for path in bindings.glob('*.json'):
        binding=json.loads(path.read_text())
        if binding.get('profile_id') not in ['p18d-a','p18d-b']:
            raise RuntimeError('UNEXPECTED_OWN_BINDING')
        container=binding['container']
        if not re.fullmatch(r'srf-id-[a-z0-9-]+',container) or container.startswith(('srf-id-cuentas-','srf-id-perplexity-')):
            raise RuntimeError('OWN_CONTAINER_REFUSED')
        if container not in state['containers']:
            with LEDGER.open('a') as sink:sink.write(json.dumps(dict(unit='P18D-IDENTITIES',container=container,kind='own dev capsule',root=state['root']))+'\n')
            state['containers'].append(container)
    for item in state['processes']:
        def visit(pid, expected=None):
            try:
                fields=Path(f'/proc/{pid}/stat').read_text().rsplit(') ',1)[1].split()
                if expected is not None and fields[19]!=expected:return
                key=f'{pid}:{fields[19]}'
                if key not in state.setdefault('seen',[]):
                    record(pid,'own live descendant',root=state['root'])
                    state['seen'].append(key)
                for child in Path(f'/proc/{pid}/task/{pid}/children').read_text().split():visit(int(child))
            except FileNotFoundError:pass
        visit(item['pid'],item['starttime'])
    STATE.write_text(json.dumps(state))


def rpc(state, op, **body):
    root=Path(state['root']);request=dict(id=uuid.uuid4().hex,op=op,**body)
    (root/'request.tmp').write_text(json.dumps(request));(root/'request.tmp').rename(root/'request.json')
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        descendants(state)
        try:reply=json.loads((root/'reply.json').read_text())
        except (FileNotFoundError,json.JSONDecodeError):reply={}
        if reply.get('id')==request['id']:
            if 'error' in reply:raise RuntimeError(reply['error'])
            return reply['result']
        time.sleep(.03)
    raise RuntimeError('OWN_RPC_TIMEOUT')


def stop(state):
    root=Path(state['root'])
    if (root/'ready.json').exists():
        try:rpc(state,'quit')
        except Exception as error:print('own quit: '+str(error))
    descendants(state)
    for key in reversed(state.get('seen',[])):
        pid,start=key.split(':');pid=int(pid)
        if type(pid) is not int or pid <= 1:continue
        try:
            if os.getpgid(pid) == os.getpgrp():continue
            current=Path(f'/proc/{pid}/stat').read_text().rsplit(') ',1)[1].split()[19]
            if current==start:os.kill(pid,signal.SIGTERM)
        except (FileNotFoundError,ProcessLookupError):pass
    # No direct Docker cleanup: only the app may have opened a test capsule.
    active=subprocess.check_output(['docker','ps','--format','{{.Names}}'],text=True).splitlines()
    started = root/'docker-started.jsonl'
    logged = [json.loads(row)['container'] for row in started.read_text().splitlines()] if started.exists() else []
    own=[name for name in active if name in state.get('containers',[])+logged]
    print(json.dumps(dict(remainingOwnCapsules=own)))
    if own:raise RuntimeError('OWN_CAPSULE_REMAINS')


def start():
    OUT.mkdir(parents=True,exist_ok=True)
    os.environ.pop('MV_WENDER_ROOT', None)
    root=Path(tempfile.mkdtemp(prefix='p18d-live-',dir='/tmp/claude-1000/xpra-spike'))
    for name in ['runtime','state','native-state','identities','recordings','config','cache','data','home','tmp','bin','memoryweb']:(root/name).mkdir(mode=0o700)
    env={k:v for k,v in os.environ.items() if not k.startswith(('MV_','SRF_','ELECTRON_','DBUS_','WAYLAND_','PYTHON','NODE_','LD_','DYLD_')) and k not in ['BASH_ENV','ENV','GCONV_PATH','HOSTALIASES','ZDOTDIR']}
    for key,name in [('HOME','home'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache'),('XDG_DATA_HOME','data'),('XDG_RUNTIME_DIR','runtime'),('XDG_STATE_HOME','state'),('TMPDIR','tmp')]:env[key]=str(root/name)
    env.update(CARGO_TARGET_DIR='/home/admin/.cache/cargo-target/mv-wt-p18d',CAPSULE_UI_KIT_REPO='/home/admin/.cache/metaviewer-kit/kit-v0.2.1',ELECTRON_OVERRIDE_DIST_PATH='/home/admin/Documentos/Games/Holdings-int/app/shell/node_modules/electron/dist')
    env.update(DISPLAY=':95',P18D_ROOT=str(root),MV_MW_HOME=str(root/'memoryweb'),MV_OPERATOR_REPO=str(ROOT),MV_MW_WENDER_ROOT='/home/admin/Documentos/wender-agent-wt-pin')
    env['PATH']=str(root/'bin')+':/home/admin/.nvm/versions/node/v24.14.0/bin:/usr/local/go/bin:/home/admin/.cargo/bin:'+env.get('PATH','')
    # Record every Docker launch before exec, including short-lived helpers.
    wrapper = root/'bin/docker'
    wrapper.write_text("#!/usr/bin/env python3\n" +
        "import json, os, pathlib, re, sys, uuid\n" +
        "a=sys.argv[1:]\n" +
        "if a and a[0]=='run':\n" +
        " name=a[a.index('--name')+1] if '--name' in a else ''\n" +
        " if not name:\n" +
        "  mount=a[a.index('--mount')+1] if '--mount' in a else ''\n" +
        "  expected='type=bind,src='+os.environ['SRF_IDENTITY_STORE_ROOT']+'/profiles/p18d-a,dst=/profile'\n" +
        "  if mount!=expected or a[a.index('--network')+1]!='none': raise SystemExit('OWN_HELPER_REQUIRED')\n" +
        "  name='mv-provision-p18d-a-'+uuid.uuid4().hex[:12]; a[1:1]=['--name',name]\n" +
        " if not re.fullmatch(r'(?:mv-provision-p18d-[ab]-[a-f0-9]{12}|srf-id-p18d-a|srf-id-[a-f0-9]{12})',name): raise SystemExit('OWN_CONTAINER_REQUIRED')\n" +
        " if name.startswith('srf-id-'):\n" +
        "  expected='type=bind,src='+os.environ['SRF_IDENTITY_STORE_ROOT']+'/profiles/p18d-a,dst=/profile'\n" +
        "  if expected not in a: raise SystemExit('OWN_PROFILE_REQUIRED')\n" +
        " row=dict(unit='P18D-IDENTITIES-R3',pid=os.getpid(),container=name,kind='own docker launch')\n" +
        " for f in [" + repr(str(LEDGER)) + ", " + repr(str(root/'docker-started.jsonl')) + "]:\n" +
        "  with open(f,'a') as out: out.write(json.dumps(row)+'\\n')\n" +
        "os.execv('/usr/bin/docker',['/usr/bin/docker',*a])\n")
    wrapper.chmod(0o700)
    state=dict(root=str(root),processes=[],containers=[])
    # Resume only this unit's previous isolated test store, through public app
    # actions. No browser storage is read or copied by the supervisor.
    identity_root = Path(os.environ.get('P18D_TEST_STORE', str(root/'identities')))
    if not re.fullmatch(r'/tmp/claude-1000/xpra-spike/p18d-live-[a-z0-9_]+/identities', str(identity_root)):
        raise RuntimeError('OWN_STORE_REQUIRED')
    state['identityRoot'] = str(identity_root)
    STATE.write_text(json.dumps(state))
    def spawn(argv,label,cwd=ROOT):
        process=subprocess.Popen(list(map(str,argv)),cwd=cwd,env=env,start_new_session=True,stdout=(OUT/(label+'.log')).open('w'),stderr=subprocess.STDOUT)
        item=dict(pid=process.pid,starttime=record(process.pid,label,root=str(root)),kind=label)
        state['processes'].append(item);STATE.write_text(json.dumps(state))
        return process
    def bounded(argv,label,cwd=ROOT,expected=0):
        process=spawn(argv,label,cwd);deadline=time.monotonic()+150
        while process.poll() is None:
            descendants(state)
            if time.monotonic()>deadline:raise RuntimeError('OWN_COMMAND_TIMEOUT '+label)
            time.sleep(.02)
        receipt=dict(label=label,command=list(map(str,argv)),rc=process.returncode,cwd=str(cwd))
        with (OUT/'commands.jsonl').open('a') as sink:sink.write(json.dumps(receipt)+'\n')
        print(json.dumps(receipt),flush=True)
        if process.returncode!=expected:raise RuntimeError('OWN_COMMAND_REFUSED '+label)
    for name in ['srf-identity-admin','srf-identity-surface']:
        bounded(['/usr/local/go/bin/go','build','-o',root/'bin'/name,'./cmd/'+name],'live-build-'+name,OSROOT)
    bounded(['/usr/local/go/bin/go','build','-o',root/'bin/mv-daemon-adapter','./cmd/mv-daemon-adapter'],'live-build-adapter',ROOT/'daemon-adapter')
    env.update(SRF_IDENTITY_STORE_ROOT=str(identity_root),SRF_PROXY_REGISTRY=str(root/'registry.json'))
    (root/'registry.json').write_text('{}');(root/'registry.json').chmod(0o600)
    bounded([root/'bin/srf-identity-admin','show','--id','p18d-missing'],'live-empty-store',expected=4)
    source=(OSROOT/'src/browserid/surface/surface.go').read_text()
    match=re.search(r'RAMRoot\s*=\s*"([^"]+)"',source)
    if not match or not match[1].startswith('/dev/shm/'):raise RuntimeError('NATIVE_RAMROOT_UNPROVEN')
    ram=match[1]
    sys.path.insert(0,str(ROOT/'tests/e2e/e2e1_slice'));import live
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    registrations={c:live.registration(c,commit,uuid.uuid4().hex) for c in ['core','ui','agent','daemon']}
    config=dict(session_id='p18d-'+uuid.uuid4().hex,core=registrations['core'],peers=[registrations[c] for c in ['ui','agent','daemon']])
    (root/'core.json').write_text(json.dumps(config));(root/'core.json').chmod(0o600)
    profiles={f'mv-live-{i}':dict(Kind='browser',NativeKind='browser',RAMRoot=ram,Display=f':{108+i}',Width=1280,Height=900,default_mode='human',text_input='paste') for i in [3,4]}
    env.update(MV_CORE_CONFIG=str(root/'core.json'),MV_SESSION_ID=config['session_id'],MV_CORE_INSTANCE=registrations['core']['endpoint']['instance'],MV_DAEMON_INSTANCE=registrations['daemon']['endpoint']['instance'],MV_COMPONENT_COMMIT=commit,MV_CONTRACT_DIR=str(ROOT/'contracts/v0.2'),MV_SRF_LIVE_PROFILE='mv-live-3',MV_SRF_LIVE_RAM_ROOT=ram,MV_SRF_PROFILES=json.dumps(profiles),MV_SRF_STATE_DIR=str(root/'native-state'),MV_SRF_BIN_DIR=str(root/'bin'),MV_RECORDING_DESTINATION=str(root/'recordings'),MV_ADAPTER_BIN=str(root/'bin/mv-daemon-adapter'))
    probe=subprocess.run(['xdpyinfo','-display',':95'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if probe.returncode:
        if Path('/tmp/.X95-lock').exists():raise RuntimeError('OWN_DISPLAY_UNAVAILABLE')
        spawn(['Xvfb',':95','-screen','0','1600x1100x24','-nolisten','tcp'],'live-xvfb')
        time.sleep(.4)
    spawn(['/home/admin/.cache/cargo-target/mv-wt-p18d/debug/metaviewer-core'],'live-core')
    deadline=time.monotonic()+15
    while not (root/'runtime/metaviewer/core.sock').exists():
        if time.monotonic()>deadline:raise RuntimeError('OWN_CORE_NOT_READY')
        descendants(state);time.sleep(.05)
    # Distribution override is for Node's launcher lookup, not Electron runtime.
    env.pop('ELECTRON_OVERRIDE_DIST_PATH', None)
    app_process=spawn([ELECTRON,ROOT/'ui/test/p18d-dev.cjs'],'live-app')
    deadline=time.monotonic()+35
    while time.monotonic()<deadline:
        descendants(state)
        output=(OUT/'live-app.log').read_text()
        if app_process.poll() is not None:
            stop(state);raise RuntimeError('OWN_DEV_EXIT '+str(app_process.returncode))
        if 'SINGLE_INSTANCE' in output or 'BOOT_REFUSED' in output:
            stop(state);raise RuntimeError('BLOCKED isolated dev startup refused')
        if (root/'ready.json').exists():
            if 'P18D_DEV_LOCK_ISOLATED' not in output:raise RuntimeError('LOCK_PROOF_ABSENT')
            print(json.dumps(dict(root=str(root),lockIsolated=True,ready=True)));return
        time.sleep(.05)
    stop(state);raise RuntimeError('OWN_DEV_START_TIMEOUT')


if __name__=='__main__':
    if sys.argv[1]=='start':start()
    elif sys.argv[1]=='stop':stop(json.loads(STATE.read_text()))
    elif sys.argv[1]=='eval':print(json.dumps(rpc(json.loads(STATE.read_text()),'eval',source=sys.argv[2])))
