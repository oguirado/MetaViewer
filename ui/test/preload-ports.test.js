import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installPreload} from '../electron/preload.js';

function notice() {
  return {
    surface:{schema:'surface/v0.2',surface_id:'s1',kind:'browser',display:':1',
      geometry:{w:1,h:1},state:'active',visibility:'unfolded',control:'human',profile_id:'test'},
    frame_ref:{schema:'frame_ref/v0.2',surface_id:'s1',generation:1,tick:0,ts_ns:0,
      capture_us:0,width:1,height:1,format:'rgb24',sha256:'a'.repeat(64)},
  };
}

function fixture(t, origin) {
  const posts=[], delivered=[];
  let receive;
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  if (origin !== undefined) Object.defineProperty(globalThis,'window',{configurable:true,value:{
    location:{origin},postMessage:(...args)=>posts.push(args),
  }});
  else Reflect.deleteProperty(globalThis,'window');
  t.after(()=>{
    if (previous) Object.defineProperty(globalThis,'window',previous);
    else Reflect.deleteProperty(globalThis,'window');
  });
  const api=installPreload({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{
    invoke:async()=>true,on:(_channel,listener)=>{receive=listener;},removeListener(){},
  }});
  t.after(api.authority.subscribeFrames(value=>delivered.push(value)));
  const closes=[0,0];
  const ports=closes.map((_,index)=>({close(){closes[index]+=1;}}));
  return {posts,delivered,closes,ports,emit:(value)=>receive({ports},value)};
}

for (const origin of ['app://metaviewer','https://unexpected.invalid']) {
  test(`ARG-r_ui-4: invalid notice closes every port without notifying (${origin})`,t=>{
    const f=fixture(t,origin), value=notice();
    value.frame_ref.sha256='invalid';
    f.emit(value);
    assert.deepEqual(f.delivered,[]);
    assert.deepEqual(f.posts,[]);
    assert.deepEqual(f.closes,[1,1]);
  });
}

for (const origin of ['https://unexpected.invalid','metaviewer://app',undefined]) {
  test(`ARG-r_ui-4: valid notice without privileged origin closes ports and notifies (${origin})`,t=>{
    const f=fixture(t,origin), value=notice();
    f.emit(value);
    assert.deepEqual(f.delivered,[value]);
    assert.deepEqual(f.posts,[]);
    assert.deepEqual(f.closes,[1,1]);
  });
}

test('ARG-r_ui-4 negative control: privileged forwarding preserves message, target and port ownership',t=>{
  const f=fixture(t,'app://metaviewer'), value=notice();
  f.emit(value);
  assert.deepEqual(f.delivered,[value]);
  assert.deepEqual(f.posts,[[{type:'metaviewer:frame-port',surface_id:'s1'},'app://metaviewer',f.ports]]);
  assert.strictEqual(f.posts[0][2],f.ports);
  assert.deepEqual(f.closes,[0,0]);
});

test('ARG-r_ui-4: one failed close does not strand remaining ports or suppress a valid notice',t=>{
  const f=fixture(t,'https://unexpected.invalid'), value=notice();
  f.ports[0].close=()=>{f.closes[0]+=1;throw new Error('already detached');};
  f.emit(value);
  assert.deepEqual(f.delivered,[value]);
  assert.deepEqual(f.posts,[]);
  assert.deepEqual(f.closes,[1,1]);
});
