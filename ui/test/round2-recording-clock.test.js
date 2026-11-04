import test from 'node:test';
import assert from 'node:assert/strict';
import {sfc,fakeClock,storeWith,mount,byId,textOf,flush,RECORD_BUTTON_STUB} from './recstate-helpers.mjs';
test('the production tile clock advances between host frame events and stops with recording',async()=>{
 const Chrome=await sfc('src/wall/TileCaptureChrome.vue',[],{components:{'../../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue':RECORD_BUTTON_STUB}});
 const clock=fakeClock(),state=storeWith('clock-one',{phase:'recording',recordingId:'rec-clock',elapsedMs:7000});
 const view=mount(Chrome,{capsuleId:'clock-one',captureState:state,clock});
 try{
  const badge=()=>textOf(byId(view,'tile-clock-one-recording-badge')).trim();
  assert.equal(badge(),'Recording 00:07');clock.advance(2000);await flush();
  assert.equal(badge(),'Recording 00:09');
  state.bySurface['clock-one'].phase='idle';await flush();assert.equal(clock.active,0);
 }finally{view.close();}
 assert.equal(clock.active,0);
});
