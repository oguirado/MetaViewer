import test from 'node:test';
import assert from 'node:assert/strict';
import {captureNativePreview,nativeThemeScript} from '../electron/nativePreview.js';
import {createXpraHumanSession} from '../electron/xpraHumanSession.js';
import {readFileSync} from 'node:fs';
const roleScript=readFileSync(new URL('../src/surfaces/RoleSurface.vue',import.meta.url),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const {nativeThemeColor}=await import('data:text/javascript;base64,'+Buffer.from(roleScript).toString('base64'));

test('computed RGB and short hex theme colors resolve to native opaque colors',()=>{
  assert.equal(nativeThemeColor('rgb(255, 255, 255)'),'#ffffff');
  assert.equal(nativeThemeColor('#fff'),'#ffffff');
  assert.equal(nativeThemeColor('rgba(23, 33, 43, 1)'),'#17212b');
  for (const value of ['transparent','rgba(0, 0, 0, 0)','rgb(256, 1, 2)','url(file:///x)']) assert.equal(nativeThemeColor(value),null);
});

test('native preview uses captured pixels and bounds its retained image',async()=>{
  let resized;
  const frame={isEmpty:()=>false,getSize:()=>({width:2000,height:1000}),
    resize:options=>{resized=options;return {toPNG:()=>Buffer.from('real captured bytes')};}};
  const result=await captureNativePreview({capturePage:async()=>frame},()=>true);
  assert.deepEqual(resized,{width:1024});
  assert.equal(result,'data:image/png;base64,'+Buffer.from('real captured bytes').toString('base64'));
});
test('native preview refuses dead leases, oversized images and a late revoked capture',async()=>{
  await assert.rejects(()=>captureNativePreview({},()=>false),/PREVIEW_UNAVAILABLE/);
  const frame={isEmpty:()=>false,getSize:()=>({width:100}),toPNG:()=>Buffer.alloc(2*1024*1024+1)};
  await assert.rejects(()=>captureNativePreview({capturePage:async()=>frame},()=>true),/PREVIEW_UNAVAILABLE/);
  let active=true;
  await assert.rejects(()=>captureNativePreview({capturePage:async()=>{active=false;return frame;}},()=>active),/PREVIEW_UNAVAILABLE/);
});
test('native theme admits only resolved colors and never guest script or paths',()=>{
  const script=nativeThemeScript({background:'#edf1f5',foreground:'#17212b'});
  assert.match(script,/document.body.style.backgroundColor="#edf1f5"/);
  for(const color of ['red','url(file:///secret)',';alert(1)','#abc',null]) {
    assert.throws(()=>nativeThemeScript({background:color,foreground:'#17212b'}),/NATIVE_THEME_REFUSED/);
  }
});
test('the role session forwards preview and theme only while its native lease is live',async()=>{
  const calls=[];
  const session=createXpraHumanSession({role:'human',setReadonly:async()=>true,
    openBridge:async()=>({close:async()=>{}}),closeTrace(){},showView:async()=>({
      preview:async()=>{calls.push('preview');return 'native pixels';},
      setTheme:async theme=>calls.push(theme),close:async()=>{},
    })});
  await session.open();
  assert.equal(await session.preview(),'native pixels');
  await session.setTheme({background:'#ffffff',foreground:'#111111'});
  assert.deepEqual(calls,['preview',{background:'#ffffff',foreground:'#111111'}]);
  await session.close();
  await assert.rejects(()=>session.preview(),/XPRA_SESSION_CLOSED/);
  await assert.rejects(()=>session.setTheme({background:'#ffffff',foreground:'#111111'}),/XPRA_SESSION_CLOSED/);
});
