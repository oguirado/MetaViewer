// A malformed or cyclic parent chain must not spin the RoleSurface clip walk
// (1 Nov 2026: unbounded test graphs exhausted host memory).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';

const require = createRequire(import.meta.url);
const VUE_URL = pathToFileURL(require.resolve('vue')).href;

async function loadRoleSurfaceModule() {
  const source = readFileSync(new URL('../src/surfaces/RoleSurface.vue', import.meta.url), 'utf8');
  const compiled = compileScript(parse(source).descriptor, { id: 'role-ancestor-bound', inlineTemplate: true }).content;
  const code = compiled.replace(/from ["']vue["']/g, `from ${JSON.stringify(VUE_URL)}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const rect = () => ({ x: 0, y: 0, width: 100, height: 100 });

test('collectClipRects stops on a cyclic parent chain', async () => {
  const { collectClipRects } = await loadRoleSurfaceModule();
  const a = { getBoundingClientRect: rect }, b = { getBoundingClientRect: rect };
  a.parentElement = b; b.parentElement = a;
  const { scrollAncestors } = collectClipRects({ parentElement: a });
  assert.equal(scrollAncestors.length, 2);
});

test('collectClipRects visits at most MAX_ANCESTORS nodes of a deep chain', async () => {
  const { collectClipRects, MAX_ANCESTORS } = await loadRoleSurfaceModule();
  let node = { getBoundingClientRect: rect };
  for (let i = 0; i < 10_000; i++) node = { getBoundingClientRect: rect, parentElement: node };
  const { scrollAncestors } = collectClipRects({ parentElement: node });
  assert.equal(scrollAncestors.length, MAX_ANCESTORS);
});

test('P18G occlusion clips edge overlaps and hides disjoint or nonrectangular remainders',async()=>{
 const role=await loadRoleSurfaceModule(),bounds={x:0,y:0,width:100,height:100};
 assert.deepEqual(role.subtractRoleOccluders(bounds,[{x:60,y:0,width:100,height:100}]),{visible:true,bounds:{x:0,y:0,width:60,height:100}});
 assert.deepEqual(role.subtractRoleOccluders(bounds,[{x:0,y:0,width:100,height:100}]).visible,false);
 assert.deepEqual(role.subtractRoleOccluders(bounds,[{x:25,y:25,width:50,height:50}]).visible,false);
 assert.deepEqual(role.subtractRoleOccluders(bounds,[{x:40,y:0,width:20,height:100}]).visible,false);
 assert.deepEqual(role.subtractRoleOccluders(bounds,[{x:60,y:0,width:40,height:50},{x:60,y:50,width:40,height:50}]),{visible:true,bounds:{x:0,y:0,width:60,height:100}});
});
test('P18G floating occlusion follows z-index and DOM tie order',async()=>{
 const role=await loadRoleSurfaceModule();
 const a={z:1,getBoundingClientRect:rect},b={z:2,getBoundingClientRect:()=>({x:50,y:0,width:100,height:100})};
 const doc={querySelectorAll:()=>[a,b]},style=el=>({zIndex:String(el.z),display:'block',visibility:'visible'});
 const el={closest:()=>a};assert.deepEqual(role.floatingPresentation(el,doc,style).occluders,[b.getBoundingClientRect()]);
 a.z=3;assert.equal(role.floatingPresentation(el,doc,style).front,true);
 assert.deepEqual(role.floatingPresentation({closest:()=>null},doc,style).occluders.length,2);
});
test('P18G Dockview portal content maps to its sibling floating window by z-order',async()=>{
 const role=await loadRoleSurfaceModule();
 const back={z:999,getBoundingClientRect:rect},front={z:1001,getBoundingClientRect:rect},portal={z:1002,getBoundingClientRect:()=>({x:1,y:20,width:98,height:79})};
 const el={closest:s=>s==='.dv-render-overlay-float'?portal:null};
 const result=role.floatingPresentation(el,{querySelectorAll:()=>[back,front]},node=>({zIndex:String(node.z)}));
 assert.equal(result.front,true);assert.deepEqual(result.occluders,[]);
});
