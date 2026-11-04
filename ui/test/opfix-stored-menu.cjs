const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 const run=code=>win.webContents.executeJavaScript(code);
 const until=async code=>{for(let n=0;n<100;n++){if(await run(code))return;await new Promise(r=>setTimeout(r,50));}assert.fail(code);};
 await win.loadURL('http://127.0.0.1:5397/test/opfix-stored-menu.html');
 await until(`!!document.getElementById('tile-state-save-cap-01')`);
 await run(`document.getElementById('tile-menu-cap-01').click()`);
 await until(`!!document.getElementById('tile-stored-data-cap-01')`);
 await run(`document.getElementById('tile-stored-data-cap-01').click()`);
 await until(`!!document.querySelector('[aria-label="Stored data for work-account"]')`);
 assert.equal(await run(`!!document.getElementById('tile-actions-cap-01')`),false,'menu closes after routing');
 assert.deepEqual(await run(`globalThis.opfixSlotRequests`),[],'opening management does not save or load');
 assert.equal(await run(`Array.from(document.querySelectorAll('.stored-data-slots button')).every(button=>button.disabled)`),true,'active capsule retains the stopped-only guard');
 console.log('OPFIX_STORED_MENU_PASS');app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
