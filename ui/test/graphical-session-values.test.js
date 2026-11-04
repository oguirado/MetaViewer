import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {graphicalValid,graphicalAction,graphicalSnapshot} from '../electron/graphicalSessionValues.js';

const dir=new URL('../../contracts/examples/v0.2/',import.meta.url),load=n=>JSON.parse(readFileSync(new URL(n,dir),'utf8'));
test('all canonical graphical schemas accept valid fixtures and reject invalid fixtures',()=>{
 let count=0;
 for(const file of readdirSync(dir)){
  const m=/^(graphical_session(?:_envelope|_event|_request)?)(?:\.invalid|\.valid)/.exec(file);if(!m)continue;
  const schema=m[1]==='graphical_session'?'graphical_session.schema.json':`${m[1]}.schema.json`;
  const valid=file.includes('.valid'),doc=load(file);assert.equal(graphicalValid(schema,doc),valid,file);count++;
 }
 assert.ok(count>=35);
});
test('renderer actions are closed and cannot choose owner, request identity, or native paths',()=>{
 const attach={op:'attach',surface_id:'surface-A'},mark={op:'mark',surface_id:'surface-A',generation:1,authority_epoch:1,label:'checkpoint'},restore={op:'restore',surface_id:'surface-A',generation:1,authority_epoch:1,point_id:'point-one'};
 for(const v of [attach,mark,restore])assert.equal(graphicalAction(v),true);
 for(const v of [{...attach,owner_id:'actor-forged'},{...mark,request_id:'request-forged'},{...restore,path:'/tmp/guest'},{...mark,generation:true},{...mark,label:'bad\nlabel'},{...restore,authority_epoch:0}])assert.equal(graphicalAction(v),false);
 let reads=0;const getter={op:'attach',surface_id:'surface-A'};Object.defineProperty(getter,'owner_id',{enumerable:true,get(){reads++;return 'actor-forged';}});assert.equal(graphicalAction(getter),false);assert.equal(reads,0);
});
test('snapshot has the exact closed public shape and point ages never use invalid values',()=>{
 const empty={available:true,busy:false,code:null,revision:0,session:null,uncertain:false,point_ages_ms:{}};
 assert.equal(graphicalSnapshot(empty),true);assert.equal(graphicalSnapshot({...empty,host_path:'/tmp'}),false);assert.equal(graphicalSnapshot({...empty,point_ages_ms:{'point-x':0}}),false);
 const ready=load('graphical_session.valid.ready.json'),ages=Object.fromEntries(ready.points.map(p=>[p.point_id,null]));assert.equal(graphicalSnapshot({...empty,session:ready,point_ages_ms:ages}),true);
 let reads=0;const points=[{...ready.points[0]}];Object.defineProperty(points,'0',{enumerable:true,configurable:true,get(){reads++;return ready.points[0];}});const hostile={...ready,points};assert.equal(graphicalValid('graphical_session.schema.json',hostile),false);assert.equal(reads,0);
});
