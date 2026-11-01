import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { physicalXkbKeycodes, rawKeyboardPatch } from '../electron/xpraKeyboard.js';
import { xpraReadyExpression } from '../electron/xpraClient.js';

// Real evdev XKB positions from the dedicated Spanish X display.
const source = '<AC01> = 38; <AE02> = 11; <AC11> = 48; <LSGT> = 94; <RALT> = 108; <LFSH> = 50;';

test('raw XKB mapping retains the ISO physical key instead of DOM keyCode 226',()=>{
  const codes=physicalXkbKeycodes(source);
  assert.equal(codes.IntlBackslash,94);assert.equal(codes.Quote,48);
  assert.equal(codes.AltRight,108);assert.equal(codes.KeyA,38);
  assert.throws(()=>physicalXkbKeycodes(source.replace('<LSGT> = 94;','')),/KEYMAP_UNAVAILABLE/);
  assert.throws(()=>physicalXkbKeycodes(source.replace('94','999')),/KEYMAP_UNAVAILABLE/);
});

test('raw client advertises the host layout and forwards physical dead keys without text synthesis',()=>{
  const calls=[],listeners={};
  class Client {
    capture_keyboard=true;server_readonly=false;topwindow=7;
    _make_hello(){this._update_capabilities({xkbmap_keycodes:['legacy']});}
    _update_capabilities(value){calls.push(value);}
    _keyb_process(){throw Error('legacy character translation');}
    _keyb_get_modifiers(event){return event.shiftKey?['shift']:[];}
    send(packet){calls.push(packet);}
  }
  vm.runInNewContext(rawKeyboardPatch({layout:'es',keycodes:physicalXkbKeycodes(source)}),{
    XpraClient:Client,document:{addEventListener:(name,handler,capture)=>{listeners[name]={handler,capture};}},
  });
  const client=new Client();client._make_hello();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),{xkbmap_layout:'es',xkbmap_raw:true});
  // KeyCode 229 and key='Dead' must retain the physical Quote position.
  client._keyb_process(true,{code:'Quote',key:'Dead',keyCode:229});
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['key-action',7,'Quote',true,[],0,'',48,0]);
  client._keyb_process(true,{code:'IntlBackslash',key:'>',keyCode:226,shiftKey:true});
  assert.equal(calls.at(-1)[7],94);assert.deepEqual(calls.at(-1)[4],['shift']);
  const count=calls.length;client._keyb_process(true,{code:'Unmapped',key:'private text'});
  assert.equal(calls.length,count);
  client.server_readonly=true;client._keyb_process(true,{code:'KeyA'});assert.equal(calls.length,count);
  let stopped=false;listeners.input.handler({stopImmediatePropagation(){stopped=true;}});
  assert(stopped);assert.equal(listeners.input.capture,true);
  assert.throws(()=>rawKeyboardPatch({layout:'es&injected=1',keycodes:{KeyA:38}}),/KEYMAP_INVALID/);
});

test('a connected but unpatched HTML client cannot pass raw-keyboard readiness',()=>{
  const client={connected:true,server_ok:true,server_readonly:false,desktop_width:1280,desktop_height:900,id_to_window:{1:{}}};
  const frame={contentWindow:{client,innerWidth:1280,innerHeight:900},contentDocument:{querySelectorAll:()=>[{width:1280,height:900}]}};
  const context={document:{getElementById:()=>frame}};
  assert.equal(vm.runInNewContext(xpraReadyExpression(true,true),context),false);
  client.metaviewer_raw_keyboard=true;
  assert.equal(vm.runInNewContext(xpraReadyExpression(true,true),context),true);
});
