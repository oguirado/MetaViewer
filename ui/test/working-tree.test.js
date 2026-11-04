import {ref,watch,nextTick} from 'vue';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDesktopState,addDesktop} from '../electron/desktopLayout.js';
const source=readFileSync(new URL('../src/App.vue',import.meta.url),'utf8');
const extract=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const mapping=extract('function buildWorkingTree(', 'const treeHandoffs');
const build=new Function('surfaceLabel',mapping+';return buildWorkingTree;')(row=>row.title || row.id);
const row=(id,extra={})=>({id,title:id,attachmentState:'live',backendLifecycle:'active',...extra});
test('working tree preserves both views and empty desktops, with exact counts and assignments',()=>{
 const state=createDesktopState();addDesktop(state,'human');
 state.assignments={a:{view:'human',desktop:1},b:{view:'agent',desktop:1}};
 const tree=build([row('a'),row('b'),row('unassigned')],state,[],[]);
 assert.deepEqual(tree.map(v=>[v.id,v.count,v.desktops.map(d=>[d.id,d.capsules.map(c=>c.id)])]),[
  ['human',1,[[1,['a']],[2,[]]]],['agent',1,[[1,['b']]]]]);
});
test('working tree never fabricates motion; its statuses require their real evidence',()=>{
 const state=createDesktopState();
 const rows=[row('idle',{control:'agent'}),row('busy',{aiSessionActivity:'busy'}),row('done',{dispatchOutcome:'verified'}),row('waiting',{attachmentState:'attaching'}),row('gone',{backendLifecycle:'lost'}),row('refused',{refusal:{code:'REFUSED'}}),row('min'),row('notice')];
 for(const r of rows)state.assignments[r.id]={view:'agent',desktop:1};
 const tree=build(rows,state,['notice'],['min']),caps=tree[1].desktops[0].capsules;
 assert.deepEqual(caps.map(c=>c.status),['Agent','Acting','Agent','Connecting','Lost','Error','Minimized','Needs you']);
 assert.equal(tree[0].needsYou,false);assert.equal(tree[1].needsYou,true);
 assert.equal(build(rows,state,[],[])[1].needsYou,false);
});
test('Host program and Desktop window warnings are retained even with pending state',()=>{
 const state=createDesktopState();state.assignments={host:{view:'human',desktop:1},desktop:{view:'human',desktop:1},regular:{view:'human',desktop:1}};
 const caps=build([row('host',{hostXpra:true}),row('desktop',{hostWindow:{state:'active'}}),row('regular')],state,['host'],[])[0].desktops[0].capsules;
 assert.deepEqual(caps.map(c=>c.notIsolated),[true,true,false]);assert.equal(caps[0].status,'Needs you');
 assert.match(source, /class="mv-tree-capsule-status"[^>]*>\{\{ capsule.status \}\}/);
 assert.match(source, /v-if="capsule.notIsolated" class="mv-tree-isolation">Not isolated/);
 assert.doesNotMatch(source, /capsule\.notIsolated \? 'Not isolated' : capsule\.status/);
});
const navigation=extract('async function selectTreeCapsule(', '// Reconcile only changed');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function navigate(text,id,result={ok:true}) {
 const events=[],selected={value:'prior'};
 const f=await new AsyncFunction('rows','guestWorkloadTiles','desktopState','selectTreeDesktop','nextTick','wall','markPanelOpen','selectedCapsuleId',text+';return selectTreeCapsule;')({value:[{id:'a'}]},{value:[]},{value:{assignments:{a:{view:'human',desktop:2}}}},(v,d)=>events.push(['desktop',v,d]),async()=>events.push(['settled']),{value:{revealSurface:(id,p)=>{events.push(['reveal',id,p]);return result;}}},id=>events.push(['restored',id]),selected);
 await f(id);return {events,selected:selected.value};
}
test('capsule selection switches desktop before restoring and focusing a minimized tile',async()=>{
 assert.deepEqual(await navigate(navigation,'a'),{events:[['desktop','human',2],['settled'],['reveal','a','tab'],['restored','a']],selected:'a'});
 assert.deepEqual(await navigate(navigation,'absent'),{events:[],selected:'prior'});
 assert.equal((await navigate(navigation,'a',{ok:false})).selected,'prior');
 const mutant=navigation.replace('await nextTick();','/* render barrier removed */');
 assert.notEqual(mutant,navigation);assert.notDeepEqual((await navigate(mutant,'a')).events,(await navigate(navigation,'a')).events);
});
test('working tree retains navigation identities and keeps Storyboard fixture-only',()=>{
 for(const pin of ['view-${view.id}','wall/view/${view.id}','desktop-${view.id}-${desktop.id}','wall/desktop/${view.id}/${desktop.id}','wall/desktop/add','wall/desktop/remove'])assert(source.includes(pin),pin);
 assert.match(source,/<UiButton v-if="props\.fixture" id="shell-creative"/);
 assert.match(source,/mv-navigation--collapsed \.mv-tree-desktops/);
 assert.match(source,/mv-tree-needs-dot/);
 assert.match(source,/\.mv-tree-capsule-name \{[^}]*overflow:hidden;[^}]*text-overflow:ellipsis/);
});


