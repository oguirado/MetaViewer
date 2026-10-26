import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as surface from '../src/surfaces/tileScheduler.js';
const binding = { principal: 'utility', epoch: 1, surfaceId: 'A', surfaceGeneration: 1 };
const budget = Object.freeze({maxDrawsPerTick:1,maxUploadBytesPerTick:1024,maxPresentMsPerTick:8,maxWarmResourcesPerSurface:1,maxDrainSteps:1});
const state = {panelOpen:true,panelSelected:true,folded:false,width:10,height:10,viewportIntersecting:true,windowPresentationAllowed:true,contextLost:false};
const canvas = () => ({getContext:()=>({createImageData:()=>({data:new Uint8ClampedArray(4)}),putImageData(){}})});
const frame = (generation, extra={}) => ({...binding,frameGeneration:generation,leaseId:`l${generation}`,width:1,height:1,format:'rgb24',sha256:'1'.repeat(64),pixelSpec:{format:'rgb24'},byteLength:3,bytes:new Uint8Array([12,34,56]),...extra});
function scheduler() {
  const releases=[];
  const engine=surface.createTileScheduler({budget,onReleaseLease:r=>releases.push(r)});
  assert.equal(engine.registerSurface({...binding,state}).ok,true);
  return {engine,releases};
}
// Exercise the real handoff callback at the port boundary: the real port rejects
// wrong identities and serializes consumers, masking these defensive cases.
function handoff() {
  let consumer;
  const source=readFileSync(new URL('../src/surfaces/frameTile.js',import.meta.url),'utf8')
    .replace(/^import .*;\n/gm,'').replace('export function','function');
  const create=new Function('createFramePort','createTileScheduler',`${source}\nreturn createFrameTile;`)(options=>{
    consumer=options.onFrame; return {revokeFramePort(){}};
  },surface.createTileScheduler);
  const tile=create({port:{},binding,limits:{},budget,state});
  return {tile,onFrame:f=>consumer(f)};
}
test('W1 present: absent or failing canvas settles once without presentation',()=>{
  for (const target of [null,{getContext(){throw Error('lost');}}, {getContext:()=>null}]) {
    const {engine,releases}=scheduler();
    if(target) engine.attachCanvas({surfaceId:'A',canvas:target});
    engine.submitFrame(frame(1));
    assert.deepEqual(engine.runTick().presented,[]);
    const metrics=engine.getInstrumentation('A');
    assert.equal(metrics.presentCount,0); assert.equal(metrics.presentedPendingFrameGen,null);
    assert.equal(metrics.drawSubmissions,0); assert.equal(metrics.uploadSubmissions,0);
    assert.equal(releases.length,1); assert.equal(releases[0].reason,'REFUSED');
    engine.runTick(); assert.equal(releases.length,1); engine.destroy();
  }
});
test('W1 re-register: dispose once and preserve floors; newer lifetime resets',()=>{
  const {engine,releases}=scheduler(); let disposed=0;
  engine.attachCanvas({surfaceId:'A',canvas:canvas()});
  engine.recordCaptureWitness({surfaceId:'A',surfaceGeneration:1,captureGeneration:5});
  engine.allocateWarmResource('A',{resourceId:'native',byteLength:8,dispose:()=>disposed++});
  engine.submitFrame(frame(5)); assert.equal(engine.runTick().presented.length,1);
  assert.equal(releases[0].reason,'PRESENTED');
  assert.equal(engine.registerSurface({...binding,state}).ok,true);
  assert.equal(disposed,1);
  assert.equal(engine.submitFrame(frame(2)).reason,'STALE_FRAME_GENERATION');
  assert.equal(engine.recordCaptureWitness({surfaceId:'A',surfaceGeneration:1,captureGeneration:2}).reason,'STALE_FRAME_GENERATION');
  assert.equal(engine.registerSurface({...binding,surfaceGeneration:2,state}).ok,true);
  assert.equal(engine.submitFrame(frame(2,{surfaceGeneration:2})).ok,true);
  engine.destroy(); assert.equal(disposed,1);
});
test('W1 handoff: rejected identity cannot poison folded capture floor',async()=>{
  const {tile,onFrame}=handoff();
  try {
    tile.scheduler.foldSurface('A');
    assert.equal((await onFrame(frame(999,{principal:'intruder'}))).outcome,'REFUSED');
    tile.scheduler.unfoldSurface('A');
    const pending=onFrame(frame(2));
    assert.equal(tile.scheduler.getInstrumentation('A').pendingMailboxFrameGen,2);
    tile.scheduler.attachCanvas({surfaceId:'A',canvas:canvas()}); tile.scheduler.runTick();
    assert.equal((await pending).outcome,'PRESENTED');
  } finally {tile.close();}
});
test('W1 handoff: valid folded witness still ratchets admission',async()=>{
  const {tile,onFrame}=handoff();
  try {
    tile.scheduler.foldSurface('A');
    assert.equal((await onFrame(frame(9))).outcome,'REFUSED');
    assert.equal(tile.scheduler.getInstrumentation('A').captureCount,1);
    tile.scheduler.unfoldSurface('A');
    assert.equal((await onFrame(frame(2))).outcome,'REFUSED');
  } finally {tile.close();}
});
test('W1 handoff: duplicate pending lease refuses second and settles first once',async()=>{
  const {tile,onFrame}=handoff(); let settled=0;
  try {
    const first=onFrame(frame(1)).then(r=>{settled++;return r;});
    const second=onFrame(frame(2,{leaseId:'l1'}));
    // A microtask checkpoint detects immediate refusal without a hanging test.
    let duplicate; second.then(r=>{duplicate=r;}); await Promise.resolve();
    assert.deepEqual(duplicate,{outcome:'REFUSED'});
    tile.scheduler.attachCanvas({surfaceId:'A',canvas:canvas()}); tile.scheduler.runTick();
    assert.equal((await first).outcome,'PRESENTED');
    tile.close(); await Promise.resolve(); assert.equal(settled,1);
  } finally {tile.close();}
});
// Execute the SFC setup with lifecycle hooks and canvas refs controlled by the
// test. Real attachCanvas owns identity validation; no DOM package is needed.
function mount(engine, supplied) {
  const source=readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue',import.meta.url),'utf8')
    .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/import[\s\S]*?from ['"][^'"]+['"];\n/g,'');
  const mounted=[], watchers=[], events=[]; let props;
  const hooks={...surface,computed:fn=>({get value(){return fn();}}),inject:()=>engine,
    ref:()=>({value:canvas()}),onMounted:fn=>mounted.push(fn),onBeforeUnmount:()=>{},watch:(get,fn)=>watchers.push(fn),
    defineProps:definitions=>(props=Object.fromEntries(Object.entries(definitions).map(([key,value])=>[key,supplied[key]??value.default]))),
    defineEmits:()=>((...args)=>events.push(args))};
  new Function(...Object.keys(hooks),source)(...Object.values(hooks)); mounted.forEach(fn=>fn());
  return {events,update(next){const previous=[props.surfaceId,props.generation,props.epoch];Object.assign(props,next);watchers.forEach(fn=>fn(null,previous));}};
}
for(const [name,props,attached] of [
  ['default',{},true],['numeric strings',{generation:'1',epoch:'1'},true],
  ['App String(epoch)',{epoch:String(1)},true],['mismatch',{generation:2},false],
  ['invalid',{epoch:'invalid'},false],['zero',{epoch:0},false],
]) test(`W1 canvas binding: ${name}`,()=>{
  const {engine}=scheduler();
  const mounted=mount(engine,{surfaceId:'A',...props});
  assert.equal(engine.getInstrumentation('A').canvasAttached,attached);
  assert.equal(mounted.events.filter(([event])=>event==='canvas-ready').length,attached?1:0);
  engine.destroy();
});
test('W1 canvas binding: watch normalizes and refuses mismatched rebind',()=>{
  const {engine}=scheduler(); const mounted=mount(engine,{surfaceId:'A'});
  mounted.update({generation:'1',epoch:'1'}); assert.equal(engine.getInstrumentation('A').canvasAttached,true);
  mounted.update({generation:'2'}); assert.equal(engine.getInstrumentation('A').canvasAttached,false);
  assert.equal(mounted.events.at(-1)[0],'canvas-released'); engine.destroy();
});

