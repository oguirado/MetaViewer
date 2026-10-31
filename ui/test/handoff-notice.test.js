import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
import {createHandoffModel,describeHandoff,HANDOFF_STEPS} from '../src/handoff/handoffModel.js';
const base={schema:'metaviewer.handoff/v1',surface_id:'surface-1',step_index:3,reason:'captcha_wall',confidence:100,evidence_kinds:['ax_role_name']};
const login={...base,surface_id:'surface-2',step_index:0,reason:'login_wall'};
const REASONS=['google_sorry','recaptcha_v2','turnstile_challenge','cloudflare_challenge','unusual_traffic','login_wall','captcha_wall'];
const tick=async()=>{await new Promise(r=>setImmediate(r));await vue.nextTick();};
const Button=vue.defineComponent({props:['label'],emits:['click'],setup:(p,{emit})=>()=>vue.h('button',{onClick:()=>emit('click')},p.label)});
let serial=0;
async function notice(){
  const url=new URL('../src/handoff/HandoffNotice.vue',import.meta.url),{descriptor}=parse(readFileSync(url,'utf8'));
  const built=compileScript(descriptor,{id:'handoff-notice',inlineTemplate:true});
  globalThis.__handoffKit={UiButton:Button};
  const require=createRequire(import.meta.url);
  const code=built.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,(_all,binding,_q,spec)=>{
    if(spec==='capsule-ui-kit/ui')return `const ${binding}=globalThis.__handoffKit;`;
    return `import ${binding} from ${JSON.stringify(spec==='vue'?pathToFileURL(require.resolve('vue')).href:new URL(spec,url).href)};`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default;
}
function mount(Component,props){
  const renderer=vue.createRenderer({createElement:tag=>({tag,props:{},children:[],parent:null}),createText:text=>({text}),createComment:text=>({text}),
    insert(child,parent,anchor){if(child.parent)this.remove(child);child.parent=parent;const at=parent.children.indexOf(anchor);parent.children.splice(at<0?parent.children.length:at,0,child);},
    remove(child){const list=child.parent?.children;if(list)list.splice(list.indexOf(child),1);},
    setText(n,text){n.text=text;},setElementText(n,text){n.text=text;n.children=[];},patchProp(n,k,_old,value){n.props[k]=value;},parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1]??null,setScopeId(){}});
  const root={children:[]},app=renderer.createApp(Component,props);app.mount(root);return {root,close:()=>app.unmount()};
}
const text=n=>(n.text??'')+(n.children??[]).map(text).join(' ');
const hostFor=(rows,extra={})=>({handoff:{list:async()=>({ok:true,rows}),subscribe:()=>()=>{},ack:async()=>({ok:true}),...extra}});

test('captcha notice names the tile and tells the operator every step, in order',async t=>{
  const view=mount(await notice(),{host:hostFor([base])});t.after(view.close);await tick();
  const shown=text(view.root);
  assert.match(shown,/CAPTCHA or bot check: solve it in the capsule, then re-run/);
  assert.match(shown,/surface-1, step 3: CAPTCHA/);
  assert.doesNotMatch(shown,/captcha_wall|ax_role_name/);
  const at=[/Take control/,/WRITE/,/yourself/,/Release control/,/Re-run the workflow/].map(r=>shown.search(r));
  assert.ok(at.every(i=>i>=0),`all steps present ${at}`);
  assert.deepEqual([...at].sort((a,b)=>a-b),at,'steps appear in operator order');
  assert.match(shown,/never does it for you/);assert.match(shown,/does not resume the run/);
});
test('login wall is not worded as a CAPTCHA',async t=>{
  const view=mount(await notice(),{host:hostFor([login])});t.after(view.close);await tick();
  const shown=text(view.root);
  assert.match(shown,/Login required: sign in yourself in the capsule, then re-run/);
  assert.match(shown,/surface-2, step 0: login wall/);
  assert.doesNotMatch(shown,/CAPTCHA or bot check/);
});
test('every closed reason has a plain label and a headline',()=>{
  for(const reason of REASONS){
    const d=describeHandoff({...base,reason});
    assert.doesNotMatch(d.detail,/stop for the operator/,reason);assert.doesNotMatch(d.detail,/_/,reason);
    assert.equal(d.steps,HANDOFF_STEPS);
    assert.match(d.headline,reason==='login_wall'?/^Login required/:/^CAPTCHA or bot check/);
  }
});
test('a failed or malformed list is shown as unavailable, never as an empty idle state',async t=>{
  for(const list of [async()=>({ok:false,code:'HANDOFF_UNAVAILABLE'}),async()=>({ok:true}),async()=>{throw new Error('ipc');}]){
    const view=mount(await notice(),{host:hostFor([],{list})});t.after(view.close);await tick();
    assert.match(text(view.root),/Handoff notifications unavailable\./);
  }
  const model=createHandoffModel({list:async()=>({ok:false,code:'HANDOFF_UNAVAILABLE'}),ack:async()=>({ok:true})});
  model.receive({ok:true,rows:[base]});
  await assert.rejects(model.load(),/HANDOFF_UNAVAILABLE/);assert.equal(model.rows().length,1,'a held row survives a failed list');
});
test('an unavailable list does not hide a row already delivered by subscription',async t=>{
  let push;
  const host=hostFor([],{list:async()=>({ok:false,code:'HANDOFF_UNAVAILABLE'}),subscribe:cb=>{push=cb;return()=>{};}});
  const view=mount(await notice(),{host});t.after(view.close);await tick();
  push({ok:true,rows:[base]});await tick();
  assert.match(text(view.root),/CAPTCHA or bot check/);assert.match(text(view.root),/unavailable/);
});
test('a subscribe that returns no unsubscribe does not break unmount',async()=>{
  const host=hostFor([base],{subscribe:()=>undefined});
  const view=mount(await notice(),{host});await tick();
  assert.match(text(view.root),/surface-1/);
  assert.doesNotThrow(()=>view.close());
});
