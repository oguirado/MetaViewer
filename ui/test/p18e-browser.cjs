const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const root=process.env.P18E_BROWSER_ROOT;
if(!root?.startsWith('/tmp/claude-1000/xpra-spike/')||process.env.DISPLAY!==':97')throw Error('ISOLATION_REQUIRED');
app.setPath('userData',path.join(root,'config','restore-test'));
app.setPath('sessionData',path.join(root,'session'));
if(!app.requestSingleInstanceLock()){console.error('SINGLE_INSTANCE');app.exit(7);}
else {
 console.log('P18E_BROWSER_LOCK_ISOLATED');
 const timer=setTimeout(()=>{console.error('RESTORE_TEST_TIMEOUT');app.exit(1);},45000);
 app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1280,height:900,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  win.webContents.on('console-message',(_event,...args)=>console.log('RENDERER',...args));
  try{
   await win.loadFile(path.resolve(process.argv[2]));
   const result=await win.webContents.executeJavaScript('window.p18eBrowser()');
   console.log(JSON.stringify(result));clearTimeout(timer);win.destroy();app.exit(0);
  }catch(error){console.error(error.stack);clearTimeout(timer);win.destroy();app.exit(1);}
 });
}