test('W1 ALREADY_FIXED controls: historical presentation/resource defects fail the oracles',async()=>{
  const source=readFileSync(new URL('../src/surfaces/tileScheduler.js',import.meta.url),'utf8');
  for(const [before,after,oracle] of [
    ['if (entry.lastPresentedFrameGen !== candidate.frameGeneration)', 'if (false)', engine=>{
      engine.submitFrame(frame(1)); assert.deepEqual(engine.runTick().presented,[]);
    }],
    ['trimWarmResources(existing, 0);','',engine=>{
      let disposed=0;
      engine.allocateWarmResource('A',{resourceId:'native',byteLength:8,dispose:()=>disposed++});
      engine.registerSurface({...binding,state}); assert.equal(disposed,1);
    }],
    ['lastPresentedFrameGen: sameLifetime ? existing.lastPresentedFrameGen : 0,', 'lastPresentedFrameGen: 0,',engine=>{
      engine.attachCanvas({surfaceId:'A',canvas:canvas()}); engine.submitFrame(frame(5)); engine.runTick();
      engine.registerSurface({...binding,state});
      assert.equal(engine.submitFrame(frame(2)).reason,'STALE_FRAME_GENERATION');
    }],
  ]) {
    assert.ok(source.includes(before));
    const mutant=await import(`data:text/javascript;base64,${Buffer.from(source.replace(before,after)).toString('base64')}`);
    const engine=mutant.createTileScheduler({budget}); engine.registerSurface({...binding,state});
    try { assert.throws(()=>oracle(engine),assert.AssertionError); } finally {engine.destroy();}
  }
});
