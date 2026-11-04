import test from 'node:test';
import assert from 'node:assert/strict';
import {createHeadlessHost} from '../electron/headlessHost.js';
import {validSession,validSnapshot} from '../electron/headlessValues.js';
import {createPreloadFacade,installPreload} from '../electron/preload.js';
const owner='actor-'+'a'.repeat(64);
const s=(phase,job=null)=>({schema:'headless_session/v0.2',workload_id:'workload-one',generation:1,owner_id:owner,profile_id:'headless-sumsq-v1',backend:'firecracker',isa:'aarch64',phase,ownership:phase==='stopped'?'released':'held',job});
const target={workload_id:'workload-one',generation:1};
function fixture(timeoutMs=1000){const sent=[];const h=createHeadlessHost({send:b=>sent.push(b),available:()=>true,ownerId:owner,timeoutMs});let n=0;const event=(event,session,op)=>h.receive({schema:'headless_event/v0.2',event_id:'event-'+(++n),request_id:sent.at(-1).request_id,event,data:{session,...(op?{op}:{})}});return{h,sent,event};}
async function ready(f){const p=f.h.request({op:'create'});f.event('accepted',s('starting'),'create');f.event('state_changed',s('ready'));await p;}
test('confirmed full lifecycle uses one host-minted job and no fake frame',async()=>{const f=fixture();await ready(f);let p=f.h.request({op:'run',...target,n:10});const job={job_id:f.sent.at(-1).params.job_id,operation:'sumsq',n:10,status:'accepted',value:null};f.event('accepted',s('running',job),'run');job.status='completed';job.value=385;f.event('completed',s('completed',job));assert.equal((await p).session.job.value,385);p=f.h.request({op:'stop',...target});f.event('accepted',s('stopping',job),'stop');f.event('state_changed',s('stopped',job));assert.equal((await p).session.ownership,'released');assert.deepEqual(f.sent.map(x=>x.op),['create','run','stop']);assert.match(job.job_id,/^job-/);f.h.disconnect();});
test('arbitrary renderer authority and malformed operands never send',async()=>{const f=fixture();for(const a of [{op:'create',path:'/tmp/x'},{op:'create',request_id:'request-x'},{op:'create',backend:'qemu'},{op:'run',...target,n:true},{op:'run',...target,n:10001}])await assert.rejects(f.h.request(a));assert.equal(f.sent.length,0);f.h.disconnect();});
test('foreign owner and premature completion fail closed',async()=>{const f=fixture();const p=f.h.request({op:'create'});assert.throws(()=>f.event('accepted',{...s('starting'),owner_id:'actor-other'},'create'));assert.throws(()=>f.event('state_changed',s('ready')));f.h.disconnect();await p;assert.equal(validSession(s('completed',{job_id:'job-x',operation:'sumsq',n:10,status:'completed',value:386})),false);});
test('timeout consumes create and ignores late success',async()=>{const f=fixture(5);assert.equal((await f.h.request({op:'create'})).uncertain,true);await f.h.request({op:'create'});assert.equal(f.sent.length,1);f.event('accepted',s('starting'),'create');assert.equal(f.h.status().session.phase,'starting');assert.equal(f.h.status().uncertain,true);f.h.disconnect();});
test('unknown job cannot repeat; explicit stop uses original tuple',async()=>{const f=fixture(5);await ready(f);await f.h.request({op:'run',...target,n:10});await f.h.request({op:'run',...target,n:10});assert.equal(f.sent.length,2);const p=f.h.request({op:'stop',...target});assert.deepEqual(f.sent.at(-1).params,target);f.h.disconnect();await p;assert.equal(f.h.status().uncertain,true);});
test('concurrent dispatch refused and unavailable never sends',async()=>{const f=fixture();const p=f.h.request({op:'create'});assert.equal((await f.h.request({op:'create'})).code,'BUSY');assert.equal(f.sent.length,1);f.h.disconnect();await p;const h=createHeadlessHost({send:()=>assert.fail(),available:()=>false,ownerId:owner});assert.equal((await h.request({op:'create'})).available,false);});
test('preload closed arity, payload and subscription',async()=>{let calls=0,listener;const snapshot={available:true,busy:false,code:null,revision:0,session:null,uncertain:false};const api=createPreloadFacade({transport:{invoke:async()=>{calls++;return snapshot;},subscribe:(name,cb)=>{listener=cb;return()=>{};}},bridge:{exposeInMainWorld(){}}});assert.deepEqual(await api.headless.status(),snapshot);await assert.rejects(api.headless.request({op:'create',profile_id:'evil'}));await assert.rejects(api.headless.status('extra'));assert.equal(calls,1);api.headless.subscribe(v=>assert.deepEqual(v,snapshot));listener(snapshot);assert.throws(()=>listener({...snapshot,frame:'fake'}));assert.equal(validSnapshot({...snapshot,session:{...s('ready'),display:':1'}}),false);});

