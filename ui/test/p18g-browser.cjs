const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=process.env.P18G_BROWSER_ROOT;
if(!root?.startsWith('/tmp/claude-1000/xpra-spike/')||process.env.DISPLAY!==':97')throw Error('ISOLATION_REQUIRED');
app.setPath('userData',path.join(root,'config','p18g'));app.setPath('sessionData',path.join(root,'session'));
if(!app.requestSingleInstanceLock()){console.error('SINGLE_INSTANCE');app.exit(7);}
else {
 console.log('P18G_LOCK_ISOLATED');const timer=setTimeout(()=>{console.error('TIMEOUT');app.exit(1);},55000);
 app.whenReady().then(async()=>{
 const {attachXpraHumanTile}=await import(process.env.P18G_TILE_SOURCE || '../electron/xpraHumanTile.js');const {xpraTileDocument}=await import('../electron/xpraClient.js');
 const win=new BrowserWindow({width:1600,height:1100,show:true,webPreferences:{preload:path.join(__dirname,'p18g-preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
 const tiles=new Map(),servers=[];let failure=null;
 win.webContents.on('console-message',(_e,...args)=>console.log('RENDERER',...args));
 ipcMain.handle('p18g:fixture',async(event,op,id,value)=>{
 if(event.sender!==win.webContents||!['red','blue'].includes(id))throw Error('SENDER_REFUSED');
 if(op==='status')return {ok:true,role:'human',view:{state:tiles.has(id)?'ready':'closed'}};
 if(op==='mount'){
  const server=http.createServer((q,r)=>{r.setHeader('Content-Type','text/html');if(q.url.startsWith('/metaviewer-tile.html'))r.end(xpraTileDocument);else r.end(`<html style="margin:0;background:${id==='red'?'rgb(220,40,40)':'rgb(40,80,220)'}"><canvas width="1280" height="900"></canvas><script>window.client={connected:true,server_ok:true,server_readonly:false,desktop_width:1280,desktop_height:900,id_to_window:{1:{}}};const c=document.querySelector('canvas');c.getContext('2d').fillStyle='${id==='red'?'rgb(220,40,40)':'rgb(40,80,220)'}';c.getContext('2d').fillRect(0,0,1280,900);</script>`);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);
  const tile=await attachXpraHumanTile({electron:require('electron'),window:win,bridge:{origin:'http://127.0.0.1:'+server.address().port,requestHeaders:{}},bounds:value,trace:{setActive(){},record(){}},isActive:()=>true,writable:true,initiallyVisible:false,capsuleSize:()=>({width:1280,height:900}),onFailure:e=>failure=e,onFocus:()=>win.webContents.send('p18g:focus',id)});
  tiles.set(id,tile);return {ok:true,role:'human',visible:false};
 }
 const tile=tiles.get(id);if(op==='resize')tile?.resize(value);else if(op==='visibility')tile?.setVisible(value);else if(op==='raise')tile?.bringToFront();else if(op==='close'){await tile?.close();tiles.delete(id);}return {ok:true};
 });
 try {
 await win.loadFile(path.resolve(process.argv[2]));await win.webContents.executeJavaScript('window.p18gReady()');
 const outcomes=[];fs.mkdirSync(path.resolve(process.argv[3]),{recursive:true});
 for(const id of ['red','blue','red']){
  const geometry=await win.webContents.executeJavaScript(`window.p18gFocus(${JSON.stringify(id)})`);
  await new Promise(r=>setTimeout(r,300));const top=tiles.get(id);if(!top||!top.view.getVisible())throw Error('FRONT_NOT_VISIBLE '+id+' '+JSON.stringify({geometry,tiles:[...tiles].map(([id,t])=>({id,visible:t.view.getVisible(),bounds:t.view.getBounds()})),failure,debug:await win.webContents.executeJavaScript('window.p18gDebug()'),native:await Promise.all(win.contentView.children.filter(v=>v.webContents).map(async v=>({url:v.webContents.getURL(),state:await v.webContents.executeJavaScript(`(()=>{const f=document.querySelector('iframe');return {iframe:!!f,width:f?.contentWindow?.innerWidth,height:f?.contentWindow?.innerHeight,client:f?.contentWindow?.client,canvas:f?.contentDocument?.querySelector('canvas')?.width};})()`).catch(()=>null)}))),dom:await win.webContents.executeJavaScript("document.body.innerText")}));
  const expectedLayout=await win.webContents.executeJavaScript('window.p18gOcclusion()');
  for(const expected of expectedLayout){const tile=tiles.get(expected.id);if(!!tile?.view.getVisible()!==expected.visible)throw Error('OCCLUSION_VISIBILITY_WRONG '+JSON.stringify(expected));if(expected.visible && JSON.stringify(tile.view.getBounds())!==JSON.stringify(expected.bounds))throw Error('OCCLUSION_BOUNDS_WRONG');}
  if(win.contentView.children.at(-1)!==top.view)throw Error('NATIVE_ORDER_WRONG');
  const file=path.resolve(process.argv[3],`floating-${outcomes.length}-${id}.png`);require('node:child_process').execFileSync('python3',['-c',"from PIL import ImageGrab;import sys;ImageGrab.grab(xdisplay=':97').save(sys.argv[1])",file]);
  const b=top.view.getBounds(),origin=win.getContentBounds(),screen=require('electron').nativeImage.createFromPath(file),pixel=screen.crop({x:origin.x+b.x+Math.floor(b.width/2),y:origin.y+b.y+Math.floor(b.height/2),width:1,height:1}).getBitmap();
  const expected=id==='red'?[40,40,220]:[220,80,40];if(!expected.every((v,i)=>Math.abs(v-pixel[i])<3))throw Error('PAINT_WRONG '+id+' '+[...pixel]);
  outcomes.push({id,geometry,pixel:[...pixel],nativeOrder:win.contentView.children.map(v=>[...tiles].find(([,t])=>t.view===v)?.[0]||'renderer'),screenshot:file});
 }
 if(failure)throw failure;fs.writeFileSync(path.resolve(process.argv[3],'paint-result.json'),JSON.stringify(outcomes,null,2));console.log('PAINT_VERIFIED',JSON.stringify(outcomes));
 clearTimeout(timer);for(const tile of tiles.values())await tile.close();for(const server of servers)await new Promise(r=>server.close(r));win.destroy();app.exit(0);
 }catch(e){console.error(e.stack);clearTimeout(timer);for(const tile of tiles.values())await tile.close();for(const server of servers)server.close();win.destroy();app.exit(1);}
 });
}
