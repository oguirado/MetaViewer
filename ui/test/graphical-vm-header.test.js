import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createGraphicalSessionController,emptyGraphicalSnapshot,graphicalSnapshot,graphicalCapabilities,graphicalAction} from '../src/wall/graphicalStateControls.js';
const require=createRequire(import.meta.url),{parse,compileScript}=require('@vue/compiler-sfc'),{createSSRApp,h}=require('vue'),{renderToString}=require('@vue/server-renderer');
const row={id:'surface-vm',kind:'vm',backendLifecycle:'active',control:'agent'};
function fixture(){return {available:true,busy:false,code:null,revision:1,uncertain:false,point_ages_ms:{'point-before':12500},session:{schema:'graphical_session/v0.2',surface_id:row.id,runtime_id:'runtime-'+'a'.repeat(64),owner_id:'actor-ui',generation:1,authority_epoch:1,authority:'core',phase:'ready',ownership:'held',pending_request_id:null,backend:'qemu',isa:'aarch64',points:[{point_id:'point-before',label:'Before',generation:1,manifest_sha256:'b'.repeat(64),created_mono_ns:1}]}};}
function host(initial=fixture()){
 const calls=[],changes=[];let notify=()=>{},stop=0,reply=initial;
 const api={status:async()=>reply,subscribe:cb=>{notify=cb;return ()=>stop++;},request:async action=>{calls.push(action);return reply;}};
 const controller=createGraphicalSessionController(api,s=>changes.push(s));
 return {api,controller,calls,changes,emit:s=>notify(s),reply:s=>{reply=s;},stops:()=>stop};
}
const source=readFileSync(new URL('../src/wall/GraphicalVmStateControls.vue',import.meta.url),'utf8');
let code=compileScript(parse(source).descriptor,{id:'graphical-header',inlineTemplate:true}).content;
code=code.replaceAll("from 'vue'",`from '${pathToFileURL(require.resolve('vue')).href}'`).replaceAll('from "vue"',`from '${pathToFileURL(require.resolve('vue')).href}'`).replace("from './graphicalStateControls.js'",`from '${new URL('../src/wall/graphicalStateControls.js',import.meta.url).href}'`);
const Component=(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).default;
const render=(snapshot,r=row)=>renderToString(createSSRApp({render:()=>h(Component,{snapshot,row:r})}));

