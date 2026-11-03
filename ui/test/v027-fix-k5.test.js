import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installRoleHost,listHostWindows} from '../electron/roleHost.js';

let roleSurfaceSerial=0;
const walkNodes = node => [node,...(node.children || []).flatMap(walkNodes)];
const nodeText = node => [node.text || '',...(node.children || []).map(nodeText)].join(' ');
async function compileRoleSurface(source) {
  const { descriptor } = parse(source);
  let code = compileScript(descriptor, { id: 'v025-rs-' + (++roleSurfaceSerial), inlineTemplate: true }).content;
  code = code.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
  code = code.replace(/^import\s+(.+?)\s+from\s+(['"])(.*?)\2;?/gm, (line, _binding, _q, path) =>
    path === 'vue' ? line.replace(/(['"])vue\1/, JSON.stringify(import.meta.resolve('vue'))) : line);
  return (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64') + '#' + roleSurfaceSerial)).default;
}

function mountRoleSurface(Component, props = {}, providers = {}, slots = {}) {
  const node = (tag) => ({
    tag,
    children: [],
    props: {},
    parent: null,
    style: {},
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 700, height: 500 }),
    getClientRects: () => [1],
  });
  const renderer = vue.createRenderer({
    createElement: node,
    createText: (value) => ({ ...node('#text'), text: value }),
    createComment: () => node('#comment'),
    setText(n, value) { n.text = value; },
    setElementText(n, value) { n.text = value; n.children = []; },
    patchProp(n, key, _previous, value) { n.props[key] = value; },
    insert(n, parent, anchor) {
      if (n.parent) this.remove(n);
      n.parent = parent;
      const at = parent.children.indexOf(anchor);
      parent.children.splice(at < 0 ? parent.children.length : at, 0, n);
    },
    remove(n) {
      if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
      n.parent = null;
    },
    parentNode: (n) => n.parent,
    nextSibling: (n) => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
    setScopeId() {},
    querySelector: () => null,
  });
  const root = node('root');
  const app = renderer.createApp({ render: () => vue.h(Component, props, slots) });
  for (const [key, value] of Object.entries(providers)) app.provide(key, value);
  app.mount(root);
  return { root, app };
}


const picked={xid:123,witness:'123:1',title:'Window',program:'xeyes',width:640,height:480};
test('attached window status follows native minimize and restore without changing frozen surface or losing Stop',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mv-k5-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let minimized=false,visible=true,witness=picked.witness;
 const listWindows=(options={})=>listHostWindows({env:{MV_SRF_BIN_DIR:root},...options,
  runTool:(_tool,_args,_opts,cb)=>cb(null,JSON.stringify([{...picked,witness,minimized,visible}]),'')});
 const handlers=new Map(),states=new Map();
 const parent=new EventEmitter();parent.webContents={session:{registerPreloadScript:()=> 'p',unregisterPreloadScript(){}}};
 const host=installRoleHost({electron:{ipcMain:{handle:(k,fn)=>handlers.set(k,fn),removeHandler:k=>handlers.delete(k)}},window:parent,
  env:{MV_SRF_PROFILES:JSON.stringify({'mv-live-1':{Kind:'browser',NativeKind:'browser',Width:1280,Height:900,RAMRoot:'/dev/shm',Display:':111'}}),MV_SRF_STATE_DIR:root},capsuleStates:states,
  stageMode:async()=>async()=>{},admit:()=>true,listIdentities:async()=>({ok:true,rows:[]}),listWindows,
  core:{getHumanSurface:id=>states.get(id),request:async req=>{
   const surface={schema:'surface/v0.2',surface_id:'window-k5',profile_id:req.params.profile_id,kind:'desktop_capsule',geometry:req.params.geometry,state:'active',control:'agent',visibility:'unfolded',display:':0'};
   states.set(surface.surface_id,surface);return {schema:'surface_event/v0.2',event:'created',data:{surface}};
  },stopSurface:async id=>{
   const surface={...states.get(id),state:'destroyed'};states.set(id,surface);
   return {schema:'surface_event/v0.2',event:'state_changed',data:{surface}};
  }}});
 t.after(()=>host.dispose());
 const invoke=(op,extra={})=>handlers.get('metaviewer:roles.v0.3')({}, {schema:'metaviewer.roles/v0.3',op,...extra});
 const first=await invoke('create-window',{choice:picked});assert.equal(first.ok,true);
 const status=()=>invoke('status',{surfaceId:first.surfaceId});
 assert.equal((await status()).hostWindow.minimized,false);
 const prior=globalThis.metaviewerRoles;
 globalThis.metaviewerRoles={status:async()=>status(),close:async()=>({ok:true}),detachWindow:surfaceId=>invoke('stop',{surfaceId}),listWindows:async()=>listWindows()};
 t.after(()=>{globalThis.metaviewerRoles=prior;});
 const component=await compileRoleSurface(readFileSync(new URL('../src/surfaces/RoleSurface.vue',import.meta.url),'utf8'));
 const mounted=mountRoleSurface(component,{surfaceId:first.surfaceId,control:'agent'});
 t.after(()=>mounted.app.unmount());
 const waitFor=async predicate=>{
  const deadline=Date.now()+2000;
  while(!predicate()) {assert.ok(Date.now()<deadline,'tile did not follow native state');await new Promise(r=>setTimeout(r,10));await vue.nextTick();}
 };
 await waitFor(()=>walkNodes(mounted.root).some(n=>n.props?.class==='mv-role-agent-canvas'));

 minimized=true;visible=false;
 assert.deepEqual(await listWindows(),[],'minimized windows remain unavailable for attachment');
 assert.equal((await status()).hostWindow.minimized,true);
 await waitFor(()=>/Window minimized/.test(nodeText(mounted.root)));
 assert.equal(walkNodes(mounted.root).find(n=>n.props?.class==='mv-role-agent-canvas').props.style.visibility,'hidden');

 assert.equal((await status()).hostWindow.state,'active');
 assert.equal((await invoke('surfaces'))[0].hostWindow.minimized,true);
 assert.equal(Object.hasOwn(states.get(first.surfaceId),'minimized'),false);
 witness='replacement';minimized=false;visible=true;
 assert.equal((await status()).hostWindow.minimized,true,'another witness cannot clear the waiting state');
 witness=picked.witness;
 assert.equal((await status()).hostWindow.minimized,false);
 await waitFor(()=>!/Window minimized/.test(nodeText(mounted.root)));
 assert.equal(walkNodes(mounted.root).find(n=>n.props?.class==='mv-role-agent-canvas').props.style.visibility,undefined);
 states.set(first.surfaceId,{...states.get(first.surfaceId),state:'lost'});
 const closed=await status();assert.equal(closed.hostWindow.state,'lost');assert.match(closed.hostWindow.lostReason,/Window closed/);
 await waitFor(()=>/Window closed/.test(nodeText(mounted.root)));
 const stop=walkNodes(mounted.root).find(n=>n.props?.id===`tile-host-stop-${first.surfaceId}`);
 await stop.props.onClick({stopPropagation(){}});
 assert.equal(states.get(first.surfaceId).state,'destroyed');
});
