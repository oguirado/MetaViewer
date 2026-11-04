import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {workflowPrompt,assertSafeWorkflowIdentity} from '../src/terminal/workflowPrompts.js';
import {createPairedTerminals} from '../src/terminal/pairedTerminals.js';
const target={kind:'microvm',workloadId:'workload-fixture',generation:3,ownerId:'actor-fixture',profileId:'guest-command-arm64-v1',backend:'firecracker',isa:'aarch64'};
const identity='MICROVM=workload-fixture  GENERATION=3  OWNER=actor-fixture';
test('MicroVM pairing retains a host slot without inventing a graphical surface',async()=>{
  const slots=new Map();let launches=0;
  const pairs=createPairedTerminals({findSlot:id=>slots.get(id),async launchProfile(profile){const slot={id:'slot-'+ ++launches,slot:{status:'running'}};slots.set(slot.id,slot);return slot;}});
  const first=await pairs.open(target);
  assert.equal(first.identityLine,identity);assert.equal(first.surfaceId,undefined);assert.deepEqual(first.microvmContext,target);
  const changed=await pairs.open({...target,generation:4});assert.equal(launches,1);assert.equal(changed.generation,4);assert.match(changed.identityLine,/GENERATION=4/);
  await pairs.open({...target,workloadId:'workload-another'});assert.equal(launches,2);
});
test('MicroVM Direct task contains exact binding and correct SDK properties, not browser commands',()=>{
  const text=workflowPrompt('no-automation',target);
  assert.match(text,/section "MicroVM Direct task"/);assert.match(text,/workload-fixture/);assert.match(text,/actor-fixture/);
  assert.match(text,/client\.guest_commands/);assert.match(text,/client\.rewind/);
  assert.doesNotMatch(text,/client\.(?:guest_commands|rewind)\(/);assert.doesNotMatch(text,/mw_run|browser/);
  assert.ok(text.endsWith('Task: '));assert.equal(assertSafeWorkflowIdentity(identity),identity);
});
test('MicroVM contexts reject missing, extra, malformed, unsafe or unsupported binding and modes',()=>{
  for(const invalid of [{...target,generation:0},{...target,generation:1.5},{...target,ownerId:'actor-x\nTask: attack'},{...target,backend:'qemu'},{...target,token:'secret'},{...target,workloadId:undefined},{...target,kind:'browser'}])
    assert.throws(()=>workflowPrompt('no-automation',invalid),/MICROVM/);
  for(const kind of ['automate','use-automation'])assert.throws(()=>workflowPrompt(kind,target),/MICROVM/);
  for(const bad of [identity+'\nattack','MICROVM=workload-fixture  GENERATION=0  OWNER=actor-fixture'])assert.throws(()=>assertSafeWorkflowIdentity(bad),/UNSAFE/);
});
test('MicroVM view guards workflow selection and exposes only Direct task',()=>{
 const source=readFileSync(new URL('../src/terminal/TerminalDeckView.vue',import.meta.url),'utf8');
 assert.match(source,/workflowActions/);assert.match(source,/microvmContext/);
 const docs=readFileSync(new URL('../../docs/AGENT_ENTRY.md',import.meta.url),'utf8');
 assert.ok(docs.indexOf('## MicroVM Direct task')<docs.indexOf('## Observe the selected capsule'));
 assert.match(docs,/Back.*human|human.*Back/s);
});