import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises';
import {headlessProfileOwnerSync as headlessProfileOwner} from '../electron/coreLauncher.js';
import {availableCatalogKindIds} from '../src/catalog/catalogModel.js';
test('profile is private, explicit and ARM only; catalogue defaults hidden',async()=>{
 const root=await mkdtemp('/dev/shm/mv-headless-ui-test-');
 try {
  const file=root+'/profile.json';
  const p={schema:'mv-headless-host/v1',owner_id:owner,guardian_unit:'test.service',python:{},python_prefix:'/usr',runner:{},controller_relative:'mc06-controller/controller.py',files:[],config_template:{schema:'mc06-host-config/v1',runtime_admitted:true,owner_id:owner},state_root:root,runtime_root:root};
  await writeFile(file,JSON.stringify(p),{mode:0o600});
  assert.equal(await headlessProfileOwner({MV_HEADLESS_PROFILE:file,MV_HEADLESS_ONLY:'1'},'arm64'),owner);
  assert.equal(await headlessProfileOwner({MV_HEADLESS_PROFILE:file,MV_HEADLESS_ONLY:'1'},'x64'),null);
  assert.equal(await headlessProfileOwner({},'arm64'),null);
  await chmod(file,0o644);assert.equal(await headlessProfileOwner({MV_HEADLESS_PROFILE:file,MV_HEADLESS_ONLY:'1'},'arm64'),null);
  assert.equal(availableCatalogKindIds().includes('microvm'),false);
  assert.equal(availableCatalogKindIds(false,true).includes('microvm'),true);
 } finally {await rm(root,{recursive:true});}
});

import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('native installPreload subscribes before the status round trip and preserves newer state',async()=>{
 const calls=[],listeners=new Map();let resolveStatus;
 const initial={available:true,busy:false,code:null,revision:1,session:null,uncertain:false};
 const newer={...initial,revision:2};
 const api=installPreload({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{
  invoke(channel,...args){calls.push([channel,args]);return new Promise(resolve=>{resolveStatus=resolve;});},
  on(channel,cb){listeners.set(channel,cb);},removeListener(channel,cb){if(listeners.get(channel)===cb)listeners.delete(channel);},
 }});
 let snapshot={...initial,revision:0};const accept=value=>{if(value.revision>=snapshot.revision)snapshot=value;};
 const unsubscribe=api.headless.subscribe(accept);
 assert.equal(listeners.has('metaviewer:headless.state'),true);
 const pending=api.headless.status().then(accept);
 assert.deepEqual(calls,[['metaviewer:headless.status',[]]]);
 listeners.get('metaviewer:headless.state')({ports:[]},newer);resolveStatus(initial);await pending;
 assert.equal(snapshot.revision,2);assert.equal(snapshot.available,true);
 unsubscribe();assert.equal(listeners.size,0);
});
test('native transport still refuses unlisted subscription channels before native on',()=>{
 const raw=readFileSync(new URL('../electron/preload.js',import.meta.url),'utf8');
 const anchor='const { transport, bridge } = assertDeps(deps);';assert.equal(raw.split(anchor).length,2);
 const instrumented=raw.replace(anchor,anchor+' globalThis.capturedNativeTransport = transport;').replace(/^export\s+(const|class|function)\s+/gm,'$1 ');
 const context=vm.createContext({URL,structuredClone,TextEncoder,TextDecoder});
 vm.runInContext(instrumented,context);
 const calls=[];
 context.installPreload({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke:async()=>null,on:(channel,cb)=>calls.push([channel,cb]),removeListener(){}}});
 assert.throws(()=>context.capturedNativeTransport.subscribe('metaviewer:unlisted.state',()=>{}),/CHANNEL/);
 assert.equal(calls.length,0);
 context.capturedNativeTransport.subscribe('metaviewer:headless.state',()=>{});assert.equal(calls.length,1);
});
