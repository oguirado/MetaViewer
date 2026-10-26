import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';
const state={panelOpen:true,panelSelected:true,folded:false,width:10,height:10,viewportIntersecting:true,windowPresentationAllowed:true,contextLost:false};
const binding={principal:'wall-main',epoch:7,surfaceGeneration:1};
const budget=overrides=>Object.freeze({maxDrawsPerTick:4,maxUploadBytesPerTick:1024,maxPresentMsPerTick:16,maxWarmResourcesPerSurface:2,maxDrainSteps:4,...overrides});
const frame=(surfaceId,generation,width=1,extra={})=>({...binding,surfaceId,frameGeneration:generation,leaseId:`${surfaceId}-${generation}`,width,height:1,bytes:new Uint8Array(width*3),byteLength:width*3,...extra});
function harness(overrides={}) {
  let now=1000;
  const releases=[],draws=[];
  const scheduler=createTileScheduler({budget:budget(overrides.budget),clock:()=>now,
    onPresent:record=>{draws.push(record.surfaceId);return scheduler.presentHandle(record);},
    onReleaseLease:release=>{releases.push(release);overrides.release?.(release);}});
  function register(id,config={}) {
    assert.equal(scheduler.registerSurface({...binding,surfaceId:id,state,...config}).ok,true);
    scheduler.attachCanvas({surfaceId:id,canvas:{getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:()=>{now+=overrides.drawMs??0;}})}});
  }
  return {scheduler,releases,draws,register};
}

test('R1-063: equal-generation registration preserves presented and capture floors',()=>{
  for(const kind of ['presented','folded capture']) {
    const h=harness();h.register('A');
    if(kind==='presented') {h.scheduler.submitFrame(frame('A',5));h.scheduler.runTick();}
    else {h.scheduler.foldSurface('A');h.scheduler.recordCaptureWitness({surfaceId:'A',surfaceGeneration:1,captureGeneration:5});}
    h.register('A');
    assert.equal(h.scheduler.submitFrame(frame('A',4)).reason,'STALE_FRAME_GENERATION',kind);
    assert.equal(h.scheduler.recordCaptureWitness({surfaceId:'A',surfaceGeneration:1,captureGeneration:4}).ok,kind==='presented');
    assert.equal(h.scheduler.submitFrame(frame('A',6)).ok,true);
    h.register('A',{surfaceGeneration:2});
    assert.equal(h.scheduler.submitFrame({...frame('A',1),surfaceGeneration:2}).ok,true,'new lifetime may restart frame generations');
    h.scheduler.destroy();
  }
});

test('R1-062: a later small draw cannot overwrite the first deferred cursor',()=>{
  const h=harness({budget:{maxUploadBytesPerTick:9,maxDrawsPerTick:2}});
  for(const id of ['A','B','C']) h.register(id);
  h.scheduler.submitFrame(frame('B',1,2));
  for(let gen=1;gen<=30;gen++) {
    h.scheduler.submitFrame(frame('A',gen,2));h.scheduler.submitFrame(frame('C',gen));h.scheduler.runTick();
  }
  assert.ok(h.draws.includes('B'),'B must receive service despite continuous A/C traffic');
  h.scheduler.destroy();
});

test('R1-064: re-registration disposes each old warm resource exactly once',()=>{
  const h=harness();h.register('A');let disposals=0;
  h.scheduler.allocateWarmResource('A',{resourceId:'warm',byteLength:1,dispose:()=>disposals++});
  h.register('A',{surfaceGeneration:2});
  assert.equal(disposals,1,'replaced warm native must be disposed');
  assert.equal(h.scheduler.getInstrumentation('A').warmResourceCount,0);
  h.scheduler.destroy();assert.equal(disposals,1);
});

test('R1-065: throwing release observer cannot escape or release a lease twice',()=>{
  const h=harness({release:()=>{throw new Error('release-spy');}});h.register('A');
  h.scheduler.submitFrame(frame('A',1));
  assert.doesNotThrow(()=>h.scheduler.submitFrame(frame('A',2)),'release observer must be isolated');
  assert.doesNotThrow(()=>h.scheduler.foldSurface('A'));
  assert.doesNotThrow(()=>h.scheduler.destroySurface('A'));
  assert.deepEqual(h.releases.map(r=>r.leaseId),['A-1','A-2']);
  h.scheduler.destroy();
});

test('R1-067: destroyed identities leave the active scan while tombstones reject revival',()=>{
  const h=harness();
  for(let i=0;i<1000;i++){h.register(`dead-${i}`);h.scheduler.destroySurface(`dead-${i}`);}
  assert.deepEqual(h.scheduler.getInstrumentation('dead-0'),{surfaceId:'dead-0',destroyed:true,captureLeaseActive:false,canvasAttached:false},'destroyed identity must retain only a compact tombstone');
  h.register('live');h.scheduler.submitFrame(frame('live',1));
  assert.equal(h.scheduler.runTick().scannedSurfaces,1,'scan must contain only active surfaces');
  assert.equal(h.scheduler.registerSurface({...binding,surfaceId:'dead-0',state}).reason,'SURFACE_DESTROYED');
  assert.equal(h.scheduler.submitFrame(frame('dead-0',1)).reason,'SURFACE_DESTROYED');
  assert.equal(h.scheduler.getInstrumentation('dead-0').destroyed,true);
  h.scheduler.destroy();
});

test('R1-073: actual synchronous draw time is reported and stops later draws',()=>{
  const h=harness({budget:{maxPresentMsPerTick:1},drawMs:25});h.register('A');h.register('B');
  h.scheduler.submitFrame(frame('A',1,1,{estimatedPresentMs:0.1}));
  h.scheduler.submitFrame(frame('B',1,1,{estimatedPresentMs:0.1}));
  const tick=h.scheduler.runTick();
  assert.equal(tick.timeSpentMs,25,'elapsed time must replace estimated work');
  assert.equal(tick.presented.length,1,'overrun must defer the next canvas');
  assert.equal(tick.budgetDeferrals,1);
  assert.equal(tick.presented[0].presentedAtMs,1025);
  assert.equal(h.scheduler.getInstrumentation('A').timingScopes.presentationMs,1025);
  h.scheduler.destroy();
});
