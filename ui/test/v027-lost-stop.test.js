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

// [TARGET, unit decision] Lost agent windows close presentation via the existing
// mode event; no destroy request or synthetic stopped receipt is authorized.
for (const [state, control] of [['lost','agent'], ['active','agent'], ['lost','human']]) {
 test(`lost-stop escape ${state}/${control}`,async t=>{
  const prior=globalThis.metaviewerRoles;
  const modes=[],stopped=[];let detached=0,closed=0;
  globalThis.metaviewerRoles={status:async()=>({role:'agent',control,view:{state:'closed'},hostWindow:{state,xid:123,witness:'123:1',title:'program',program:'program',lostReason:state==='lost'?'Window closed':null}}),close:async()=>{closed++;return {ok:true};},detachWindow:async()=>{detached++;return control==='agent' && state==='lost'?{ok:false,code:'POLICY'}:{ok:true};},listWindows:async()=>control==='agent'?[{xid:123,witness:'123:1'}]:[]};
  t.after(()=>{globalThis.metaviewerRoles=prior;});
  const component=await compileRoleSurface(readFileSync(new URL('../src/surfaces/RoleSurface.vue',import.meta.url),'utf8'));
  const mounted=mountRoleSurface(component,{surfaceId:'escape',control,onMode:e=>modes.push(e),onStopped:e=>stopped.push(e)});
  t.after(()=>mounted.app.unmount());
  await new Promise(r=>setTimeout(r,40));await vue.nextTick();
  const button=walkNodes(mounted.root).find(n=>n.props?.id==='tile-host-stop-escape');
  assert.ok(button);
  if(state==='lost' && control==='agent') {
   assert.equal(nodeText(button).trim(),'Close tile');
   assert.equal(walkNodes(mounted.root).some(n=>n.tag==='button' && nodeText(n).trim()==='Reopen'),false,'Reopen also requires forbidden destroy');
   assert.match(nodeText(mounted.root),/Close tile to remove it from this workspace/);
   const menu=walkNodes(mounted.root).find(n=>n.props?.id==='tile-menu-escape');
   menu.props.onClick();await vue.nextTick();
   const menuClose=walkNodes(mounted.root).find(n=>n.props?.id==='tile-stop-escape');
   assert.equal(nodeText(menuClose).trim(),'Close tile','menu must not retain the forbidden Stop action');
   await button.props.onClick({stopPropagation(){}});await vue.nextTick();
   assert.equal(detached,0,'local close must not request forbidden destroy');
   assert.ok(closed>0,'native view resources must be released');
   assert.ok(modes.some(e=>e.surfaceId==='escape' && e.mode==='closed'),'existing presentation close event must reach the parent');
   assert.deepEqual(stopped,[],'local close must not claim backend destruction');
  } else {
   assert.equal(nodeText(button).trim(),'Stop');
   await button.props.onClick({stopPropagation(){}});
   assert.equal(detached,1,'admitted Stop must retain its destroy receipt');
   assert.deepEqual(stopped,['escape']);
  }
 });
}
