import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as vue from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { resolveNestedMode, applyNestedWall } from '../src/nested/nested.js';
import { createSettingsHost } from '../src/settings/settingsHost.js';
import { createTileScheduler } from '../src/surfaces/tileScheduler.js';

// Compile the real App with the pinned compiler. Replace only external UI
// boundaries; the root surface slot and its reactive witness bindings run live.
async function loadApp(captured, row) {
  const stub=vue.defineComponent({setup:(_,ctx)=>()=>vue.h('div',{},Object.values(ctx.slots).flatMap(slot=>slot?.()??[]))});
  const wall=vue.defineComponent({setup:(_,ctx)=>()=>vue.h('main',{},row?ctx.slots.surface?.({surface:row,capsuleId:row.id}):[])});
  const canvas=vue.defineComponent({props:['surfaceId','generation','epoch','state','frame','digest'],setup:props=>()=>{
    captured.push({...props});return vue.h('canvas');
  }});
  const deps={
    'capsule-ui-kit/DockWorkspace':stub,
    '../.kit/capsule-ui-kit/src/index-shell.js':{ShellWorkspace:stub,TopBar:stub,Sidebar:stub,StatusBar:stub,NewCapsuleDialog:stub},
    '../.kit/capsule-ui-kit/src/side-terminal/SideTerminalPanel.vue':stub,
    'capsule-ui-kit/ui':{UiButton:stub},'capsule-ui-kit/theme':{setKitScheme:()=>{}},
    '../.kit/capsule-ui-kit/src/shell/SettingsModel.js':{SETTINGS_STORAGE_KEYS:{scheme:'scheme'},readStoredSetting:(_s,_k,d)=>d,writeStoredSetting:()=>{}},
    './wall/WallWorkspace.vue':wall,'./surfaces/SurfaceCanvas.vue':canvas,
    './wall/EmptyWallView.vue':stub, './catalog/CatalogLauncher.vue':stub,
    './terminal/SideTerminalOverlay.vue':stub, './multislot/MultislotHost.vue':stub,
    './recording/MvRecordingPanel.vue':stub, './settings/MvSettingsPanel.vue':stub,
    './agent/AgentLaneHost.vue':stub,
    './settings/settingsHost.js':{createSettingsHost},
    './nested/nested.js':{resolveNestedMode,applyNestedWall},
    './surfaces/tileScheduler.js':{createTileScheduler},
  };
  globalThis.__mvuiEngineDeps=deps;
  const {descriptor}=parse(readFileSync(new URL('../src/App.vue',import.meta.url),'utf8'));
  const compiled=compileScript(descriptor,{id:'mvui-engine-app',inlineTemplate:true});
  const require=createRequire(import.meta.url);
  const code=compiled.content.replace(/^import\s+([^\n]+?)\s+from\s+(['"])(.*?)\2;?/gm,(all,bindings,_quote,specifier)=>{
    if(specifier==='vue') return all.replace(/(['"])vue\1/,JSON.stringify(pathToFileURL(require.resolve('vue')).href));
    const binding=bindings.trim();
    return `const ${binding}=globalThis.__mvuiEngineDeps[${JSON.stringify(specifier)}];`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${row?.id??'unavailable'}`)).default;
}
function renderer() {
  return vue.createRenderer({
    createElement:tag=>({tag,children:[]}),createText:text=>({text}),createComment:text=>({text}),
    insert(child,parent){child.parent=parent;parent.children.push(child);},
    remove(child){const children=child.parent?.children;if(children) children.splice(children.indexOf(child),1);},
    setText(node,text){node.text=text;},setElementText(node,text){node.text=text;},
    parentNode:node=>node.parent,nextSibling:()=>null,patchProp(){},querySelector:()=>null,setScopeId(){},
  });
}

test('R1-074: mounted App displays completed scheduler witnesses and updates after a live tick',async()=>{
  const oldDocument=globalThis.document,oldWindow=globalThis.window;
  globalThis.document={documentElement:{dataset:{}},getElementById:()=>null};
  globalThis.window={addEventListener(){},removeEventListener(){}};
  const budget=Object.freeze({maxDrawsPerTick:1,maxUploadBytesPerTick:3,maxPresentMsPerTick:8,maxWarmResourcesPerSurface:0,maxDrainSteps:1});
  const scheduler=createTileScheduler({budget,onPresent:r=>scheduler.presentHandle(r)});
  const row=vue.reactive({id:'A',surfaceId:'A',generation:1,backendLifecycle:'active',attachmentState:'live'});
  const binding={surfaceId:'A',surfaceGeneration:1,principal:'wall-main',epoch:7};
  scheduler.registerSurface({...binding,state:{panelOpen:true,panelSelected:true,width:10,height:10,viewportIntersecting:true,windowPresentationAllowed:true}});
  scheduler.attachCanvas({surfaceId:'A',canvas:{getContext:()=>({createImageData:()=>({data:new Uint8ClampedArray(4)}),putImageData(){}})}});
  const submit=gen=>scheduler.submitFrame({...binding,frameGeneration:gen,leaseId:`l${gen}`,width:1,height:1,byteLength:3,bytes:new Uint8Array(3),sha256:String(gen).repeat(64)});
  const captured=[];let app;
  try {
    submit(1);scheduler.runTick();
    const App=await loadApp(captured,row);
    const snapshot={status:'live',stale:false,envelope:{epoch:7},error:null};
    const runtime={tileScheduler:scheduler,projectionView:{getProjection:()=>({rows:[row]}),getSnapshot:()=>snapshot,subscribe:()=>()=>{}},intentBuilders:{},controlRegistry:{},scheduler:{}};
    app=renderer().createApp(App,{runtime,layout:{},scope:{},storage:{readRaw:async()=>null,writeAtomic:async()=>{}}});app.mount({children:[]});
    assert.equal(captured.at(-1).state,'live');
    assert.ok(captured.at(-1).frame,'App must pass a completed frame witness');
    assert.equal(captured.at(-1).digest,'1'.repeat(64));
    const first=captured.at(-1).frame;
    submit(2);scheduler.runTick();await vue.nextTick();
    assert.notEqual(captured.at(-1).frame,first,'later scheduler presentation must update the mounted canvas');
    assert.equal(captured.at(-1).digest,'2'.repeat(64));
    row.generation=2;await vue.nextTick();assert.equal(captured.at(-1).frame,'','old lifetime witness cannot label a new surface live');
  } finally {app?.unmount();scheduler.destroy();globalThis.document=oldDocument;globalThis.window=oldWindow;delete globalThis.__mvuiEngineDeps;}
});


test('App without a runtime keeps its unavailable footer and creates no live canvas',async()=>{
  const oldDocument=globalThis.document,oldWindow=globalThis.window;
  globalThis.document={documentElement:{dataset:{}},getElementById:()=>null};
  globalThis.window={addEventListener(){},removeEventListener(){}};
  const captured=[];let app;
  try {
    const App=await loadApp(captured,null);
    const root={children:[]};
    app=renderer().createApp(App,{layout:{},scope:{},storage:{readRaw:async()=>null,writeAtomic:async()=>{}}});
    app.mount(root);
    function text(node){return [node.text??'',...(node.children??[]).map(text)].join(' ');}
    assert.match(text(root),/Core not connected/);
    assert.equal(captured.length,0);
  } finally {app?.unmount();globalThis.document=oldDocument;globalThis.window=oldWindow;delete globalThis.__mvuiEngineDeps;}
});
