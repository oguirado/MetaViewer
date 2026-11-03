import test from 'node:test';
import assert from 'node:assert/strict';
import {createPairedTerminals} from '../src/terminal/pairedTerminals.js';

function fixture() {
  const slots=new Map(),focus=[];let launches=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const controller={findSlot:id=>slots.get(id),focusSlot:id=>focus.push(id),async launchProfile(command){
    assert.equal(command,'shell');const id='slot-'+(++launches);await gate;const slot={id};slots.set(id,slot);return slot;
  }};
  return {pairs:createPairedTerminals(controller),slots,focus,release,get launches(){return launches;}};
}
test('repeated and concurrent opens reuse one exact capsule shell',async()=>{
  const f=fixture(),target={surfaceId:'surface-a',profileId:'identity-a',title:'Browser'};
  const first=f.pairs.open(target),second=f.pairs.open(target);f.release();
  const [a,b]=await Promise.all([first,second]);assert.equal(f.launches,1);assert.deepEqual(a,b);
  assert.equal((await f.pairs.open(target)).slotId,a.slotId);assert.equal(f.launches,1);
  assert.match(a.identityLine,/identity-a/);assert.equal(f.pairs.forSlot(a.slotId).surfaceId,'surface-a');
});
test('distinct capsule identities stay separate and deleted slots can be replaced',async()=>{
  const f=fixture();f.release();
  const a=await f.pairs.open({surfaceId:'surface-a',profileId:'identity-a'});
  const b=await f.pairs.open({surfaceId:'surface-b',profileId:'identity-b'});
  assert.notEqual(a.slotId,b.slotId);assert.match(b.identityLine,/identity-b/);assert.doesNotMatch(b.identityLine,/identity-a/);
  f.slots.delete(a.slotId);assert.equal(f.pairs.forSlot(a.slotId),null);
  assert.notEqual((await f.pairs.open({surfaceId:'surface-a'})).slotId,a.slotId);
  assert.equal(f.pairs.forSlot('unpaired'),null);
});
test('invalid target never opens a shell and failed opens remain retryable',async()=>{
  let attempts=0;
  const pairs=createPairedTerminals({findSlot(){},focusSlot(){},async launchProfile(){attempts++;throw Error('BROKER_REFUSED');}});
  await assert.rejects(()=>pairs.open({surfaceId:'bad id'}),/PAIRED_CAPSULE_INVALID/);assert.equal(attempts,0);
  for(let i=0;i<2;i++) await assert.rejects(()=>pairs.open({surfaceId:'surface-a'}),/BROKER_REFUSED/);
  assert.equal(attempts,2);
});


test('paired header inventory rejects missing identity, capability and action guards',async()=>{
  const {readFileSync}=await import('node:fs');
  const {withoutPairedTerminalControl}=await import('./pairedTerminalMarkup.js');
  const source=readFileSync(new URL('../src/wall/SurfacePanel.vue',import.meta.url),'utf8');
  assert.doesNotMatch(withoutPairedTerminalControl(source),/mv-tile-terminal-toggle/);
  for(const key of ['v-if=',':id=',':data-semantic-anchor=',':aria-label=',':aria-expanded=','@click.stop=']) {
    assert.throws(()=>withoutPairedTerminalControl(source.replace(key,'removed=')),assert.AssertionError);
  }
});


test('legacy header-button suppression preserves the paired terminal control',async()=>{
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../src/App.vue',import.meta.url),'utf8');
  const selector=source.match(/([^{}]+cuk-capsule-panel__actions[^{}]+)\{ display:none; \}/)?.[1];
  assert.ok(selector);assert.ok(selector.includes(':not(.mv-tile-terminal-toggle)'));
});
