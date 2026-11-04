import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthorityRuntime} from '../src/core/hostAdapters.js';

function notice(kind,generation=1,state='active',control='agent'){
 return {surface:{schema:'surface/v0.2',surface_id:'surface-one',kind,display:':100',geometry:{w:64,h:64},state,visibility:'unfolded',control,profile_id:'synthetic'},
 frame_ref:{schema:'frame_ref/v0.2',surface_id:'surface-one',generation,tick:generation,ts_ns:generation,width:64,height:64,format:'rgb24',sha256:'a'.repeat(64),capture_us:1}};
}
function fixture(){let emit;const runtime=createAuthorityRuntime({subscribeFrames:cb=>{emit=cb;return()=>{};}});return {runtime,emit:v=>emit(v),rows:()=>runtime.projectionView.getProjection()?.rows??[]};}
test('only validated surface kinds reach wall rows and malformed kinds cannot create a VM row',()=>{
 for(const kind of ['desktop_capsule','browser','game_capsule','vm']){
  const f=fixture();try{f.emit(notice(kind));assert.equal(f.rows()[0].kind,kind);f.emit(notice('invented',2));assert.equal(f.rows()[0].kind,kind);assert.equal(f.runtime.projectionView.getSnapshot().stale,true);}finally{f.runtime.dispose();}
 }
 const f=fixture();try{f.emit(notice('invented'));assert.equal(f.rows().length,0);}finally{f.runtime.dispose();}
});
test('VM identity remains explicit after human control and physical lifecycle updates',()=>{
 const f=fixture();try{
  f.emit(notice('vm'));f.emit(notice('vm',2,'active','human'));assert.equal(f.rows()[0].kind,'vm');assert.equal(f.rows()[0].control,'human');
  f.emit(notice('vm',3,'destroyed','human'));assert.equal(f.rows()[0].kind,'vm');assert.equal(f.rows()[0].backendLifecycle,'destroyed');
 }finally{f.runtime.dispose();}
});
