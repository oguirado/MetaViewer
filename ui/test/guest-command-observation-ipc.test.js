import test from 'node:test';
import assert from 'node:assert/strict';
import {installPreload} from '../electron/preload.js';
import {gcObservationSnapshot} from '../electron/guestCommandValues.js';
const empty={staged:null,active:null,history:[],uncertain:false,generation:null};
test('native readonly observation subscription preserves closed shape and invokes only readonly initial snapshot',()=>{
 const handlers=new Map(),calls=[];
 const api=installPreload({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke(...args){calls.push(args);return Promise.resolve(empty);},on(ch,fn){handlers.set(ch,fn);},removeListener(ch,fn){assert.equal(handlers.get(ch),fn);handlers.delete(ch);}}});
 let seen;const off=api.guestCommand.onObservation(v=>{seen=v;});assert.deepEqual([...handlers.keys()],['metaviewer:guest-command.observation']);
 handlers.get('metaviewer:guest-command.observation')({},empty);assert.deepEqual(seen,empty);seen.history.push('mutated');assert.deepEqual(empty.history,[]);
 assert.throws(()=>handlers.get('metaviewer:guest-command.observation')({},{...empty,execute:'rm'}),/observation/);
 assert.throws(()=>api.guestCommand.onObservation({command:'x'}));assert.deepEqual(calls,[['metaviewer:guest-command.observation']]);assert.throws(()=>api.guestCommand.onObservation(()=>{},'extra'));off();assert.equal(handlers.size,0);
});
test('projection rejects executable metadata, malformed transcript and unbounded buffers',()=>{
 assert.equal(gcObservationSnapshot(empty),true);
 for(const v of [{...empty,stdin:'secret'},{...empty,generation:true},{...empty,history:Array(9).fill({})},{...empty,active:{command_utf8:'x'}},{...empty,staged:{request_id:'x',job_id:'x',execute:true}}])assert.equal(gcObservationSnapshot(v),false);
});

test('a newer observation event wins over delayed initial snapshot',async()=>{
 let resolve,listener;const api=installPreload({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke(){return new Promise(r=>{resolve=r;});},on(_ch,cb){listener=cb;},removeListener(){}}});
 const seen=[],off=api.guestCommand.onObservation(v=>seen.push(v));listener({}, {...empty,generation:2});resolve({...empty,generation:1});await Promise.resolve();await Promise.resolve();assert.deepEqual(seen.map(v=>v.generation),[2]);off();
});

import {mkdtemp,rm} from 'node:fs/promises';
import {installAuthorityWire,GUEST_COMMAND_CHANNELS} from '../electron/authorityWire.js';
test('actual authority binds readonly snapshot to own main frame and unwinds it',async t=>{
 const root=await mkdtemp('/dev/shm/rw123-ipc-');t.after(()=>rm(root,{recursive:true,force:true}));
 const handlers=new Map(),posts=[];const frame={origin:'app://metaviewer',url:'app://metaviewer/index.html'};const contents={id:9,mainFrame:frame,isDestroyed:()=>false,postMessage(...args){posts.push(args);}};
 let listener,revoked=false;const core={request:async()=>assert.fail('readonly query executed command'),guestCommand:{onObservation(cb){listener=cb;return()=>{revoked=true;};},observationSnapshot:()=>empty}};
 const binding=installAuthorityWire({ipcMain:{handle:(ch,fn)=>handlers.set(ch,fn),removeHandler:ch=>handlers.delete(ch)},contents,core,env:{XDG_CONFIG_HOME:root},argv:[]});
 const ch=GUEST_COMMAND_CHANNELS.guestCommandObservation,fn=handlers.get(ch),event={sender:contents,senderFrame:frame};
 assert.equal(ch,'metaviewer:guest-command.observation');assert.deepEqual(await fn(event),empty);
 await assert.rejects(fn({...event,sender:{id:9}}),/SENDER/);await assert.rejects(fn({...event,senderFrame:{...frame}}),/SENDER/);await assert.rejects(fn(event,{command:'x'}),/ARGS/);
 listener(empty);assert.deepEqual(posts.at(-1),[ch,empty]);assert.throws(()=>listener({...empty,execute:true}),/OBSERVATION/);
 await binding.dispose();assert.equal(revoked,true);assert.equal(handlers.has(ch),false);
});
