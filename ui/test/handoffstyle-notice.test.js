// HANDOFF-STYLE: handoff rows and the notice own their classes; refusals use
// the refusal tone; the list is content-sized. Every guard ships a mutant.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';

const SFC_URL=new URL('../src/handoff/HandoffNotice.vue',import.meta.url);
const CSS_URL=new URL('../src/handoff/handoff.css',import.meta.url);
const sfc=readFileSync(SFC_URL,'utf8'),css=readFileSync(CSS_URL,'utf8');
const base={schema:'metaviewer.handoff/v1',surface_id:'surface-1',step_index:3,reason:'captcha_wall',confidence:100,evidence_kinds:['ax_role_name']};
const login={...base,surface_id:'surface-2',step_index:0,reason:'login_wall'};
const tick=async()=>{await new Promise(r=>setImmediate(r));await vue.nextTick();};
const Button=vue.defineComponent({props:['label'],emits:['click'],setup:(p,{emit})=>()=>vue.h('button',{onClick:()=>emit('click')},p.label)});
let serial=0;
async function notice(source=sfc){
  const {descriptor}=parse(source);
  const built=compileScript(descriptor,{id:'handoff-style',inlineTemplate:true});
  globalThis.__handoffKit={UiButton:Button};
  const require=createRequire(import.meta.url);
  const code=built.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,(_all,binding,_q,spec)=>{
    if(spec==='capsule-ui-kit/ui')return `const ${binding}=globalThis.__handoffKit;`;
    return `import ${binding} from ${JSON.stringify(spec==='vue'?pathToFileURL(require.resolve('vue')).href:new URL(spec,SFC_URL).href)};`;
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
const all=n=>[n,...(n.children??[]).flatMap(all)];
const withClass=(root,name)=>all(root).filter(n=>typeof n.props?.class==='string'&&n.props.class.split(/\s+/).includes(name));
const classesOf=root=>all(root).flatMap(n=>typeof n.props?.class==='string'?n.props.class.split(/\s+/):[]);
const hostFor=(rows,extra={})=>({handoff:{list:async()=>({ok:true,rows}),subscribe:()=>()=>{},ack:async()=>({ok:true}),...extra}});

/** Rule body of the first rule whose selector is exactly `selector`. */
function ruleBody(source,selector){
  const m=source.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*\\{([^}]*)\\}`));
  assert.ok(m,`rule ${selector} present`);return m[1];
}
/** Fail-closed CSS predicates; each one is exercised against a planted mutant below. */
function assertOwnClassesOnly(source,label){
  assert.doesNotMatch(source,/mv-activity/,`${label}: no generic activity class`);
}
function assertContentSizedList(source){
  const body=ruleBody(source,'.mv-handoff__list');
  assert.doesNotMatch(body,/(?<![-\w])height\s*:/,'list has no fixed height');
  assert.match(body,/max-height\s*:/,'list is capped, not reserved');assert.match(body,/overflow\s*:\s*auto/,'list scrolls past the cap');
}
function assertRefusalNotSuccess(source){
  assert.doesNotMatch(source,/status-success/,'no success tone anywhere in handoff styles');
  assert.match(ruleBody(source,".mv-handoff__row[data-handoff-tone='refusal']::before"),/background\s*:\s*var\(--cuk-semantic-status-error-border\)/,'refusal marker uses the error border token');
  assert.doesNotMatch(ruleBody(source,'.mv-handoff__row::before'),/status-(success|error)/,'default marker is neutral');
}
function assertTokenOnlyCss(source,label){
  assert.doesNotMatch(source,/#[0-9a-fA-F]{3,8}\b/,`${label}: no hex literal`);
  assert.doesNotMatch(source,/\b(?:rgba?|hsla?)\(/,`${label}: no colour function`);
  assert.doesNotMatch(source,/@import|@font-face|\burl\(/,`${label}: no remote or font load`);
  assert.ok(source.includes('var(--cuk-'),`${label}: builds on kit tokens`);
}
function assertNoInlineStyleVector(source,label){
  assert.doesNotMatch(source,/\bstyle\s*=/,`${label}: no style attribute`);
  assert.doesNotMatch(source,/:style\b|v-bind:style/,`${label}: no style binding`);
  assert.doesNotMatch(source,/\.style\b|setAttribute\(\s*['"]style['"]/,`${label}: no element.style write`);
}

test('handoff rows and the notice use handoff classes, never the generic activity ones',async t=>{
  const view=mount(await notice(),{host:hostFor([base,login])});t.after(view.close);await tick();
  const seen=classesOf(view.root);
  for(const name of ['mv-handoff','mv-handoff__list','mv-handoff__row','mv-handoff__steps','mv-handoff__actions'])assert.ok(seen.includes(name),`${name} rendered`);
  assert.deepEqual(seen.filter(c=>c.startsWith('mv-activity')),[],'no mv-activity class in the rendered tree');
  assert.equal(withClass(view.root,'mv-handoff__row').length,2,'one handoff row per notice');
  assert.equal(withClass(view.root,'mv-handoff__actions').length,2,'actions grouped per row');
  assert.doesNotMatch(sfc,/mv-activity/,'SFC source names no activity class');
});

test('every handoff row carries the refusal tone, which is not the success dot',async t=>{
  const view=mount(await notice(),{host:hostFor([base,login])});t.after(view.close);await tick();
  const rows=withClass(view.root,'mv-handoff__row');
  assert.equal(rows.length,2);
  for(const row of rows)assert.equal(row.props['data-handoff-tone'],'refusal');
  assertRefusalNotSuccess(css);
});

test('an unavailable list shows only the alert, with no empty list box reserved',async t=>{
  const view=mount(await notice(),{host:hostFor([],{list:async()=>({ok:false,code:'HANDOFF_UNAVAILABLE'})})});t.after(view.close);await tick();
  const alert=withClass(view.root,'mv-handoff__error');
  assert.equal(alert.length,1);assert.equal(alert[0].props.role,'alert');
  assert.equal(withClass(view.root,'mv-handoff__list').length,0,'no list while there are no rows');
  assert.equal(withClass(view.root,'mv-handoff__row').length,0);
});

test('with no handoff host the notice renders nothing',async t=>{
  const view=mount(await notice(),{host:{}});t.after(view.close);await tick();
  assert.equal(classesOf(view.root).filter(c=>c.startsWith('mv-handoff')).length,0);
});

test('handoff styles are own-class, content-sized, tone-correct, token-only and CSP-clean',()=>{
  assertOwnClassesOnly(css,'handoff.css');assertContentSizedList(css);assertRefusalNotSuccess(css);
  assertTokenOnlyCss(css,'handoff.css');
  assertNoInlineStyleVector(css,'handoff.css');assertNoInlineStyleVector(sfc,'HandoffNotice.vue');
  assert.match(sfc,/<style\s+src="\.\/handoff\.css"\s*>\s*<\/style>/,'SFC links its own stylesheet');
});

test('negative control: each planted defect fails its own predicate',()=>{
  const A=assert.AssertionError;
  assert.throws(()=>assertOwnClassesOnly('.mv-activity__list{margin:0}','planted'),A,'generic class reused');
  assert.throws(()=>assertContentSizedList(css.replace('max-height: 40vh;','height: 132px;')),A,'fixed 132px list');
  assert.throws(()=>assertContentSizedList(css.replace('max-height: 40vh;','max-height: 40vh;\n  height: 40vh;')),A,'fixed height beside the cap');
  assert.throws(()=>assertContentSizedList(css.replace('max-height: 40vh;','')),A,'uncapped list');
  assert.throws(()=>assertRefusalNotSuccess(css.replace(/(\.mv-handoff__row::before \{[^}]*background: )var\(--cuk-semantic-border-default\)/,'$1var(--cuk-semantic-status-success-border)')),A,'green default dot');
  assert.throws(()=>assertRefusalNotSuccess(css.replace(/(data-handoff-tone='refusal'\]::before \{\s*background: )var\(--cuk-semantic-status-error-border\)/,'$1var(--cuk-semantic-border-default)')),A,'refusal tone lost');
  for(const planted of ['.a{color:#fff}','.a{color:rgb(1,2,3)}','.a{color:hsl(1,2%,3%)}','@import url("x.css")','.a{background:url(x.png)}','.a{color:red}'])
    assert.throws(()=>assertTokenOnlyCss(planted,'planted'),A,planted);
  for(const planted of ['<li style="color:red">','<li :style="s">','el.style.display="none"',"el.setAttribute('style','x')"])
    assert.throws(()=>assertNoInlineStyleVector(planted,'planted'),A,planted);
});

test('negative control: mutated SFCs are caught by the rendered-tree checks',async t=>{
  const leak=mount(await notice(sfc.replace('class="mv-handoff__row"','class="mv-activity__row"')),{host:hostFor([base])});t.after(leak.close);await tick();
  assert.ok(classesOf(leak.root).some(c=>c.startsWith('mv-activity')),'generic class reuse is visible to the class scan');
  assert.equal(withClass(leak.root,'mv-handoff__row').length,0);
  const toneless=mount(await notice(sfc.replace(' data-handoff-tone="refusal"','')),{host:hostFor([base])});t.after(toneless.close);await tick();
  const row=withClass(toneless.root,'mv-handoff__row')[0];
  assert.ok(row);assert.notEqual(row.props['data-handoff-tone'],'refusal','a row without the tone attribute is detected');
  const listed=mount(await notice(sfc.replace('<ol v-if="rows.length" class','<ol class')),{host:hostFor([],{list:async()=>({ok:false})})});t.after(listed.close);await tick();
  assert.equal(withClass(listed.root,'mv-handoff__list').length,1,'an unconditional list box is detected');
});
