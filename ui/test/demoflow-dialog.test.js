import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
// DEMO-FLOW: the Automate-from-a-demo dialog reports id errors, single-use ids, location and privacy.
const tick=async()=>{await new Promise(r=>setImmediate(r));await vue.nextTick();};
const Button=vue.defineComponent({props:['label','disabled'],emits:['click'],setup:(p,{emit})=>()=>vue.h('button',{disabled:p.disabled,onClick:()=>emit('click')},p.label)});
const Input=vue.defineComponent({props:['label','modelValue'],emits:['update:modelValue'],setup:(p,{emit})=>()=>vue.h('input',{'aria-label':p.label,value:p.modelValue,onInput:e=>emit('update:modelValue',e.target.value)})});
const Dialog=vue.defineComponent({props:['open','title','confirmLabel','backLabel','busy','confirmDisabled'],emits:['confirm','back'],setup:(p,{emit,slots})=>()=>p.open?vue.h('section',{'aria-label':p.title},[...(slots.default?.()??[]),vue.h('button',{disabled:p.busy||p.confirmDisabled,onClick:()=>emit('confirm')},p.confirmLabel),vue.h('button',{onClick:()=>emit('back')},p.backLabel??'Back')]):null});
let serial=0;
async function component(file){
  const url=new URL(`../src/${file}`,import.meta.url),{descriptor}=parse(readFileSync(url,'utf8'));
  const built=compileScript(descriptor,{id:'demoflow',inlineTemplate:true});
  globalThis.__demoflowComponents={UiButton:Button,UiTextInput:Input,Dialog};
  const require=createRequire(import.meta.url);
  const code=built.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,(all,binding,_q,spec)=>{
    if(spec==='capsule-ui-kit/ui')return `const ${binding}=globalThis.__demoflowComponents;`;
    if(spec.endsWith('.vue'))return `const ${binding}=globalThis.__demoflowComponents.Dialog;`;
    return `import ${binding} from ${JSON.stringify(spec==='vue'?pathToFileURL(require.resolve('vue')).href:new URL(spec,url).href)};`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#demoflow${serial++}`)).default;
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
const find=(root,label)=>nodes(root).find(n=>n.tag==='button'&&n.text===label);
const enabled=(root,label)=>{const b=find(root,label);assert.ok(b,`button ${label}`);return !b.props.disabled;};
const press=async(root,label)=>{assert.ok(enabled(root,label),`${label} enabled`);find(root,label).props.onClick();await tick();};
const typeInto=async(root,label,value)=>{nodes(root).find(n=>n.props?.['aria-label']===label).props.onInput({target:{value}});await tick();};
const choose=async root=>{nodes(root).find(n=>n.tag==='select').props['onUpdate:modelValue']('account-a');await tick();};
function fixture(overrides={}){
  const calls=[];
  const host={identity:{list:async()=>({ok:true,rows:[{id:'account-a',label:'Account A'}]})},demo:{}};
  for(const verb of ['start','stop','prompt','check'])host.demo[verb]=async(...args)=>{calls.push([verb,...args]);return overrides[verb]?.(...args)??(verb==='start'?{ok:true,url:'http://127.0.0.1:1234/'}:{ok:true});};
  return {calls,host};
}
async function open(t,overrides){
  const f=fixture(overrides),view=mount(await component('demo/DemoDialog.vue'),{open:true,host:f.host});t.after(view.close);await tick();await choose(view.root);
  return {...f,view,root:view.root};
}

test('invalid ids name the grammar and never reach the host',async t=>{
  const {root,calls}=await open(t);
  for(const bad of ['PPLX Ask 1','Upper','has space','-lead','a'.repeat(41),'under_score']){
    await typeInto(root,'Demo id',bad);
    assert.equal(enabled(root,'Start'),false,`Start refused for ${bad}`);
    assert.match(text(root),/Demo id: use lowercase letters, digits and hyphens/);
  }
  await typeInto(root,'Demo id','ok-1');
  assert.equal(enabled(root,'Start'),true);
  assert.doesNotMatch(text(root),/Demo id: use lowercase/);
  for(const bad of ['Perplexity','a b','a'.repeat(65)]){
    await typeInto(root,'Site name',bad);
    assert.equal(enabled(root,'Check site'),false,`Check refused for ${bad}`);
    assert.match(text(root),/Site: use lowercase letters, digits and hyphens/);
  }
  await typeInto(root,'Site name','a'.repeat(64));
  assert.equal(enabled(root,'Check site'),true);
  assert.deepEqual(calls,[]);
});

test('ids are trimmed before the host call',async t=>{
  const {root,calls}=await open(t);
  await typeInto(root,'Demo id','  demo-1 ');await typeInto(root,'Site name',' site-1  ');
  await press(root,'Start');await press(root,'Stop');await press(root,'Copy prompt');await press(root,'Check site');
  assert.deepEqual(calls,[['start',{identity:'account-a',demo:'demo-1'}],['stop'],['prompt',{demo:'demo-1',site:'site-1'}],['check',{site:'site-1'}]]);
});

test('a recorded demo id is single-use inside the session',async t=>{
  const {root,calls}=await open(t);
  await typeInto(root,'Demo id','demo-1');await press(root,'Start');await press(root,'Stop');
  assert.equal(enabled(root,'Start'),false);
  assert.match(text(root),/already recorded: choose a new one/);
  await typeInto(root,'Demo id','demo-2');
  assert.equal(enabled(root,'Start'),true);
  assert.deepEqual(calls.map(c=>c[0]),['start','stop']);
});

test('Stop states where the private recording is and what it contains',async t=>{
  const {root}=await open(t);
  await typeInto(root,'Demo id','demo-1');await press(root,'Start');
  assert.match(text(root),/press Stop/);
  await press(root,'Stop');
  const shown=text(root);
  assert.match(shown,/~\/\.local\/state\/metaviewer\/demos\/demo-1/);
  assert.match(shown,/\$XDG_STATE_HOME\/metaviewer\/demos\/demo-1/);
  assert.match(shown,/typed text is kept as length only/);
  assert.match(shown,/frames can show field contents/);
});

test('refusals keep the public code and add the next step',async t=>{
  const refuse=async(overrides,drive)=>{
    const {root}=await open(t,overrides);await typeInto(root,'Demo id','demo-1');await typeInto(root,'Site name','site-1');await drive(root);return text(root);
  };
  assert.match(await refuse({start:async()=>({ok:false,code:'DEMO_REFUSED'})},r=>press(r,'Start')),/DEMO_REFUSED: Start refused\. Choose an unused demo id/);
  assert.match(await refuse({stop:async()=>({ok:false,code:'DEMO_REFUSED'})},async r=>{await press(r,'Start');await press(r,'Stop');}),/DEMO_REFUSED: The recording could not be sealed\. Start again with a new demo id/);
  assert.match(await refuse({check:async()=>({ok:false,code:'DEMO_REFUSED'})},r=>press(r,'Check site')),/DEMO_REFUSED: Check failed\. The site folder must exist/);
  assert.match(await refuse({start:async()=>({ok:false,code:'DEMO_BUSY'})},r=>press(r,'Start')),/DEMO_BUSY: Another demo operation is still running/);
  assert.match(await refuse({check:async()=>({ok:false,code:'BUTTON_UNAVAILABLE'})},r=>press(r,'Check site')),/BUTTON_UNAVAILABLE: .*MV_OPERATOR_REPO/);
});

test('a refused Stop releases the dialog so a new id can start',async t=>{
  const {root}=await open(t,{stop:async()=>({ok:false,code:'DEMO_REFUSED'})});
  await typeInto(root,'Demo id','demo-1');await press(root,'Start');await press(root,'Stop');
  assert.equal(enabled(root,'Start'),false,'the failed id stays burned');
  assert.equal(find(root,'Copy prompt').props.disabled,true);
  await typeInto(root,'Demo id','demo-2');
  assert.equal(enabled(root,'Start'),true);
});
