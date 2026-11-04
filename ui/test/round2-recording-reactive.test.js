import test from 'node:test';
import assert from 'node:assert/strict';
import {nextTick,watchEffect} from 'vue';
import {createCaptureState} from '../src/capture/capturePort.js';

for(const ok of [true,false])test(`a first recording ${ok?'reply':'refusal'} leaves Starting reactively without state events`,async()=>{
 let reply;
 const state=createCaptureState({
  recordStart:()=>new Promise(resolve=>{reply=resolve;}),
  recordStop:async()=>({ok:true,recording:{id:'record-one',surface_id:'surface-one',frames:1,duration_ms:1000,sealed:true,sha256:'a'.repeat(64)}}),
  screenshot:async()=>({ok:false,code:'CAPTURE_UNAVAILABLE'}),
  list:async()=>({ok:true,rows:[]}),subscribe:()=>()=>{},
 });
 const phases=[];
 const stop=watchEffect(()=>phases.push(state.bySurface['surface-one']?.phase ?? 'absent'));
 try{
  const pending=state.toggleRecord('surface-one');await nextTick();
  assert.equal(phases.at(-1),'starting');
  reply(ok?{ok:true,recording_id:'record-one'}:{ok:false,code:'CAPTURE_UNAVAILABLE'});
  await pending;await nextTick();
  assert.equal(phases.at(-1),ok?'recording':'idle','the rendered phase must follow the reply');
 }finally{stop();state.dispose();}
});
