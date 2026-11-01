#!/usr/bin/env python3
"""Compare the existing UI suite against the pinned R1 source, always restoring edits."""
import hashlib, json, pathlib, subprocess, sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
paths=['ui/electron/roleHost.js','ui/electron/xpraHumanBridge.js','ui/electron/xpraHumanTile.js',
       'ui/electron/xpraTracePreload.cjs','ui/src/surfaces/RoleSurface.vue','ui/test/xpra-role-tiles.test.js']
saved={name:(ROOT/name).read_bytes() for name in paths}
original={name:subprocess.check_output(['git','show','9ccd712d3:'+name],cwd=ROOT) for name in paths}
try:
 for name,data in original.items():(ROOT/name).write_bytes(data)
 result=subprocess.run([sys.executable,str(ROOT/'tools/xpra_role_run.py'),'r2-ui-baseline','--',
  '/home/admin/.nvm/versions/node/v24.14.0/bin/node','--test','--test-concurrency=4',
  '--test-timeout=120000',*[str(p.relative_to(ROOT/'ui')) for p in sorted((ROOT/'ui/test').glob('*.test.js'))]],cwd=ROOT/'ui')
finally:
 for name,data in saved.items():(ROOT/name).write_bytes(data)
assert all((ROOT/name).read_bytes()==data for name,data in saved.items())
(ROOT/'.xpra-evidence/r2-ui-baseline-source.json').write_text(json.dumps({'ref':'9ccd712d3',
 'rc':result.returncode,'restored':True,'files':{name:hashlib.sha256(data).hexdigest() for name,data in original.items()}},indent=2)+'\n')
print(json.dumps({'baseline_rc':result.returncode,'edits_restored':True}))
