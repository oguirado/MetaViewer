import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
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

test('window close after take-control polls an unmounted native view and retains Stop',async t=>{
 const prior=globalThis.metaviewerRoles;
 let state='active', control='agent', polls=0, detached=0;
 const props=vue.reactive({surfaceId:'closed',control});
 const host={xid:123,witness:'123:1',title:'xeyes',program:'xeyes',minimized:false};
 globalThis.metaviewerRoles={status:async()=>{polls++;return {role:'agent',control,view:{state:'closed'},hostWindow:{...host,state,lostReason:state==='lost'?'Window closed — capsule tile ended.':null}};},close:async()=>({ok:true}),detachWindow:async()=>{detached++;return {ok:true};},listWindows:async()=>[]};
 t.after(()=>{globalThis.metaviewerRoles=prior;});
 const component=await compileRoleSurface(readFileSync(new URL('../src/surfaces/RoleSurface.vue',import.meta.url),'utf8'));
 const mounted=mountRoleSurface(component,props);
 t.after(()=>mounted.app.unmount());
 await new Promise(r=>setTimeout(r,40));
 assert.ok(walkNodes(mounted.root).some(n=>n.props?.id==='tile-host-stop-closed'));
 assert.ok(walkNodes(mounted.root).some(n=>n.props?.class==='mv-role-agent-canvas'));
 control='human';props.control='human';await vue.nextTick();
 state='lost';
 await new Promise(r=>setTimeout(r,180));await vue.nextTick();
 assert.ok(polls>=2);
 assert.match(nodeText(mounted.root),/Window closed/);
 const nodes=walkNodes(mounted.root);
 assert.equal(nodeText(nodes.find(n=>n.props?.class==='mv-role-mode-badge')).trim(),'Window closed');
 assert.equal(nodes.some(n=>n.tag==='button' && nodeText(n).trim()==='Reopen'),false,'a destroyed witness cannot be reopened');
 assert.equal(walkNodes(mounted.root).some(n=>n.props?.class==='mv-role-agent-canvas'),false,'lost canvas must leave layout so the closed message fits inside the clipped viewport');
 const stop=walkNodes(mounted.root).find(n=>n.props?.id==='tile-host-stop-closed');
 await stop.props.onClick({stopPropagation(){}});assert.equal(detached,1);
});
