import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../electron/preload.js';
import { assertCaptureCall, assertCaptureReply, validCaptureState, installCaptureBridge } from '../electron/captureBridge.js';

function host(core,env={}) {
  const handlers=new Map();
  const frame={url:'app://metaviewer/index.html',origin:'app://metaviewer'};
  const sent=[];
  const contents={id:1,mainFrame:frame,getURL:()=>frame.url,isDestroyed:()=>false,send:(...args)=>sent.push(args)};
  const event={sender:contents,senderFrame:frame};
  const bridge=installCaptureBridge({ipcMain:{handle:(c,h)=>handlers.set(c,h),removeHandler:c=>handlers.delete(c)},contents,core,env});
  return {handlers,event,bridge,sent};
}

const state={type:'capture.state',recording_id:'record',surface_id:'surface',phase:'recording',frames:1,elapsed_ms:2};
const badStates=()=>[
  {...state,phase:'exported'},{...state,type:'capture.other'},
  {...state,recording_id:'../escape'},{...state,surface_id:''},
  {...state,recording_id:1},{...state,surface_id:'x'.repeat(129)},
  {...state,extra:true},
];
test('ws3 main capture state rejects phase type identifiers and extra keys',()=>{
  assert.equal(validCaptureState(state),true);
  for(const value of badStates()) assert.equal(validCaptureState(value),false,JSON.stringify(value));
});
test('ws3 main capture subscription drops bogus phase and sends closed metadata',async()=>{
  let emit;
  const h=host({subscribeCapture:callback=>{emit=callback;return()=>{};}});
  try {
    emit(state);
    assert.deepEqual(h.sent,[]);
    assert.deepEqual(await h.handlers.get('metaviewer:capture.subscribe')(h.event),{ok:true});
    for(const value of badStates()) emit(value);
    assert.deepEqual(h.sent,[]);
    emit(state);
    assert.deepEqual(h.sent,[['metaviewer:capture.state',state]]);
    assert.deepEqual(Object.keys(h.sent[0][1]).sort(),['elapsed_ms','frames','phase','recording_id','surface_id','type']);
  } finally {await h.bridge.dispose();}
});
