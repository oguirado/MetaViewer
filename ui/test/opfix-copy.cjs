const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 await win.loadURL(process.env.MV_OPFIX_URL||'http://127.0.0.1:5397/test/opfix-recording.html');
 let ready=false;
 for(let attempt=0;attempt<100;attempt++){
  ready=await win.webContents.executeJavaScript(`!!document.querySelector('#tile-cap-01-copy-id')`);
  if(ready)break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(ready,'copy button must mount');
 await win.webContents.executeJavaScript(`document.querySelector('#tile-cap-01-copy-id').click()`);
 const copied=await win.webContents.executeJavaScript(`globalThis.opfixCopiedText`);
 assert.equal(copied,'cap-01','copy click writes only the complete capsule identifier');
 const status=await win.webContents.executeJavaScript(`document.querySelector('.mv-tile-capid__status')?.textContent`);
 assert.equal(status,'Copied');
 console.log('OPFIX_COPY_PASS');
 app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
