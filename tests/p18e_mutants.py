"""Executable negative controls. Rewrites are test-only and never dispatch Docker."""
import json
import os
from pathlib import Path
import subprocess
import sys
from p18e_verify import ROOT, OUT

NODE = '/home/admin/.nvm/versions/node/v24.14.0/bin/node'
mutants = [
    ('host-service', 'ui/electron/operatorBridge.js', "method==='identity.delete' && isProtectedIdentity(v.id)", 'false'),
    ('host-runner', 'ui/electron/operatorBridge.js', "method==='delete' && isProtectedIdentity(v.id)", 'false'),
    ('closed-refusal', 'ui/electron/preload.js', "'IDENTITY_PROTECTED',", ''),
    ('protected-policy', 'ui/electron/identityProtection.js', 'return /^(mv-', 'return /^(removed-'),
]
results=[]
for name, path, before, after in mutants:
    source=ROOT/path
    assert source.read_text().count(before)==1, name
    env=dict(os.environ,P18D_MUTATION=json.dumps(dict(path=str(source),before=before,after=after)))
    argv=[NODE,'--max-old-space-size=1024','--import',str(ROOT/'tests/p18d_mutant_loader.mjs'),
          '--test','--test-timeout=60000','--test-name-pattern=P18E host service', 'test/p18d-identities.test.js']
    with (OUT/('mutant-'+name+'.log')).open('w') as sink:
        result=subprocess.run(argv,cwd=ROOT/'ui',env=env,stdout=sink,stderr=subprocess.STDOUT,timeout=65)
    row=dict(name=name,command=argv,rc=result.returncode,killed=result.returncode!=0 and ('ERR_ASSERTION' in (OUT/('mutant-'+name+'.log')).read_text() or 'AssertionError' in (OUT/('mutant-'+name+'.log')).read_text()))
    results.append(row);print(json.dumps(row),flush=True)
source=(ROOT/'tools/mv_identity.py').read_text()
for name,before,after in [
    ('tool-delete-guard','if protected_identity(identity) or identity == self.live_profile:', 'if False:'),
    ('tool-prefix','"mv-", "cuentas-", "perplexity-",','"removed-", "removed-cuentas-", "removed-perplexity-",'),
    ('tool-existing-list','or value in PROTECTED_HOLDERS','or False'),
]:
    assert source.count(before)==1,name
    path=OUT/('mutant-'+name+'.py');path.write_text(source.replace(before,after))
    argv=[sys.executable,str(ROOT/'tests/test_p18e_identity.py')]
    with (OUT/('mutant-'+name+'.log')).open('w') as sink:
        result=subprocess.run(argv,env=dict(os.environ,P18E_IDENTITY_SOURCE=str(path)),stdout=sink,stderr=subprocess.STDOUT,timeout=15)
    row=dict(name=name,command=argv,rc=result.returncode,killed=result.returncode!=0 and ('ERR_ASSERTION' in (OUT/('mutant-'+name+'.log')).read_text() or 'AssertionError' in (OUT/('mutant-'+name+'.log')).read_text()))
    results.append(row);print(json.dumps(row),flush=True)
(OUT/'mutants.json').write_text(json.dumps(results,indent=2)+'\n')
if not all(row['killed'] for row in results):raise SystemExit('SURVIVING_MUTANT')
