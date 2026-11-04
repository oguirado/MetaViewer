import test from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,stat,readdir,rm,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {defaultCapturePreferences,readCapturePreferences,writeCapturePreferences,validateCaptureFolder,applySavedCapturePreferences,capturePreferencesHost,copyScreenshotArchive} from '../electron/capturePreferences.js';
import {installCaptureBridge} from '../electron/captureBridge.js';
import {installCapturePreferencesBridge} from '../electron/capturePreferencesBridge.js';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'mv-capture-prefs-'));t.after(()=>rm(root,{recursive:true,force:true}));const recordings=join(root,'recordings'),shots=join(root,'shots');await mkdir(recordings);await mkdir(shots);return {root,recordings,shots,file:join(root,'host','capture-preferences.json')};}
test('native choices persist privately and cancellation creates no preference',async t=>{
 const f=await fixture(t);let result={canceled:true,filePaths:[]};const host=capturePreferencesHost({file:f.file,env:{},chooseDirectory:async()=>result});
 assert.deepEqual(readCapturePreferences(f.file),defaultCapturePreferences());await host.choose('recordings');await assert.rejects(stat(f.file));
 result={canceled:false,filePaths:[f.recordings]};await host.choose('recordings');result={canceled:false,filePaths:[f.shots]};await host.choose('screenshots');await host.mode('disk-on-stop');
 assert.equal((await stat(f.file)).mode&0o777,0o600);const saved=readCapturePreferences(f.file);assert.equal(saved.recordingsFolder,f.recordings);assert.equal(saved.screenshotsFolder,f.shots);
 const view=await host.snapshot();assert.equal(view.mode,'disk-on-stop');assert.equal(view.recordings.label,'recordings');assert.equal(view.screenshots.label,'shots');assert.equal(view.active,false);assert.ok(!JSON.stringify(view).includes(f.root));
 assert.equal(host.shouldSave(),false);await assert.rejects(host.mode('erase'));await assert.rejects(host.choose('other'));
});
test('startup uses the saved recording grant and explicit environment wins',async t=>{
 const f=await fixture(t);await writeCapturePreferences(f.file,{...defaultCapturePreferences(),recordingsFolder:f.recordings});
 assert.equal(applySavedCapturePreferences({PATH:'/usr/bin'},f.file).MV_RECORDING_DESTINATION,f.recordings);
 await writeCapturePreferences(f.file,{...defaultCapturePreferences(),recordingsFolder:join(f.root,'missing')});const refused=applySavedCapturePreferences({PATH:'/usr/bin'},f.file);assert.equal(refused.MV_RECORDING_DESTINATION,undefined);assert.match(refused.MV_CAPTURE_PREFERENCES_ERROR,/unavailable/);
 await writeCapturePreferences(f.file,{...defaultCapturePreferences(),recordingsFolder:f.recordings});
 for(const value of ['',f.shots]){const env={MV_RECORDING_DESTINATION:value};assert.equal(applySavedCapturePreferences(env,f.file),env);}
 assert.throws(()=>validateCaptureFolder('relative'));assert.throws(()=>validateCaptureFolder(f.recordings+'\n'));await chmod(f.shots,0o500);assert.throws(()=>validateCaptureFolder(f.shots),/not writable/);const readonly=capturePreferencesHost({file:f.file,env:{MV_RECORDING_DESTINATION:f.shots},chooseDirectory:async()=>({canceled:true})});assert.equal(readonly.shouldSave(),false);assert.match((await readonly.snapshot()).warning,/not writable/);await chmod(f.shots,0o700);
 const link=join(f.root,'alias');await symlink(f.file,link);assert.throws(()=>readCapturePreferences(link));
});
test('screenshot archive copy verifies bytes, digest and exclusive destination',async t=>{
 const f=await fixture(t);const bytes=Buffer.from('actual exported archive bytes'),digest=createHash('sha256').update(bytes).digest('hex');const item={id:'shot-one',bytes:bytes.length,sha256:digest};const name=`${item.id}-${digest}.tar`;await writeFile(join(f.recordings,name),bytes,{mode:0o600});
 await copyScreenshotArchive(f.recordings,f.shots,item);assert.deepEqual(await readFile(join(f.shots,name)),bytes);assert.equal((await stat(join(f.shots,name))).mode&0o777,0o600);
 await assert.rejects(copyScreenshotArchive(f.recordings,f.shots,item));await assert.rejects(copyScreenshotArchive(f.recordings,f.shots,{...item,id:'../escape'}));
 await writeFile(join(f.recordings,name),'tampered');await assert.rejects(copyScreenshotArchive(f.recordings,f.shots,item));assert.deepEqual(await readdir(f.shots),[name]);
});
test('native folder IPC rejects renderer paths and foreign senders before a dialog',async t=>{
 const f=await fixture(t);const handlers=new Map();let opened=0,registered=0;const contents={session:{registerPreloadScript:()=>++registered,unregisterPreloadScript:()=>{}},send(){}};
 const bridge=installCapturePreferencesBridge({ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},contents,window:{},app:{getPath:()=>join(f.root,'host')},dialog:{showOpenDialog:async()=>{opened++;return {canceled:true,filePaths:[]};}},env:{},admit:event=>event.trusted});
 t.after(()=>bridge.dispose());assert.equal(registered,1);const handle=[...handlers.values()][0];
 for(const message of [{op:'choose',kind:'recordings',path:'/tmp'},{op:'get',extra:1}])await assert.rejects(handle({trusted:true},message));
 await assert.rejects(handle({trusted:false},{op:'choose',kind:'recordings'}));assert.equal(opened,0);
 assert.equal((await handle({trusted:true},{op:'choose',kind:'recordings'})).ok,true);assert.equal(opened,1);
});
test('disk-on-stop uses existing export only after a sealed stop; RAM and refused stop never export',async t=>{
 const f=await fixture(t);const handlers=new Map(),calls=[],saved=[];let disk=false,refuse=false;
 const frame={url:'app://metaviewer/index.html',origin:'app://metaviewer'};const contents={id:1,mainFrame:frame,getURL:()=>frame.url,isDestroyed:()=>false};const event={sender:contents,senderFrame:frame};
 const core={request:async body=>{calls.push(body);if(body.method==='recordStop')return refuse?{ok:false,code:'NOT_RECORDING',request_id:'stop'}:{ok:true,recording:{id:'record-one',surface_id:'surface-one',frames:1,duration_ms:1,sealed:true,sha256:'a'.repeat(64)}};return {ok:true,export:{id:'record-one',bytes:2048,sha256:'b'.repeat(64)}};}};
 const bridge=installCaptureBridge({ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},contents,core,env:{MV_RECORDING_DESTINATION:f.recordings},capturePreferences:{shouldSave:()=>disk,saved:(...v)=>saved.push(v)}});t.after(()=>bridge.dispose());
 const stop=()=>handlers.get('metaviewer:capture.record.stop')(event,{schema:'capture_request/v1',request_id:'stop',recording_id:'record-one'});
 await stop();assert.deepEqual(calls.map(x=>x.method),['recordStop']);disk=true;await stop();assert.deepEqual(calls.slice(1).map(x=>x.method),['recordStop','export']);assert.equal(calls[2].request.destination,'recording:configured');assert.ok(!JSON.stringify(calls).includes(f.root));assert.deepEqual(saved,[['record-one',true,'']]);
 refuse=true;await stop();assert.equal(calls.at(-1).method,'recordStop');assert.equal(saved.length,1);
});
test('disk mode exports a sealed screenshot through the selected screenshot route',async t=>{
 const f=await fixture(t),handlers=new Map(),calls=[],routes=[],outcomes=[];
 const frame={url:'app://metaviewer/index.html',origin:'app://metaviewer'},contents={id:1,mainFrame:frame,getURL:()=>frame.url,isDestroyed:()=>false};
 const shot={id:'shot-one',surface_id:'surface-one',width:1,height:1,created_ms:0,sha256:'a'.repeat(64)};
 const core={request:async body=>{calls.push(body);return body.method==='screenshot'?{ok:true,shot}:{ok:true,export:{id:shot.id,bytes:2048,sha256:'b'.repeat(64)}};}};
 const bridge=installCaptureBridge({ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},contents,core,env:{MV_RECORDING_DESTINATION:f.recordings},capturePreferences:{shouldSave:()=>true,routeExport:async(...args)=>routes.push(args),saved:(...args)=>outcomes.push(args)}});t.after(()=>bridge.dispose());
 const reply=await handlers.get('metaviewer:capture.screenshot')({sender:contents,senderFrame:frame},{schema:'capture_request/v1',request_id:'shot',surface_id:'surface-one'});
 assert.deepEqual(reply,{ok:true,shot});assert.deepEqual(calls.map(c=>c.method),['screenshot','export']);assert.equal(routes[0][1],'shot');assert.deepEqual(outcomes,[[shot.id,true,'']]);assert.ok(!JSON.stringify(calls).includes(f.root));
});

