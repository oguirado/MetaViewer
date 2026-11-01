import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import { identityFormRequest, validIdentityName, identityErrorText } from '../src/identities/identityForm.js';
import { assertOperatorCall, assertOperatorReply } from '../electron/preload.js';
import { installRoleHost } from '../electron/roleHost.js';
import { toolRefusedCode } from '../electron/operatorBridge.js';

const tick = async () => { await new Promise(r => setImmediate(r)); await vue.nextTick(); };
const nodes = n => [n, ...(n.children ?? []).flatMap(nodes)];
const text = n => (n.text ?? '') + (n.children ?? []).map(text).join(' ');
const field = (root,label) => nodes(root).find(n=>n.props?.['aria-label']===label);
const button = (root,label) => nodes(root).find(n=>n.tag==='button' && n.text===label);
const Button=vue.defineComponent({props:['label','disabled'],emits:['click'],setup:(p,{emit})=>()=>vue.h('button',{disabled:p.disabled,onClick:()=>emit('click')},p.label)});
const Input=vue.defineComponent({props:['label','modelValue'],emits:['update:modelValue'],setup:(p,{emit})=>()=>vue.h('input',{'aria-label':p.label,value:p.modelValue,onInput:e=>emit('update:modelValue',e.target.value)})});
const Dialog=vue.defineComponent({props:['open','title','confirmLabel','busy','confirmDisabled'],emits:['confirm','back'],setup:(p,{emit,slots})=>()=>p.open?vue.h('section',{'aria-label':p.title},[...(slots.default?.()??[]),vue.h('button',{disabled:p.busy||p.confirmDisabled,onClick:()=>emit('confirm')},p.confirmLabel)]):null});
let serial=0;
async function dialog() {
  const url=new URL('../src/identities/IdentitiesDialog.vue',import.meta.url);
  const {descriptor}=parse(readFileSync(url,'utf8'));
  globalThis.__p18d={UiButton:Button,UiTextInput:Input,Dialog};
  const require=createRequire(import.meta.url);
  const code=compileScript(descriptor,{id:'p18d',inlineTemplate:true}).content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,(_all,binding,_q,spec)=>{
    if(spec==='capsule-ui-kit/ui')return `const ${binding}=globalThis.__p18d;`;
    if(spec.endsWith('.vue'))return `const ${binding}=globalThis.__p18d.Dialog;`;
    return `import ${binding} from ${JSON.stringify(spec==='vue'?pathToFileURL(require.resolve('vue')).href:new URL(spec,url).href)};`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default;
}
function mount(component,props){
  const renderer=vue.createRenderer({createElement:tag=>({tag,props:{},children:[]}),createText:text=>({text}),createComment:text=>({text}),
    insert(child,parent,anchor){if(child.parent)this.remove(child);child.parent=parent;const at=parent.children.indexOf(anchor);parent.children.splice(at<0?parent.children.length:at,0,child);},
    remove(child){const list=child.parent?.children;if(list)list.splice(list.indexOf(child),1);},
    setText(n,text){n.text=text;},setElementText(n,text){n.text=text;n.children=[];},patchProp(n,k,_o,v){n.props[k]=v;},parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1]??null,setScopeId(){}});
  const root={children:[]},app=renderer.createApp(component,props);app.mount(root);return {root,close:()=>app.unmount()};
}

test('P18D required name, optional display name, any-site and sorted unique sites cross IPC',()=>{
  for(const name of ['', 'A-test', 'x', '-bad', 'a b', 'mv-live-1', 'cuentas-new', 'srf-pg-editor', 'a'.repeat(41)]){
    assert.equal(validIdentityName(name),false,name);
    assert.equal(identityFormRequest(name,'',''),null,name);
  }
  assert.deepEqual(identityFormRequest('p18d-a','',''),{id:'p18d-a',label:'p18d-a',domains:[]});
  const request=identityFormRequest('p18d-a','  Work  ',' Z.org, a.com, Z.ORG, , a.com');
  assert.deepEqual(request,{id:'p18d-a',label:'Work',domains:['a.com','z.org']});
  assert.doesNotThrow(()=>assertOperatorCall('identity.create',[request]));
  assert.doesNotThrow(()=>assertOperatorCall('identity.create',[identityFormRequest('p18d-a','','')]));
  for(const domains of [['z.org','a.com'],['a.com','a.com'],['bad_host'],Array(17).fill('a.com')])assert.throws(()=>assertOperatorCall('identity.create',[{id:'p18d-a',label:'A',domains}]),/OPERATOR_PAYLOAD/);
});

