// [TARGET, unit decision] Exercise the shipped display entry from a scratch app
// with its own built renderer/preload; never grant a core or native capsule.
import * as electron from 'electron';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { enterNested, startDisplay } from '../../ui/electron/nesting.js';
import { registerPrivilegedScheme } from '../../ui/electron/main.js';

const { app } = electron;
const [reportPath, depthFlag] = process.argv.slice(-2);
app.setPath('userData', join(dirname(reportPath), 'profile-' + depthFlag.at(-1)));
app.enableSandbox();
registerPrivilegedScheme(electron.protocol);
let calls = 0;
const watchdog = setTimeout(() => app.exit(2), 25000);
async function probe() {
  try {
    const win = await enterNested([depthFlag], {}, () => { calls++; return startDisplay(electron); });
    const renderer = await win.webContents.executeJavaScript(`(async()=>{
      let saveRefused=false;try{await window.metaviewer.save('{}')}catch(error){saveRefused=String(error).includes('DISPLAY_ONLY')}
      const blocked=[];
      for(const call of [()=>window.metaviewer.authority.intent('{}'),
        ()=>window.metaviewer.authority.propose('{}'),()=>window.metaviewer.sideTerminal.setEnabled(true)]) {
        try{await call();blocked.push(false)}catch(error){blocked.push(String(error).includes('DISPLAY_ONLY'))}
      }
      return {node:typeof window.require,layout:await window.metaviewer.load(),saveRefused,
        depth:await window.metaviewer.nestedDepth(),settings:await window.metaviewer.loadSettings(),blocked,
        settled:!!document.querySelector('.metaviewer[data-wall-settled="true"]')};
    })()`);
    writeFileSync(reportPath, JSON.stringify({ status: 'ready', calls, renderer }));
    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) {
    writeFileSync(reportPath, JSON.stringify({ status: 'refused', calls, error: String(error) }));
    console.error(String(error));
    clearTimeout(watchdog);
    app.exit(1);
  }
}
void probe();
