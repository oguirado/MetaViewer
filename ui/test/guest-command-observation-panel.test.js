import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc';
import {createSSRApp} from 'vue';
import {renderToString} from '@vue/server-renderer';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../src/components/GuestCommandPanel.vue',import.meta.url),'utf8');
const descriptor=parse(source).descriptor;
function imports(code){return code.replaceAll("from 'vue'",`from '${pathToFileURL(require.resolve('vue')).href}'`).replaceAll('from "vue"',`from '${pathToFileURL(require.resolve('vue')).href}'`).replaceAll('from "vue/server-renderer"',`from '${pathToFileURL(require.resolve('vue/server-renderer')).href}'`).replaceAll("from '../../electron/guestCommandValues.js'",`from '${new URL('../electron/guestCommandValues.js',import.meta.url).href}'`).replaceAll("from '../wall/rewindStateControls.js'",`from '${new URL('../src/wall/rewindStateControls.js',import.meta.url).href}'`).replaceAll("from '../wall/restoreDuration.js'",`from '${new URL('../src/wall/restoreDuration.js',import.meta.url).href}'`);}
const script=compileScript(descriptor,{id:'observed-panel'});
const Component=(await import('data:text/javascript;base64,'+Buffer.from(imports(script.content)).toString('base64'))).default;
const template=compileTemplate({source:descriptor.template.content,filename:'GuestCommandPanel.vue',id:'observed-panel',ssr:true,ssrCssVars:descriptor.cssVars,compilerOptions:{bindingMetadata:script.bindings}});
assert.deepEqual(template.errors,[]);
const {ssrRender}=await import('data:text/javascript;base64,'+Buffer.from(imports(template.code)).toString('base64'));
const session={schema:'guest_command_session/v0.2',workload_id:'workload-one',generation:1,owner_id:'actor-one',profile_id:'guest-command-arm64-v1',backend:'firecracker',isa:'aarch64',phase:'ready',ownership:'held',jobs_started:0,job:null,controls:{cancel:null,stop:null}};
test('actual compiled panel renders SDK text escaped and separate from editable next command',async()=>{
 const command='<img src=x onerror=alert(1)> & printf ok';let state;
 const Wrapped={...Component,ssrRender,setup(props,ctx){state=Component.setup(props,ctx);state.observation.value={active:{requester:{component:'agent'},command_utf8:command,generation:1,state:'running'},history:[]};return state;}};
 const html=await renderToString(createSSRApp(Wrapped,{snapshot:{available:true,busy:false,canCancel:false,uncertain:false,code:null,revision:1,session,stdout:'ok',stderr:''}}));
 assert.match(html,/SDK command/);assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt; &amp; printf ok/);assert.ok(!html.includes('<img src=x'));assert.equal(state.command.value,'uname -m');assert.ok(!source.includes('v-html'));
});
test('preload and host projection validators remain exact copies',()=>{
 const marker='/** Closed, readonly command transcript projection; it cannot authorize a request. */';
 const values=readFileSync(new URL('../electron/guestCommandValues.js',import.meta.url),'utf8');
 const preload=readFileSync(new URL('../electron/preload.js',import.meta.url),'utf8');
 const expected=values.slice(values.indexOf(marker),values.indexOf('\nexport {gcObservationSnapshot};')).trim();
 assert.equal(preload.slice(preload.indexOf(marker),preload.indexOf(marker)+expected.length),expected);
});
