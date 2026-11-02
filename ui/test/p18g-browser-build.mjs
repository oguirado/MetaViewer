import {build,mergeConfig} from 'vite';
import config from '../vite.config.js';
import {fileURLToPath} from 'node:url';
await build(mergeConfig(config,{configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),build:{outDir:fileURLToPath(new URL('../../.p18c-evidence/p18g/renderer',import.meta.url)),emptyOutDir:true,rollupOptions:{input:fileURLToPath(new URL('./p18g-browser.html',import.meta.url))}}}));
