import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createXpraHumanSession} from '../electron/xpraHumanSession.js';
import {createHumanTraceBuffer} from '../electron/humanTrace.js';
import {readFile,mkdtemp,rm,access,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
async function altered(file,from,to){const url=new URL(file,import.meta.url),source=await readFile(url,'utf8');assert(source.includes(from));const code=source.replace(from,to).replace(/from '\.\/identityProtection.js'/g,`from '${new URL('../electron/identityProtection.js',import.meta.url).href}'`);return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));}
test('H46/48 session close is single flight, closes trace once, and retries failed handles',async()=>{
 let bridges=0,tiles=0,traces=0;let release;
 const gate=new Promise(r=>release=r);
 const session=createXpraHumanSession({role:'human',setReadonly:async()=>true,openBridge:async()=>({close:async()=>{bridges++;await gate;if(bridges===1)throw Error('FAIL_ONCE');}}),showView:async()=>({resize(){},close:async()=>tiles++}),closeTrace:()=>traces++});
 await session.open();const a=session.close(),b=session.close();release();await assert.rejects(a,/XPRA_CLOSE_FAILED/);await assert.rejects(b,/XPRA_CLOSE_FAILED/);
 assert.equal(bridges,1);assert.equal(tiles,1);await session.close();assert.equal(bridges,2);assert.equal(traces,1);await session.close();assert.equal(traces,1);
});
test('H47 revoked replacement bridge remains available for retry when close fails',async()=>{
 let bridgeCount=0,recover,release,closes=0;
 const gate=new Promise(r=>release=r);
 const session=createXpraHumanSession({role:'human',setReadonly:async()=>true,
 openBridge:async()=>++bridgeCount===1?{isHealthy:async()=>false,close:async()=>{}}:(await gate,{close:async()=>{if(++closes===1)throw Error('FAIL_ONCE');}}),
 showView:async(_b,r)=>{recover=r;return {resize(){},close:async()=>{}};},closeTrace(){}});
 await session.open();const pending=recover();await new Promise(r=>setImmediate(r));const closing=session.close();release();await assert.rejects(pending);await closing;
 assert.equal(closes,2,'cleanup retries the retained revoked replacement');
});
test('H56 trace buffer refuses empty chunks without retaining them',()=>{
 const buffer=createHumanTraceBuffer(10);for(let i=0;i<100;i++)assert.throws(()=>buffer.write(''),/TRACE_EVENT_REFUSED/);assert.equal(buffer.bytes,0);
});
test('H54 failed trace export unlinks its partial file and can be retried',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p18g-export-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const api=await altered('../electron/humanTrace.js','await handle.sync();',"throw Error('INJECTED_SYNC_FAILURE');");
 const buffer=api.createHumanTraceBuffer();buffer.write('safe\n');const file=join(dir,'trace.jsonl');
 await assert.rejects(buffer.exportTo(file),/INJECTED_SYNC_FAILURE/);await assert.rejects(access(file),{code:'ENOENT'});
 const good=createHumanTraceBuffer();good.write('safe\n');await good.exportTo(file);assert.equal(await readFile(file,'utf8'),'safe\n');
});
test('H52 failed stage write unlinks its partial request so a retry succeeds',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p18g-stage-fail-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const api=await altered('../electron/openingMode.js','await handle.sync();',"throw Error('INJECTED_SYNC_FAILURE');");
 await assert.rejects(api.stageOpeningMode(dir,'fixture-owned','human'),/INJECTED_SYNC_FAILURE/);assert.deepEqual(await readdir(join(dir,'opening-modes')),[]);
});
