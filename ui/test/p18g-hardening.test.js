import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {stageOpeningMode} from '../electron/openingMode.js';
import {createOperatorService,identityRunner} from '../electron/operatorBridge.js';
import {installRoleHost} from '../electron/roleHost.js';
import {isProtectedIdentity,PROTECTED_HOLDERS,FOREIGN_PREFIXES} from '../electron/identityProtection.js';
import { fileURLToPath } from 'node:url';
const MV_IDENTITY_PY=fileURLToPath(new URL('../../tools/mv_identity.py',import.meta.url));
import {createHumanTraceFile} from '../electron/humanTrace.js';
const foreign=['cuentas-other','perplexity-other','srf-id-cuentas-other','srf-id-perplexity-other','srf-pg-other','srf-egress-proxy','n8n','distil-box'];
async function fixture(t, profiles=['demo'], install=installRoleHost) {
 const root=await mkdtemp(join(tmpdir(),'p18g-host-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let handler;const stops=[];let reply={};const states=new Map();
 const core={request:async()=>reply,getHumanSurface:id=>states.get(id),stopSurface:async id=>{stops.push(id);return {schema:'surface_event/v0.2',event:'state_changed',data:{surface:{surface_id:id,state:'destroyed'}}};}};
 const window=new EventEmitter();window.webContents={session:{registerPreloadScript(){},unregisterPreloadScript(){}}};
 const host=install({electron:{ipcMain:{handle(_c,h){handler=h;},removeHandler(){}},app:{getPath:()=>root}},window,admit:()=>true,
 env:{MV_SRF_STATE_DIR:root,MV_SRF_PROFILES:JSON.stringify(Object.fromEntries(profiles.map(p=>[p,{Kind:'browser',role:'human'}])))},capsuleStates:states,
 listIdentities:async()=>({ok:true,rows:profiles.map(id=>({id}))}),stageMode:async()=>async()=>{},
 core});
 t.after(()=>host.dispose());
 return {root,host,core,stops,states,setReply:v=>reply=v,request:(op,body={})=>handler({}, {schema:'metaviewer.roles/v0.3',op,...body})};
}
test('foreign staging refuses before filesystem access; own profiles remain openable',async t=>{
 const root=await mkdtemp(join(tmpdir(),'p18g-stage-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const id of foreign) await assert.rejects(stageOpeningMode(root,id,'human'),/IDENTITY_PROTECTED/);
 await (await stageOpeningMode(root,'mv-live-3','human'))();
});
test('foreign login/create/delete refuse both service and direct runner without dispatch',async()=>{
 let calls=0;const service=createOperatorService({env:{MV_HANDOFF_PATHS:'[]'},runIdentity:async()=>{calls++;return {ok:true};}});
 const runner=identityRunner({tool:'/unused',spawnTool:()=>{calls++;throw Error('DISPATCHED');}});
 for(const id of foreign) for(const method of ['login','create','delete']) {
  const request=method==='create'?{id,label:'Fixture',domains:[]}:{id};
  assert.deepEqual(await service.request('identity.'+method,[request]),{ok:false,code:'IDENTITY_PROTECTED'});
  await assert.rejects(runner(method,request),/IDENTITY_PROTECTED/);
 }
 assert.equal(calls,0);
});
test('role create and reuse refuse foreign profiles including named holders',async t=>{
 const f=await fixture(t,foreign);
 for(const profileId of foreign) for(const op of ['open','create']) {
  f.states.set('foreign',{surface_id:'foreign',profile_id:profileId,state:'active',control:'human'});
  assert.deepEqual(await f.request(op,{choice:{profileId,role:'human'}}),{ok:false,code:'IDENTITY_PROTECTED'});
 }
});
test('created but invalid capsule is compensated through stopSurface',async t=>{
 const f=await fixture(t);f.setReply({schema:'surface_event/v0.2',event:'created',data:{surface:{surface_id:'created-bad',profile_id:'demo',state:'active',control:'agent'}}});
 assert.deepEqual(await f.request('create',{choice:{profileId:'demo',role:'human'}}),{ok:false,code:'CAPSULE_MODE_UNPROVEN'});
 assert.deepEqual(f.stops,['created-bad']);
});
test('role surfaces project only renderer fields',async t=>{
 const f=await fixture(t);f.states.set('live',{surface_id:'live',profile_id:'demo',state:'active',control:'human',kind:'browser',width:1280,height:900,generation:1,private_native_diagnostic:'WITHHELD'});
 const rows=await f.request('surfaces');assert(!JSON.stringify(rows).includes('WITHHELD'));
 assert.deepEqual(Object.keys(rows[0].surface).sort(),['control','profile_id','state','surface_id']);
});
test('Python and JS deletion protection cover identical prefixes and holders',()=>{
 const lists=JSON.parse(execFileSync('python3',['-c','import runpy,json; m=runpy.run_path('+JSON.stringify(MV_IDENTITY_PY)+'); print(json.dumps([sorted(m["PROTECTED_HOLDERS"]),list(m["FOREIGN_PREFIXES"])]))'],{encoding:'utf8'}));
 assert.deepEqual(lists,[[...PROTECTED_HOLDERS].sort(),[...FOREIGN_PREFIXES]]);
 const ids=[...foreign,'mv-live-3','cuentas-','perplexity-','srf-id-cuentas-','srf-id-perplexity-','srf-pg-','srf-id-cuentas-1','srf-id-perplexity-1','srf-pg-notepad-1','srf-pg-metaviewer-1','owned-fixture'];
 const code='import runpy,json; m=runpy.run_path('+JSON.stringify(MV_IDENTITY_PY)+'); print(json.dumps([m["protected_identity"](i) for i in '+JSON.stringify(ids)+']))';
 assert.deepEqual(JSON.parse(execFileSync('python3',['-c',code],{encoding:'utf8'})),ids.map(isProtectedIdentity));
});
test('trace cap pauses without throwing and startup prunes only expired trace files',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'p18g-trace-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const old=join(directory,'human-trace-old.jsonl'),keep=join(directory,'unrelated.jsonl');
 await writeFile(old,'old');await writeFile(keep,'keep');await utimes(old,1,1);await utimes(keep,1,1);
 const trace=createHumanTraceFile({directory,sessionId:'fixture',surfaceId:'fixture',capsuleId:'srf-id-fixture',maxBytes:500});t.after(()=>trace.close());
 trace.setActive(true);for(let i=0;i<20;i++)trace.record({kind:'move',x:1,y:2},{width:100,height:100,capsuleWidth:1280,capsuleHeight:900});
 assert.equal(trace.paused,true);assert((await readFile(trace.path)).length<=500);
 await assert.rejects(readFile(old),{code:'ENOENT'});assert.equal(await readFile(keep,'utf8'),'keep');
});

test('H27 disposal during pending create compensates a late created capsule',async t=>{
 const f=await fixture(t);let resolve,entered;const wait=new Promise(r=>resolve=r),started=new Promise(r=>entered=r);f.core.request=()=>{entered();return wait;};
 const creating=f.request('create',{choice:{profileId:'demo',role:'human'}});await started;await f.host.dispose();
 resolve({schema:'surface_event/v0.2',event:'created',data:{surface:{surface_id:'late-created',profile_id:'demo',control:'human',state:'active'}}});
 assert.deepEqual(await creating,{ok:false,code:'XPRA_HOST_CLOSED'});assert.deepEqual(f.stops,['late-created']);
});
test('H29 open and mount refuse while a stop acknowledgement is pending',async t=>{
 const f=await fixture(t);f.states.set('live',{surface_id:'live',profile_id:'demo',state:'active',control:'human'});
 let resolve;f.core.stopSurface=()=>new Promise(r=>resolve=r);
 const stopping=f.request('stop',{surfaceId:'live'});await new Promise(r=>setImmediate(r));
 assert.deepEqual(await f.request('open',{choice:{profileId:'demo',role:'human'}}),{ok:false,code:'SURFACE_CREATE_BUSY'});
 assert.deepEqual(await f.request('mount',{surfaceId:'live',bounds:{x:0,y:0,width:100,height:100}}),{ok:false,code:'SURFACE_CREATE_BUSY'});
 resolve({schema:'surface_event/v0.2',event:'state_changed',data:{surface:{surface_id:'live',state:'destroyed'}}});assert.equal((await stopping).ok,true);
});

test('C epochs retain no renderer-supplied close ids after a close storm',async t=>{
 const url=new URL('../electron/roleHost.js',import.meta.url);let source=await readFile(url,'utf8');
 source=source.replace("new URL('./rolePreload.cjs',import.meta.url)",`new URL('${new URL('../electron/rolePreload.cjs',import.meta.url).href}')`);
 source=source.replace('return Object.freeze({dispose});','return Object.freeze({dispose,epochCount:()=>epochs.size});').replace(/from '([^']+)'/g,(all,spec)=>spec.startsWith('.')?`from '${new URL(spec,url).href}'`:all);
 const {installRoleHost:instrumented}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const f=await fixture(t,['demo'],instrumented);for(let i=0;i<10000;i++)await f.request('close',{surfaceId:'renderer-'+i});assert.equal(f.host.epochCount(),0);await f.host.dispose();assert.equal(f.host.epochCount(),0);
});
test('H30 closed is a presentation label, not an admitted authoritative surface state',async()=>{
 const schema=JSON.parse(await readFile(new URL('../../contracts/v0.2/surface.schema.json',import.meta.url),'utf8'));assert(!schema.properties.state.enum.includes('closed'));assert(schema.properties.state.enum.includes('destroyed'));
});
test('H53 trace export is not exposed by the renderer operator bridge',async()=>{
 const {assertOperatorCall}=await import('../electron/preload.js');assert.throws(()=>assertOperatorCall('trace.export',[{path:'/not-written'}]));
});
