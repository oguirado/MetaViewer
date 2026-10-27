import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installPreload} from '../electron/preload.js';

function notice() {
  return {
    surface:{schema:'surface/v0.2',surface_id:'s1',kind:'browser',display:':1',
      geometry:{w:1,h:1},state:'active',visibility:'unfolded',control:'human',profile_id:'test'},
    frame_ref:{schema:'frame_ref/v0.1',surface_id:'s1',generation:1,tick:1,ts_ns:1,
      width:1,height:1,format:'rgb24',sha256:'a'.repeat(64),capture_us:1},
  };
}

function fixture(t, origin) {
  const posts=[], delivered=[], handlers=new Map();
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{
    location:{origin},postMessage:(...args)=>posts.push(args),
  }});
  t.after(()=>{
    if(previous) Object.defineProperty(globalThis,'window',previous);
    else delete globalThis.window;
  });
  const api=installPreload({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{
    invoke:async()=>true,
    on:(channel,listener)=>handlers.set(channel,listener),
    removeListener:channel=>handlers.delete(channel),
  }});
  const unsubscribe=api.authority.subscribeFrames(value=>delivered.push(value));
  t.after(unsubscribe);
  return {posts,delivered,subscribe:cb=>api.authority.subscribeFrames(cb),
    emit:(value,ports)=>handlers.get('metaviewer:authority.frames')({ports},value)};
}

test('ARG-n_uisrc-4: frame port targets the privileged origin with its transfer list',t=>{
  const f=fixture(t,'metaviewer://app'), value=notice(), port={};
  f.emit(value,[port]);
  assert.deepEqual(f.posts,[[{type:'metaviewer:frame-port',surface_id:'s1'},'metaviewer://app',[port]]]);
  assert.deepEqual(f.delivered,[value]);
});

test('ARG-n_uisrc-4: unexpected origins refuse port transfer but retain notice delivery',t=>{
  const f=fixture(t,'https://unexpected.invalid'), value=notice();
  f.emit(value,[{}]);
  assert.deepEqual(f.posts,[]);
  assert.deepEqual(f.delivered,[value]);
});

test('ARG-n_uisrc-4: each frame is validated once even with multiple subscribers',t=>{
  const f=fixture(t,'metaviewer://app');
  const other=[];
  t.after(f.subscribe(value=>other.push(value)));
  const stringify=JSON.stringify;
  let validations=0;
  t.mock.method(JSON,'stringify',(...args)=>{validations+=1;return stringify(...args);});
  f.emit(notice(),[{}]);
  f.emit(notice(),[]);
  assert.equal(validations,2);
  assert.equal(f.delivered.length,2);
  assert.deepEqual(other,f.delivered);
});

test('ARG-n_uisrc-4 negative control: malformed notices deliver neither ports nor callbacks',t=>{
  const f=fixture(t,'metaviewer://app'), value=notice();
  value.frame_ref.sha256='invalid';
  f.emit(value,[{}]);
  assert.deepEqual(f.posts,[]);
  assert.deepEqual(f.delivered,[]);
});
