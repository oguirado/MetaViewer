const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 for(const dialog of ['identities','demo']){
  await win.loadURL(`http://127.0.0.1:5397/test/opfix-examples.html?dialog=${dialog}`);
  let result;
  for(let n=0;n<100;n++){
   result=await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('input')).map(e=>e.placeholder)`);
   if(result.includes(dialog==='demo'?'meta-ai':'dev.meta.ai, example.com'))break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(result.includes(dialog==='demo'?'meta-ai':'dev.meta.ai, example.com'),'rendered Meta site example');
  assert.ok(!result.some(value=>/perplexity|pplx/.test(value)));
 }
 console.log('OPFIX_EXAMPLES_PASS');app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