test('graphical header shows classic Back, Mark and host-computed point ages',async()=>{
 const s=fixture();s.session.points[0].label='<Before>';const html=await render(s);
 assert.match(html,/Mark VM checkpoint/);assert.match(html,/Back to VM checkpoint/);assert.match(html,/⏪︎/);assert.match(html,/&lt;Before&gt;/);assert.match(html,/12 s ago/);assert.doesNotMatch(html,/Guest counter|owner_id|runtime_id/);
 s.point_ages_ms['point-before']=null;assert.match(await render(s),/Age unavailable/);
});
test('unavailable, ordinary, other-surface and closed states have no mutation placeholders',async()=>{
 for(const [s,r] of [[emptyGraphicalSnapshot(),row],[fixture(),{...row,kind:'browser'}],[fixture(),{...row,id:'other'}]])assert.doesNotMatch(await render(s,r),/aria-label="(?:Mark VM|Back to VM)/);
 const s=fixture();s.session.phase='stopped';s.session.ownership='released';assert.doesNotMatch(await render(s),/aria-label="(?:Mark VM|Back to VM)/);
});
test('busy, unknown, pending, stopping and lost disable mutations but display real state',async()=>{
 for(const mutate of [s=>s.busy=true,s=>{s.uncertain=true;s.code='OUTCOME_UNKNOWN';},s=>s.session.phase='pending',s=>s.session.phase='stopping']){
  const s=fixture();mutate(s);assert.equal(graphicalCapabilities(s,row).enabled,false);assert.equal(graphicalAction(s,row,'mark'),null);assert.match(await render(s),/disabled/);
 }
 assert.equal(graphicalAction(fixture(),{...row,backendLifecycle:'lost'},'mark'),null);
 const s=fixture();s.code='STALE';assert.match(await render(s),/Checkpoints: STALE/);
});
test('human Take control retains graphical UI authority and exact facade fields',()=>{
 const s=fixture(),human={...row,control:'human'};
 assert.deepEqual(graphicalAction(s,human,'mark'),{op:'mark',surface_id:row.id,generation:1,authority_epoch:1,label:''});
 assert.deepEqual(graphicalAction(s,human,'restore','point-before'),{op:'restore',surface_id:row.id,generation:1,authority_epoch:1,point_id:'point-before'});
 assert.equal(graphicalAction(s,human,'restore','point-missing'),null);
});
test('malformed, over-capacity and unsafe labels fail closed',()=>{
 for(const mutate of [s=>s.session.points.push(null),s=>s.session.points=Array(5).fill(s.session.points[0]),s=>s.session.points[0].label='bad\u009b',s=>s.session.generation=0]){const s=fixture();mutate(s);assert.equal(graphicalSnapshot(s),false);}
 for(const label of ['bad/name','bad\\name','x'.repeat(81),'bad\nline'])assert.equal(graphicalAction(fixture(),row,'mark',label),null);
});
test('a full four-point session hides Mark and refuses dispatch while retaining Back',async()=>{
 const s=fixture();s.session.points=Array.from({length:4},(_,index)=>({...s.session.points[0],point_id:`point-${index}`}));
 assert.equal(graphicalSnapshot(s),true);assert.equal(graphicalCapabilities(s,row).mark.available,false);
 assert.equal(graphicalCapabilities(s,row).back.available,true);assert.equal(graphicalAction(s,row,'mark'),null);
 const html=await render(s);assert.doesNotMatch(html,/aria-label="Mark VM checkpoint"/);assert.match(html,/aria-label="Back to VM checkpoint"/);
 const h=host(s);await h.controller.refresh();assert.equal(await h.controller.request({op:'mark',surface_id:row.id,generation:1,authority_epoch:1,label:''},1,[row]),false);assert.equal(h.calls.length,0);h.controller.dispose();
});
test('attach uses only a live VM row, once, without renderer ownership or request ids',async()=>{
 const h=host({...emptyGraphicalSnapshot(),available:true});await h.controller.refresh();
 await h.controller.attach([{...row,kind:'program'},{...row,backendLifecycle:'lost'}]);assert.equal(h.calls.length,0);
 await h.controller.attach([row]);await h.controller.attach([row]);assert.deepEqual(h.calls,[{op:'attach',surface_id:row.id}]);h.controller.dispose();assert.equal(h.stops(),1);
});
test('stale revision, tuple, removed point and other-surface clicks never reach host',async()=>{
 const h=host();await h.controller.refresh();const action=graphicalAction(fixture(),row,'restore','point-before');
 const next=fixture();next.revision=2;next.session.generation=2;next.session.authority_epoch=2;h.emit(next);
 assert.equal(await h.controller.request(action,1,[row]),false);assert.equal(await h.controller.request(action,2,[row]),false);
 assert.equal(await h.controller.request({...action,surface_id:'other'},2,[row]),false);
 const missing=graphicalAction(next,row,'restore','point-before');next.session.points=[];h.emit({...next,revision:3});assert.equal(await h.controller.request(missing,3,[row]),false);assert.equal(h.calls.length,0);h.controller.dispose();
});
test('pending requests serialize; only host completion changes generation and points',async()=>{
 const h=host();await h.controller.refresh();let finish;h.api.request=action=>{h.calls.push(action);return new Promise(resolve=>finish=resolve);};
 const action=graphicalAction(fixture(),row,'mark');const pending=h.controller.request(action,1,[row]);assert.equal(h.changes.at(-1).busy,true);assert.equal(h.changes.at(-1).session.generation,1);
 assert.equal(await h.controller.request(action,1,[row]),false);assert.equal(h.calls.length,1);
 const completed=fixture();completed.revision=2;completed.session.generation=2;finish(completed);await pending;assert.equal(h.changes.at(-1).session.generation,2);assert.equal(h.changes.at(-1).busy,false);h.controller.dispose();
});
test('transport loss retains the held session, latches uncertainty until a newer host revision',async()=>{
 const h=host();await h.controller.refresh();h.api.request=async()=>{throw Error('timeout');};
 await h.controller.request(graphicalAction(fixture(),row,'mark'),1,[row]);assert.equal(h.changes.at(-1).uncertain,true);assert.equal(h.changes.at(-1).session.surface_id,row.id);
 await h.controller.refresh();assert.equal(h.changes.at(-1).uncertain,true);
 const fresh=fixture();fresh.revision=2;h.emit(fresh);assert.equal(h.changes.at(-1).uncertain,false);h.emit(fixture());assert.equal(h.changes.at(-1).revision,2);h.controller.dispose();
});
test('disposed subscriptions and late status completion cannot publish or dispatch',async()=>{
 const h=host();let finish;h.api.status=()=>new Promise(resolve=>finish=resolve);const refresh=h.controller.refresh();h.controller.dispose();finish(fixture());await refresh;h.emit(fixture());assert.equal(h.changes.length,0);assert.equal(await h.controller.request({},1,[row]),false);
});
test('App forwards the existing header seam without changing the MicroVM header',()=>{
 const app=readFileSync(new URL('../src/App.vue',import.meta.url),'utf8');
 assert.match(app,/:state-controls-for="graphicalControlsFor"/);assert.match(app,/<template #state-controls="\{capsuleId\}">/);assert.match(app,/nestedMode.displayOnly\?null:props.graphicalSessionHost/);assert.doesNotMatch(app,/metaviewer\?\.graphicalSession/);
 assert.match(readFileSync(new URL('../src/wall/WallWorkspace.vue',import.meta.url),'utf8'),/stateControls: props.stateControlsFor\?\.\(capsuleId\)/);
 assert.match(readFileSync(new URL('../src/wall/DesktopWorkspace.vue',import.meta.url),'utf8'),/<slot name="state-controls"/);
});

test('a physically released stopped session permits attach to a new VM lifetime',async()=>{
 const s=fixture();s.session.phase='stopped';s.session.ownership='released';const h=host(s);await h.controller.refresh();
 await h.controller.attach([{...row,id:'surface-new'}]);assert.deepEqual(h.calls,[{op:'attach',surface_id:'surface-new'}]);h.controller.dispose();
});


test('graphical header CSS references only existing canonical theme tokens',()=>{
 const theme=readFileSync(new URL('../src/design/metaviewer.css',import.meta.url),'utf8');
 const defined=new Set([...theme.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(match=>match[1]));
 const referenced=[...source.matchAll(/var\((--[a-z0-9-]+)/g)].map(match=>match[1]);
 assert.ok(referenced.length>0);for(const token of referenced)assert.ok(defined.has(token),`Undefined graphical header token: ${token}`);
 assert.doesNotMatch(source,/--cuk-semantic-/);
});

test('graphical control local mv-dark bridge mirrors canonical dark without changing global theme',()=>{
 const theme=readFileSync(new URL('../src/design/metaviewer.css',import.meta.url),'utf8');
 const keys=['surface-panel','surface-canvas','text-primary','text-muted','border-default'];
 for(const contrast of ['normal','high']){
  const canonical=theme.split(`:root[data-theme-scheme="dark"][data-theme-contrast="${contrast}"] {`)[1].split('}')[0];
  const local=source.split(`:root[data-theme-scheme="mv-dark"][data-theme-contrast="${contrast}"] .graphical-vm-state-controls {`)[1].split('}')[0];
  const values=text=>new Map([...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match=>[match[1],match[2]]));
  for(const key of keys)assert.equal(values(local).get(`--mv-semantic-${key}`),values(canonical).get(`--mv-semantic-${key}`));
 }
});
