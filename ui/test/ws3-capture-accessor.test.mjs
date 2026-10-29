import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../electron/preload.js';
import { assertCaptureCall, assertCaptureReply, validCaptureState, installCaptureBridge } from '../electron/captureBridge.js';

const request={schema:'capture_request/v1',request_id:'ws3',surface_id:'surface'};
const reply={ok:true,recording_id:'record'};
const state={type:'capture.state',recording_id:'record',surface_id:'surface',phase:'recording',frames:0,elapsed_ms:0};
function getter(value,key) {
  const copy={...value};
  Object.defineProperty(copy,key,{enumerable:true,get:()=>value[key]});
  return copy;
}
test('ws3 capture rejects accessor properties before invoking getters',()=>{
  assert.doesNotThrow(()=>assertCaptureCall('screenshot',[request]));
  assert.deepEqual(assertCaptureReply('recordStart',reply),reply);
  assert.equal(validCaptureState(state),true);
  for(const key of Object.keys(request)) assert.throws(()=>assertCaptureCall('screenshot',[getter(request,key)]),ContractError);
  for(const key of Object.keys(reply)) assert.throws(()=>assertCaptureReply('recordStart',getter(reply,key)),ContractError);
  for(const key of Object.keys(state)) assert.equal(validCaptureState(getter(state,key)),false);
  let reads=0;
  const hostile={...request};
  Object.defineProperty(hostile,'surface_id',{enumerable:true,get(){reads++;return 'surface';}});
  assert.throws(()=>assertCaptureCall('screenshot',[hostile]),ContractError);
  assert.equal(reads,0);
});
test('ws3 capture refuses own prototype-polluting JSON keys and callable shapes',()=>{
  const polluted=value=>JSON.parse(JSON.stringify(value).slice(0,-1)+',"__proto__":{"polluted":true}}');
  assert.throws(()=>assertCaptureCall('screenshot',[polluted(request)]),ContractError);
  assert.throws(()=>assertCaptureReply('recordStart',polluted(reply)),ContractError);
  assert.equal(validCaptureState(polluted(state)),false);
  assert.throws(()=>assertCaptureCall('screenshot',[Object.assign(()=>{},request)]),ContractError);
  assert.equal(Object.prototype.polluted,undefined);
});