test('P18D dialog creates with defaults and shows plain live validation',async t=>{
  const calls=[];const identity={list:async()=>({ok:true,rows:[]}),create:async request=>{calls.push(request);return {ok:true};}};
  const view=mount(await dialog(),{open:true,host:{identity}});t.after(view.close);await tick();
  assert.equal(button(view.root,'Add identity').props.disabled,true);
  assert.match(text(view.root),/lowercase letters, numbers and dashes/);
  assert.match(text(view.root),/Leave empty to allow any site/);
  field(view.root,'Name').props.onInput({target:{value:'Bad Name'}});await tick();
  assert.match(text(view.root),/product and protected names are reserved/);
  assert.equal(button(view.root,'Add identity').props.disabled,true);
  field(view.root,'Name').props.onInput({target:{value:'p18d-a'}});await tick();
  assert.equal(button(view.root,'Add identity').props.disabled,false);
  button(view.root,'Add identity').props.onClick();await tick();
  assert.deepEqual(calls,[{id:'p18d-a',label:'p18d-a',domains:[]}]);
});

test('P18D open identity delete refuses locally; backend lease race keeps clear message',async t=>{
  globalThis.metaviewerRoles={choices:async()=>[{profileId:'p18d-a',available:true,currentMode:'human',surfaceId:'surface-a',lastLogin:123000}]};
  t.after(()=>delete globalThis.metaviewerRoles);
  let deletes=0;const identity={list:async()=>({ok:true,rows:[{id:'p18d-a',label:'Work',domains:[]}]}),delete:async()=>{deletes++;return {ok:false,code:'IDENTITY_BOUND'};}};
  const view=mount(await dialog(),{open:true,host:{identity}});t.after(view.close);await tick();
  assert.match(text(view.root),/Last login:/);
  button(view.root,'Delete').props.onClick();await tick();
  assert.equal(deletes,0);assert.match(text(view.root),/Stop it first/);
  assert.equal(button(view.root,'Delete identity'),undefined);
  globalThis.metaviewerRoles.choices=async()=>[{profileId:'p18d-a',available:true,currentMode:'closed'}];
  view.close();
  const closed=mount(await dialog(),{open:true,host:{identity}});t.after(closed.close);await tick();
  button(closed.root,'Delete').props.onClick();await tick();assert.equal(deletes,0);
  button(closed.root,'Delete identity').props.onClick();await tick();
  assert.equal(deletes,1);assert.match(text(closed.root),/Stop it first/);
  const reply={schema:'metaviewer.identity/v1',ok:false,error:'IDENTITY_BOUND'};
  assert.equal(toolRefusedCode(JSON.stringify(reply)),'IDENTITY_BOUND');
  assert.deepEqual(assertOperatorReply('identity.delete',{ok:false,code:'IDENTITY_BOUND'}),{ok:false,code:'IDENTITY_BOUND'});
  assert.match(identityErrorText('IDENTITY_BOUND'),/Stop it first/);
});

test('P18D modal marker covers confirmation and releases only its own marker',async t=>{
  const attributes=new Map();const prior=globalThis.document;
  globalThis.document={body:{setAttribute:(k,v)=>attributes.set(k,v),removeAttribute:k=>attributes.delete(k),hasAttribute:k=>attributes.has(k)}};
  t.after(()=>{globalThis.document=prior;});
  const component=await dialog(),host={identity:{list:async()=>({ok:true,rows:[]})}};
  const view=mount(component,{open:true,host});await tick();
  assert.equal(attributes.get('data-mv-modal'),'true');view.close();assert.equal(attributes.has('data-mv-modal'),false);
  attributes.set('data-mv-modal','true');const shared=mount(component,{open:true,host});shared.close();assert.equal(attributes.has('data-mv-modal'),true);
});

