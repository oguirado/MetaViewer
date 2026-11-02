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
import { identityFormRequest, validIdentityName, identityErrorText, normalizeIdentityName, retainTypedIdentityName } from '../src/identities/identityForm.js';
import { isProtectedIdentity } from '../electron/identityProtection.js';
import { createOperatorService, identityRunner } from '../electron/operatorBridge.js';
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
async function dialog(source) {
  const url=new URL('../src/identities/IdentitiesDialog.vue',import.meta.url);
  const {descriptor}=parse(source ?? readFileSync(url,'utf8'));
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

test('P18E Name normalizes while retaining typed default Display name, including incremental edits',async t=>{
  assert.equal(normalizeIdentityName('Prueba1'),'prueba1');
  assert.equal(normalizeIdentityName('Work Account_!'),'work-account');
  let original='';
  for(const char of 'Prueba1') original=retainTypedIdentityName(original,normalizeIdentityName(original)+char);
  assert.equal(original,'Prueba1');
  assert.equal(retainTypedIdentityName('Prueba1','prueba12'),'Prueba12');
  assert.equal(retainTypedIdentityName('Prueba1','prueXba1'),'PrueXba1');
  const requests=[];
  const view=mount(await dialog(),{open:true,host:{identity:{list:async()=>({ok:true,rows:[]}),create:async v=>{requests.push(v);return {ok:true};}}}});
  t.after(view.close);await tick();
  for(const char of 'Prueba1') {
    const input=field(view.root,'Name');input.props.onInput({target:{value:input.props.value+char}});await tick();
  }
  assert.equal(field(view.root,'Name').props.value,'prueba1');
  assert.equal(field(view.root,'Display name').props.value,'Prueba1');
  assert.match(text(view.root),/Will be saved as prueba1/);
  assert.equal(button(view.root,'Add identity').props.disabled,false);
  button(view.root,'Add identity').props.onClick();await tick();
  assert.deepEqual(requests,[{id:'prueba1',label:'Prueba1',domains:[]}]);
});

const protectedIds=[
  'srf-id-cuentas-1','srf-id-perplexity-1','srf-pg-notepad-1','srf-pg-metaviewer-1',
  'srf-egress-proxy','n8n','distil-box','mv-live-1'];
async function protectionUiOracle(source) {
  let deletes=0;
  const view=mount(await dialog(source),{open:true,host:{identity:{
    list:async()=>({ok:true,rows:protectedIds.map(id=>({id,label:id,domains:[]}))}),
    delete:async()=>{deletes++;return {ok:true};},
  }}});
  try {
    await tick();
    const buttons=nodes(view.root).filter(n=>n.tag==='button' && n.text==='Delete');
    assert.equal(buttons.length,protectedIds.length);
    for(const control of buttons) {
      assert.equal(control.props.disabled,true);
      assert.equal(control.props.title,'Managed outside MetaViewer');
      control.props.onClick();await tick();
      assert.equal(button(view.root,'Delete identity'),undefined,'forced click cannot enter deletion confirmation');
    }
    assert.equal(deletes,0);
  } finally {view.close();}
}
test('P18E all protected identities disable Delete and refuse forced clicks',()=>protectionUiOracle());
test('P18E mutant enabling protected Delete is killed by the actual UI oracle',async()=>{
  const source=readFileSync(new URL('../src/identities/IdentitiesDialog.vue',import.meta.url),'utf8');
  const mutant=source.replace(':disabled="busy || isProtectedIdentity(row.id)"',':disabled="busy"');
  assert.notEqual(mutant,source);
  await assert.rejects(()=>protectionUiOracle(mutant),{code:'ERR_ASSERTION'});
});
test('P18E host service and direct runner reject protected deletion before invoking tools',async()=>{
  let dispatched=0;
  const service=createOperatorService({env:{MV_HANDOFF_PATHS:'[]'},runIdentity:async()=>{dispatched++;return {ok:true};}});
  const runner=identityRunner({tool:'/not-invoked',spawnTool:()=>{dispatched++;throw Error('MUTANT_DISPATCHED');}});
  for(const id of protectedIds) {
    assert(isProtectedIdentity(id),id);
    assert.deepEqual(await service.request('identity.delete',[{id}]),{ok:false,code:'IDENTITY_PROTECTED'});
    await assert.rejects(runner('delete',{id}),/IDENTITY_PROTECTED/);
  }
  assert.equal(dispatched,0);
  assert.doesNotThrow(()=>assertOperatorReply('identity.delete',{ok:false,code:'IDENTITY_PROTECTED'}));
  assert.equal(toolRefusedCode(JSON.stringify({schema:'metaviewer.identity/v1',ok:false,error:'IDENTITY_PROTECTED'})),'IDENTITY_PROTECTED');
  assert.equal(isProtectedIdentity('p18e-owned'),false);
  assert.deepEqual(await service.request('identity.delete',[{id:'p18e-owned'}]),{ok:true});
  assert.equal(dispatched,1,'unprotected names still reach the tool');
});

test('P18D required name, optional display name, any-site and sorted unique sites cross IPC',()=>{
  for(const name of ['', 'A-test', 'x', '-bad', 'a b', 'mv-live-1', 'srf-id-cuentas-1', 'srf-pg-editor', 'a'.repeat(41)]){
    assert.equal(validIdentityName(name),false,name);
    assert.equal(identityFormRequest(name,'',''),null,name);
  }
  for(const normal of ['p18d-a', 'cuentas-1', 'cuentas-new', 'perplexity-1', 'perplexity-new']){
    assert.equal(validIdentityName(normal),true,normal);
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
  field(view.root,'Name').props.onInput({target:{value:'mv-live-1'}});await tick();
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
  rows=[{id:'p18d-a'},{id:'p18d-b'},{id:'cuentas-1'},{id:'perplexity-1'},{id:'srf-id-cuentas-1'},...Object.keys(profiles).map(id=>({id}))];
  const choices=await request('choices');assert.equal(choices.find(p=>p.profileId==='p18d-a').available,true);
  assert.equal(choices.find(p=>p.profileId==='cuentas-1').available,true);
  assert.equal(choices.find(p=>p.profileId==='perplexity-1').available,true);
  assert.equal(choices.some(p=>p.profileId==='srf-id-cuentas-1'),false);
  const a=await request('open',{choice:{profileId:'p18d-a',role:'human'}});assert.equal(a.ok,true);
  const b=await request('open',{choice:{profileId:'p18d-b',role:'agent'}});assert.equal(b.ok,true);
  const c1=await request('open',{choice:{profileId:'cuentas-1',role:'human'}});assert.equal(c1.ok,true);
  const p1=await request('open',{choice:{profileId:'perplexity-1',role:'agent'}});assert.equal(p1.ok,true);
  assert.equal((await request('stop',{surfaceId:c1.surfaceId})).ok,true);
  assert.equal((await request('stop',{surfaceId:p1.surfaceId})).ok,true);
  assert.equal((await request('open',{choice:{profileId:'missing-id',role:'human'}})).ok,false);
  assert.equal((await request('open',{choice:{profileId:'srf-id-cuentas-1',role:'human'}})).ok,false);
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

const foreignOpenIds=protectedIds.filter(id=>!id.startsWith('mv-'));
async function foreignUiOracle(source,legacy=false){
 const previous=globalThis.metaviewerRoles;let calls=0;const opened=[];
 globalThis.metaviewerRoles=legacy?undefined:{choices:async()=>foreignOpenIds.map(profileId=>({profileId,available:true}))};
 const view=mount(await dialog(source),{open:true,onOpenIdentity:v=>opened.push(v),host:{identity:{list:async()=>({ok:true,rows:foreignOpenIds.map(id=>({id,label:id,domains:[]}))}),login:async()=>{calls++;return {ok:true};}}}});
 try{await tick();for(const b of nodes(view.root).filter(n=>n.tag==='button'&&['Log in','Open as human','Open as agent'].includes(n.text))){assert.equal(b.props.disabled,true,b.text);b.props.onClick();assert.equal(calls,0,'guard blocks dispatch before rendering');await tick();}assert.equal(calls,0);assert.deepEqual(opened,[]);}
 finally{view.close();globalThis.metaviewerRoles=previous;}
}
test('P18G foreign identities refuse disabled and forced human/agent opens',()=>foreignUiOracle());
test('P18G legacy login refuses disabled and forced foreign clicks',()=>foreignUiOracle(undefined,true));
test('P18G UI guard mutants cannot dispatch foreign opens or login',async()=>{
 const source=readFileSync(new URL('../src/identities/IdentitiesDialog.vue',import.meta.url),'utf8');
 const mutant=source.replaceAll('isForeignIdentity(row.id) || ','').replaceAll('busy || isForeignIdentity(row.id)','busy');assert.notEqual(source,mutant);
 await assert.rejects(foreignUiOracle(mutant),{code:'ERR_ASSERTION'});await assert.rejects(foreignUiOracle(mutant,true),{code:'ERR_ASSERTION'});
});
test('H9 successful identity creation clears its form despite unavailable mode refresh',async t=>{
 const previous=globalThis.metaviewerRoles;let modes=0;
 globalThis.metaviewerRoles={choices:async()=>{if(++modes>1)throw Error('MODE_LOOKUP_FAILED');return [];}};
 const view=mount(await dialog(),{open:true,host:{identity:{list:async()=>({ok:true,rows:[]}),create:async()=>({ok:true})}}});
 t.after(()=>{view.close();globalThis.metaviewerRoles=previous;});await tick();field(view.root,'Name').props.onInput({target:{value:'fixture-owned'}});await tick();
 button(view.root,'Add identity').props.onClick();await tick();assert.equal(field(view.root,'Name').props.value,'');assert(!text(view.root).includes('Unavailable'));
});
test('P18G identity form reserves every named foreign holder as well as the prefixes',()=>{
 for(const id of foreignOpenIds)assert.equal(validIdentityName(id),false,id);
});
test('H10 invalid auto-filled display names have a visible field error',async t=>{
 const view=mount(await dialog(),{open:true,host:{identity:{list:async()=>({ok:true,rows:[]})}}});t.after(view.close);await tick();
 field(view.root,'Name').props.onInput({target:{value:'Work$'}});await tick();assert.equal(field(view.root,'Name').props.value,'work');assert.equal(button(view.root,'Add identity').props.disabled,true);assert.match(text(view.root),/Display name contains unsupported characters/);
});

test('V024 cuentas-1 and perplexity-1 are normal capsules (open as human/agent and delete with confirmation)',async t=>{
 const previous=globalThis.metaviewerRoles;
 globalThis.metaviewerRoles={choices:async()=>[
   {profileId:'cuentas-1',available:true,currentMode:'closed'},
   {profileId:'perplexity-1',available:true,currentMode:'closed'},
 ]};
 t.after(()=>{globalThis.metaviewerRoles=previous;});
 const opened=[],deleted=[];
 const rows=[{id:'cuentas-1',label:'Google + ChatGPT',domains:[]},{id:'perplexity-1',label:'Perplexity',domains:[]}];
 const view=mount(await dialog(),{open:true,onOpenIdentity:v=>opened.push(v),host:{identity:{
   list:async()=>({ok:true,rows}),
   delete:async({id})=>{deleted.push(id);return {ok:true};},
 }}});
 t.after(view.close);await tick();
 const shown=text(view.root);
 assert(shown.includes('cuentas-1'));assert(shown.includes('perplexity-1'));
 const humanBtns=nodes(view.root).filter(n=>n.tag==='button' && n.text==='Open as human');
 const agentBtns=nodes(view.root).filter(n=>n.tag==='button' && n.text==='Open as agent');
 const delBtns=nodes(view.root).filter(n=>n.tag==='button' && n.text==='Delete');
 assert.equal(humanBtns.length,2);assert.equal(agentBtns.length,2);assert.equal(delBtns.length,2);
 for(const b of [...humanBtns,...agentBtns,...delBtns])assert.equal(b.props.disabled,false);
 humanBtns[0].props.onClick();await tick();
 agentBtns[1].props.onClick();await tick();
 assert.deepEqual(opened,[{profileId:'cuentas-1',role:'human'},{profileId:'perplexity-1',role:'agent'}]);
 delBtns[0].props.onClick();await tick();
 assert.notEqual(button(view.root,'Delete identity'),undefined);
 button(view.root,'Delete identity').props.onClick();await tick();
 assert.deepEqual(deleted,['cuentas-1']);
 const app=readFileSync(new URL('../src/App.vue',import.meta.url),'utf8');
 assert.doesNotMatch(app,/hide-foreign/);

 // Mutant: restoring cuentas-/perplexity- to FOREIGN_PREFIXES in identityProtection.js makes this open/delete test fail.
 const protUrl=new URL('../electron/identityProtection.js',import.meta.url);
 const protSrc=readFileSync(protUrl,'utf8');
 const mutantProtSrc=protSrc.replace(
   "['srf-id-cuentas-', 'srf-id-perplexity-', 'srf-pg-']",
   "['cuentas-', 'perplexity-', 'srf-id-cuentas-', 'srf-id-perplexity-', 'srf-pg-']",
 );
 assert.notEqual(protSrc,mutantProtSrc);
 const mutantProtMod=await import(`data:text/javascript;base64,${Buffer.from(mutantProtSrc).toString('base64')}`);
 assert.equal(mutantProtMod.isForeignIdentity('cuentas-1'),true,'restoring prefix blocks cuentas-1');
 assert.equal(mutantProtMod.isProtectedIdentity('perplexity-1'),true,'restoring prefix blocks perplexity-1');
});
