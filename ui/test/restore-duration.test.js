import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const panel=readFileSync(new URL('../src/components/GuestCommandPanel.vue',import.meta.url),'utf8');
const load=()=>import('../src/wall/restoreDuration.js');
function fixture(){
 const s=JSON.parse(readFileSync(new URL('../../contracts/examples/v0.2/rewind_session.valid.json',import.meta.url))),g=JSON.parse(readFileSync(new URL('../../contracts/examples/v0.2/guest_command_session.valid.json',import.meta.url)));
 Object.assign(g,{workload_id:s.workload_id,owner_id:s.owner_id,generation:s.generation,phase:'ready'});
 return {rewind:{available:true,busy:false,uncertain:false,code:null,revision:1,session:s,point_ages_ms:{'point-one':null},stop_target:{workload_id:s.workload_id,generation:s.generation}},guest:{available:true,busy:false,uncertain:false,code:null,revision:1,canCancel:false,session:g,stdout:'',stderr:''},action:{op:'restore',workload_id:s.workload_id,generation:s.generation,authority_epoch:s.authority_epoch,point_id:'point-one'}};
}
function accepted(f){f.rewind.busy=true;Object.assign(f.rewind.session,{phase:'restoring',pending_request_id:'request-restore',generation:f.action.generation+1,authority_epoch:f.action.authority_epoch+1});}
function completed(f){f.rewind.busy=false;Object.assign(f.rewind.session,{phase:'ready',pending_request_id:null,last_good_usable:'point-one'});f.guest.session.generation=f.rewind.session.generation;}
test('panel presents honest prominent timing and semantic descendant controls',()=>{
 assert.match(panel,/Restore response \(observed\)/);assert.match(panel,/data-testid="restore-duration"/);assert.match(panel,/guest-command-panel__sticky\{position:sticky;/);assert.doesNotMatch(panel,/:deep\(\.rewind-timeline header\).*position:sticky/);assert.match(panel,/:deep\(\.rewind-timeline button\)/);assert.doesNotMatch(panel,/#(?:[\da-f]{3,8})/i);
});
test('click through restoring correlation to ready measures actual monotonic difference',async()=>{
 const {createRestoreDuration}=await load();let now=10;const t=createRestoreDuration(()=>now),f=fixture();assert.equal(t.begin(f.action,f.rewind,f.guest),true);now=15;accepted(f);assert.equal(t.observe(f.rewind,f.guest),null);now=93;completed(f);assert.equal(t.observe(f.rewind,f.guest),83);
});
test('generation advance alone or unrelated Resume never proves restore',async()=>{
 const {createRestoreDuration}=await load();for(const phase of ['ready','resuming']){let now=1;const t=createRestoreDuration(()=>now),f=fixture();t.begin(f.action,f.rewind,f.guest);accepted(f);f.rewind.session.phase=phase;if(phase==='ready')completed(f);now=40;assert.equal(t.observe(f.rewind,f.guest),null);completed(f);now=50;assert.equal(t.observe(f.rewind,f.guest),null);}
});
test('foreign owner/workload, stale target, missing selected point and extra fields refuse',async()=>{
 const {createRestoreDuration}=await load();for(const mutate of [f=>f.action.generation--,f=>f.action.extra=true,f=>f.action.point_id='point-missing']){const f=fixture();mutate(f);assert.equal(createRestoreDuration(()=>10).begin(f.action,f.rewind,f.guest),false);}
 for(const mutate of [f=>f.rewind.session.owner_id='actor-other',f=>f.rewind.session.workload_id='workload-other',f=>f.rewind.session.authority_epoch++,f=>f.rewind.session.last_good_usable=null]){let now=1;const f=fixture(),t=createRestoreDuration(()=>now);t.begin(f.action,f.rewind,f.guest);accepted(f);t.observe(f.rewind,f.guest);completed(f);mutate(f);now=20;assert.equal(t.observe(f.rewind,f.guest),null);}
});
test('unknown refusal Stop timeout invalid or reversed clocks never produce default zero',async()=>{
 const {createRestoreDuration}=await load();for(const mutate of [f=>f.rewind.uncertain=true,f=>f.rewind.code='NATIVE',f=>f.guest.session.controls.stop={request_id:'request-stop',ack:'pending'},f=>f.rewind.session.phase='stopped']){let now=1;const f=fixture(),t=createRestoreDuration(()=>now);t.begin(f.action,f.rewind,f.guest);accepted(f);t.observe(f.rewind,f.guest);mutate(f);now=5;assert.equal(t.observe(f.rewind,f.guest),null);completed(f);now=10;assert.equal(t.observe(f.rewind,f.guest),null);}
 for(const end of [0,NaN,Infinity,60011]){let now=10;const f=fixture(),t=createRestoreDuration(()=>now);t.begin(f.action,f.rewind,f.guest);accepted(f);t.observe(f.rewind,f.guest);completed(f);now=end;assert.equal(t.observe(f.rewind,f.guest),null);}
});
test('request identity change, successor reuse and disposal cannot retain success',async()=>{
 const {createRestoreDuration}=await load();let now=1;const f=fixture(),t=createRestoreDuration(()=>now);t.begin(f.action,f.rewind,f.guest);accepted(f);t.observe(f.rewind,f.guest);f.rewind.session.pending_request_id='request-other';now=5;assert.equal(t.observe(f.rewind,f.guest),null);completed(f);assert.equal(t.observe(f.rewind,f.guest),null);t.clear();assert.equal(t.observe(f.rewind,f.guest),null);
});

test('pause prefix and delayed guest projection are included without optimistic success',async()=>{
 const {createRestoreDuration}=await load();let now=1;const f=fixture(),t=createRestoreDuration(()=>now);t.begin(f.action,f.rewind,f.guest);
 f.rewind.busy=true;f.rewind.session.phase='pausing';f.rewind.session.pending_request_id='request-pause';now=3;assert.equal(t.observe(f.rewind,f.guest),null);
 f.rewind.busy=false;f.rewind.session.phase='paused';f.rewind.session.pending_request_id=null;now=7;assert.equal(t.observe(f.rewind,f.guest),null);
 accepted(f);now=10;t.observe(f.rewind,f.guest);completed(f);f.guest.session.generation--;now=15;assert.equal(t.observe(f.rewind,f.guest),null);f.guest.session.generation++;now=17;assert.equal(t.observe(f.rewind,f.guest),16);
 f.rewind.session.generation++;f.rewind.session.authority_epoch++;assert.equal(t.observe(f.rewind,f.guest),null);
});
test('unavailable busy invalid clock and unmeasurable zero delta refuse timing',async()=>{
 const {createRestoreDuration}=await load();for(const mutate of [f=>f.rewind=null,f=>f.rewind.busy=true,f=>f.guest.uncertain=true]){const f=fixture();mutate(f);assert.equal(createRestoreDuration(()=>1).begin(f.action,f.rewind,f.guest),false);}
 for(const stamp of [NaN,Infinity,-1]){const f=fixture();assert.equal(createRestoreDuration(()=>stamp).begin(f.action,f.rewind,f.guest),false);}
 const f=fixture(),t=createRestoreDuration(()=>10);t.begin(f.action,f.rewind,f.guest);accepted(f);t.observe(f.rewind,f.guest);completed(f);assert.equal(t.observe(f.rewind,f.guest),null);
});

test('every panel CSS variable is defined by the actual application token authority',()=>{
 const css=readFileSync(new URL('../src/design/metaviewer.css',import.meta.url),'utf8');
 const defined=new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m=>m[1]));
 const undefinedVariables=source=>[...new Set([...source.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map(m=>m[1]))].filter(name=>!defined.has(name));
 assert.deepEqual(undefinedVariables(panel),[]);
 assert.deepEqual(undefinedVariables(panel+'\n.bad{color:var(--mv-semantic-undefined-proof)}'),['--mv-semantic-undefined-proof']);
});
