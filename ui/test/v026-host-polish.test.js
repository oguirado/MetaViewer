import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir, readFile, symlink } from 'node:fs/promises';
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


import { stageOpeningMode } from '../electron/openingMode.js';
test('V026 HOST programs reopen in selected role through actual preload IPC and staged opening mode, including restart', async t => {
  const root=await mkdtemp(join(tmpdir(),'v026-identities-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const binary=join(root,'editor');await writeFile(binary,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const states=new Map(),requests=[],staged=[],handlers=new Map();let seq=0,rows=[];
  const parent=new EventEmitter();parent.webContents={session:{registerPreloadScript:()=> 'v026',unregisterPreloadScript(){}}};
  const core={getHumanSurface:id=>states.get(id),async request(req){
    requests.push(req);
    const mode=JSON.parse(await readFile(join(root,'opening-modes',req.params.profile_id+'.json'),'utf8'));staged.push(mode);
    const surface={schema:'surface/v0.2',surface_id:'surface-'+(++seq),profile_id:req.params.profile_id,state:'active',control:mode.mode,geometry:req.params.geometry};
    states.set(surface.surface_id,surface);return {schema:'surface_event/v0.2',event:'created',data:{surface}};
  },async stopSurface(id){const surface={...states.get(id),state:'destroyed'};states.set(id,surface);return {schema:'surface_event/v0.2',event:'state_changed',data:{surface}};}};
  const options={electron:{ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)}},window:parent,core,
    env:{MV_SRF_STATE_DIR:root},capsuleStates:states,admit:()=>true,listIdentities:async()=>({ok:true,rows}),
    provisionProgramIdentity:async ({id})=>{if(!rows.some(r=>r.id===id))rows.push({id,browser:'program',label:'Editor'});return {ok:true};},
    readFreeMemoryBytes:async()=>8*1024**3,stageMode:stageOpeningMode};
  let host=installRoleHost(options);t.after(()=>host.dispose());
  const ipc=[];const require=createRequire(import.meta.url);
  // Execute the real preload rather than reconstructing its request shape.
  const vm=await import('node:vm');let roles;
  vm.runInNewContext(readFileSync(new URL('../electron/rolePreload.cjs',import.meta.url),'utf8'),{
    process:{isMainFrame:true},location:{origin:'app://metaviewer'},require:()=>({
      contextBridge:{exposeInMainWorld:(_name,api)=>{roles=api;}},
      ipcRenderer:{invoke:(channel,message)=>{ipc.push(message);return handlers.get(channel)({},message);}},
    }),
  });
  let launched=await roles.createProgram({binary,role:'agent',hostXpra:true});assert.equal(launched.ok,true);
  const liveChoice=(await roles.programs()).find(row=>row.profileId===launched.profileId);
  assert.equal(liveChoice.available,true);assert.equal(liveChoice.busy,false);
  await roles.stop(launched.surfaceId);
  await host.dispose();host=installRoleHost(options);
  const prior=globalThis.metaviewerRoles;globalThis.metaviewerRoles=roles;t.after(()=>{globalThis.metaviewerRoles=prior;});
  async function reopen(role,source) {
    const view=mount(await dialog(source),{open:true,host:{identity:{list:async()=>({ok:true,rows})}},
      ...(role==='human'?{openProgram:choice=>roles.createProgram(choice)}:{})});
    for(let n=0;n<100 && (!button(view.root,'Open as '+role) || button(view.root,'Open as '+role).props.disabled);n++)await new Promise(r=>setTimeout(r,5));
    assert.doesNotMatch(text(view.root),/Last login/);
    const control=button(view.root,'Open as '+role);assert.equal(control.props.disabled,false);
    const before=staged.length;control.props.onClick();
    for(let n=0;n<100 && (staged.length===before || button(view.root,'Open as '+role).props.disabled);n++)await new Promise(r=>setTimeout(r,5));
    await tick();
    try {
    assert.equal(staged.length,before+1);
    assert.equal(staged.at(-1).mode,role);assert.equal(staged.at(-1).host_binary,binary);assert.equal(staged.at(-1).host_xpra,true);
    assert.deepEqual(JSON.parse(JSON.stringify(ipc.filter(r=>r.op==='create-program').at(-1))),{schema:'metaviewer.roles/v0.3',op:'create-program',choice:{binary,role,hostXpra:true}});
    assert.equal(requests.at(-1).schema,'surface_request/v0.2');
    const active=[...states.values()].find(s=>s.state==='active');assert.ok(active);
    } finally {
      for(const active of [...states.values()].filter(s=>s.state==='active'))await roles.stop(active.surface_id);view.close();
    }
  }
  for(const role of ['human','agent'])await reopen(role);
  assert.match(readFileSync(new URL('../src/App.vue',import.meta.url),'utf8'), /<IdentitiesDialog[^>]*:open-program="createProgramCapsule"/);
  const original=readFileSync(new URL('../src/identities/IdentitiesDialog.vue',import.meta.url),'utf8');
  const mutant=original.replace('{binary:mode.binary,role}', "{binary:mode.binary,role:'human'}");assert.notEqual(mutant,original);
  await assert.rejects(()=>reopen('agent',mutant),{code:'ERR_ASSERTION'});
  const hostMutant=original.replace('if (mode.hostXpra) Object.assign(choice,{hostXpra:true});','');
  assert.notEqual(hostMutant,original);
  await assert.rejects(()=>reopen('agent',hostMutant),{code:'ERR_ASSERTION'});
});
