"""Prove the dev Electron lock on the isolated display before live work."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from p18_live import record

root = Path(tempfile.mkdtemp(prefix='p18b-lock-', dir='/tmp/claude-1000/xpra-spike'))
env = dict(os.environ, DISPLAY=':97')
for key in ['HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR','XDG_STATE_HOME','TMPDIR']:
    directory = root/key.lower()
    directory.mkdir(mode=0o700)
    env[key] = str(directory)
processes = []
try:
    if subprocess.run(['xdpyinfo','-display',':97'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        if Path('/tmp/.X97-lock').exists(): raise RuntimeError('BLOCKED unowned display lock')
        xvfb = subprocess.Popen(['Xvfb',':97','-screen','0','1600x1100x24','-nolisten','tcp'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        record(pid=xvfb.pid,kind='P18B lock display'); processes.append(xvfb)
        time.sleep(.5)
    script = root/'lock.cjs'
    script.write_text("const {app}=require('electron');app.setPath('userData',process.env.XDG_CONFIG_HOME+'/MetaViewer');if(!app.requestSingleInstanceLock()){console.error('SINGLE_INSTANCE');app.exit(7);}else{console.log('P18B_LOCK_ISOLATED '+app.getPath('userData'));app.exit(0);}")
    env['P18B_ELECTRON_MODULE'] = str(Path(__file__).resolve().parents[1]/'ui/node_modules/electron')
    logfile = Path(__file__).resolve().parents[1]/'.p18b-evidence/lock-app.log'
    with logfile.open('w') as output:
        app = subprocess.Popen(['/home/admin/Documentos/Games/Holdings-int/app/shell/node_modules/electron/dist/electron', str(script)], env=env, stdout=output, stderr=subprocess.STDOUT)
        record(pid=app.pid,kind='P18B lock app'); processes.append(app)
        rc = app.wait(timeout=20)
    text = logfile.read_text()
    if rc or 'SINGLE_INSTANCE' in text or 'BOOT_REFUSED' in text or 'P18B_LOCK_ISOLATED' not in text: raise RuntimeError('BLOCKED isolated lock unproven')
    print(json.dumps(dict(lockIsolated=True,rc=rc)))
finally:
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