test('a killed screenshot copy never publishes a partial final archive and retry succeeds',async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(65536,42),digest=createHash('sha256').update(bytes).digest('hex');
 const item={id:'interrupted-shot',bytes:bytes.length,sha256:digest},name=`${item.id}-${digest}.tar`;
 await writeFile(join(f.recordings,name),bytes,{mode:0o600});
 const code=`import {open} from 'node:fs/promises';
 import {copyScreenshotArchive} from ${JSON.stringify(new URL('../electron/capturePreferences.js',import.meta.url).href)};
 const h=await open(${JSON.stringify(join(f.root,'probe'))},'w');const proto=Object.getPrototypeOf(h);await h.close();
 proto.writeFile=async function(bytes){await this.write(bytes.subarray(0,8));process.stdout.write('partial\\n');await new Promise(()=>{});};
 await copyScreenshotArchive(${JSON.stringify(f.recordings)},${JSON.stringify(f.shots)},${JSON.stringify(item)});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 const ready=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('copy exited before interruption');}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('copy interruption timed out')),3000);timer.unref();})]);
 assert.match(String(ready[0]),/partial/);child.kill('SIGKILL');await once(child,'exit');
 await assert.rejects(stat(join(f.shots,name)),{code:'ENOENT'});
 await copyScreenshotArchive(f.recordings,f.shots,item);assert.deepEqual(await readFile(join(f.shots,name)),bytes);
});
