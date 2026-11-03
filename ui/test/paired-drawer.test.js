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
 const element={},target={surfaceId:'a'},host={element,width:400,height:600,visible:true};
 assert.equal(choose(target,{a:host},true,false),element);
 for(const patch of [{width:399},{height:599},{visible:false},{width:NaN},{height:undefined}]) assert.equal(choose(target,{a:{...host,...patch}},true,false),null);
 assert.equal(choose(target,{a:host},false,false),null);
 assert.equal(choose(target,{a:host},true,true),null);
 assert.equal(choose(target,{},true,false),null);assert.equal(choose(null,{a:host},true,false),null);
});
test('drawer is tile-contained, keeps the deck instance and uses only scoped native occlusion',()=>{
 assert.match(source,/<Teleport :to="terminalDrawerTarget \|\| 'body'" :disabled="!terminalInDrawer">/);
 assert.match(source,/setSurface\(terminalDrawerOwner,id,true\)/);
 assert.match(source,/setSurface\(terminalDrawerOwner,previous,false\)/);
 assert.doesNotMatch(source,/set\(terminalDrawerOwner/);
 const css=readFileSync(new URL('../src/wall/wall.css',import.meta.url),'utf8');
 assert.match(css,/\.mv-tile-terminal-drawer \{[^}]*position:absolute;[^}]*inset:auto 0 0;[^}]*height:min\(45%,360px\)/);
});


test('narrow headers move Close into the tool row while preserving its anchored control',()=>{
 const css=readFileSync(new URL('../src/wall/wall.css',import.meta.url),'utf8');
 assert.match(css,/\.cuk-capsule-panel__actions > button\[data-semantic-anchor\$="\/close"\] \{[^}]*top:29px;[^}]*visibility:hidden/);
 assert.match(css,/data-chrome-expanded="true"\][^}]+data-semantic-anchor\$="\/close"\][^}]+visibility:visible; pointer-events:auto/);
 const kit=readFileSync(new URL('../.kit/capsule-ui-kit/src/capsules/CapsulePanel.vue',import.meta.url),'utf8');
 assert.match(kit,/:data-semantic-anchor="anchors.close"/);
 assert.match(kit,/@click="onClosePanel"/);
});
