import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validSnapshot} from '../electron/headlessValues.js';
const source=readFileSync(new URL('../src/App.vue',import.meta.url),'utf8');
const start=source.indexOf('async function headlessAction('),end=source.indexOf('function runHeadlessJob(',start);
assert.ok(start>=0 && end>start);
const code=source.slice(start,end);
const snapshot=revision=>({available:true,busy:false,code:null,revision,session:null,uncertain:false});
test('delayed action reply cannot overwrite a newer subscribed snapshot',async()=>{
 let resolve;const promise=new Promise(r=>{resolve=r;});const state={value:snapshot(1)},opened={value:false};
 const action=new Function('props','headlessSnapshot','headlessOpen','validSnapshot',code+';return headlessAction;')({headlessHost:{request:()=>promise}},state,opened,validSnapshot);
 const pending=action('create');state.value=snapshot(3);resolve(snapshot(2));await pending;
 assert.equal(opened.value,true);assert.equal(state.value.revision,3);
});
test('current action reply remains visible',async()=>{
 const state={value:snapshot(1)},opened={value:false};
 const action=new Function('props','headlessSnapshot','headlessOpen','validSnapshot',code+';return headlessAction;')({headlessHost:{request:async()=>snapshot(2)}},state,opened,validSnapshot);
 await action('create');assert.equal(state.value.revision,2);
});
