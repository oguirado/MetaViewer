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
 const f=await new AsyncFunction('rows','desktopState','selectTreeDesktop','nextTick','wall','markPanelOpen','selectedCapsuleId',text+';return selectTreeCapsule;')({value:[{id:'a'}]},{value:{assignments:{a:{view:'human',desktop:2}}}},(v,d)=>events.push(['desktop',v,d]),async()=>events.push(['settled']),{value:{revealSurface:(id,p)=>{events.push(['reveal',id,p]);return result;}}},id=>events.push(['restored',id]),selected);
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
