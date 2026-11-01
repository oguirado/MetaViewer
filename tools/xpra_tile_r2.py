#!/usr/bin/env python3
"""Isolated standalone demo supervisor; no product launcher or existing identity access."""
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import uuid

REPO = Path(__file__).resolve().parents[1]
SRF = Path('/home/admin/Documentos/OpenSuperficies-wt-xverb')
BASE = Path('/tmp/claude-1000/xpra-spike')
LEDGER = Path('/home/admin/Música/TeamWork_Antigravity2/campaigns/metaviewer-0/out/pids.log')
ELECTRON = '/home/admin/Documentos/Games/Holdings-int/app/shell/node_modules/electron/dist/electron'


def ledger(**row):
    with LEDGER.open('a') as f:
        f.write(json.dumps(dict(unit='XPRA-DEMO-SEGMENT', **row))+'\n')


def docker_relay():
    args = sys.argv[2:]
    if args and args[0] == 'run':
        if '--name' in args:
            name = args[args.index('--name')+1]
        else:
            name = 'xpra-demo-helper-'+uuid.uuid4().hex[:10]
            args[1:1] = ['--name', name]
        ledger(container=name, kind='docker-run', root=os.environ['MV_XPRA_SPIKE_ROOT'])
    p = subprocess.Popen(['/usr/bin/docker', *args])
    ledger(pid=p.pid, kind='docker-client', root=os.environ['MV_XPRA_SPIKE_ROOT'])
    rc = p.wait()
    with (Path(os.environ['MV_XPRA_SPIKE_ROOT'])/'commands.jsonl').open('a') as f:
        # Docker input text, environment and inspect output are never logged.
        f.write(json.dumps(dict(command=['docker', *args], rc=rc))+'\n')
    return rc


