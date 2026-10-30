import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
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
  const renderer=vue.createRenderer({createElement:tag=>({tag,tagName:tag.toUpperCase(),props:{},children:[],get options(){return this.children.filter(n=>n.tag==='option');},listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},removeEventListener(name){delete this.listeners[name];},getAttribute(name){return this.props[name];}}),createText:text=>({text}),createComment:text=>({text}),
    insert(child,parent,anchor){if(child.parent)this.remove(child);child.parent=parent;const at=parent.children.indexOf(anchor);parent.children.splice(at<0?parent.children.length:at,0,child);},
    remove(child){const list=child.parent?.children;if(list)list.splice(list.indexOf(child),1);},
    setText(n,text){n.text=text;},setElementText(n,text){n.text=text;n.children=[];},patchProp(n,k,_old,value){n.props[k]=value;},parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1]??null,setScopeId(){}});
  const root={children:[]},app=renderer.createApp(Component,props);app.mount(root);return {root,close:()=>app.unmount()};
}
function nodes(n){return [n,...(n.children??[]).flatMap(nodes)];}
function text(n){return (n.text??'')+(n.children??[]).map(text).join(' ');}
function button(root,label){const found=nodes(root).find(n=>n.tag==='button'&&n.text===label);assert.ok(found,`button ${label}`);assert.ok(!found.props.disabled,`${label} enabled`);found.props.onClick();}
test('Demo dialog chooses identity, records, seals, copies and checks; refusal is visible',async t=>{
  const calls=[];
  const host={identity:{list:async()=>({ok:true,rows:[{id:'account-a',label:'Account A'}]})},demo:{}};
  for(const verb of ['start','stop','prompt','check'])host.demo[verb]=async(...args)=>{calls.push([verb,...args]);return verb==='start'?{ok:true,url:'http://127.0.0.1:1234/'}:{ok:true};};
  const view=mount(await component('demo/DemoDialog.vue'),{open:true,host});t.after(view.close);await tick();
  assert.match(text(view.root),/Account A/);
  const select=nodes(view.root).find(n=>n.tag==='select');
  select.props['onUpdate:modelValue']('account-a');
  for(const [label,value] of [['Demo id','demo'],['Site name','site']])nodes(view.root).find(n=>n.props?.['aria-label']===label).props.onInput({target:{value}});
  await tick();button(view.root,'Start');await tick();assert.match(text(view.root),/Viewer URL/);
  assert.ok(nodes(view.root).find(n=>n.tag==='button'&&n.text==='Copy prompt').props.disabled);
  button(view.root,'Stop');await tick();button(view.root,'Copy prompt');await tick();assert.match(text(view.root),/Copied/);
  button(view.root,'Check site');await tick();assert.match(text(view.root),/Site check: ok/);
  assert.deepEqual(calls,[['start',{identity:'account-a',demo:'demo'}],['stop'],['prompt',{demo:'demo',site:'site'}],['check',{site:'site'}]]);
  host.demo.check=async()=>({ok:false,code:'DEMO_REFUSED'});button(view.root,'Check site');await tick();assert.match(text(view.root),/DEMO_REFUSED/);
});
for(const pending of [false,true])test(`Demo dialog unmount stops ${pending?'pending':'active'} recording`,async()=>{
  const calls=[];let announce;
  const started=new Promise(resolve=>{announce=resolve;});
  const host={identity:{list:async()=>({ok:true,rows:[]})},demo:{start:async()=>pending?started:{ok:true,url:'http://localhost:1234/'},stop:async()=>{calls.push('stop');return {ok:true};}}};
  const view=mount(await component('demo/DemoDialog.vue'),{open:true,host});await tick();
  nodes(view.root).find(n=>n.tag==='select').props['onUpdate:modelValue']('account');
  nodes(view.root).find(n=>n.props?.['aria-label']==='Demo id').props.onInput({target:{value:'demo'}});
  await tick();button(view.root,'Start');await tick();view.close();
  if(pending)announce({ok:true,url:'http://localhost:1234/'});
  await tick();assert.deepEqual(calls,['stop']);
});
