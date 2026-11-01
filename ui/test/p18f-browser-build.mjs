import {build,mergeConfig} from 'vite';
import config from '../vite.config.js';
import {fileURLToPath} from 'node:url';
const mutant=process.env.P18F_MUTANT;
const mutation={name:'p18f-negative-control',enforce:'pre',transform(source,id){
 if(mutant==='handoff' && id.endsWith('/src/surfaces/RoleSurface.vue')) {
  const anchor='if (!transferring) void revoke();';
  if(!source.includes(anchor))throw Error('MUTATION_ANCHOR_ABSENT');
  return source.replace(anchor,'void revoke();');
 }
}};
await build(mergeConfig(config,{root:fileURLToPath(new URL('../',import.meta.url)),configFile:false,plugins:[mutation],build:{outDir:fileURLToPath(new URL('../../.p18f-evidence/browser'+(mutant?'-'+mutant:'')+'/renderer',import.meta.url)),emptyOutDir:true,rollupOptions:{input:fileURLToPath(new URL('./p18f-browser.html',import.meta.url))}}}));
