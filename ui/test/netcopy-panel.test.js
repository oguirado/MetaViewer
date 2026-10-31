// NETWORK-COPY: the per-capsule Network panel against the deployed legacy binary.
// Legacy mode must be explained, every set() outcome must be visible, and the
// dialog must use kit inputs. Host fakes only; no capsule, network or secrets.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
import {exactEgressHost,validEgress} from '../electron/preload.js';
import {allowlistProblem,exactHostname,legacyExplanation,parseAllowlist,plainReason,refusalText} from '../src/netmode/networkCopy.js';

const open={schema:'metaviewer.capsule_egress/v1',mode:'open',domains:[]};
const tick=async()=>{await new Promise(r=>setImmediate(r));await vue.nextTick();};
const Button=vue.defineComponent({props:['label','disabled'],emits:['click'],setup:(p,{emit})=>()=>vue.h('button',{disabled:p.disabled,onClick:()=>emit('click')},p.label)});
const Input=vue.defineComponent({props:['label','modelValue'],emits:['update:modelValue'],setup:(p,{emit})=>()=>vue.h('input',{'aria-label':p.label,value:p.modelValue,onInput:e=>emit('update:modelValue',e.target.value)})});
const Dialog=vue.defineComponent({props:['open','title','confirmLabel','backLabel','busy','confirmDisabled'],emits:['confirm','back'],setup:(p,{emit,slots})=>()=>p.open?vue.h('section',{'aria-label':p.title},[...(slots.default?.()??[]),vue.h('button',{disabled:p.busy||p.confirmDisabled,onClick:()=>emit('confirm')},p.confirmLabel),vue.h('button',{onClick:()=>emit('back')},p.backLabel??'Back')]):null});
let serial=0;
async function panel(){
  const url=new URL('../src/netmode/NetworkPanel.vue',import.meta.url),{descriptor}=parse(readFileSync(url,'utf8'));
  const built=compileScript(descriptor,{id:'netcopy',inlineTemplate:true});
  globalThis.__netcopyComponents={UiButton:Button,UiTextInput:Input,Dialog};
  const require=createRequire(import.meta.url);
  const code=built.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,(_all,binding,_q,spec)=>{
    if(spec==='capsule-ui-kit/ui')return `const ${binding}=globalThis.__netcopyComponents;`;
    if(spec.endsWith('.vue'))return `const ${binding}=globalThis.__netcopyComponents.Dialog;`;
    return `import ${binding} from ${JSON.stringify(spec==='vue'?pathToFileURL(require.resolve('vue')).href:new URL(spec,url).href)};`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${serial++}`)).default;
}
function mount(Component,props){
  const renderer=vue.createRenderer({createElement:tag=>({tag,children:[],props:{}}),createText:text=>({text}),createComment:text=>({text}),
    insert(child,parent,anchor){if(child.parent)this.remove(child);child.parent=parent;const at=parent.children.indexOf(anchor);parent.children.splice(at<0?parent.children.length:at,0,child);},
    remove(child){const list=child.parent?.children;if(list)list.splice(list.indexOf(child),1);},
    setText(n,text){n.text=text;},setElementText(n,text){n.text=text;n.children=[];},patchProp(n,k,_old,value){n.props[k]=value;},parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1]??null,setScopeId(){}});
  const root={children:[]},app=renderer.createApp(Component,props);app.mount(root);return {root,close:()=>app.unmount()};
}
const nodes=n=>[n,...(n.children??[]).flatMap(nodes)];
const text=n=>(n.text??'')+(n.children??[]).map(text).join(' ');
const alerts=root=>nodes(root).filter(n=>n.props?.role==='alert').map(text).join(' | ');
const field=root=>nodes(root).find(n=>n.props?.['aria-label']==='Domain allowlist');
function press(root,label){const found=nodes(root).find(n=>n.tag==='button'&&n.text===label);assert.ok(found,`button ${label}`);assert.ok(!found.props.disabled,`${label} enabled`);found.props.onClick();}
/** Host fake whose get reports the given probe state and whose set is scripted. */
function fakeHost({netMode='legacy',reason='legacy_binary',record=open,set}={}){
  const calls=[];
  return {calls,egress:{get:async v=>{calls.push(['get',v]);return {ok:true,record,net_mode:netMode,reason};},set:async v=>{calls.push(['set',v]);return set?set(v):{ok:true,record:v.record,net_mode:netMode,reason};}}};
}
async function opened(t,host,extra={}){const view=mount(await panel(),{open:true,identity:'account-a',host,...extra});t.after(view.close);await tick();return view;}

test('legacy_binary: says legacy, why, what happens, and what Open and Proxied need, without the raw token',async t=>{
  const view=await opened(t,fakeHost());const shown=text(view.root);
  assert.match(shown,/legacy: legacy \(binary has no network modes\)/);
  assert.match(shown,/capabilities v1 without net_modes/);
  assert.match(shown,/predates network modes/);
  assert.match(shown,/keeps starting with the unrestricted network/);
  assert.match(shown,/Open as an explicit mode needs identity image 0\.2\.0 and the final OpenSuperficies pin/);
  assert.match(shown,/Dedicated proxy needs a binary that lists proxied/);
  assert.doesNotMatch(shown,/legacy_binary|invalid capability reply/);
});

test('every probe reason gets its own cause and never leaks the raw token',async t=>{
  const seen=new Set();
  for(const reason of ['legacy_binary','binary_missing','timeout','oversize','malformed','ok','exit_3']){
    const view=await opened(t,fakeHost({reason}));const shown=text(view.root);
    const paragraph=nodes(view.root).find(n=>n.props?.['data-netcopy']==='legacy-explanation');
    assert.ok(paragraph,`explanation for ${reason}`);seen.add(text(paragraph).split('This capsule')[0]);
    assert.doesNotMatch(shown,/legacy_binary|binary_missing|exit_3|oversize/);
    view.close();
  }
  assert.equal(seen.size,7,'seven distinct causes');
});

test('a non-legacy capsule shows no legacy notice',async t=>{
  const view=await opened(t,fakeHost({netMode:'open',reason:'ok'}));
  assert.doesNotMatch(text(view.root),/legacy|Legacy/);
  assert.equal(nodes(view.root).some(n=>n.props?.['data-netcopy']),false);
});

test('set() never fails silently: each typed refusal is announced and nothing claims success',async t=>{
  for(const code of ['NET_PROXIED_UNSUPPORTED','NET_OPEN_PREREQ','NET_EGRESS_IO','NET_EGRESS_INVALID','IDENTITY_REFUSED','SOMETHING_NEW']){
    const host=fakeHost({set:async()=>({ok:false,code})});const view=await opened(t,host);
    press(view.root,'Save network');await tick();
    assert.ok(alerts(view.root).length>20,`${code} announced`);
    assert.doesNotMatch(text(view.root),/Saved\./);
    if(code==='NET_EGRESS_IO')assert.match(alerts(view.root),/read or written.*permissions/);
    if(code==='SOMETHING_NEW')assert.match(alerts(view.root),/unavailable \(SOMETHING_NEW\)/);
    view.close();
  }
});

test('set() that throws is reported as a failed request, not as a missing identity',async t=>{
  const host=fakeHost({set:async()=>{throw new Error('OPERATOR_PAYLOAD');}});const view=await opened(t,host);
  press(view.root,'Save network');await tick();
  assert.match(alerts(view.root),/failed before the adapter answered; nothing was saved/);
  assert.doesNotMatch(text(view.root),/admitted profile identity/);
});

test('a successful save is confirmed, and the confirmation clears on the next edit',async t=>{
  const view=await opened(t,fakeHost());
  press(view.root,'Save network');await tick();
  assert.match(text(view.root),/Saved\. Applies on the next start of this capsule\./);
  press(view.root,'Dedicated proxy with allowlist');await tick();
  assert.doesNotMatch(text(view.root),/Saved\./);
});

test('a missing identity or channel is named precisely',async t=>{
  const noId=mount(await panel(),{open:true,identity:'',host:fakeHost()});t.after(noId.close);await tick();
  assert.match(alerts(noId.root),/no admitted profile identity/);
  const noChannel=mount(await panel(),{open:true,identity:'account-a',host:{}});t.after(noChannel.close);await tick();
  assert.match(alerts(noChannel.root),/no operator network channel/);
});

test('allowlist: local pre-flight names the problem and never calls the host with a bad list',async t=>{
  const host=fakeHost({netMode:'proxied',reason:'ok'});const view=await opened(t,host);
  press(view.root,'Dedicated proxy with allowlist');await tick();
  press(view.root,'Save network');await tick();
  assert.match(alerts(view.root),/at least one exact hostname/);
  field(view.root).props.onInput({target:{value:'good.example.com, *.example.com'}});await tick();
  press(view.root,'Save network');await tick();
  assert.match(alerts(view.root),/Not an exact hostname: \*\.example\.com/);
  assert.equal(host.calls.filter(c=>c[0]==='set').length,0);
});

test('allowlist: lowercases, de-duplicates, accepts commas and spaces, and echoes the saved list',async t=>{
  const host=fakeHost({netMode:'proxied',reason:'ok'});const view=await opened(t,host);
  press(view.root,'Dedicated proxy with allowlist');await tick();
  field(view.root).props.onInput({target:{value:' Example.com,b.example.org  example.com '}});await tick();
  press(view.root,'Save network');await tick();
  const sent=host.calls.find(c=>c[0]==='set')[1];
  assert.deepEqual(sent.record,{schema:'metaviewer.capsule_egress/v1',mode:'allowlisted',domains:['example.com','b.example.org']});
  assert.equal(validEgress(sent.record),true);
  assert.equal(field(view.root).props.value,'example.com, b.example.org');
  assert.match(text(view.root),/Saved\./);
});

test('an open save sends no domains even when the allowlist field held text',async t=>{
  const host=fakeHost({netMode:'proxied',reason:'ok'});const view=await opened(t,host);
  press(view.root,'Dedicated proxy with allowlist');await tick();
  field(view.root).props.onInput({target:{value:'keep.example.com'}});await tick();
  press(view.root,'Open (default)');await tick();
  press(view.root,'Save network');await tick();
  assert.deepEqual(host.calls.find(c=>c[0]==='set')[1].record,open);
});

test('mode choice is a kit button pair with pressed state',async t=>{
  const view=await opened(t,fakeHost());
  const pressed=label=>nodes(view.root).find(n=>n.tag==='button'&&n.text===label).props['aria-pressed'];
  assert.equal(pressed('Open (default)'),true);assert.equal(pressed('Dedicated proxy with allowlist'),false);
  press(view.root,'Dedicated proxy with allowlist');await tick();
  assert.equal(pressed('Open (default)'),false);assert.equal(pressed('Dedicated proxy with allowlist'),true);
  assert.equal(nodes(view.root).some(n=>n.tag==='textarea'||n.props?.type==='radio'),false);
});

test('the SFC uses kit components only: no native radio, textarea or input element',()=>{
  const source=readFileSync(new URL('../src/netmode/NetworkPanel.vue',import.meta.url),'utf8');
  assert.doesNotMatch(source,/<(input|textarea|select)\b/i);
  assert.doesNotMatch(source,/type="radio"/);
  assert.match(source,/import \{[^}]*UiTextInput[^}]*\} from 'capsule-ui-kit\/ui'/);
});

test('legacy notice and form belong to the current identity: a failed reload drops the previous capsule state',async t=>{
  const id=vue.ref('account-a'),failing={on:false};
  const host={egress:{get:async()=>failing.on?{ok:false,code:'NET_EGRESS_IO'}:{ok:true,record:{schema:'metaviewer.capsule_egress/v1',mode:'allowlisted',domains:['a.example.com']},net_mode:'legacy',reason:'legacy_binary'},set:async()=>({ok:false,code:'NET_EGRESS_IO'})}};
  const Panel=await panel();
  const view=mount(vue.defineComponent({setup:()=>()=>vue.h(Panel,{open:true,identity:id.value,host})}),{});t.after(view.close);await tick();
  assert.match(text(view.root),/Legacy network mode/);assert.equal(field(view.root).props.value,'a.example.com');
  failing.on=true;id.value='account-b';await tick();
  assert.doesNotMatch(text(view.root),/Legacy network mode|legacy:/);
  assert.match(alerts(view.root),/NET_EGRESS_IO/);
  assert.equal(nodes(view.root).some(n=>n.props?.['aria-label']==='Domain allowlist'),false,'previous allowlist is gone');
  assert.equal(nodes(view.root).find(n=>n.tag==='button'&&n.text==='Save network').props.disabled,true);
});

test('copy helpers: hostname rules match the host validator exactly',()=>{
  const corpus=['example.com','a.b.example.co.uk','EXAMPLE.com','localhost','x.local','x.internal','x.lan','home.arpa','x.home.arpa','127.0.0.1','0x7f.0.0.1','a..b.com','-a.example.com','a-.example.com','a_b.example.com','*.example.com','example.com.','exa mple.com','','1.2.3.4','xn--bcher-kva.example','a'.repeat(63)+'.com','a'.repeat(64)+'.com',('a'.repeat(60)+'.').repeat(4)+'com','0xff.example.com',42,null,undefined];
  for(const h of corpus)assert.equal(exactHostname(h),exactEgressHost(h),`parity for ${String(h)}`);
  for(const list of [[],['example.com'],Array(256).fill(0).map((_,i)=>`h${i}.example.com`),Array(257).fill(0).map((_,i)=>`h${i}.example.com`),['bad host.com'],['127.0.0.1']])
    assert.equal(allowlistProblem(list)==='',validEgress({schema:'metaviewer.capsule_egress/v1',mode:'allowlisted',domains:list}),`list parity ${list.length}`);
  assert.deepEqual(parseAllowlist(' A.com;b.com\n a.com , '),['a.com','b.com']);
  assert.match(allowlistProblem(['x'.repeat(300)]),/…/);
  assert.equal(plainReason('exit_7'),'capability probe exited with status 7');
  assert.equal(plainReason('whatever'),'capability probe unavailable');
  assert.match(legacyExplanation('exit_9'),/exited with status 9/);
  assert.match(legacyExplanation('zzz'),/was unavailable/);
  assert.equal(refusalText('lowercase'),'Network configuration unavailable.');
  assert.equal(refusalText(undefined),'Network configuration unavailable.');
});

test('NET-01: the Open prerequisite under a legacy binary names the real cause and what confirming does',async t=>{
  const host=fakeHost({set:async v=>v.confirm===true?{ok:true,record:v.record,net_mode:'legacy',reason:'legacy_binary'}:{ok:false,code:'NET_OPEN_PREREQ'}});
  const view=await opened(t,host);
  press(view.root,'Save network');await tick();
  const shown=alerts(view.root);
  assert.match(shown,/NET_OPEN_PREREQ.*image 0\.2\.0.*final OpenSuperficies pin/);
  assert.match(shown,/predates network modes/);
  assert.match(shown,/Open is already how a legacy capsule starts, so confirming only records the choice/);
  assert.doesNotMatch(shown,/legacy_binary/);
  press(view.root,'Confirm save for next start anyway');await tick();
  assert.match(text(view.root),/Saved\./);assert.equal(alerts(view.root),'');
});

test('NET-01: outside legacy mode the prerequisite text carries no legacy cause',()=>{
  assert.doesNotMatch(refusalText('NET_OPEN_PREREQ'),/predates|legacy/);
  assert.match(refusalText('NET_OPEN_PREREQ','timeout'),/did not answer in time/);
});

test('NET-03: a stored allowlist under a legacy binary warns before the refused start, and recovery clears it',async t=>{
  const proxy={schema:'metaviewer.capsule_egress/v1',mode:'allowlisted',domains:['a.example.com']};
  const host=fakeHost({record:proxy,set:async v=>v.confirm===true?{ok:true,record:v.record,net_mode:'legacy',reason:'legacy_binary'}:{ok:false,code:'NET_OPEN_PREREQ'}});
  const view=await opened(t,host);
  const warning=()=>nodes(view.root).find(n=>n.props?.['data-netcopy']==='stored-allowlist');
  assert.ok(warning(),'warning present');assert.match(text(warning()),/NET_PROXIED_UNSUPPORTED.*Choose Open and save it/);
  press(view.root,'Open (default)');await tick();assert.ok(warning(),'warning tracks the stored record, not the edit');
  press(view.root,'Save network');await tick();press(view.root,'Confirm save for next start anyway');await tick();
  assert.equal(warning(),undefined,'warning gone once Open is stored');
});

test('NET-03: no warning for a stored open record or for a binary that can enforce the allowlist',async t=>{
  const proxy={schema:'metaviewer.capsule_egress/v1',mode:'allowlisted',domains:['a.example.com']};
  for(const host of [fakeHost(),fakeHost({netMode:'proxied',reason:'ok',record:proxy})]){
    const view=await opened(t,host);
    assert.equal(nodes(view.root).some(n=>n.props?.['data-netcopy']==='stored-allowlist'),false);view.close();
  }
});
