import {build, mergeConfig} from 'vite';
import config from '../vite.config.js';
import {fileURLToPath} from 'node:url';
const mutant=process.argv.includes('--mutant-watch') ? 'watch' : process.argv.includes('--mutant-preset') ? 'preset' : null;
const mutation={name:'p18e-negative-control',enforce:'pre',transform(source,id){
  if(mutant==='watch' && id.endsWith('/src/surfaces/RoleSurface.vue')) {
    const anchor=":style=\"{visibility: watching ? 'hidden' : undefined}\"";
    if(!source.includes(anchor))throw Error('MUTATION_ANCHOR_ABSENT');
    return source.replace(anchor,'v-show="!watching"');
  }
  if(mutant==='preset' && id.endsWith('/src/wall/DesktopWorkspace.vue')) {
    const anchor='const result = walls.get(activeKey())?.setPreset(preset);';
    if(!source.includes(anchor))throw Error('MUTATION_ANCHOR_ABSENT');
    return source.replace(anchor,"const result = walls.get('human-1')?.setPreset(preset);");
  }
}};
const root=fileURLToPath(new URL('../',import.meta.url));
await build(mergeConfig(config,{root,configFile:false,plugins:[mutation],build:{
  outDir:fileURLToPath(new URL('../../.p18-evidence/p18e/browser'+(mutant?'-'+mutant:'')+'/renderer',import.meta.url)),
  emptyOutDir:true,rollupOptions:{input:fileURLToPath(new URL('./p18e-browser.html',import.meta.url))},
}}));
