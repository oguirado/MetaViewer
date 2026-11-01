#!/usr/bin/env python3
"""Exercise layout.save through the real packaged renderer IPC on own display."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

BASE = Path('/tmp/claude-1000/xpra-spike')
LEDGER = Path('/home/admin/Música/TeamWork_Antigravity2/campaigns/metaviewer-0/out/pids.log')
BINARY = Path('/home/admin/Documentos/OpenSuperficies-wt-xverb/.p18-package-review/MetaViewer-linux-arm64/metaviewer')

def main():
    root = Path(tempfile.mkdtemp(prefix='p18-package-',dir=BASE))
    env = {k:v for k,v in os.environ.items() if not k.startswith(('MV_','SRF_','ELECTRON_','DBUS_','WAYLAND_','NODE_','PYTHON','LD_','DYLD_'))}
    for key in ['BASH_ENV','ENV','GCONV_PATH','HOSTALIASES','ZDOTDIR']:env.pop(key,None)
    for name in ['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR','TMPDIR']:
        directory = root/name.lower();directory.mkdir(mode=0o700);env[name]=str(directory)
    env.update(DISPLAY=':97',MV_PACKAGE_SMOKE='1',MV_PACKAGE_SMOKE_LAYOUT='1',MV_MW_WENDER_ROOT='/home/admin/Documentos/wender-agent-wt-pin')
    def record(p,kind):
        with LEDGER.open('a') as f:f.write(json.dumps(dict(unit='P18-MODES-TILES',pid=p.pid,kind=kind,root=str(root)))+'\n')
    xvfb = None
    if subprocess.run(['xdpyinfo','-display',':97'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        if Path('/tmp/.X97-lock').exists():raise RuntimeError('BLOCKED unowned X97 lock')
        xvfb = subprocess.Popen(['Xvfb',':97','-screen','0','1600x1100x24','-nolisten','tcp'],stdout=(root/'xvfb.log').open('w'),stderr=subprocess.STDOUT);record(xvfb,'Xvfb :97');time.sleep(.5)
    try:
        with (root/'package.log').open('w') as log:
            child = subprocess.Popen([str(BINARY)],env=env,stdout=log,stderr=subprocess.STDOUT);record(child,'packaged layout smoke')
            try:rc=child.wait(timeout=45)
            except subprocess.TimeoutExpired:child.terminate();rc=child.wait(timeout=50)
        output=(root/'package.log').read_text()
        print(output)
        print(json.dumps(dict(root=str(root),rc=rc,layoutSaved='METAVIEWER_LAYOUT_SAVE_PACKAGED_OK' in output)))
        if 'SINGLE_INSTANCE' in output or 'BOOT_REFUSED' in output:raise RuntimeError('BLOCKED isolated packaged start refused')
        if rc or 'METAVIEWER_LAYOUT_SAVE_PACKAGED_OK' not in output:raise RuntimeError('PACKAGED_LAYOUT_UNPROVEN')
    finally:
        if xvfb is not None:xvfb.terminate();xvfb.wait(timeout=5)

if __name__=='__main__':main()
