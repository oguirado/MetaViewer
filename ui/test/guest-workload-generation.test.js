import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {guestWorkloadTile,validGuestWorkloadTile} from '../src/wall/guestWorkloadTile.js';
globalThis.Document=class Document {};
const base=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(base+'package.json');
const vue=await import(pathToFileURL(require.resolve('vue')));
const {parse}=await import(pathToFileURL(require.resolve('@vue/compiler-sfc')));
const {compileSfc,rendererElement,nodes,text,flush}=await import(pathToFileURL(base+'test/mvui2-terminal-mount.mjs'));
const values=await import(pathToFileURL(base+'electron/guestCommandValues.js'));
const controls=await import(pathToFileURL(base+'src/wall/rewindStateControls.js'));
const {createCapsulePanelRouter}=await import(pathToFileURL(base+'src/wall/capsulePanelRouter.js'));
const src=readFileSync(base+'src/wall/WallWorkspace.vue','utf8');
const code=parse(src).descriptor.script.content.replace("from 'vue'",`from ${JSON.stringify(pathToFileURL(require.resolve('vue')).href)}`);
const {createWallWorkspaceController}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
function mountComponent(component,initial){
 const props=vue.reactive(initial),root={children:[]};
 const renderer=vue.createRenderer({createElement:tag=>Object.assign(rendererElement(tag),{getRootNode:()=>({activeElement:null}),ownerDocument:{activeElement:null}}),createText:t=>({text:t}),createComment:t=>({text:t}),insert(n,p,anchor){if(n.parent){const a=n.parent.children;const i=a.indexOf(n);if(i>=0)a.splice(i,1);}n.parent=p;const i=anchor?p.children.indexOf(anchor):-1;if(i<0)p.children.push(n);else p.children.splice(i,0,n);},remove(n){const a=n.parent?.children;if(a)a.splice(a.indexOf(n),1);},setText(n,t){n.text=t;},setElementText(n,t){n.text=t;},patchProp(n,k,o,v){n.props[k]=v;},parentNode:n=>n.parent,nextSibling:()=>null,setScopeId(){}});
 const app=renderer.createApp({setup:()=>()=>vue.h(component,props)});app.mount(root);return{app,props,root};
}
const snapshot=(generation,owner_id='actor-one')=>({available:true,busy:false,canCancel:false,uncertain:false,code:null,revision:generation,session:{schema:'guest_command_session/v0.2',workload_id:'workload-one',generation,owner_id,profile_id:'guest-command-arm64-v1',backend:'firecracker',isa:'aarch64',phase:'ready',ownership:'held',jobs_started:0,job:null,controls:{cancel:null,stop:null}},stdout:'',stderr:''});
test('actual wall keeps one owned workload panel across three generation advances',()=>{
 let row=guestWorkloadTile(snapshot(1));const first=row.id,panels=new Map(),added=[];
 const api={panels:[],groups:[],getPanel:id=>panels.get(id),addPanel:p=>{added.push(p);const v={id:p.id,api:{setActive(){}}};panels.set(p.id,v);return v;}};
 const c=createWallWorkspaceController({projectionView:{getProjection:()=>({rows:[]})},workloadTiles:()=>[row],validateWorkloadTile:validGuestWorkloadTile});
 c.handleReady({api,windows:{state:()=>({hidden:false}),show(){},hide(){},float(){},dock(){}},revision:1});
 try {for(const gen of [1,2,3,4]){row=guestWorkloadTile(snapshot(gen));assert.equal(row.id,first);assert.equal(c.revealWorkload(row.id).ok,true);}assert.equal(added.length,1);assert.deepEqual(added[0].params,{sessionId:first});}finally{c.dispose();}
});
test('mounted real command panel retains edits and dispatches current generation; foreign owner fences old route',async()=>{
 const state=vue.reactive({rows:[guestWorkloadTile(snapshot(1))]});const first=state.rows[0].id,actions=[];
 const Panel=await compileSfc('components/GuestCommandPanel.vue',{'../../electron/guestCommandValues.js':values,'../wall/rewindStateControls.js':controls});
 const Router=createCapsulePanelRouter({...vue,graphical:vue.defineComponent({render(){throw Error('graphical');}}),rows:()=>state.rows,validate:validGuestWorkloadTile,slot:({workload})=>vue.h(Panel,{snapshot:workload.snapshot,onAction:a=>actions.push(a)})});
 const m=mountComponent(Router,{params:{params:{sessionId:first}}});
 const byId=id=>nodes(m.root).find(n=>n.props?.id===id);
 try {await flush();byId('guest-command').value='printf retained';byId('guest-command').props['onUpdate:modelValue']('printf retained');byId('guest-cwd').value='workspace';byId('guest-cwd').props['onUpdate:modelValue']('workspace');await flush();
 for(const gen of [2,3,4]){state.rows=[guestWorkloadTile(snapshot(gen))];await flush();assert.equal(byId('guest-command').value,'printf retained');assert.equal(byId('guest-cwd').value,'workspace');nodes(m.root).find(n=>n.tag==='form').props.onSubmit({preventDefault(){}});nodes(m.root).find(n=>n.tag==='button'&&text(n).includes('Stop capsule')).props.onClick();assert.equal(actions.at(-2).generation,gen);assert.equal(actions.at(-2).command_utf8,'printf retained');assert.equal(actions.at(-1).generation,gen);assert.equal(actions.at(-1).op,'stop');}
 state.rows=[guestWorkloadTile(snapshot(4,'actor-foreign'))];await flush();assert.match(text(m.root),/no longer available/);assert.equal(byId('guest-command'),undefined);state.rows=[guestWorkloadTile(snapshot(4)),guestWorkloadTile(snapshot(4))];await flush();assert.match(text(m.root),/no longer available/);
 }finally{m.app.unmount();}
});
test('closed validation refuses forged generation and duplicate/current foreign routing',()=>{
 const tile=guestWorkloadTile(snapshot(2));assert.equal(validGuestWorkloadTile({...tile,generation:1}),false);assert.equal(validGuestWorkloadTile({...tile,extra:true}),false);assert.notEqual(guestWorkloadTile(snapshot(2,'actor-other')).id,tile.id);assert.equal(guestWorkloadTile(snapshot(0)),null);
});
