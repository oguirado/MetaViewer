const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=process.env.P18F_BROWSER_ROOT;
if(!root?.startsWith('/tmp/claude-1000/xpra-spike/')||process.env.DISPLAY!==':97')throw Error('ISOLATION_REQUIRED');
app.setPath('userData',path.join(root,'config','p18f-browser'));app.setPath('sessionData',path.join(root,'session'));
if(!app.requestSingleInstanceLock()){console.error('SINGLE_INSTANCE');app.exit(7);}
else {
 console.log('P18F_BROWSER_LOCK_ISOLATED');
 const timer=setTimeout(()=>{console.error('BROWSER_TIMEOUT');app.exit(1);},55000);
 app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1600,height:1100,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  win.webContents.on('console-message',(_event,...args)=>console.log('RENDERER',...args));
  try {
   await win.loadFile(path.resolve(process.argv[2]));
   const outcomes=[];
   for(let count=1;!process.argv.includes('--controls-only')&&count<=5;count++)for(const preset of ['single','side-by-side','grid','focus-strip','floating']) {
    const result=await win.webContents.executeJavaScript(`window.p18fPrepare(${count},${JSON.stringify(preset)})`);outcomes.push(result);
    console.log('GEOMETRY',JSON.stringify(result));
    if(count===2||count===3){const file=path.resolve(process.argv[3],`preset-${count}-${preset}.png`);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,(await win.capturePage()).toPNG());}
   }
   const controls=await win.webContents.executeJavaScript('window.p18fControls()');
   console.log('CONTROLS',JSON.stringify(controls));
   const renumber=await win.webContents.executeJavaScript('window.p18fRenumber()');console.log('RENUMBER',JSON.stringify(renumber));
   const membership=await win.webContents.executeJavaScript('window.p18fMembership()');console.log('MEMBERSHIP',JSON.stringify(membership));
   const agentMove=await win.webContents.executeJavaScript('window.p18fAgentMove()');console.log('AGENT_MOVE',JSON.stringify(agentMove));
   fs.writeFileSync(path.resolve(process.argv[3],'browser-result.json'),JSON.stringify({outcomes,controls,renumber,membership,agentMove},null,2));
   clearTimeout(timer);win.destroy();app.exit(0);
  }catch(error){console.error(error.stack);clearTimeout(timer);win.destroy();app.exit(1);}
 });
}
