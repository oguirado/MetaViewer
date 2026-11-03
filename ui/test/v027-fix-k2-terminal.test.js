import test from 'node:test';
import assert from 'node:assert/strict';
function storage(raw) { return {getItem:()=>raw,setItem(){}}; }
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import * as deckModel from '../src/terminal/terminalDeckModel.js';
import {createPairedTerminals} from '../src/terminal/pairedTerminals.js';
import vm from 'node:vm';

let viewSerial = 0;
function loadView(mutate = source => source, model = deckModel) {
  const source = mutate(readFileSync(new URL('../src/terminal/TerminalDeckView.vue', import.meta.url), 'utf8'))
    .replace('defineExpose({', 'defineExpose({ pendingSessionOutput, onWindowKeyDown, onTileKeyDown, mountedTerminals,');
  const { descriptor } = parse(source);
  let code = compileScript(descriptor, { id: `u5-${++viewSerial}`, inlineTemplate: true }).content;
  class MissingTerminal { constructor() { throw Error('headless terminal unavailable'); } }
  const key = `__u5deps${viewSerial}`;
  globalThis[key] = { vue, '@xterm/xterm': { Terminal: MissingTerminal }, '@xterm/addon-fit': { FitAddon: class {} }, './terminalDeckModel.js': model, './pairedTerminals.js': {createPairedTerminals},
    '../../.kit/capsule-ui-kit/src/terminal/nonceDocument.js': { createTerminalDocument: () => ({}) } };
  code = code.replace(/^import\s+(['"])(.*?)\1;?\s*$/gm, '')
    .replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm, (_all, binding, _q, spec) => `const ${binding.replace(/\bas\b/g, ':')} = globalThis[${JSON.stringify(key)}][${JSON.stringify(spec)}];`)
    .replace(/^export\s+default\s+/m, 'globalThis.__u5view = ');
  vm.runInThisContext(`{\n${code}\n}`);
  const component = globalThis.__u5view;
  delete globalThis.__u5view; delete globalThis[key];
  return component;
}
function mountView(component, props) {
  const make = tag => ({ tag, children: [], props: {}, parent: null,
    focus() { globalThis.document.activeElement=this; },
    contains(node) { return node===this || this.children.some(child=>child.contains(node)); },
    getBoundingClientRect() { return {width:144,height:80}; },
    querySelector(selector) { return this.querySelectorAll().find(n=>'#'+n.props.id===selector); },
    querySelectorAll() { return this.children.flatMap(child=>child.tag==='button'?[child]:child.querySelectorAll()); },
  });
  const renderer = vue.createRenderer({ createElement: make, createComment: make, createText: text => ({ ...make('#text'), text }),
    insert(child, parent, anchor) { if (child.parent) this.remove(child); child.parent = parent; const i = parent.children.indexOf(anchor); parent.children.splice(i < 0 ? parent.children.length : i, 0, child); },
    remove(child) { const list = child.parent?.children; if (list) list.splice(list.indexOf(child), 1); child.parent = null; },
    setText(n, text) { n.text = text; }, setElementText(n, text) { n.text = text; n.children = []; }, patchProp(n, key, _old, value) { n.props[key] = value; },
    parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, setScopeId() {} });
  const root = make('root'), app = renderer.createApp(component, props), exposed = app.mount(root);
  const find = (id, node = root) => node.props.id === id ? node : node.children.map(n => find(id, n)).find(Boolean);
  return { app, exposed, find };
}
const tick = async () => { await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick(); };


function environment(t) {
  const doc=globalThis.document, win=globalThis.window;
  globalThis.document={activeElement:null};globalThis.window={innerWidth:300,innerHeight:200};
  t.after(()=>{globalThis.document=doc;globalThis.window=win;});
}
function event(key,extra={}) { return {key,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},stopImmediatePropagation(){this.stopped=true;},...extra}; }
function setup() {
  const writes=[];
  const view=mountView(loadView(),{storage:storage(null),terminalBroker:{open:async()=>({session:'session-k2'}),close:async()=>{}},terminalBinding:{attach:async()=>{},write:req=>writes.push(req),close(){},onData(){},onExit(){}}});
  return {...view,writes};
}
test('V027 K2 Ctrl+Shift+F6 exits terminal input without bytes; Tab stays terminal input',async t=>{
  environment(t);const v=setup();t.after(()=>v.app.unmount());
  const slot=await v.exposed.controller.launchProfile('shell');await tick();
  const terminal={tagName:'TEXTAREA'};document.activeElement=terminal;
  const tab=event('Tab',{target:terminal});v.exposed.onWindowKeyDown(tab);
  assert.equal(tab.prevented,undefined);
  const leave=event('F6',{ctrlKey:true,shiftKey:true,target:terminal});v.exposed.onWindowKeyDown(leave);await tick();
  assert.ok(vue.toRaw(document.activeElement)===v.find('terminal-deck-new'),'focus returns to New terminal');
  assert.equal(leave.prevented,true);assert.equal(v.writes.length,0);
});
test('V027 K2 busy-close focuses Cancel, contains Tab, blocks background shortcuts and restores focus',async t=>{
  environment(t);const v=setup();t.after(()=>v.app.unmount());
  const slot=await v.exposed.controller.launchProfile('shell');await tick();
  const before=v.find('terminal-deck-new');document.activeElement=before;
  await v.exposed.controller.requestCloseSlot(slot.id);await tick();
  const cancel=v.find('terminal-deck-confirm-close-no'),confirm=v.find('terminal-deck-confirm-close-yes');
  assert.ok(vue.toRaw(document.activeElement)===cancel,'Cancel receives focus');
  const tab=event('Tab',{target:cancel});v.exposed.onWindowKeyDown(tab);assert.ok(vue.toRaw(document.activeElement)===confirm,'Tab focuses confirm');assert.equal(tab.prevented,true);
  const reverse=event('Tab',{shiftKey:true,target:confirm});v.exposed.onWindowKeyDown(reverse);assert.ok(vue.toRaw(document.activeElement)===cancel,'Cancel receives focus');
  const shortcut=event('t',{ctrlKey:true,shiftKey:true,target:before});v.exposed.onWindowKeyDown(shortcut);await tick();
  assert.equal(v.exposed.controller.state.screens[0].slots.length,1);
  v.exposed.onTileKeyDown(slot.id,event('x',{target:before}));assert.equal(v.writes.length,0);
  v.exposed.onWindowKeyDown(event('Escape',{target:cancel}));await tick();assert.ok(vue.toRaw(document.activeElement)===before,'Cancel restores invoking control');
});
test('V027 K2 context menu uses rendered dimensions to stay inside the viewport',async t=>{
  environment(t);const v=setup();t.after(()=>v.app.unmount());
  const slot=await v.exposed.controller.launchProfile('shell');await tick();
  v.exposed.onTileContextMenu(slot.id,{clientX:299,clientY:199});await tick();
  assert.ok(v.exposed.contextMenu.x<=156);assert.ok(v.exposed.contextMenu.y<=120);
  v.exposed.onTileContextMenu(slot.id,{clientX:20,clientY:30});await tick();
  assert.equal(v.exposed.contextMenu.x,20);assert.equal(v.exposed.contextMenu.y,30);
});