test('tree program icons come only from known binaries and browser identities',()=>{
 const state=createDesktopState();for(const id of ['p','b','u','vm'])state.assignments[id]={view:'agent',desktop:1};
 const metadata={apps:[{binary:'/usr/bin/editor',icon:'data:image/png;base64,AAAA'}],programs:[{profileId:'editor-profile',binary:'/usr/bin/editor'}],browsers:[{profileId:'browser-profile'}]};
 const caps=build([row('p',{profile_id:'editor-profile'}),row('b',{profile_id:'browser-profile'}),row('u'),row('vm',{kind:'guest-command',snapshot:{session:{phase:'ready'}}})],state,[],[],metadata)[1].desktops[0].capsules;
 assert.deepEqual(caps.map(c=>c.kind),['program','browser','unknown','microvm']);assert.equal(caps[0].icon,metadata.apps[0].icon);assert.equal(caps[2].icon,'');assert.equal(caps[3].status,'ready');
 state.labels={'editor-profile':'My editor'};assert.equal(build([row('p',{profile_id:'editor-profile'})],state,[],[],metadata)[1].desktops[0].capsules[0].title,'My editor');
});


test('unchanged capsule frames do not repeat host icon and identity lookups',async()=>{
 const state=ref([{id:'a',profile_id:'one',title:'Frame 1'}]),open=ref(false),stops=[],calls=[];
 const nativeApi={listApps:async()=>{calls.push('apps');return {apps:[]};},programs:async()=>{calls.push('programs');return [];},choices:async()=>{calls.push('browsers');return [];}};
 const body=extract('const treeMetadata=', 'const navigationTree');
 new Function('ref','watch','rows','launcherOpen','nativeApi','hostActive',body)(ref,(...args)=>{const stop=watch(...args);stops.push(stop);return stop;},state,open,nativeApi,true);
 try {
  await nextTick();await Promise.resolve();assert.equal(calls.length,3);
  state.value=[{id:'a',profile_id:'one',title:'Frame 2'}];await nextTick();await Promise.resolve();assert.equal(calls.length,3);
  state.value=[{id:'b',profile_id:'two',title:'New capsule'}];await nextTick();await Promise.resolve();assert.equal(calls.length,6);
 } finally {for(const stop of stops)stop();}
});


test('ambiguous executable names and inherited labels remain generic',()=>{
 const state=createDesktopState();state.assignments={a:{view:'human',desktop:1}};state.labels={};
 const metadata={apps:[{binary:'/first/editor',icon:'first'},{binary:'/second/editor',icon:'second'}],programs:[],browsers:[]};
 const capsule=build([row('a',{profile_id:'toString',hostWindow:{program:'editor'}})],state,[],[],metadata)[0].desktops[0].capsules[0];
 assert.equal(capsule.title,'a');assert.equal(capsule.icon,'');
});


test('finishing or cancelling a name edit returns focus to its original tree row',async()=>{
 const edit=ref(null),focused=[],saved=[];
 const body=extract('async function beginTreeRename(', '/** @param {string} view @param {number} desktop */');
 const api=new Function('treeRename','nextTick','document','wall',body+';return {beginTreeRename,cancelTreeRename,saveTreeRename};')(edit,async()=>{}, {getElementById:id=>({focus:()=>focused.push(id),select(){}})}, {value:{renameDesktop:async(...args)=>{saved.push(args);return true;}}});
 await api.beginTreeRename('desktop','agent',{id:1,label:'Original'});
 await api.cancelTreeRename();assert.equal(focused.at(-1),'desktop-agent-1');assert.equal(edit.value,null);
 await api.beginTreeRename('desktop','agent',{id:1,label:'Original'});edit.value.value='Renamed';await api.saveTreeRename();
 assert.deepEqual(saved,[['agent',1,'Renamed']]);assert.equal(focused.at(-1),'desktop-agent-1');assert.equal(edit.value,null);
});
