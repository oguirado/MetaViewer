#!/usr/bin/env python3
"""Serial behavioral mutants; always restore and verify the original source bytes."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
NODE='/home/admin/.nvm/versions/node/v24.14.0/bin/node'
GO='/usr/local/go/bin/go'
UI=[NODE,'--test','--test-force-exit','--test-timeout=10000']
cases=[
 ('legacy-default','ui/electron/roleHost.js',"raw[profile]?.default_mode ?? raw[profile]?.role ?? 'agent'","'agent'",'P18 opening mode overrides'),
 ('duplicate-identity','ui/electron/roleHost.js',"if (bound.has(choice.profileId)) throw refuse('PROFILE_ALREADY_BOUND');",'/* bypass identity fence */','P18 opening mode overrides'),
 ('switch-without-stop','ui/electron/roleHost.js','      await stop(surfaceId);','      /* omit stop */','P18 switch closes'),
 ('login-without-confirmation','ui/electron/roleHost.js','lastLogin:await markers.read(p.id)','lastLogin:(await markers.read(p.id)) || Date.now()','P18 last login'),
 ('login-in-agent','ui/electron/roleHost.js',"if (roleFor(surface) !== 'human' || surface.control !== 'human') throw refuse('LOGIN_CONFIRMATION_REQUIRES_HUMAN');",'/* admit agent confirmation */','P18 last login'),
 ('trace-flat','ui/electron/humanTrace.js','    directory = join(directory, profileId);','    /* omit identity directory */','P18 trace destination'),
 ('minimized-counted','ui/src/wall/WallWorkspace.vue','tiles.filter(tile => !tile.hidden && !tile.floating)','tiles.filter(tile => !tile.floating)','P18 minimized'),
 ('preset-single-geometry','ui/src/wall/WallWorkspace.vue',"preset === 'single' ? 1 : Math.min(2,count)","preset === 'single' ? Math.min(2,count) : Math.min(2,count)",'P18 each preset'),
 ('preset-grid-geometry','ui/src/wall/WallWorkspace.vue',"preset === 'single' ? 1 : Math.min(2,count)","preset === 'single' || preset === 'grid' ? 1 : Math.min(2,count)",'P18 each preset'),
 ('preset-side-geometry','ui/src/wall/WallWorkspace.vue',"preset === 'single' ? 1 : Math.min(2,count)","preset === 'single' || preset === 'side-by-side' ? 1 : Math.min(2,count)",'P18 each preset'),
 ('mode-ignored','daemon-adapter/internal/capsule/manager.go','p.Role, err = selector.ConsumeOpeningMode(q.ProfileID, p.Role)','_, err = selector.ConsumeOpeningMode(q.ProfileID, p.Role)',None),
 ('preset-focus-geometry','ui/src/wall/WallWorkspace.vue','width * 0.7','width * 0.6','P18 each preset'),
 ('keymap-omitted','ui/electron/xpraClient.js',"(keyboardLayout ? '&keyboard_layout=' + encodeURIComponent(keyboardLayout) : '')","''",'P18 host XKB'),
 ('human-agent-builder','ui/src/App.vue',None,None,'P18 native human path'),
 ('human-initial-capture','daemon-adapter/internal/daemon/dispatch.go','if opening.Role == "human" {\n\t\t\treturn events, nil\n\t\t}', 'if opening.Role == "never" { return events, nil }',None),
 ('human-frame-subscribe','daemon-adapter/internal/daemon/subscriptions.go','if b.Role == "human" {\n\t\t\treturn nil, nil\n\t\t}', 'if false { return nil, nil }',None),
 ('fresh-capture-bypass','core/src/admission/mod.rs','''        let Some(f) = &s.frame else {
            return Ok(Some(Refusal::StaleFrame));
        };''','''        let synthetic = Frame {sha256:p.based_on_frame.sha256.clone(),generation:p.based_on_frame.generation,width:1280,height:900};
        let f = s.frame.as_ref().unwrap_or(&synthetic);''',None),
]
results=[]
for label,relative,old,new,pattern in cases:
 path=ROOT/relative;original=path.read_bytes();source=original.decode()
 if label=='human-agent-builder':
  begin=source.index('  // Native human capsules never enter the agent Control intent builder.')
  end=source.index("  if (verb === 'release_control')",begin)
  old=source[begin:end];new=''
 if old not in source:raise RuntimeError('MUTATION_ANCHOR_ABSENT '+label)
 try:
  path.write_text(source.replace(old,new,1))
  if label == 'mode-ignored':
   cwd=ROOT/'daemon-adapter';argv=[GO,'test','./internal/capsule','-run','TestOpeningModeOverridesLegacyAndBindsPerCapsule','-count=1']
  elif relative.startswith('daemon-adapter'):
   cwd=ROOT/'daemon-adapter';argv=[GO,'test','./internal/daemon','-run','TestHumanOpeningHasNoInitialCaptureOrFrameSubscription','-count=1']
  elif relative.startswith('core/'):
   cwd=ROOT;argv=['/home/admin/.cargo/bin/cargo','test','--offline','--locked','-p','metaviewer-core','--test','xpra_role_tiles','switched_agent_lifetime_requires_its_own_fresh_verified_capture']
  else:
   cwd=ROOT;argv=UI+['--test-name-pattern='+pattern,'ui/test/p18-modes-tiles.test.js']
  run=subprocess.run([sys.executable,str(ROOT/'tools/p18_run.py'),'mutant-'+label,*argv],cwd=cwd)
  log=(ROOT/'.p18-evidence'/('mutant-'+label+'.log')).read_text()
  killed=run.returncode!=0 and any(marker in log for marker in ['AssertionError','assertion `left == right` failed','human opening attempted','human subscription started polling','wrong opening mode','opening mode did not override legacy default','human cleanup requires nonexistent frame allocation'])
  results.append(dict(mutant=label,rc=run.returncode,killed=killed))
 finally:
  path.write_bytes(original)
  assert hashlib.sha256(path.read_bytes()).digest()==hashlib.sha256(original).digest()
print(json.dumps(results))
if not all(row['killed'] for row in results):raise SystemExit(1)
