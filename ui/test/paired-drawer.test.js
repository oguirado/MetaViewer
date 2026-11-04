import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse,compileScript} from '@vue/compiler-sfc';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/App.vue',import.meta.url),'utf8');
const {descriptor}=parse(source), ast=compileScript(descriptor,{id:'drawer-test'}).scriptSetupAst;
const node=ast.find(n=>n.type==='FunctionDeclaration' && n.id.name==='pairedDrawerTarget');
assert.ok(node);
const c=vm.createContext({});vm.runInContext(descriptor.scriptSetup.content.slice(node.start,node.end),c);
const choose=c.pairedDrawerTarget;
test('drawer requires real visible geometry large enough for both content and terminal',()=>{
 const element={},target={surfaceId:'a'},host={element,width:240,height:320,visible:true};
 assert.equal(choose(target,{a:host},true,false),element);
 for(const patch of [{width:0},{height:0},{visible:false},{width:NaN},{height:undefined}]) assert.equal(choose(target,{a:{...host,...patch}},true,false),null);
 assert.equal(choose(target,{a:host},false,false),null);
 assert.equal(choose(target,{a:host},true,true),null);
 assert.equal(choose(target,{},true,false),null);assert.equal(choose(null,{a:host},true,false),null);
});
test('drawer is tile-contained, keeps the deck instance and reserves live presentation space',()=>{
 assert.match(source,/<Teleport v-for="entry in pairedDrawers"[^>]+:disabled="!entry.host">/);
 assert.doesNotMatch(source,/terminalDrawerOwner/,'the drawer cannot occlude its live native view');
 const css=readFileSync(new URL('../src/wall/wall.css',import.meta.url),'utf8');
 assert.match(css,/\.mv-tile-terminal-drawer \{[^}]*position:absolute;[^}]*inset:auto 0 0;[^}]*height:min\(45%,360px\)/);
 assert.match(css,/data-terminal-drawer="true"\] \{[^}]*display: grid;[^}]*grid-template-rows: minmax\(0,1fr\) min\(45%,360px\)/);
 assert.match(css,/data-terminal-drawer="true"\] > \.cuk-capsule-panel \{[^}]*grid-row: 1;/);
 assert.match(css,/data-terminal-drawer="true"\] > \.mv-tile-terminal-drawer \{[^}]*grid-row: 2;[^}]*position: relative;/);
 const panel=readFileSync(new URL('../src/wall/SurfacePanel.vue',import.meta.url),'utf8');
 assert.match(panel,/:data-terminal-drawer="String\(capsuleTerminal\?\.inDrawer\?\.\(props.capsuleId\) \?\? false\)"/);

});


test('narrow headers move Close into the tool row while preserving its anchored control',()=>{
 const css=readFileSync(new URL('../src/wall/wall.css',import.meta.url),'utf8');
 assert.match(css,/\.cuk-capsule-panel__actions > button\[data-semantic-anchor\$="\/close"\] \{[^}]*top:29px;[^}]*visibility:hidden/);
 assert.match(css,/data-chrome-expanded="true"\][^}]+data-semantic-anchor\$="\/close"\][^}]+visibility:visible; pointer-events:auto/);
 const kit=readFileSync(new URL('../.kit/capsule-ui-kit/src/capsules/CapsulePanel.vue',import.meta.url),'utf8');
 assert.match(kit,/:data-semantic-anchor="anchors.close"/);
 assert.match(kit,/@click="onClosePanel"/);
});

test('paired drawers retain an independent view and visibility flag for each capsule',()=>{
 assert.match(source,/v-for="entry in pairedDrawers"/);
 assert.match(source,/:key="entry.target.surfaceId"/);
 assert.match(source,/:paired-target="entry.target"/);
 assert.match(source,/setPairedDrawerOpen\(entry.target.surfaceId, \$event\)/);
 assert.doesNotMatch(source,/terminalPreferDock.value=true/);
});

test('drawer visibility and desktop registration retain each capsule entry independently',async()=>{
 const vue=await import('vue');
 const begin=source.indexOf('const pairedTerminalStorage =');
 const end=source.indexOf('/** Renderer intents remain events',begin);
 assert.ok(begin>0 && end>begin);
 let controls;
 const context=vm.createContext({...vue,nestedMode:{displayOnly:false},props:{terminalBroker:{open(){}}},
  terminalDeckOpen:vue.ref(false),toggleTerminal(){throw Error('side panel must stay independent');},
  surfaceLabel:r=>r.id,rows:vue.ref([{id:'surface-a'},{id:'surface-b'}]),provide(_key,value){controls=value;}});
 vm.runInContext(source.slice(begin,end)+';globalThis.entries=pairedTerminalEntries;globalThis.drawers=pairedDrawers;',context);
 const a={},b={};
 controls.registerDrawer('surface-a',a,{width:250,height:350,visible:true});
 controls.registerDrawer('surface-b',b,{width:500,height:700,visible:true});
 controls.toggle('surface-a');controls.toggle('surface-b');
 assert.equal(controls.inDrawer('surface-a'),true);assert.equal(controls.inDrawer('surface-b'),true);
 const retainedA=context.entries.value['surface-a'].target;
 controls.toggle('surface-a');assert.equal(controls.inDrawer('surface-a'),false);assert.equal(controls.inDrawer('surface-b'),true);
 assert.equal(context.entries.value['surface-a'].target,retainedA,'hiding retains the view key and target');
 controls.registerDrawer('surface-b',b,{width:500,height:700,visible:false});
 assert.equal(controls.inDrawer('surface-b'),false);assert.equal(controls.isOpen('surface-b'),true,'desktop hiding preserves requested visibility');
 controls.registerDrawer('surface-b',b,{width:500,height:700,visible:true});
 assert.equal(controls.inDrawer('surface-b'),true);
 controls.toggle('surface-a');assert.equal(controls.inDrawer('surface-a'),true);
 assert.equal(Object.keys(context.entries.value).length,2);
});
