import os,tempfile,sys
from pathlib import Path
from p18f_verify import run,ROOT,OUT
root=Path(tempfile.mkdtemp(prefix='p18f-browser-',dir='/tmp/claude-1000/xpra-spike'))
for key,name in [('HOME','home'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache'),('XDG_DATA_HOME','data'),('XDG_RUNTIME_DIR','runtime'),('XDG_STATE_HOME','state'),('TMPDIR','tmp')]:
 (root/name).mkdir(mode=0o700);os.environ[key]=str(root/name)
os.environ['DISPLAY']=':97';os.environ['P18F_BROWSER_ROOT']=str(root)
raise SystemExit(run('browser'+('-'+os.environ['P18F_MUTANT'] if os.environ.get('P18F_MUTANT') else ''),['/home/admin/Documentos/Games/Holdings-int/app/shell/node_modules/electron/dist/electron',ROOT/'ui/test/p18f-browser.cjs',OUT/('browser'+('-'+os.environ['P18F_MUTANT'] if os.environ.get('P18F_MUTANT') else '')+'/renderer/test/p18f-browser.html'),OUT/'screenshots',*sys.argv[1:]]))
