import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const {parse,compileScript}=require('@vue/compiler-sfc');
const {createSSRApp,h,reactive,nextTick}=require('vue');
const {renderToString}=require('@vue/server-renderer');
const source=readFileSync(new URL('../src/components/GuestCommandPanel.vue',import.meta.url),'utf8');
async function component(inlineTemplate,mockLifecycle=false){
 let code=compileScript(parse(source).descriptor,{id:'rw27-header',inlineTemplate}).content;
 const vueURL=pathToFileURL(require.resolve('vue')).href;
 if(mockLifecycle){const shim="export * from '"+vueURL+"';export const onMounted=fn=>globalThis.__rw27Hooks.mount.push(fn);export const onUnmounted=fn=>globalThis.__rw27Hooks.unmount.push(fn);";const shimURL='data:text/javascript;base64,'+Buffer.from(shim).toString('base64');code=code.replaceAll("from 'vue'",`from '${shimURL}'`);}
 code=code.replaceAll("from 'vue'",`from '${pathToFileURL(require.resolve('vue')).href}'`).replaceAll('from "vue"',`from '${pathToFileURL(require.resolve('vue')).href}'`);
 for(const [old,path] of [['../../electron/guestCommandValues.js','../electron/guestCommandValues.js'],['../wall/rewindStateControls.js','../src/wall/rewindStateControls.js'],['../wall/restoreDuration.js','../src/wall/restoreDuration.js']])code=code.replaceAll(`from '${old}'`,`from '${new URL(path,import.meta.url).href}'`);
 return (await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).default;
}
const Panel=await component(false),SSR=await component(true);
function fixture(){
 const s=JSON.parse(readFileSync(new URL('../../contracts/examples/v0.2/rewind_session.valid.json',import.meta.url))),g=JSON.parse(readFileSync(new URL('../../contracts/examples/v0.2/guest_command_session.valid.json',import.meta.url)));
 Object.assign(g,{workload_id:s.workload_id,generation:s.generation,owner_id:s.owner_id,phase:'ready'});
 return {snapshot:{available:true,busy:false,canCancel:false,uncertain:false,code:null,revision:1,session:g,stdout:'',stderr:''},rewind:{available:true,busy:false,uncertain:false,code:null,revision:1,session:s,point_ages_ms:{'point-one':null},stop_target:{workload_id:s.workload_id,generation:s.generation}},rewindPanel:null};
}
const render=props=>renderToString(createSSRApp({render:()=>h(SSR,props)}));
function setup(props){const calls=[];const p=Panel.setup(props,{expose(){},emit:(...args)=>calls.push(args)});return {p,calls};}
test('SSR exposes classic Back, real point label and null-age wording; Stop remains visible',async()=>{
 const props=fixture();props.rewind.session.points[0].label='<Before>';const html=await render(props);
 assert.match(html,/Back to checkpoint/);assert.match(html,/&lt;Before&gt;/);assert.match(html,/Age unavailable/);assert.match(html,/Stop capsule/);assert.match(html,/d="M11 5v14l-9-7zM22 5v14l-9-7z" fill="currentColor"/);assert.doesNotMatch(html,/stroke-linecap|m11 5-7/);assert.doesNotMatch(html,/>Save<|>Load<|host terminal/i);
});
test('SSR shows supplied point age without fabricating a live clock',async()=>{
 const props=fixture();props.rewind.point_ages_ms['point-one']=12500;assert.match(await render(props),/12 s ago/);
});
test('unavailable, busy and stopping hide Back while preserving Stop control',async()=>{
 for(const mutate of [p=>p.rewind=null,p=>p.rewind.available=false,p=>p.rewind.busy=true,p=>p.snapshot.session.phase='stopping',p=>p.snapshot.session.controls.stop={request_id:'request-stop',ack:'pending'}]){
  const p=fixture();mutate(p);const html=await render(p);assert.doesNotMatch(html,/Back to checkpoint/);assert.match(html,/Stop capsule/);
 }
});
test('fresh props drive one canonical restore emission, with no implicit Pause emission',()=>{
 const props=reactive(fixture()),{p,calls}=setup(props);
 props.rewind.session.generation=5;props.rewind.session.authority_epoch=8;props.snapshot.session.generation=5;
 p.restorePoint('point-one');assert.deepEqual(calls,[['rewind-action',{op:'restore',workload_id:'workload-one',generation:5,authority_epoch:8,point_id:'point-one'}]]);
 props.rewind.busy=true;p.restorePoint('point-one');assert.equal(calls.length,1);
});
test('stale target and removed point cannot emit a restore from old menu',()=>{
 const props=reactive(fixture()),{p,calls}=setup(props);props.snapshot.session.generation=99;p.restorePoint('point-one');assert.equal(calls.length,0);
 props.snapshot.session.generation=2;props.rewind.session.points=[];props.rewind.session.last_good_usable=null;props.rewind.point_ages_ms={};p.restorePoint('point-one');assert.equal(calls.length,0);
});
test('custom header receives only capability/callback seam; timeline remains slotted',async()=>{
 const props=fixture();let seen;
 props.rewindPanel={props:['snapshot','guest'],render(){return h('aside','Pause Resume Mark timeline');}};
 const html=await renderToString(createSSRApp({render:()=>h(SSR,props,{header:slot=>{seen=slot;return h('header','Frontend header');}})}));
 assert.deepEqual(Object.keys(seen).sort(),['capabilities','onRestore']);assert.equal(seen.capabilities.back.available,true);assert.equal(typeof seen.onRestore,'function');assert.match(html,/Frontend header/);assert.match(html,/Pause Resume Mark timeline/);assert.match(html,/Stop capsule/);
});
// Preserve original unit assertions, with the actual original behaviors still exercised.
test('original bounded command and independent cancel/Stop semantics remain',()=>{
 const props=fixture(),x=setup(props);x.p.run();assert.equal(x.calls[0][1].command_utf8,'uname -m');assert.equal(x.calls[0][1].cwd,'');x.p.cwd.value='../bad';x.p.run();assert.equal(x.calls.length,1);x.p.stop();assert.equal(x.calls[1][1].op,'stop');
 const y=fixture();Object.assign(y.snapshot,{busy:true,canCancel:true});Object.assign(y.snapshot.session,{phase:'running',jobs_started:1,job:{job_id:'job-one',state:'running',exit_code:null,signal:null,stdout_bytes:0,stderr_bytes:0,output_complete:false}});const z=setup(y);z.p.cancel();z.p.stop();assert.deepEqual(z.calls.map(c=>c[1].op),['cancel','stop']);assert.ok(!source.includes('v-html'));
});
test('original invalid or uncertain state cannot run a command',()=>{
 for(const mutate of [p=>p.snapshot.session.extra='bad',p=>{p.snapshot.session.phase='uncertain';p.snapshot.uncertain=true;}]){const props=fixture();mutate(props);const {p,calls}=setup(props);p.run();assert.equal(calls.length,0);}
});

