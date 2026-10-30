import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
import {createHandoffModel} from '../src/handoff/handoffModel.js';
const row={schema:'metaviewer.handoff/v1',surface_id:'surface-1',step_index:1,reason:'captcha_wall',confidence:100,evidence_kinds:['ax_role_name']};
const tick=async()=>{await new Promise(r=>setImmediate(r));await vue.nextTick();};
const Button=vue.defineComponent({props:['label','disabled'],emits:['click'],setup:(p,{emit})=>()=>vue.h('button',{disabled:p.disabled,onClick:()=>emit('click')},p.label)});
const Input=vue.defineComponent({props:['label','modelValue'],emits:['update:modelValue'],setup:(p,{emit})=>()=>vue.h('input',{'aria-label':p.label,value:p.modelValue,onInput:e=>emit('update:modelValue',e.target.value)})});
const Dialog=vue.defineComponent({props:['open','title','confirmLabel','backLabel','busy','confirmDisabled'],emits:['confirm','back'],setup:(p,{emit,slots})=>()=>p.open?vue.h('section',{'aria-label':p.title},[...(slots.default?.()??[]),vue.h('button',{disabled:p.busy||p.confirmDisabled,onClick:()=>emit('confirm')},p.confirmLabel),vue.h('button',{onClick:()=>emit('back')},p.backLabel??'Back')]):null});
let serial=0;
async function component(file){
  const url=new URL(`../src/${file}`,import.meta.url),{descriptor}=parse(readFileSync(url,'utf8'));
  const built=compileScript(descriptor,{id:'idnet',inlineTemplate:true});
  globalThis.__idnetComponents={UiButton:Button,UiTextInput:Input,Dialog};
  const require=createRequire(import.meta.url);
  const code=built.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,(all,binding,_q,spec)=>{
    if(spec==='capsule-ui-kit/ui')return `const ${binding}=globalThis.__idnetComponents;`;
    if(spec.endsWith('.vue'))return `const ${binding}=globalThis.__idnetComponents.Dialog;`;
    return `import ${binding} from ${JSON.stringify(spec==='vue'?pathToFileURL(require.resolve('vue')).href:new URL(spec,url).href)};`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default;
}
function mount(Component,props){
  const renderer=vue.createRenderer({createElement:tag=>({tag,tagName:tag.toUpperCase(),props:{},children:[],listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},removeEventListener(name){delete this.listeners[name];},getAttribute(name){return this.props[name];}}),createText:text=>({text}),createComment:text=>({text}),
    insert(child,parent,anchor){if(child.parent)this.remove(child);child.parent=parent;const at=parent.children.indexOf(anchor);parent.children.splice(at<0?parent.children.length:at,0,child);},
    remove(child){const list=child.parent?.children;if(list)list.splice(list.indexOf(child),1);},
    setText(n,text){n.text=text;},setElementText(n,text){n.text=text;n.children=[];},patchProp(n,k,_old,value){n.props[k]=value;},parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1]??null,setScopeId(){}});
  const root={children:[]},app=renderer.createApp(Component,props);app.mount(root);return {root,close:()=>app.unmount()};
}
function nodes(n){return [n,...(n.children??[]).flatMap(nodes)];}
function text(n){return (n.text??'')+(n.children??[]).map(text).join(' ');}
function button(root,label){const found=nodes(root).find(n=>n.tag==='button'&&n.text===label);assert.ok(found,`button ${label}`);assert.ok(!found.props.disabled,`${label} enabled`);found.props.onClick();}
test('Identities dialog lists multiple accounts per site, creates, confirms delete, and logs in',async t=>{
  const calls=[];let finishLogin;
  const rows=[{id:'account-a',label:'A',domains:['example.com'],logged_in:'yes'},{id:'account-b',label:'B',domains:['example.com'],logged_in:'no'}];
  const identity={list:async()=>({ok:true,rows}),create:async v=>{calls.push(['create',v]);return {ok:true,rows:[]};},delete:async v=>{calls.push(['delete',v]);return {ok:true};},login:v=>{calls.push(['login',v]);return new Promise(r=>{finishLogin=r;});}};
  const view=mount(await component('identities/IdentitiesDialog.vue'),{open:true,host:{identity}});t.after(view.close);await tick();
  assert.match(text(view.root),/account-a/);assert.match(text(view.root),/account-b/);
  for(const [label,value] of [['Identity id','account-c'],['Account label','C'],['Domains (comma separated)','example.com']])nodes(view.root).find(n=>n.props?.['aria-label']===label).props.onInput({target:{value}});
  await tick();button(view.root,'Create identity');await tick();assert.equal(calls[0][0],'create');assert.equal(calls[0][1].id,'account-c');
  button(view.root,'Delete');await tick();assert.equal(calls.length,1);button(view.root,'Delete identity');await tick();assert.equal(calls[1][0],'delete');
  button(view.root,'Log in');await tick();assert.match(text(view.root),/Agent input stays refused/);finishLogin({ok:true});await tick();
  assert.doesNotMatch(text(view.root),/Agent input stays refused/);
  assert.equal(nodes(view.root).filter(n=>n.tag==='input').length,3);
});
test('Network panel edits only selected profile and shows typed refusal and legacy',async t=>{
  const calls=[];const host={egress:{get:async v=>{calls.push(['get',v]);return {ok:true,record:{schema:'metaviewer.capsule_egress/v1',mode:'open',domains:[]},net_mode:'legacy',reason:'binary_missing'};},set:async v=>{calls.push(['set',v]);return {ok:false,code:'NET_PROXIED_UNSUPPORTED'};}}};
  const view=mount(await component('netmode/NetworkPanel.vue'),{open:true,identity:'account-a',host});t.after(view.close);await tick();
  assert.match(text(view.root),/legacy: capability binary missing/);assert.match(text(view.root),/Open \(default\)/);assert.match(text(view.root),/Dedicated proxy with allowlist/);
  button(view.root,'Save network');await tick();assert.equal(calls[1][1].identity,'account-a');assert.equal(calls[1][1].record.mode,'open');assert.match(text(view.root),/NET_PROXIED_UNSUPPORTED/);
  host.egress.set=async v=>{calls.push(['set',v]);return v.confirm===true?{ok:true,record:v.record,net_mode:'legacy',reason:'binary_missing'}:{ok:false,code:'NET_OPEN_PREREQ'};};button(view.root,'Save network');await tick();assert.match(text(view.root),/NET_OPEN_PREREQ.*image 0.2.0.*final OpenSuperficies pin.*morning report.*step 0/);
  assert.equal(calls.length,3);assert.equal(calls[2][1].confirm,undefined);
  assert.equal(nodes(view.root).find(n=>n.tag==='button' && n.text==='Save network').props.disabled,true);
  button(view.root,'Confirm save for next start anyway');await tick();assert.equal(calls.length,4);assert.equal(calls[3][1].confirm,true);
  assert.doesNotMatch(text(view.root),/NET_OPEN_PREREQ/);
});
test('MUT-AUTO-DISMISS-HANDOFF component stays after empty events and failed ack, emits control once',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let receive,allowAck=false,activities=0,controls=0;
  const host={handoff:{list:async()=>({ok:true,rows:[row]}),subscribe:cb=>{receive=cb;return()=>{};},ack:async()=>({ok:allowAck})}};
  const view=mount(await component('handoff/HandoffNotice.vue'),{host,onActivity:()=>activities++,onTakeControl:()=>controls++});t.after(view.close);await tick();
  assert.match(text(view.root),/CAPTCHA or bot check: solve it in the capsule, then re-run/);assert.equal(activities,1);
  t.mock.timers.tick(10000);await tick();assert.match(text(view.root),/CAPTCHA or bot check/);
  receive({ok:true,rows:[]});receive({ok:true,rows:[row]});await tick();assert.equal(activities,1);
  button(view.root,'Take control');assert.equal(controls,1);
  button(view.root,'Acknowledge');await tick();assert.match(text(view.root),/notice stays visible/);assert.match(text(view.root),/CAPTCHA or bot check/);
  allowAck=true;button(view.root,'Acknowledge');await tick();assert.doesNotMatch(text(view.root),/CAPTCHA or bot check/);
  receive({ok:true,rows:[row]});await tick();assert.doesNotMatch(text(view.root),/CAPTCHA or bot check/);
});
test('handoff model never removes a row on absent snapshots or transport failure',async()=>{
  const model=createHandoffModel({list:async()=>{throw new Error('offline');},ack:async()=>{throw new Error('disk');}});
  model.receive({ok:true,rows:[row]});model.receive({ok:true,rows:[]});model.receive({ok:false});
  await assert.rejects(model.load());await assert.rejects(model.acknowledge(row));assert.equal(model.rows().length,1);
});