def main():
    args = sys.argv[1:]
    if args == ['--docker'] or (args and args[0] == '--docker'):
        return docker_relay()
    if len(args) != 1 or not (args[0] == '--new' or args[0].startswith('srf-id-')):
        print('usage: tools/xpra_operator_view.sh --new | <dedicated-demo-capsule>'); return 2
    BASE.mkdir(parents=True, exist_ok=True)
    if args[0] == '--new':
        root = Path(tempfile.mkdtemp(prefix='operator-', dir=BASE))
    else:
        value = os.environ.get('MV_XPRA_DEMO_ROOT', '')
        root = Path(value)
        if not value or not str(root).startswith(str(BASE)+'/operator-') or root.resolve()!=root:
            print('REFUSED: dedicated demo witness required; product capsules unsupported'); return 2
    root.chmod(0o700)
    env = {k:v for k,v in os.environ.items() if not k.startswith(('MV_', 'SRF_', 'DBUS_', 'WAYLAND_', 'ELECTRON_'))}
    for key, sub in [('HOME','home'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache'),
                     ('XDG_DATA_HOME','data'),('XDG_RUNTIME_DIR','run'),('TMPDIR','tmp')]:
        folder=root/sub;folder.mkdir(mode=0o700,exist_ok=True);env[key]=str(folder)
    env.update(DISPLAY=':97', MV_XPRA_SPIKE_ROOT=str(root), XPRA_PROBE_ROOT=str(root),
        MV_MW_WENDER_ROOT='/home/admin/Documentos/wender-agent-wt-pin',
        CARGO_TARGET_DIR='/home/admin/.cache/cargo-target/mv-wt-xtile',
        CAPSULE_UI_KIT_REPO='/home/admin/.cache/metaviewer-kit/kit-v0.2.1',
        ELECTRON_OVERRIDE_DIST_PATH=str(Path(ELECTRON).parent))
    bin_dir=root/'bin';bin_dir.mkdir(mode=0o700,exist_ok=True)
    relay=bin_dir/'docker'
    import shlex
    relay.write_text('#!/bin/sh\nexec /usr/bin/python3 '+shlex.quote(str(Path(__file__).resolve()))+' --docker "$@"\n');relay.chmod(0o700)
    env['PATH']=str(bin_dir)+':/usr/bin:/bin'
    ctypes.CDLL(None).prctl(36,1,0,0,0)
    ledger(pid=os.getpid(),kind='supervisor',root=str(root))
    seen=set()
    active=None
    def forward(signum, _frame):
        if active is not None and active.poll() is None:active.send_signal(signal.SIGTERM)
    signal.signal(signal.SIGTERM,forward)
    signal.signal(signal.SIGINT,forward)
    def record_tree(parent):
        table={}
        for item in Path('/proc').iterdir():
            if not item.name.isdigit():continue
            try:
                raw=(item/'stat').read_text();fields=raw[raw.rfind(')')+2:].split()
                table[int(item.name)]=(int(fields[1]),fields[19])
            except (OSError,ValueError):continue
        own={parent}
        while True:
            more={pid for pid,(ppid,_) in table.items() if ppid in own}
            if more<=own:break
            own|=more
        for pid in own-seen:
            ledger(pid=pid,starttime=table.get(pid,(None,None))[1],kind='own-process',root=str(root))
        seen.update(own)
    def run(argv, cwd=None, logfile=None):
        nonlocal active
        with (root/(logfile or 'build.log')).open('a') as out:
            p=subprocess.Popen(argv,cwd=cwd,env=env,stdout=out,stderr=out)
            active=p
            ledger(pid=p.pid,kind='command',root=str(root))
            reader=(root/logfile).open() if logfile=='operator.log' else None
            if reader:reader.seek(out.tell())
            while p.poll() is None:
                if reader:
                    for line in reader.readlines():
                        if not line.startswith('['):print(line,end='',flush=True)
                record_tree(p.pid);time.sleep(.02)
            rc=p.wait()
            if reader:
                for line in reader.readlines():
                    if not line.startswith('['):print(line,end='',flush=True)
                reader.close()
            active=None
        with (root/'commands.jsonl').open('a') as f:f.write(json.dumps(dict(command=argv,rc=rc))+'\n')
        return rc
    xvfb=None
    def display_ready():
        return subprocess.run(['/usr/bin/xdpyinfo','-display',':97'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0
    if not display_ready():
        lock=Path('/tmp/.X97-lock')
        if lock.exists():
            stale=int(lock.read_text().strip())
            ours=False
            with LEDGER.open() as rows:
                for line in rows:
                    try:row=json.loads(line)
                    except ValueError:continue
                    if row.get('pid')==stale and row.get('unit')=='XPRA-DEMO-SEGMENT' and row.get('kind')=='Xvfb :97':ours=True
            stat=Path(f'/proc/{stale}/stat')
            dead=not stat.exists() or stat.read_text().split(') ')[-1].startswith('Z ')
            if not (ours and dead):
                print('BLOCKED: unavailable :97 has an unowned lock');return 7
            lock.unlink()
            Path('/tmp/.X11-unix/X97').unlink(missing_ok=True)
        log=(root/'xvfb.log').open('w')
        xvfb=subprocess.Popen(['/usr/bin/Xvfb',':97','-screen','0','1600x1000x24','-nolisten','tcp'],stdout=log,stderr=log)
        ledger(pid=xvfb.pid,kind='Xvfb :97',root=str(root))
        for _ in range(100):
            if display_ready():break
            time.sleep(.02)
        if not display_ready():
            xvfb.terminate();xvfb.wait(timeout=5)
            print('BLOCKED: own :97 did not start');return 7
    # Chromium/GTK clamps a screen-sized window below the requested bounds.
    # Reuse an existing :97 only if it can contain the fixed viewport in full.
    import re
    dimensions=subprocess.run(['/usr/bin/xdpyinfo','-display',':97'],capture_output=True,text=True)
    match=re.search(r'dimensions:\s+(\d+)x(\d+) pixels',dimensions.stdout)
    if dimensions.returncode or not match or int(match[1])<=1280 or int(match[2])<=900:
        if xvfb is not None:xvfb.terminate();xvfb.wait(timeout=5)
        print('BLOCKED: :97 must exceed the fixed 1280x900 viewport');return 7
    print('DEMO_ROOT='+str(root),flush=True)
    try:
        rc=run([ELECTRON,str(REPO/'tools/xpra_lock_probe.cjs'),'--probe'],logfile='probe.log')
        probe=(root/'probe.log').read_text()
        if rc or 'SPIKE_LOCK_ISOLATED' not in probe or 'SINGLE_INSTANCE' in probe or 'BOOT_REFUSED' in probe:
            print('BLOCKED: isolated lock probe refused; no capsule started');return 7
        print('LOCK_ISOLATED probe rc=0',flush=True)
        for package,name in [('srf-identity-surface','srf-identity-surface'),('srf-identity-admin','srf-identity-admin')]:
            rc=run(['/usr/local/go/bin/go','build','-o',str(root/name),'./cmd/'+package],cwd=SRF)
            if rc:print('BUILD_FAILED '+name);return rc
        rc=run([ELECTRON,str(REPO/'tools/xpra_tile_r2.cjs'),args[0]],logfile='operator.log')
        # Stop our display before waiting for all adopted children, including Xvfb.
        if xvfb is not None:
            xvfb.terminate();xvfb.wait(timeout=5);xvfb=None
        # Reap crashpad and native restore children after Electron termination.
        deadline=time.monotonic()+150
        while time.monotonic()<deadline:
            try:
                child,status=os.waitpid(-1,os.WNOHANG)
                if child:ledger(pid=child,kind='reaped',status=status)
                else:time.sleep(.02)
            except ChildProcessError:break
        else:print('CLEANUP_UNPROVEN');return 9
        return rc
    finally:
        if xvfb is not None:
            xvfb.terminate();xvfb.wait(timeout=5)


if __name__=='__main__':
    raise SystemExit(main())
