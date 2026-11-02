import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse, compileScript } from '@vue/compiler-sfc';

const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
const canvasSource = readFileSync(new URL('../src/surfaces/SurfaceCanvas.vue', import.meta.url), 'utf8');
const launcherSource = readFileSync(new URL('../src/catalog/CatalogLauncher.vue', import.meta.url), 'utf8');
// Scrubbed witness; all field names and the event order follow the live tool/DOM.
const toolRow = {xid:4194311,witness:'scrubbed-window-witness',pid:3500288,exe:'gnome-mines',class:'Gnome-mines',title:'Minas',rect:{x:289,y:72,width:821,height:855},visible:true,minimized:false,window_type:'normal'};
function snippets(source) {
  const descriptor = parse(source).descriptor;
  const ast = compileScript(descriptor, {id:'window-polish'}).scriptSetupAst;
  const script = descriptor.scriptSetup.content;
  return {
    fn: name => { const node = ast.find(n => n.type === 'FunctionDeclaration' && n.id.name === name); assert.ok(node, name); return script.slice(node.start,node.end); },
    variable: name => { const node = ast.find(n => n.type === 'VariableDeclaration' && n.declarations.some(d => d.id.name === name)); assert.ok(node, name); return script.slice(node.start,node.end); },
  };
}
async function titleProbe(source) {
  const code = snippets(source);
  const surface = {schema:'surface/v0.2',surface_id:'surface-mines',profile_id:'hw-400007',state:'active',control:'human'};
  const baseRow = {id:surface.surface_id,title:surface.profile_id,profile_id:surface.profile_id,generation:7,control:'human'};
  const modes = [];
  const ctx = vm.createContext({
    nativePolling:false,hostActive:true,nativeLoaded:false,nativePollFailed:false,nativeRevision:0,
    nativeApi:{surfaces:async()=>[{schema:'metaviewer.role_surface/v0.3',role:'agent',surface,hostWindow:{title:toolRow.title,program:toolRow.exe}}]},
    nativeRows:{value:[]},nativeListeners:new Set(),baseFeed:{getProjection:()=>({rows:[baseRow]})},
    onCapsuleMode: e=>modes.push(e),nativeSnapshot:()=>({}),
  });
  vm.runInContext(code.variable('mergedRows')+'\n'+code.fn('pollNativeSurfaces')+'\nglobalThis.readRows=mergedRows;',ctx);
  await ctx.pollNativeSurfaces();
  const row = ctx.readRows()[0];
  assert.equal(row.title,'Minas');
  assert.equal(row.hostWindow.program,'gnome-mines');
  assert.equal(row.profile_id,'hw-400007');
  assert.equal(row.generation,7);
  assert.equal(modes[0].mode,'agent');
  // Human native rows also use the title when there is no base projection row.
  ctx.baseFeed.getProjection=()=>({rows:[]});
  assert.equal(ctx.readRows()[0].title,'Minas');
}
function inputProbe(source, scrollEnabled) {
  const code = snippets(source), calls = [];
  const ctx = vm.createContext({
    props:{surfaceId:'surface-mines',streamId:1,inputEnabled:true,scrollEnabled},
    inputPort:{available:true,queue:(_sid,_stream,event)=>calls.push(event)},
    inputGateOpen:()=>true,focusCanvas:()=>{},resolvedState:{value:'live'},emit:()=>{},
    clientToFramePoint:()=>({x:410,y:427}),POINTER_BUTTONS:['left','middle','right'],showEcho:()=>{},
    canvasFocused:{value:true},closeInputGate:()=>{},
  });
  vm.runInContext('let activePress=null;\n'+['onCanvasPointerDown','onCanvasPointerUp','onCanvasClick','onCanvasWheel','onCanvasBlur'].map(code.fn).join('\n'),ctx);
  const event = {pointerId:1,button:0,preventDefault(){},deltaX:0,deltaY:120};
  ctx.onCanvasPointerDown(event);
  ctx.onCanvasPointerUp(event);
  ctx.onCanvasClick(event);
  ctx.onCanvasWheel(event);
  ctx.onCanvasBlur(event);
  assert.equal(calls[0].kind,'click');
  assert.equal(calls[0].x,410);
  assert.equal(calls.length,scrollEnabled ? 2 : 1);
  if (scrollEnabled) assert.equal(calls[1].kind,'scroll');
}
test('window title replaces private profile label without changing binding or control', async()=>{
  await titleProbe(appSource);
  const mutant = appSource.replace('hostWindow?.title || s.profile_id','s.profile_id');
  assert.notEqual(mutant,appSource);
  await assert.rejects(titleProbe(mutant),assert.AssertionError);
});
test('desktop window click/wheel/blur sequence forwards only supported input; ordinary capsules keep scroll',()=>{
  inputProbe(canvasSource,false);
  inputProbe(canvasSource,true);
  const mutant = canvasSource.replace('if (!props.scrollEnabled) return;','');
  assert.notEqual(mutant,canvasSource);
  assert.throws(()=>inputProbe(mutant,false),assert.AssertionError);
  // Verify the actual wall binding selects the capability from host metadata.
  assert.match(appSource,/:scroll-enabled="!surface.hostWindow"/);
  assert.match(appSource,/:scroll-enabled="!selectedSurface.hostWindow"/);
});
test('picker exposes keyboard selection, separate labels, and visible selected styling',()=>{
  const descriptor = parse(launcherSource).descriptor;
  const row = descriptor.template.content.match(/<button\s+[\s\S]*?class="mv-window-row"[\s\S]*?<\/button>/)?.[0];
  assert.ok(row);
  assert.match(row,/:aria-selected="windowChoiceXid === win.xid"/);
  assert.match(row,/type="button"/);
  assert.match(row,/@click="selectWindowRow\(win.xid\)"/);
  assert.doesNotMatch(row,/keydown/);
  const css = descriptor.styles.map(s=>s.content).join('\n');
  assert.match(css,/\.mv-window-row\s*\{[^}]*display:flex;[^}]*gap:1rem/);
  assert.match(css,/\.mv-window-row--selected\s*\{[^}]*background:Highlight;[^}]*color:HighlightText/);
});
