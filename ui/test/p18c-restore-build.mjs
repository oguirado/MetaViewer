import {build, mergeConfig} from 'vite';
import config from '../vite.config.js';
import {fileURLToPath} from 'node:url';
const mutant=process.argv.includes('--mutant');
const root=fileURLToPath(new URL('../',import.meta.url));
const mutation={name:'p18c-original-leaf-root-mutant',enforce:'pre',transform(source,id){
  if(!mutant||!id.endsWith('/electron/desktopLayout.js'))return;
  const before=source;
  source=source.replace("if (root.type === 'leaf')",'if (false)');
  source=source.replace("{type:'branch',size,data:[{type:'leaf',size,data:{id,views:[]}}]}","{type:'leaf',data:{id,views:[]}}");
  if(source===before)throw Error('MUTANT_NOT_APPLIED');
  return source;
}};
await build(mergeConfig(config,{root,configFile:false,plugins:[mutation],build:{
  outDir:fileURLToPath(new URL(mutant?'../../.p18c-evidence/restore-mutant/renderer':'../../.p18c-evidence/restore/renderer',import.meta.url)),
  emptyOutDir:true,rollupOptions:{input:fileURLToPath(new URL('./p18c-restore.html',import.meta.url))},
}}));
