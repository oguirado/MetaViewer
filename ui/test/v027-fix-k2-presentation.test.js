import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildCapsuleReadyLine} from '../src/wall/capsuleId.js';
import {HANDOFF_STEPS} from '../src/handoff/handoffModel.js';
import * as capture from '../src/wall/tileCapture.js';

test('V027 K2 copy guidance distinguishes programs and refuses Desktop window automation',()=>{
  assert.equal(buildCapsuleReadyLine({surfaceId:'surface-demo',profileId:'program-demo'}),'CAPSULE=surface-demo  IDENTITY=program-demo');
  const line=readFileSync(new URL('../../docs/AGENT_ENTRY.md',import.meta.url),'utf8').replace(/\s+/g,' ');
  assert.match(line,/--surface-kind program/);
  assert.match(line,/tools\/mw_run_program\.md/);
  assert.match(line,/Desktop.window.*unsupported/i);
  assert.match(line,/browser goal/i);
  assert.equal(buildCapsuleReadyLine({surfaceId:'bad id',profileId:'program-demo'}),null);
});
test('V027 K2 intervention guides direct wall typing only after takeover',()=>{
  const text=HANDOFF_STEPS.join(' ');
  assert.doesNotMatch(text,/multislot/);
  assert.match(text,/After.*Take control.*succeeds.*wall/i);
  assert.match(text,/Release control/);assert.match(text,/Re-run/);
});
test('V027 K2 typed capture refusal supplies visible recovery while success stays quiet',()=>{
  assert.match(capture.tileCaptureRefusal({lastCode:'CAPTURE_UNAVAILABLE'}),/Capture unavailable.*live.*again/i);
  assert.match(capture.tileCaptureRefusal({lastCode:'SURFACE_UNKNOWN'}),/surface.*available/i);
  assert.equal(capture.tileCaptureRefusal({lastCode:'',lastShot:{id:'shot'}}),'');
});

import {parse,compileScript} from '@vue/compiler-sfc';
import * as vue from 'vue';
import * as recordingElapsed from '../src/recording/useRecordingElapsed.js';
import vm from 'node:vm';
function chromeView(state) {
  const source=readFileSync(new URL('../src/wall/TileCaptureChrome.vue',import.meta.url),'utf8');
  const {descriptor}=parse(source);
  let code=compileScript(descriptor,{id:'k2-chrome',inlineTemplate:true}).content;
  const deps={vue,'./tileCapture.js':capture,'../recording/useRecordingElapsed.js':recordingElapsed,
    '../../.kit/capsule-ui-kit/src/saas/SaasRecordButton.vue':{default:{render:()=>null}},
    '../../.kit/capsule-ui-kit/src/shell/SidebarIcon.vue':{default:{render:()=>null}}};
  globalThis.__k2deps=deps;
  code=code.replace(/^import\s+([\s\S]+?)\s+from\s+(['"])(.*?)\2;?/gm,(_all,binding,_q,spec)=>{
    const dep=`globalThis.__k2deps[${JSON.stringify(spec)}]`;
    return binding.trim().startsWith('{')?`const ${binding.replace(/\bas\b/g,':')}=${dep};`:`const ${binding}=${dep}.default;`;
  }).replace(/^export\s+default\s+/m,'globalThis.__k2component=');
  vm.runInThisContext(`{${code}}`);
  const make=tag=>({tag,children:[],props:{},parent:null});
  const renderer=vue.createRenderer({createElement:make,createComment:make,createText:text=>({...make('#text'),text}),
    insert(n,parent){n.parent=parent;parent.children.push(n);},remove(n){const a=n.parent?.children;if(a)a.splice(a.indexOf(n),1);},
    setText(n,text){n.text=text;},setElementText(n,text){n.text=text;},patchProp(n,k,_old,v){n.props[k]=v;},parentNode:n=>n.parent,nextSibling:()=>null,setScopeId(){}});
  const root=make('root'),app=renderer.createApp(globalThis.__k2component,{capsuleId:'surface-demo',captureState:state});
  delete globalThis.__k2component;app.mount(root);delete globalThis.__k2deps;
  const all=(n=root)=>[n,...n.children.flatMap(c=>all(c))];return {app,all};
}
test('V027 K2 screenshot refusal is rendered; successful compact screenshot has a persistent marker',async()=>{
  const entry=vue.reactive({phase:'idle',lastCode:'',lastShot:null});
  const state={toggleRecord:async()=>{},bySurface:{'surface-demo':entry},screenshot:async()=>{entry.lastCode='CAPTURE_UNAVAILABLE';return {ok:false,code:entry.lastCode};}};
  const v=chromeView(state);
  try {
    const shot=v.all().find(n=>n.props.class==='mv-tile-chrome__shot');
    shot.props.onClick();await vue.nextTick();await vue.nextTick();
    assert.match(v.all().find(n=>n.props.role==='alert').text,/Capture unavailable/);
    entry.lastCode='';entry.lastShot={id:'shot'};await vue.nextTick();
    assert.equal(v.all().some(n=>n.props.role==='alert'),false);
    assert.equal(shot.props['data-captured'],'true');
    assert.match(readFileSync(new URL('../src/wall/SurfacePanel.vue',import.meta.url),'utf8'),/\[data-captured="true"\]::after\s*\{\s*content:\s*"✓"/);
  } finally {v.app.unmount();}
});