test('identity first impression labels, placeholders, grammar and typed tool failure',async t=>{
  let creates=0;
  const host={identity:{list:async()=>({ok:false,code:'IDENTITY_UNAVAILABLE'}),create:async()=>{creates++;return {ok:true};}}};
  const view=mount(await component('identities/IdentitiesDialog.vue'),{open:true,host});t.after(view.close);await tick();
  for(const label of ['Identity id','Label','Domains (comma separated)'])assert.ok(nodes(view.root).some(n=>n.tag==='label'&&text(n).startsWith(label)));
  const source=readFileSync(new URL('../src/identities/IdentitiesDialog.vue',import.meta.url),'utf8');
  for(const example of ['perplexity-main','Perplexity main','perplexity.ai'])assert.ok(source.includes(`placeholder="${example}"`));
  assert.match(text(view.root),/The identity tool could not run: IDENTITY_UNAVAILABLE/);
  assert.match(text(view.root),/2–40 chars: a–z\/0–9 first/);
  const field=label=>nodes(view.root).find(n=>n.props?.['aria-label']===label);
  for(const [label,value] of [['Account label','Account'],['Domains (comma separated)','example.com']])field(label).props.onInput({target:{value}});
  for(const id of ['', 'a','Bad-id','-account','aa bb','a'.repeat(41)]){
    field('Identity id').props.onInput({target:{value:id}});await tick();
    const create=nodes(view.root).find(n=>n.tag==='button'&&n.text==='Create identity');
    assert.equal(create.props.disabled,true,id);create.props.onClick();await tick();assert.equal(creates,0);
  }
  for(const id of ['aa','perplexity-main','1-account','a'.repeat(40)]){
    field('Identity id').props.onInput({target:{value:id}});await tick();
    assert.equal(nodes(view.root).find(n=>n.tag==='button'&&n.text==='Create identity').props.disabled,false,id);
  }
});
