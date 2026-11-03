import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import {stateRequest,stateEvent} from '../electron/preload.js';
import {createPreloadFacade} from '../electron/preload.js';
const tick = async () => { await new Promise(r => setImmediate(r)); await vue.nextTick(); };
const Button = vue.defineComponent({ props: ['label', 'disabled'], emits: ['click'], setup: (p, { emit }) => () => vue.h('button', { disabled: p.disabled, onClick: () => emit('click') }, p.label) });
const Input = vue.defineComponent({ props: ['label', 'modelValue'], emits: ['update:modelValue'], setup: (p, { emit }) => () => vue.h('input', { 'aria-label': p.label, value: p.modelValue, onInput: e => emit('update:modelValue', e.target.value) }) });
const Dialog = vue.defineComponent({ props: ['open', 'title', 'confirmLabel', 'backLabel', 'busy', 'confirmDisabled', 'description'], emits: ['confirm', 'back'], setup: (p, { emit, slots }) => () => p.open ? vue.h('section', { 'aria-label': p.title }, [vue.h('p',p.description), ...(slots.default?.() ?? []), vue.h('button', { disabled: p.busy || p.confirmDisabled, onClick: () => emit('confirm') }, p.confirmLabel)]) : null });
let serial = 0;
async function component(file='StoredDataSlots.vue', Slots=null) {
  const url = new URL('../src/identities/'+file, import.meta.url), { descriptor } = parse(readFileSync(url, 'utf8'));
  const built = compileScript(descriptor, { id: 'identdlg', inlineTemplate: true });
  globalThis.__slotDialog = { UiButton: Button, UiTextInput: Input, Dialog, Slots };
  const require = createRequire(import.meta.url);
  const code = built.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm, (all, binding, _q, spec) => {
    if (spec === 'capsule-ui-kit/ui') return `const ${binding}=globalThis.__slotDialog;`;
    if (spec.endsWith('StoredDataSlots.vue')) return `const ${binding}=globalThis.__slotDialog.Slots;`;
    if (spec.endsWith('.vue')) return `const ${binding}=globalThis.__slotDialog.Dialog;`;
    return `import ${binding} from ${JSON.stringify(spec === 'vue' ? pathToFileURL(require.resolve('vue')).href : new URL(spec, url).href)};`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default;
}
function mount(Component, props) {
  const renderer = vue.createRenderer({ createElement: tag => ({ tag, props: {}, children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
    insert(child, parent, anchor) { if (child.parent) this.remove(child); child.parent = parent; const at = parent.children.indexOf(anchor); parent.children.splice(at < 0 ? parent.children.length : at, 0, child); },
    remove(child) { const list = child.parent?.children; if (list) list.splice(list.indexOf(child), 1); },
    setText(n, text) { n.text = text; }, setElementText(n, text) { n.text = text; n.children = []; }, patchProp(n, k, _o, value) { n.props[k] = value; },
    parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, setScopeId() {} });
  const root = { children: [] }, app = renderer.createApp(Component, props); app.mount(root); return { root, close: () => app.unmount() };
}
const nodes = n => [n, ...(n.children ?? []).flatMap(nodes)];
const text = n => (n.text ?? '') + (n.children ?? []).map(text).join(' ');
const field = (root, label) => nodes(root).find(n => n.props?.['aria-label'] === label);

const button=(root,label)=>nodes(root).find(n=>n.tag==='button' && n.text===label);
const edit=async(root,label,value)=>{field(root,label).props.onInput({target:{value}});await tick();};
test('slots human flow lists name/time and requires explicit confirmation before overwrite/copy/delete',async()=>{
 const calls=[];
 const api={request:async request=>{calls.push(request);return {...request,schema:'capsule_state_event/v0.2',event:'completed',slots:request.op==='list'?[{slot_id:'before-update',name:'before-update',saved_at:'2026-11-03T12:00:00Z',generation:1}]:undefined};}};
 const mounted=mount(await component(),{profileId:'work-account',api});
 try {
  await tick();assert.equal(calls[0].op,'list');assert.match(text(mounted.root),/before-update/);
  assert.equal(nodes(mounted.root).find(n=>n.tag==='time').props.datetime,'2026-11-03T12:00:00Z');
  assert.match(text(mounted.root),/Stored data, not open tabs/);
  await edit(mounted.root,'Slot name','new-slot');button(mounted.root,'Save').props.onClick();await tick();
  assert.equal(calls.length,1);assert.match(text(mounted.root),/Signed-in sessions travel/);
  button(mounted.root,'Continue — signed-in sessions travel').props.onClick();await tick();await tick();assert.equal(calls.at(-2).op,'save');
  button(mounted.root,'Overwrite').props.onClick();await tick();const before=calls.length;
  assert.match(text(mounted.root),/Replace slot before-update/);assert.equal(calls.length,before);
  button(mounted.root,'Overwrite — signed-in sessions travel').props.onClick();await tick();await tick();assert.equal(calls.at(-2).op,'overwrite');
  button(mounted.root,'Load').props.onClick();await tick();button(mounted.root,'Continue — signed-in sessions travel').props.onClick();await tick();await tick();assert.equal(calls.at(-2).op,'load');
  await edit(mounted.root,'New capsule name for Copy','new-capsule');button(mounted.root,'Copy to a new capsule').props.onClick();await tick();
  assert.match(text(mounted.root),/Signed-in sessions travel.*new-capsule/);
  const count=calls.length;assert.equal(calls.length,count);button(mounted.root,'Continue — signed-in sessions travel').props.onClick();await tick();await tick();
  assert.equal(calls.at(-2).op,'copy');assert.equal(calls.at(-2).destination_profile_id,'new-capsule');
  button(mounted.root,'Delete slot').props.onClick();await tick();assert.match(text(mounted.root),/cannot be undone/);
  nodes(mounted.root).filter(n=>n.tag==='button'&&n.text==='Delete slot').at(-1).props.onClick();await tick();await tick();assert.equal(calls.at(-2).op,'delete');
  assert.ok(calls.every(c=>c.credential_copy_confirmed===true));
 } finally {mounted.close();}
});
test('closed request/event IPC refuses paths, endpoints, malformed rows and destination confusion',()=>{
 const request={schema:'capsule_state_request/v0.2',operation_id:'op-1',op:'save',profile_id:'work-account',slot_id:'slot-one',credential_copy_confirmed:true};
 assert.deepEqual(stateRequest(request),request);
 for(const extra of [{path:'/private/profile'},{from:{component:'ui'}},{destination_profile_id:'another'}])assert.throws(()=>stateRequest({...request,...extra}));
 const event={schema:'capsule_state_event/v0.2',operation_id:'op-1',op:'list',profile_id:'work-account',slot_id:'list',event:'completed',slots:[]};
 assert.deepEqual(stateEvent(event),event);
 assert.throws(()=>stateEvent({...event,path:'/private'}));
 assert.throws(()=>stateEvent({...event,slots:[{slot_id:'ok',name:'ok',saved_at:'now',generation:1,path:'/private'}]}));
 assert.throws(()=>stateRequest({...request,slot_id:'../escape'}));
 assert.throws(()=>stateRequest({...request,op:'copy',destination_profile_id:'work-account'}));
});
test('preload slot capability validates both directions and nested displays cannot call it',async()=>{
 const request={schema:'capsule_state_request/v0.2',operation_id:'op-1',op:'list',profile_id:'work-account',slot_id:'list',credential_copy_confirmed:true};
 const reply={schema:'capsule_state_event/v0.2',operation_id:'op-1',op:'list',profile_id:'work-account',slot_id:'list',event:'completed',slots:[]};
 let called=0;
 const make=(nested=false,bad=false)=>createPreloadFacade({transport:{nested,invoke:async(channel,args)=>{called++;assert.equal(channel,'metaviewer:capsule-state.request');assert.deepEqual(args,[request]);return bad?{...reply,path:'/private'}:reply;}},bridge:{exposeInMainWorld(){}}});
 assert.deepEqual(await make().slots.request(request),reply);
 await assert.rejects(make(false,true).slots.request(request));
 await assert.rejects(make(true).slots.request(request),/disabled/);assert.equal(called,2);
});

test('nonempty daemon listing metadata survives preload and closed validation',()=>{
 const event={schema:'capsule_state_event/v0.2',operation_id:'list-op',op:'list',profile_id:'work-account',slot_id:'list',event:'completed',slots:[{slot_id:'slot-one',name:'slot-one',saved_at:'2026-11-03T20:14:34.373343959Z',generation:1,size_bytes:2140160}]};
 assert.deepEqual(stateEvent(event),event);
 for (const size_bytes of [-1,NaN,'1024',Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>stateEvent({...event,slots:[{...event.slots[0],size_bytes}]}));
 const {slots,...missing}=event;assert.throws(()=>stateEvent(missing));
});

test('slot save shows progress, success and size; empty and failed listings are distinct',async()=>{
 let finish;let saved=false;
 const api={request:request=>request.op==='save'?new Promise(resolve=>{finish=()=>{saved=true;resolve({event:'completed'});};}):Promise.resolve({event:'completed',slots:saved?[{slot_id:'slot-one',name:'slot-one',saved_at:'2026-11-03T20:14:34Z',generation:1,size_bytes:2048}]:[]})};
 const mounted=mount(await component(),{profileId:'work-account',api});
 try {
  await tick();assert.match(text(mounted.root),/No saved slots for work-account/);
  await edit(mounted.root,'Slot name','slot-one');button(mounted.root,'Save').props.onClick();await tick();
  button(mounted.root,'Continue — signed-in sessions travel').props.onClick();await tick();
  assert.match(text(mounted.root),/Saving slot-one/);finish();await tick();await tick();
  assert.match(text(mounted.root),/Saved slot-one/);assert.ok(text(mounted.root).includes((2048).toLocaleString()+' bytes'));
  assert.equal(field(mounted.root,'Slot name').props.value,'');
  api.request=async()=>({event:'completed'});button(mounted.root,'Refresh slots').props.onClick();await tick();
  assert.match(text(mounted.root),/SLOT_LIST_MISSING/);assert.doesNotMatch(text(mounted.root),/No saved slots/);
 }finally{mounted.close();}
});

test('refusals and invalid names stay readable outside the closed confirmation',async()=>{
 const api={request:async request=>request.op==='list'?{event:'completed',slots:[]}:{event:'refused',reason_code:'SLOT_QUOTA'}};
 const mounted=mount(await component(),{profileId:'work-account',api});
 try{
  await tick();await edit(mounted.root,'Slot name','BAD/name');button(mounted.root,'Save').props.onClick();await tick();
  assert.match(text(mounted.root),/Use 2–40 lowercase/);
  await edit(mounted.root,'Slot name','slot-one');button(mounted.root,'Save').props.onClick();await tick();button(mounted.root,'Continue — signed-in sessions travel').props.onClick();await tick();
  assert.match(text(mounted.root),/Slot storage is full/);assert.equal(button(mounted.root,'Continue — signed-in sessions travel'),undefined);
 }finally{mounted.close();}
 const protectedProfile=mount(await component(),{profileId:'mv-live-1',api});
 try{await tick();assert.match(text(protectedProfile.root),/profile is protected/);}finally{protectedProfile.close();}
 const openProfile=mount(await component(),{profileId:'work-account',blocked:true,api});
 try{await tick();assert.match(text(openProfile.root),/Stop this capsule/);}finally{openProfile.close();}
});

test('Identities mounts one selected saved-data panel instead of racing every identity listing',async()=>{
 const old=globalThis.metaviewer,calls=[];
 globalThis.metaviewer={slots:{request:async request=>{calls.push(request);return {event:'completed',slots:[]};}}};
 const Slots=await component();
 const host={identity:{list:async()=>({ok:true,rows:[{id:'first-account',label:'First'},{id:'second-account',label:'Second'}]})}};
 const mounted=mount(await component('IdentitiesDialog.vue',Slots),{open:true,host});
 try{
  await tick();assert.equal(calls.length,0);
  const select=()=>nodes(mounted.root).filter(n=>n.tag==='button'&&n.text==='Stored data');
  select()[0].props.onClick();await tick();assert.deepEqual(calls.map(c=>c.profile_id),['first-account']);
  assert.match(text(mounted.root),/No saved slots for first-account/);
  select()[1].props.onClick();await tick();assert.deepEqual(calls.map(c=>c.profile_id),['first-account','second-account']);
  assert.doesNotMatch(text(mounted.root),/No saved slots for first-account/);
  assert.match(text(mounted.root),/No saved slots for second-account/);
 }finally{mounted.close();globalThis.metaviewer=old;}
});
