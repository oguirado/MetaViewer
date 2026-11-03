const {app,BrowserWindow}=require('electron');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
app.whenReady().then(async()=>{
  const source=readFileSync(path.join(__dirname,'../src/wall/WallWorkspace.vue'),'utf8');
  let fit=source.slice(source.indexOf('  function fitAllocation('),source.indexOf('  function rememberFloatingBounds('));
  if(process.env.MV_CONSTRAINT_NEGATIVE) fit=fit.replace(/\(target\.group \?\? target\)\.api\?\.setConstraints\?\.\(\{[\s\S]*?\}\);/,'');
  const css=readFileSync(path.join(__dirname,'../node_modules/dockview-vue/dist/styles/dockview.css'),'utf8');
  const win=new BrowserWindow({width:800,height:600,webPreferences:{nodeIntegration:true,contextIsolation:false}});
  await win.loadURL('data:text/html,'+encodeURIComponent(`<style>${css}html,body{margin:0}#host{width:600px;height:400px}</style><div id="host"></div>`));
  const result=await win.webContents.executeJavaScript(`(async()=>{
    const {createDockview,registerModules,FloatingGroupModule}=require(${JSON.stringify(require.resolve('dockview-core'))});
    registerModules([FloatingGroupModule]);
    const api=createDockview(document.getElementById('host'),{createComponent:()=>({element:document.createElement('div'),init(){}})});
    api.layout(600,400);
    const panel=api.addPanel({id:'a',component:'test',minimumWidth:240,minimumHeight:200});
    api.addFloatingGroup(panel,{position:{left:0,top:0},width:202,height:300});
    await new Promise(requestAnimationFrame);
    const before=panel.group.width;
    const WALL_PANEL_MIN_WIDTH=240,WALL_PANEL_MIN_HEIGHT=200;
    ${fit}
    fitAllocation(panel.group,202,300);
    api.addFloatingGroup(panel.group,{position:{left:0,top:0},width:202,height:300});
    await new Promise(requestAnimationFrame);
    const after=panel.group.width;
    const minimum=panel.group.minimumWidth;
    api.dispose();return {before,after,minimum};
  })()`);
  assert.equal(result.before,240,'negative witness: panel minimum overflows a 202px float');
  assert.equal(result.after,202,'group constraint must fit native/DOM content inside the allocated cell');
  assert.equal(result.minimum,202);
  console.log('FLOATING_CONSTRAINTS_OK',JSON.stringify(result));app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
