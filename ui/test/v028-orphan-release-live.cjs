const {app,BrowserWindow,Menu}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const root=process.env.MV_ORPHAN_LIVE_ROOT;
if(!root || process.env.DISPLAY!==':98')throw Error('ISOLATED_DISPLAY_REQUIRED');
app.setPath('userData',path.join(root,'user-data'));
app.setPath('sessionData',path.join(root,'session'));
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1200,height:900,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'File',submenu:[{label:'Quit',accelerator:'Ctrl+Q',click:()=>app.quit()}]}]));
  win.webContents.on('console-message',(_e,...args)=>console.log('RENDERER',...args));
  await win.loadFile(process.env.MV_ORPHAN_LIVE_HTML);
  // Test-only owned process hook: inspect real DOM and painted dimensions.
  const timer=setInterval(async()=>{
    const request=path.join(root,'request.json');
    if(!fs.existsSync(request))return;
    const {source}=JSON.parse(fs.readFileSync(request));fs.unlinkSync(request);
    try {fs.writeFileSync(path.join(root,'reply.json'),JSON.stringify(await win.webContents.executeJavaScript(source)));}
    catch(error){fs.writeFileSync(path.join(root,'reply.json'),JSON.stringify({error:String(error)}));}
  },100);
  app.on('before-quit',()=>clearInterval(timer));
  console.log('ORPHAN_LIVE_READY');
});
