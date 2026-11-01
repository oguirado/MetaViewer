// The input suites use the real role menu as the emergency-control entry.
// Native transport is a separate seam, exercised by xpra-role-tiles and P18B.
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';

const priorApi = globalThis.metaviewerRoles;
const source = readFileSync(new URL('../src/surfaces/RoleSurface.vue',import.meta.url),'utf8');
const compiled = compileScript(parse(source).descriptor,{id:'role-menu-input',inlineTemplate:true}).content
  .replace(/from ['"]vue['"]/g,'from '+JSON.stringify(import.meta.resolve('vue')));
const RoleSurface = (await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'))).default;

export function installRoleMenuInput(t, app) {
  globalThis.metaviewerRoles = {status:async()=>({role:'agent',view:{state:'closed'}}),close:async()=>({ok:true})};
  app.component('RoleSurface',RoleSurface);
  t.after(()=>{globalThis.metaviewerRoles=priorApi;});
}

export async function openRoleMenuInput(root) {
  const walk=node=>[node,...(node.children||[]).flatMap(walk)];
  for(const node of walk(root)) if(node.props?.class==='mv-role-menu-button') node.props.onClick();
  await vue.nextTick();
}