test('P18D runtime names admitted in human and agent modes, unknown/protected refused; login marker persists',async t=>{
  const root=await mkdtemp(join(tmpdir(),'p18d-roles-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const handlers=new Map(),states=new Map();let next=0,mode='agent';let rows=[];
  const parent=new EventEmitter();parent.webContents={session:{registerPreloadScript(){return 'p18d';},unregisterPreloadScript(){}}};
  const profiles=Object.fromEntries([1,2,3,4].map(i=>[`mv-live-${i}`,{Kind:'browser',NativeKind:'browser',Width:1280,Height:900,RAMRoot:'/dev/shm',Display:`:${110+i}`,text_input:'paste'}]));
  const core={getHumanSurface:id=>states.get(id),async request(request){
    const surface={schema:'surface/v0.2',surface_id:`surface-${++next}`,profile_id:request.params.profile_id,state:'active',control:mode,geometry:request.params.geometry};
    states.set(surface.surface_id,surface);return {schema:'surface_event/v0.2',event:'created',data:{surface}};
  },async stopSurface(id){const surface={...states.get(id),state:'destroyed'};states.set(id,surface);return {schema:'surface_event/v0.2',event:'state_changed',data:{surface}};}};
  const host=installRoleHost({electron:{ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)}},window:parent,core,env:{MV_SRF_STATE_DIR:root,MV_SRF_PROFILES:JSON.stringify(profiles)},capsuleStates:states,admit:()=>true,listIdentities:async()=>({ok:true,rows}),stageMode:async(_root,_id,role)=>{mode=role;return async()=>{};}});
  t.after(()=>host.dispose());
  const request=(op,extra={})=>handlers.get('metaviewer:roles.v0.3')({}, {schema:'metaviewer.roles/v0.3',op,...extra});
  rows=[{id:'p18d-a'},{id:'p18d-b'},{id:'cuentas-9'},...Object.keys(profiles).map(id=>({id}))];
  const choices=await request('choices');assert.equal(choices.find(p=>p.profileId==='p18d-a').available,true);
  assert.equal(choices.some(p=>p.profileId==='cuentas-9'),false);
  const a=await request('open',{choice:{profileId:'p18d-a',role:'human'}});assert.equal(a.ok,true);
  const b=await request('open',{choice:{profileId:'p18d-b',role:'agent'}});assert.equal(b.ok,true);
  assert.equal((await request('open',{choice:{profileId:'missing-id',role:'human'}})).ok,false);
  assert.equal((await request('open',{choice:{profileId:'cuentas-9',role:'human'}})).ok,false);
  const marked=await request('confirm-login',{surfaceId:a.surfaceId});assert.equal(marked.ok,true);assert.ok(marked.lastLogin>0);
  assert.equal((await request('confirm-login',{surfaceId:b.surfaceId})).ok,false);
  assert.equal((await request('choices')).find(p=>p.profileId==='p18d-a').lastLogin,marked.lastLogin);
  assert.equal((await request('stop',{surfaceId:a.surfaceId})).ok,true);
  assert.equal((await request('stop',{surfaceId:b.surfaceId})).ok,true);
  assert.equal((await request('choices')).find(p=>p.profileId==='p18d-a').currentMode,'closed');
  assert.equal((await request('choices')).find(p=>p.profileId==='p18d-a').lastLogin,marked.lastLogin);
  for(const profileId of Object.keys(profiles)){
    const opened=await request('open',{choice:{profileId,role:'agent'}});assert.equal(opened.ok,true);
    assert.equal((await request('stop',{surfaceId:opened.surfaceId})).ok,true);
  }
});

test('P18D runtime profiles require an explicit configured browser template',async t=>{
  const root=await mkdtemp(join(tmpdir(),'p18d-template-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const good={Kind:'browser',NativeKind:'browser',Width:1280,Height:900,RAMRoot:'/dev/shm',Display:':111',text_input:'paste'};
  for(const configured of [undefined,{...good,NativeKind:'program'},{...good,Width:640},{...good,RAMRoot:undefined}]){
    const handlers=new Map();const parent=new EventEmitter();parent.webContents={session:{registerPreloadScript(){return 'p18d';},unregisterPreloadScript(){}}};
    const env={MV_SRF_STATE_DIR:root,...(configured?{MV_SRF_PROFILES:JSON.stringify({'mv-live-3':configured})}:{})};
    const host=installRoleHost({electron:{ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)}},window:parent,core:{},env,capsuleStates:new Map(),admit:()=>true,listIdentities:async()=>({ok:true,rows:[{id:'p18d-a'}]})});
    try {
      const choices=await handlers.get('metaviewer:roles.v0.3')({}, {schema:'metaviewer.roles/v0.3',op:'choices'});
      assert.equal(choices.some(p=>p.profileId==='p18d-a'),false,'inferred or non-browser template admitted');
    } finally {await host.dispose();}
  }
});
