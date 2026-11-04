import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {OPERATOR_RESOURCES,packageArchitecture} from '../tools/package.js';
const docs=['docs/AGENT_ENTRY.md','docs/AUTOMATE_FROM_DEMO.md','docs/MW_RUN_FIRST_RUN.md','tools/mw_run_browser_goal.md','tools/mw_run_program.md'];
test('both supported package architectures include every workflow entry document',()=>{
 for(const arch of ['arm64','x64']) {
  assert.equal(packageArchitecture(arch).arch,arch);
  for(const path of docs)assert.ok(OPERATOR_RESOURCES.includes(path),`${arch}: ${path}`);
 }
});
test('workflow documentation uses the real attachment pointer and explains initial observation',()=>{
 for(const path of [...docs,'docs/USER_GUIDE.md','docs/JUDGE_TROUBLESHOOTING.md']) {
  const text=readFileSync(new URL('../../'+path,import.meta.url),'utf8');
  assert.doesNotMatch(text,/Copy env path/);
 }
 const entry=readFileSync(new URL('../../docs/AGENT_ENTRY.md',import.meta.url),'utf8');
 assert.match(entry,/BrowserGoalBackend/);
 assert.match(entry,/backend.surface_id != capsule/);
 assert.match(entry,/backend.observe\(5000\)/);
 assert.match(entry,/No action is submitted/);
});
