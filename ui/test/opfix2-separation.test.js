import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/App.vue',import.meta.url),'utf8');
test('right panel opens independently even when a paired drawer is visible',()=>{
 const fn=source.match(/function toggleTerminalDock\(\) \{[\s\S]*?\n\}/)?.[0];assert.ok(fn);
 let toggles=0;
 const state={terminalInDrawer:{value:true},terminalPreferDock:{value:false},toggleTerminal(){toggles++;}};
 vm.runInNewContext(`${fn};toggleTerminalDock()`,state);
 assert.equal(toggles,1,'opening the right panel must not move the paired terminal');
 assert.equal(state.terminalPreferDock.value,false,'paired drawer position stays unchanged');
});
test('right panel cannot pass a capsule target to its retained deck',()=>{
 const section=source.match(/<section[^>]*id="mv-terminal-deck-screen"[\s\S]*?<\/section>/)?.[0];assert.ok(section);
 assert.doesNotMatch(section,/:paired-target=/,'no pairing watcher can spawn in the side panel');
 assert.doesNotMatch(section,/<Teleport/,'right panel does not travel with a capsule');
 assert.match(section,/:open="terminalDeckOpen"/);
});
