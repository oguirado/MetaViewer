"""Run the real Dockview replay on the unit's isolated display; no backend."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from p18c_run import run, EVIDENCE, LEDGER, ROOT

def record(pid, kind):
    try:
        start=Path(f'/proc/{pid}/stat').read_text().rsplit(') ',1)[1].split()[19]
        with LEDGER.open('a') as f:f.write(json.dumps(dict(unit='P18C-R2',pid=pid,starttime=start,kind=kind))+'\n')
    except FileNotFoundError:pass

def main():
    EVIDENCE.mkdir(exist_ok=True)
    xvfb=None
    if subprocess.run(['xdpyinfo','-display',':97'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        if Path('/tmp/.X97-lock').exists():raise RuntimeError('UNOWNED_DISPLAY_LOCK')
        xvfb=subprocess.Popen(['Xvfb',':97','-screen','0','1600x1100x24','-nolisten','tcp'],stdout=(EVIDENCE/'r2-xvfb.log').open('w'),stderr=subprocess.STDOUT)
        record(xvfb.pid,'own restore Xvfb');time.sleep(.4)
    try:
        for mutant in [False,True]:
            label='r2-restore'+('-mutant' if mutant else '')
            argv=['/home/admin/.nvm/versions/node/v24.14.0/bin/node','ui/test/p18c-restore-build.mjs']+(['--mutant'] if mutant else [])
            if run(label+'-build',argv):raise RuntimeError('FIXTURE_BUILD_FAILED')
            root=Path(tempfile.mkdtemp(prefix='p18c-r2-restore-',dir='/tmp/claude-1000/xpra-spike'))
            for name in ['home','config','cache','data','runtime','state','session']:(root/name).mkdir(mode=0o700)
            for key,name in [('HOME','home'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache'),('XDG_DATA_HOME','data'),('XDG_RUNTIME_DIR','runtime'),('XDG_STATE_HOME','state')]:os.environ[key]=str(root/name)
            os.environ.update(DISPLAY=':97',P18C_RESTORE_ROOT=str(root))
            html=EVIDENCE/('restore-mutant' if mutant else 'restore')/'renderer/test/p18c-restore.html'
            rc=run(label,['/home/admin/Documentos/Games/Holdings-int/app/shell/node_modules/electron/dist/electron',str(ROOT/'ui/test/p18c-restore.cjs'),str(html)])
            output=(EVIDENCE/(label+'.log')).read_text()
            if 'SINGLE_INSTANCE' in output or 'BOOT_REFUSED' in output:raise RuntimeError('BLOCKED LOCK_ISOLATION_REFUSED')
            if 'P18C_RESTORE_LOCK_ISOLATED' not in output:raise RuntimeError('LOCK_PROOF_ABSENT')
            if rc!=(1 if mutant else 0):raise RuntimeError('MUTANT_SURVIVED' if mutant else 'RESTORE_REPLAY_FAILED')
            if mutant and 'WALL_NOT_SETTLED human-2' not in output:raise RuntimeError('MUTANT_FAILED_FOR_WRONG_REASON')
        print('PASS restored desktop replay; original leaf-root mutant rejected')
        cgroup=Path('/proc/self/cgroup').read_text().strip().split('::',1)[1]
        memory=Path('/sys/fs/cgroup')/cgroup.lstrip('/')
        print(json.dumps(dict(memoryPeakBytes=int((memory/'memory.peak').read_text()),memoryMax=(memory/'memory.max').read_text().strip(),memoryHigh=(memory/'memory.high').read_text().strip(),memorySwapMax=(memory/'memory.swap.max').read_text().strip())))
    finally:
        if xvfb:xvfb.terminate();xvfb.wait(timeout=5)

if __name__=='__main__':main()
