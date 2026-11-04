import test from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import * as model from '../.kit/capsule-ui-kit/src/shell/NewCapsuleModel.js';
import {compileSfc,mountComponent,nodes,text,flush} from './mvui2-terminal-mount.mjs';
const icon=vue.defineComponent({setup:()=>()=>vue.h('span')});
const dialog=vue.defineComponent({props:['visible'],emits:['show'],setup(p,{slots,emit}){vue.onMounted(()=>emit('show'));return ()=>p.visible?vue.h('section',slots.default?.()):null;}});
const button=vue.defineComponent({props:['label'],emits:['click'],setup:(p,{emit,slots})=>()=>vue.h('button',{onClick:()=>emit('click')},[p.label,slots.default?.()])});
const input=vue.defineComponent({props:['modelValue'],emits:['update:modelValue'],setup:(p,{emit})=>()=>vue.h('input',{value:p.modelValue,onInput:e=>emit('update:modelValue',e.target.value)})});
const tag=vue.defineComponent({props:['label'],setup:p=>()=>vue.h('span',p.label)});
async function fixture(t) {
 const old=globalThis.document;let focused='';globalThis.document={getElementById:id=>({focus(){focused=id;}})};t.after(()=>{globalThis.document=old;});
 const view=await compileSfc('catalog/GroupedCapsuleDialog.vue',{
  'openvue/dialog':dialog,'../../.kit/capsule-ui-kit/src/workspace/cspDialog.js':{createCspDialog:x=>x},
  '@openvue/icons/search':icon,'@openvue/icons/check':icon,'@openvue/icons/plus':icon,'@openvue/icons/times':icon,
  '../../.kit/capsule-ui-kit/src/ui/UiButton.vue':button,'../../.kit/capsule-ui-kit/src/ui/UiTextInput.vue':input,
  '../../.kit/capsule-ui-kit/src/ui/UiTag.vue':tag,'../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue':icon,
  '../../.kit/capsule-ui-kit/src/shell/NewCapsuleModel.js':model,
 });
 const types=[{id:'browser',label:'Browser',description:'Isolated browser',category:'Capsules',opensAs:'tab'},
  {id:'recent-editor',label:'Editor',description:'Host program — not isolated',category:'Recent',opensAs:'tab'},
  {id:'app-editor',label:'Editor',description:'Host program — not isolated',category:'Installed apps',opensAs:'tab'},
  {id:'app-calculator',label:'Calculator',description:'Host program — not isolated',category:'Installed apps',opensAs:'tab'}];
 const created=[],closed=[];
 const mounted=mountComponent(view,{visible:true,types,onCreate:x=>created.push(x),'onUpdate:visible':x=>closed.push(x)});
 t.after(()=>mounted.app.unmount());await flush();
 const byId=id=>nodes(mounted.root).find(n=>n.props?.id===id);
 return {...mounted,byId,created,closed,get focused(){return focused;}};
}
test('launcher separates kinds, real Recent and apps with one warning per app section',async t=>{
 const f=await fixture(t);
 const groups=nodes(f.root).filter(n=>n.tag==='section' && n.props?.role==='group' && String(n.props?.['data-semantic-anchor']).startsWith('dialog/new-capsule/group-'));
 assert.deepEqual(groups.map(n=>n.props['aria-label']),['Capsule kinds','Recent','Installed apps']);
 assert.equal(nodes(f.root).filter(n=>n.props?.role==='note').length,2);
 for(const id of ['recent-editor','app-editor','app-calculator']) assert.ok(f.byId(f.byId('shell/new-capsule/card-'+id).props['aria-describedby']));
 assert.match(f.byId('shell/new-capsule/card-recent-editor').props['aria-label'],/from Recent/);
 for(const id of ['recent-editor','app-editor','app-calculator']) assert.doesNotMatch(text(f.byId('shell/new-capsule/card-'+id)),/Opens as/);
 assert.match(text(f.byId('shell/new-capsule/card-browser')),/Opens as/);
 f.byId('shell/new-capsule/card-app-editor').props.onClick();await flush();
 assert.equal((text(f.root).match(/not isolated/gi)??[]).length,2,'one warning per app section, including when an app is selected');
});
test('launcher search filters all sections and preserves empty state',async t=>{
 const f=await fixture(t),search=f.byId('shell/new-capsule/search');
 search.props.onInput({target:{value:'Calculator'}});await flush();
 assert.ok(f.byId('shell/new-capsule/card-app-calculator'));assert.equal(f.byId('shell/new-capsule/card-browser'),undefined);
 search.props.onInput({target:{value:'Absent value'}});await flush();assert.ok(f.byId('shell/new-capsule/empty'));
});
test('launcher keyboard and create use the selected real card and retain placement',async t=>{
 const f=await fixture(t),grid=f.byId('shell/new-capsule/grid');
 grid.props.onKeydown({key:'End',preventDefault(){}});await flush();
 assert.equal(f.focused,'shell/new-capsule/card-app-calculator');
 grid.props.onKeydown({key:'Enter',preventDefault(){}});await flush();
 assert.equal(f.created[0].type.id,'app-calculator');assert.equal(f.created[0].placement,'tab');assert.deepEqual(f.closed,[false]);
});

test('launcher focuses search after the native dialog reports show',async t=>{const f=await fixture(t);assert.equal(f.focused,'shell/new-capsule/search');});
