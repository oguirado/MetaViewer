import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'vite';

test('tile chrome fits narrow containers and keeps wide controls',async t=>{
  const temp=await mkdtemp(join(tmpdir(),'mv-tile-chrome-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const server=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),cacheDir:join(temp,'vite'),server:{host:'127.0.0.1',port:0},optimizeDeps:{noDiscovery:true,include:[]}});
  t.after(()=>server.close());await server.listen();
  const port=server.httpServer.address().port;
  const child=spawn(process.env.CHROME_BIN || 'google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--disable-background-networking',`--user-data-dir=${join(temp,'chrome')}`,'--dump-dom','--virtual-time-budget=12000',`http://127.0.0.1:${port}/test/v027-tile-chrome.html`]);
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  let out='',err='';child.stdout.on('data',x=>{out+=x;});child.stderr.on('data',x=>{err=(err+x).slice(-3000);});
  const rc=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(rc,0,err);
  const body=out.match(/<body[^>]*>/)?.[0] || out.slice(-1000);
  assert.ok(body.includes('data-verdict="pass"'),body);
  t.diagnostic(body);
});
