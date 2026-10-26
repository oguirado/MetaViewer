import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFramePort } from '../electron/framePort.js';
import { createFrameTile } from '../src/surfaces/frameTile.js';
const binding={principal:'utility',epoch:1,surfaceId:'A',surfaceGeneration:1};
const limits={maxFrameBytes:1024,ackTimeoutMs:1000,maxSurfacesPerPort:1};
const budget=Object.freeze({maxDrawsPerTick:1,maxUploadBytesPerTick:1024,maxPresentMsPerTick:8,maxWarmResourcesPerSurface:1,maxDrainSteps:1});
const state={panelOpen:true,panelSelected:true,folded:false,width:10,height:10,viewportIntersecting:true,windowPresentationAllowed:true,contextLost:false};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function pair() {
  const a=new EventEmitter(),b=new EventEmitter();
  a.postMessage=data=>queueMicrotask(()=>b.emit('message',{data}));
  b.postMessage=data=>queueMicrotask(()=>a.emit('message',{data}));
  a.start=b.start=()=>{};a.close=b.close=()=>{};return[a,b];
}
function frame(generation=1) { return {...binding,frameGeneration:generation,leaseId:'l'+generation,width:1,height:1,format:'rgb24',sha256:'1'.repeat(64),pixelSpec:{format:'rgb24'},byteLength:3,bytes:new Uint8Array([12,34,56])}; }
test('MessagePort frame ACK follows actual canvas draw; folded tiles stop drawing',async()=>{
  const [a,b]=pair(), released=[]; let draws=0;
  const sender=createFramePort({port:a,binding,limits,role:'sender',onReleaseLease:r=>released.push(r),onRevoke:()=>{}});
  const tile=createFrameTile({port:b,binding,limits,budget,state});
  const canvas={getContext:()=>({createImageData:()=>({data:new Uint8ClampedArray(4)}),putImageData:()=>draws++})};
  try {
    assert.equal(tile.scheduler.attachCanvas({surfaceId:'A',surfaceGeneration:2,epoch:1,canvas}).ok,false);
    assert.equal(tile.scheduler.attachCanvas({surfaceId:'A',surfaceGeneration:1,epoch:1,canvas}).ok,true);
    assert.equal(sender.postFrame(frame()).ok,true);await turn();
    assert.equal(draws,0);assert.equal(sender.getInstrumentation().acked,0);
    tile.scheduler.runTick();await turn();assert.equal(draws,1);
    assert.equal(released[0].reason,'PRESENTED');assert.equal(sender.getInstrumentation().acked,1);
    tile.scheduler.foldSurface('A');sender.postFrame(frame(2));await turn();
    tile.scheduler.runTick();await turn();assert.equal(draws,1);
    assert.equal(released.at(-1).reason,'REFUSED');
    assert.equal(tile.scheduler.getInstrumentation('A').captureCount,2);
    assert.equal(sender.postFrame({...frame(3),surfaceId:'B'}).ok,false);
  } finally {tile.close();sender.revokeFramePort('SHUTDOWN');}
});
