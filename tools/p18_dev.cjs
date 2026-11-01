// Own dev MetaViewer only. No renderer capability or operator session is reused.
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {app} = electron;
const root = process.env.P18_ROOT;
if (!root?.startsWith('/tmp/claude-1000/xpra-spike/p18-live-') || fs.realpathSync(root)!==root || process.env.DISPLAY!==':97') throw Error('ISOLATION_REQUIRED');
app.setName('MetaViewer');
app.setAppPath(path.resolve(__dirname,'../ui'));
app.setPath('userData',path.join(root,'config','MetaViewer'));
app.setPath('sessionData',path.join(root,'electron-session'));
if (!app.requestSingleInstanceLock()) { console.error('SINGLE_INSTANCE'); app.exit(7); }
else {
 console.log('P18_DEV_LOCK_ISOLATED');
 let boot,closing=false;
 const close = async rc => {
  if(closing)return;closing=true;
  try{await boot?.dispose();}catch{rc=1;}
  app.exit(rc);
 };
 process.on('SIGTERM',()=>void close(0));
 app.on('window-all-closed',()=>{});
 (async()=>{
  const main=await import('../ui/electron/main.js');
  main.registerPrivilegedScheme(electron.protocol);
  const bindings=await main.loadMainBindings();
  boot=await main.bootProductionMain({core:bindings.core,wire:bindings.wire,adapter:bindings.adapter,
   electronVersion:process.versions.electron,app,BrowserWindow:electron.BrowserWindow,ipcMain:electron.ipcMain,
   protocol:electron.protocol,session:electron.session,argv:[],env:process.env,
   shellRoot:path.resolve(__dirname,'../ui'),runtime:{xdgRuntimeDir:process.env.XDG_RUNTIME_DIR,uid:process.getuid()},
   geometry:{width:1600,height:1000},bridge:main.createLayoutBridge({app})});
  const win=boot.window;
  console.log('P18_DEV_READY');
  fs.writeFileSync(path.join(root,'ready.json'),JSON.stringify({pid:process.pid}));
  let busy=false;
  setInterval(async()=>{
   const file=path.join(root,'request.json');
   if(busy||closing||!fs.existsSync(file))return;busy=true;
   let request;
   try {
    request=JSON.parse(fs.readFileSync(file));fs.unlinkSync(file);
    let result;
    if(request.op==='eval')result=await win.webContents.executeJavaScript(request.source);
    else if(request.op==='tile-status') {
     const child=win.contentView.children.find(v=>v.webContents?.getURL().includes('metaviewer-tile.html'));
     result=child ? await child.webContents.executeJavaScript(`(()=>{const w=document.getElementById('metaviewer-xpra-client').contentWindow;return {connected:w.client?.connected,readonly:w.client?.server_readonly,layout:w.client?.keyboard_layout,remoteWindows:Object.keys(w.client?.id_to_window||{}).length}})()`) : null;
    } else if(request.op==='pixel') {
     const child=win.contentView.children.find(v=>v.webContents?.getURL().includes('metaviewer-tile.html'));
     if(!child)throw Error('VIEW_ABSENT');
     result=[...(await child.webContents.capturePage({x:request.x,y:request.y,width:1,height:1})).getBitmap()];
    } else if(request.op==='quit') {result={closing:true};fs.writeFileSync(path.join(root,'reply.json'),JSON.stringify({id:request.id,result}));void close(0);return;}
    else throw Error('OP_REFUSED');
    fs.writeFileSync(path.join(root,'reply.json'),JSON.stringify({id:request.id,result}));
   } catch(error) {fs.writeFileSync(path.join(root,'reply.json'),JSON.stringify({id:request?.id,error:error.message}));}
   finally{busy=false;}
  },50);
 })().catch(error=>{console.error(error.message);void close(1);});
}
