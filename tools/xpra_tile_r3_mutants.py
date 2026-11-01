#!/usr/bin/env python3
"""Bounded R3 mutants; restore original bytes even after a failed test run."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[1]
NODE='/home/admin/.nvm/versions/node/v24.14.0/bin/node'
mutants=[
 ('native-reconnect','ui/electron/xpraClient.js','&reconnect=false','&reconnect=true','both role mounts send',False),
 ('no-retry','ui/electron/xpraRecovery.js','later(retry, xpraRetryDelay(attempt++));','/* no retry */','recovery backoff',False),
 ('early-ready','ui/electron/xpraHumanTile.js','await waitForXpraClient(wc, {writable, isActive:live});','/* bypass readiness */','lost connection reloads',True),
 ('stale-bridge','ui/electron/xpraHumanSession.js','if (await bridge?.isHealthy?.() === true)','if (true)','healthy bridge is reused',False),
 ('no-crash-error','ui/electron/xpraHumanTile.js',"wc.on('render-process-gone', () => fail('XPRA_VIEW_CRASHED'));",'/* ignore child crash */','child crash and hang',False),
 ('no-hang-error','ui/electron/xpraHumanTile.js',"wc.on('unresponsive', () => fail('XPRA_VIEW_UNRESPONSIVE'));",'/* ignore child hang */','child crash and hang',False),
 ('app-shortcuts','ui/electron/xpraHumanTile.js','wc.setIgnoreMenuShortcuts(true);','wc.setIgnoreMenuShortcuts(false);','human shortcuts reach',False),
 ('swallow-human-keys','ui/electron/xpraHumanTile.js',"wc.on('before-input-event', () => { wc.setIgnoreMenuShortcuts(true); });","wc.on('before-input-event', event => { event.preventDefault(); wc.setIgnoreMenuShortcuts(true); });",'human shortcuts reach',False),
 ('layout-revokes','ui/src/surfaces/RoleSurface.vue','await api.visibility(props.surfaceId,false);','await revoke();','human role never instantiates',False),
]
results=[]
for name,relative,old,new,pattern,last in mutants:
 path=ROOT/relative;original=path.read_bytes();source=original.decode()
 if old not in source:raise RuntimeError('MUTATION_ANCHOR_ABSENT '+name)
 if last:
  head,tail=source.rsplit(old,1);changed=head+new+tail
 else:changed=source.replace(old,new)
 try:
  path.write_text(changed)
  argv=[NODE,'--test','--test-force-exit','--test-timeout=5000','--test-name-pattern='+pattern,'test/xpra-role-tiles.test.js']
  run=subprocess.run([sys.executable,str(ROOT/'tools/xpra_role_run.py'),'r3-mutant-'+name,'--',*argv],cwd=ROOT/'ui')
  log=(ROOT/'.xpra-evidence'/('r3-mutant-'+name+'.log')).read_text()
  killed=run.returncode!=0 and ('AssertionError' in log or 'ERR_ASSERTION' in log)
  results.append(dict(mutant=name,rc=run.returncode,killed=killed))
 finally:
  path.write_bytes(original)
  assert hashlib.sha256(path.read_bytes()).digest()==hashlib.sha256(original).digest()
(ROOT/'.xpra-evidence/r3-mutants.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results))
if not all(row['killed'] for row in results):raise SystemExit(1)
