import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parse,compileScript} from '@vue/compiler-sfc';
import {unavailableArmCapsules} from '../src/catalog/catalogModel.js';
const source=readFileSync(process.env.P18G_CATALOG_SOURCE || new URL('../src/catalog/CatalogLauncher.vue',import.meta.url),'utf8');
const {descriptor}=parse(source),compiled=compileScript(descriptor,{id:'p18g-catalog'}),script=descriptor.scriptSetup.content;
const functions=compiled.scriptSetupAst.filter(n=>n.type==='FunctionDeclaration').map(n=>script.slice(n.start,n.end)).join('\n');
function fixture(choices,arm64Capabilities={supported_host:true,vm:{available:false,reason:'VM setup required'},microvm:{available:false,reason:'MicroVM setup required'}}){const events=[];const c={props:{visible:true,arm64Capabilities},disabledArmKinds:{get value(){return unavailableArmCapsules(c.props.arm64Capabilities);}},buildCreateIntent:()=>({ok:true,intent:{kind:'browser'}}),api:{choices},pendingIntent:{value:null},roleChoice:{value:'human'},roleError:{value:''},profileChoices:{value:[]},profileChoice:{value:'same-profile'},matchingProfiles:{get value(){return c.profileChoices.value;}},choosingRole:{value:false},choiceGeneration:0,emit:(...v)=>events.push(v)};vm.createContext(c);vm.runInContext(functions,c);return {c,events};}
test('H19 late identity choices cannot reopen a cancelled catalog',async()=>{
 let resolve;const {c}=fixture(()=>new Promise(r=>resolve=r));const pending=c.onCreate({type:{id:'browser'}});c.onClose();c.props.visible=false;resolve([{profileId:'same-profile',role:'human',available:true}]);await pending;assert.equal(c.choosingRole.value,false);
});
test('H20 reselecting the same identity restores its configured default role',async()=>{
 const {c,events}=fixture(async()=>[{profileId:'same-profile',role:'human',available:true}]);await c.onCreate({type:{id:'browser'}});assert.equal(c.roleChoice.value,'human');c.confirmRole();assert.equal(events.find(e=>e[0]==='create')[1].choice.role,'human');
});
