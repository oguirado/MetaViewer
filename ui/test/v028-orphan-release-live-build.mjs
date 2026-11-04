import {build, mergeConfig} from 'vite';
import config from '../vite.config.js';
import {fileURLToPath} from 'node:url';
if(!process.env.MV_ORPHAN_LIVE_OUT)throw Error('MV_ORPHAN_LIVE_OUT_REQUIRED');
await build(mergeConfig(config,{root:fileURLToPath(new URL('../',import.meta.url)),configFile:false,
  build:{outDir:process.env.MV_ORPHAN_LIVE_OUT,emptyOutDir:true,rollupOptions:{input:fileURLToPath(new URL('./v028-orphan-release-live.html',import.meta.url))}}}));
