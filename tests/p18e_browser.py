import os
from pathlib import Path
import subprocess
import tempfile
from p18e_verify import ROOT, record
root=Path(tempfile.mkdtemp(prefix='p18e-browser-',dir='/tmp/claude-1000/xpra-spike'))
env=dict(os.environ,DISPLAY=':97',P18E_BROWSER_ROOT=str(root))
for key in ['HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR','XDG_STATE_HOME','TMPDIR']:
    directory=root/key.lower();directory.mkdir(mode=0o700);env[key]=str(directory)
env.pop('ELECTRON_OVERRIDE_DIST_PATH',None)
child=subprocess.Popen(['/home/admin/Documentos/Games/Holdings-int/app/shell/node_modules/electron/dist/electron',str(ROOT/'ui/test/p18e-browser.cjs'),str(ROOT/('.p18-evidence/p18e/browser'+('-'+os.environ['P18E_BROWSER_MUTANT'] if os.environ.get('P18E_BROWSER_MUTANT') else '')+'/renderer/test/p18e-browser.html'))],env=env)
record(child.pid,'own browser fixture')
try:
    rc=child.wait(timeout=50)
    cgroup=Path('/proc/self/cgroup').read_text().strip().split('::',1)[1]
    peak=int((Path('/sys/fs/cgroup'+cgroup)/'memory.peak').read_text())
    print('P18E_BROWSER_MEMORY_PEAK_BYTES '+str(peak),flush=True)
    if peak>2*1024**3:raise RuntimeError('UI_MEMORY_TARGET_EXCEEDED')
    raise SystemExit(rc)
finally:
    if child.poll() is None:child.terminate();child.wait(timeout=5)