test('monotonic age advances, resets per snapshot, rejects unknown/overflow and cleans timer',async()=>{
 const originalPerformance=Object.getOwnPropertyDescriptor(globalThis,'performance'),originalSet=globalThis.setInterval,originalClear=globalThis.clearInterval;
 let clock=1000,tick,cleared=[];globalThis.__rw27Hooks={mount:[],unmount:[]};
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>clock}});
 globalThis.setInterval=(fn,ms)=>{assert.equal(ms,1000);tick=fn;return 123;};globalThis.clearInterval=id=>cleared.push(id);
 try {
  const Component=await component(false,true),props=reactive(fixture()),calls=[];
  const p=Component.setup(props,{expose(){},emit:(...a)=>calls.push(a)});
  assert.equal(globalThis.__rw27Hooks.mount.length,1);assert.equal(globalThis.__rw27Hooks.unmount.length,1);
  globalThis.__rw27Hooks.mount[0]();assert.equal(p.pointAge(12000),'12 s ago');
  clock=3500;tick();assert.equal(p.pointAge(12000),'14 s ago');assert.equal(p.pointAge(null),'Age unavailable');
  clock=4000;props.rewind={...props.rewind,revision:2};await nextTick();assert.equal(p.pointAge(12000),'12 s ago');
  clock=3999;tick();assert.equal(p.pointAge(12000),'Age unavailable');
  clock=4001;tick();assert.equal(p.pointAge(Number.MAX_SAFE_INTEGER),'Age unavailable');
  clock=Infinity;tick();assert.equal(p.pointAge(12000),'Age unavailable');
  assert.deepEqual(calls,[]);globalThis.__rw27Hooks.unmount[0]();assert.deepEqual(cleared,[123]);globalThis.__rw27Hooks.unmount[0]();assert.deepEqual(cleared,[123]);
 } finally {Object.defineProperty(globalThis,'performance',originalPerformance);globalThis.setInterval=originalSet;globalThis.clearInterval=originalClear;delete globalThis.__rw27Hooks;}
});
