const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 await win.loadURL('http://127.0.0.1:5397/test/opfix-recording.html');
 const run=code=>win.webContents.executeJavaScript(code);
 const until=async code=>{for(let n=0;n<100;n++){if(await run(code))return;await new Promise(r=>setTimeout(r,50));}assert.fail('condition not reached: '+code);};
 await until(`globalThis.opfixDockApis?.get('main-wall-agent-1')?.()?.panels.length===4`);
 const before=await run(`JSON.stringify(opfixRoot.$.setupState.desktopState.assignments)`);
 await run(`document.querySelector('#desktop-add').click()`);
 await until(`document.querySelector('[data-desktop="agent-2"]')!==null`);
 // Emulate presentation loss through the same public API used by stale-panel
 // pruning. The host rows, capsule processes and assignments remain intact.
 await run(`opfixDockApis.get('main-wall-agent-1')().getPanel('panel-cap-01').api.close()`);
 await until(`!opfixDockApis.get('main-wall-agent-1')().getPanel('panel-cap-01')`);
 await run(`document.querySelector('#view-human').click()`);
 await run(`document.querySelector('#desktop-agent-1').click()`);
 await until(`!!opfixDockApis.get('main-wall-agent-1')().getPanel('panel-cap-01')`);
 assert.equal(await run(`JSON.stringify(opfixRoot.$.setupState.desktopState.assignments)`),before);
 await run(`opfixDockApis.get('main-wall-agent-1')().getPanel('panel-cap-02').api.close()`);
 await until(`!opfixDockApis.get('main-wall-agent-1')().getPanel('panel-cap-02')`);
 await run(`document.querySelector('#wall-refresh').click()`);
 await until(`!!opfixDockApis.get('main-wall-agent-1')().getPanel('panel-cap-02')`);
 assert.equal(await run(`JSON.stringify(opfixRoot.$.setupState.desktopState.assignments)`),before);
 assert.equal(await run(`opfixDockApis.get('main-wall-agent-2')().panels.length`),0);
 for(let n=0;n<5;n++){
  await run(`document.querySelector('#desktop-agent-2').click()`);
  await run(`document.querySelector('#view-human').click()`);
  await run(`document.querySelector('#desktop-agent-1').click()`);
  assert.equal(await run(`opfixDockApis.get('main-wall-agent-1')().panels.length`),4);
 }
 console.log('OPFIX_DESKTOPS_PASS');app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
