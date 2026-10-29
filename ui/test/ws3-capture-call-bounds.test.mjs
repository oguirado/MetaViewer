import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../electron/preload.js';
import { assertCaptureCall, assertCaptureReply, validCaptureState, installCaptureBridge } from '../electron/captureBridge.js';

const request={schema:'capture_request/v1',request_id:'ws3',surface_id:'surface'};
test('ws3 capture request correlation has exact printable string boundaries',()=>{
  assert.doesNotThrow(()=>assertCaptureCall('screenshot',[{...request,request_id:'x'.repeat(64)}]));
  for(const request_id of ['x'.repeat(65),'','line\nbreak','nul\0byte']) {
    assert.throws(()=>assertCaptureCall('screenshot',[{...request,request_id}]),ContractError,JSON.stringify(request_id));
  }
});
test('ws3 capture identifiers and modes have paired boundaries',()=>{
  for(const [method,key] of [['screenshot','surface_id'],['recordStop','recording_id'],['export','capture_id']]) {
    const value={schema:request.schema,request_id:request.request_id,[key]:'a'.repeat(128)};
    if(method==='export') value.destination='recording:configured';
    assert.doesNotThrow(()=>assertCaptureCall(method,[value]));
    assert.throws(()=>assertCaptureCall(method,[{...value,[key]:'a'.repeat(129)}]),ContractError);
    assert.throws(()=>assertCaptureCall(method,[{...value,extra:true}]),ContractError);
  }
  assert.doesNotThrow(()=>assertCaptureCall('recordStart',[{...request,mode:'ai'}]));
  assert.throws(()=>assertCaptureCall('recordStart',[{...request,mode:'video'}]),ContractError);
});
