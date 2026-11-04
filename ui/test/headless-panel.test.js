import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parse,compileScript} from '@vue/compiler-sfc';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../src/components/HeadlessMicroVmPanel.vue',import.meta.url),'utf8');
const compiled=compileScript(parse(source).descriptor,{id:'headless-panel-test'}).content
 .replaceAll("from 'vue'",`from '${pathToFileURL(require.resolve('vue')).href}'`)
 .replaceAll("from '../../electron/headlessValues.js'",`from '${new URL('../electron/headlessValues.js',import.meta.url).href}'`);
const Component=(await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'))).default;
const session=(phase,job=null)=>({schema:'headless_session/v0.2',workload_id:'workload-panel',generation:1,owner_id:'actor-panel',profile_id:'headless-sumsq-v1',backend:'firecracker',isa:'aarch64',phase,ownership:phase==='stopped'?'released':'held',job});
function panel(s,busy=false,uncertain=false){const calls=[];return {calls,p:Component.setup({snapshot:{available:true,busy,uncertain,revision:1,code:null,session:s}},{expose(){},emit:(...args)=>calls.push(args)})};}
test('compiled panel emits only bounded run for ready authoritative session',()=>{const {p,calls}=panel(session('ready'));p.run();assert.deepEqual(calls,[['run',10]]);p.n.value='10001';p.run();p.n.value='1e2';p.run();assert.equal(calls.length,1);});
test('compiled panel blocks busy/repeated run and allows uncertain held Stop',()=>{for(const [phase,busy,uncertain] of [['ready',true,false],['uncertain',false,true],['stopped',false,false]]){const {p,calls}=panel(session(phase),busy,uncertain);p.run();assert.deepEqual(calls,[]);p.stop();assert.equal(calls.length,phase==='uncertain'?1:0);}});
test('compiled panel rejects malformed session and never emits host arguments',()=>{const {p,calls}=panel({...session('ready'),path:'/forbidden'});p.run();p.stop();assert.deepEqual(calls,[]);const ready=panel(session('ready'));ready.p.stop();assert.deepEqual(ready.calls,[['stop']]);});
