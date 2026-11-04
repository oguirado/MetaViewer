const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 const run=code=>win.webContents.executeJavaScript(code);
 const until=async code=>{for(let n=0;n<100;n++){if(await run(code))return;await new Promise(r=>setTimeout(r,50));}assert.fail(code);};
 for(const arch of ['arm64','x64']){
  await win.loadURL(`http://127.0.0.1:5397/test/opfix-launcher.html?arch=${arch}`);
  await until(`!!document.querySelector('[data-semantic-anchor="dialog/new-capsule/category-windows"]')`);
  await run(`document.querySelector('[data-semantic-anchor="dialog/new-capsule/category-windows"]').click()`);
  const cards=await run(`['vm','microvm'].map(kind=>{const e=document.getElementById('shell/new-capsule/card-'+kind);return e?{disabled:e.disabled,card:e.classList.contains('s8n-card'),grid:!!e.closest('.s8n-grid'),text:e.textContent,reason:document.getElementById(e.getAttribute('aria-describedby'))?.textContent}:null})`);
  if(arch==='x64'){assert.deepEqual(cards,[null,null]);continue;}
  for(const card of cards){assert.ok(card,'ARM entry must be a real card in Windows');assert.ok(card.disabled && card.card && card.grid);assert.match(card.reason,/Complete ARM64 capsule setup/);assert.match(card.text,/Enable:.*local assets/);}
  const created=await run(`(()=>{document.getElementById('shell/new-capsule/card-vm').click();document.getElementById('shell/new-capsule/card-microvm').click();return !!document.querySelector('[data-semantic-anchor="dialog/new-capsule/type-vm"][aria-pressed="true"], [data-semantic-anchor="dialog/new-capsule/type-microvm"][aria-pressed="true"]')})()`);
  assert.equal(created,false,'disabled ARM cards cannot be selected');
  await run(`(()=>{const e=document.getElementById('shell/new-capsule/search');e.value='microvm';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(`document.querySelectorAll('.s8n-card').length===1`);
  assert.equal(await run(`document.getElementById('shell/new-capsule/create').disabled`),true,'an unavailable-only search cannot create');
  await run(`document.getElementById('shell/new-capsule/search').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  assert.equal(await run(`document.querySelector('main > p[role="status"]').textContent`),'No launch requested','Enter cannot launch a disabled-only match');
 }
 console.log('OPFIX_ARM_CARDS_PASS');app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
