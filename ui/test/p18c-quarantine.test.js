import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {kitQuarantineReason} from '../tools/kitQuarantineReason.js';
const source=readFileSync(new URL('../.kit/capsule-ui-kit/src/workspace/DockWorkspace.vue',import.meta.url),'utf8');
test('P18C quarantine overlay preserves the pinned source and refuses drift',()=>{
  const patched=kitQuarantineReason(source);
  assert(patched.includes("ref('LAYOUT_RESTORE_PENDING')"));
  assert.throws(()=>kitQuarantineReason(source.replace("const quarantineReason = ref('');",'')),/OVERLAY_DRIFT/);
});
function reasonOracle(transform) {
  const patched=transform(source);
  const expression=patched.match(/quarantineReason.value = (.*);/)[1];
  const reason=new Function('st',`return ${expression};`);
  assert.equal(reason({restorePhase:'uninitialized',quarantineCode:null,quarantineReason:null}),'LAYOUT_RESTORE_PENDING');
  assert.equal(reason({restorePhase:'restoring',quarantineCode:null,quarantineReason:null}),'LAYOUT_RESTORE_PENDING');
  assert.equal(reason({restorePhase:'read-only-quarantine',quarantineCode:'SCHEMA_FUTURE',quarantineReason:''}),'SCHEMA_FUTURE');
  assert.equal(reason({restorePhase:'read-only-quarantine',quarantineCode:null,quarantineReason:'  '}),'LAYOUT_READ_ONLY');
  assert.equal(reason({restorePhase:'read-only-quarantine',quarantineCode:'CORRUPT',quarantineReason:'Invalid JSON'}),'CORRUPT: Invalid JSON');
}
test('P18C banner always contains a reason code',()=>reasonOracle(kitQuarantineReason));
test('P18C mutant: the original blank banner is rejected',()=>{
  assert.throws(()=>reasonOracle(value=>value),{code:'ERR_ASSERTION'});
});
