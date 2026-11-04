// Production launcher, synthetic inventory, real owned X11 windows. This
// isolates renderer focus handling; it does not emulate the capsule backend.
const {app,BrowserWindow,ipcMain}=require('electron');
const {spawn,spawnSync}=require('node:child_process');
const {join}=require('node:path');
const assert=require('node:assert/strict');
const children=[];
let launches=0;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let n=0;n<100;n++){if(await check())return;await wait(30);}assert.fail(label);}
ipcMain.handle('opfix-launch',async(_event,intent)=>{
 assert.equal(intent.kind,'host-program');assert.equal(intent.binary,'xmessage');
 if(process.env.MV_OPFIX_DROP_CREATE)return {ok:false,reason:'Synthetic dropped launch'};
 const title='Owned launcher probe-'+(children.length+1);
 const child=spawn('/usr/bin/xmessage',['-title',title,'-buttons','Close:0','Graphical launch reached X11 without an outside click'],{stdio:'ignore'});
 children.push(child);
 await until(()=>{
  const found=spawnSync('xdotool',['search','--name','^'+title+'$'],{encoding:'utf8'});
  if(found.status!==0)return false;
  const xid=found.stdout.trim().split('\n')[0];
  return /Map State: IsViewable/.test(spawnSync('xwininfo',['-id',xid],{encoding:'utf8'}).stdout);
 },'owned graphical window must map');
 launches++;return {ok:true};
});
app.on('before-quit',()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:850,webPreferences:{preload:join(__dirname,'opfix-launcher-preload.cjs'),contextIsolation:true,nodeIntegration:false}});
 const other=new BrowserWindow({width:300,height:160,show:false});
 await other.loadURL('data:text/html,<p>Owned focus-change window</p>');
 await win.loadURL('http://127.0.0.1:5397/test/opfix-launcher.html');
 const run=code=>win.webContents.executeJavaScript(code);
 const click=async id=>{
  await until(()=>run(`!!document.getElementById(${JSON.stringify(id)})`),'control must mount: '+id);
  const box=await run(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...box});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...box});
  await wait(80);
 };
 for(const opener of ['probe-add','probe-launcher']){
  other.show();other.focus();await until(()=>other.isFocused(),'secondary window must gain focus');
  win.focus();await until(()=>win.isFocused(),'launcher must regain focus');
  await click(opener);
  await click('shell/new-capsule/card-app-0123456789abcdef01234567');
  await click('shell/new-capsule/create');
  await click('shell/new-capsule/program-start');
  await until(()=>launches>0,'launch must arrive without an outside click');
  await until(()=>run(`!document.getElementById('shell/new-capsule/program-start')`),'program dialog must close');
  console.log('OPFIX_FOCUS_PASS '+opener);
  if(!process.env.MV_OPFIX_HOLD || opener==='probe-add'){
   for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');
  }
  launches=0;
 }
 other.close();
 if(!process.env.MV_OPFIX_HOLD)app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
