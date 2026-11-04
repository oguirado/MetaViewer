const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 await win.loadURL(process.env.MV_OPFIX_URL||'http://127.0.0.1:5397/test/opfix-recording.html');
 for(let attempt=0;attempt<100;attempt++){
  if(await win.webContents.executeJavaScript(`document.querySelectorAll('.mv-tile-chrome__badge--header').length===4`))break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 const results=[];
 for(const width of [1280,960,760]){
  win.setSize(width,850);
  await new Promise(resolve=>setTimeout(resolve,200));
  for(const expanded of [false,true]){
  await win.webContents.executeJavaScript(`document.querySelectorAll('.mv-tile').forEach(tile=>{const header=tile.querySelector('.cuk-capsule-panel__header');${expanded ? "header.dispatchEvent(new PointerEvent('pointermove',{bubbles:true}))" : "tile.dispatchEvent(new PointerEvent('pointerleave'))"}})`);
  await new Promise(resolve=>setTimeout(resolve,100));
  const rows=await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.mv-tile-chrome__badge--header')).map(b=>{
   const tile=b.closest('.mv-tile'), r=b.getBoundingClientRect(),t=tile.getBoundingClientRect();
   const range=document.createRange();range.selectNodeContents(b);const text=range.getBoundingClientRect();
   const controls=Array.from(tile.querySelectorAll('.cuk-capsule-panel__actions button')).filter(e=>getComputedStyle(e).visibility==='visible' && e.getBoundingClientRect().width>0).map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};});
   return {text:b.textContent,expanded:tile.dataset.chromeExpanded,lines:range.getClientRects().length,clientWidth:b.clientWidth,scrollWidth:b.scrollWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,textRight:text.right,tileLeft:t.left,tileRight:t.right,controls};
  })`);
  assert.ok(rows.every(row=>row.expanded===String(expanded)),'requested header expansion must be observed');
  results.push(...rows);
  }
 }
 assert.equal(results.length,24,'all production recording badges must mount');
 for(const row of results){
  assert.equal(row.text,'Recording 02:05');
  assert.equal(row.lines,1,'recording label stays on one line');
  assert.ok(row.controls.length>0,'tile menu remains visible');
  assert.ok(row.scrollWidth<=row.clientWidth,'recording time is clipped: '+JSON.stringify(row));
  assert.ok(row.textRight<=row.right+.5,'recording text overflows: '+JSON.stringify(row));
  assert.ok(row.left>=row.tileLeft-.5 && row.right<=row.tileRight+.5,'badge leaves tile: '+JSON.stringify(row));
  for(const control of row.controls){
   assert.ok(control.width>0 && control.left>=row.tileLeft-.5 && control.right<=row.tileRight+.5,'control leaves tile: '+JSON.stringify(row));
   assert.ok(control.right<=row.left || control.left>=row.right || control.bottom<=row.top || control.top>=row.bottom,'recording label overlaps a control: '+JSON.stringify(row));
  }
 }
 console.log('OPFIX_RECORDING_PASS '+JSON.stringify(results));
 if(process.env.MV_OPFIX_HOLD)return;
 app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
