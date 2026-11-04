import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {workflowPrompt} from '../src/terminal/workflowPrompts.js';
const context={kind:'microvm',workloadId:'workload-fixture',generation:3,ownerId:'actor-fixture',profileId:'guest-command-arm64-v1',backend:'firecracker',isa:'aarch64'};
const docs=readFileSync(new URL('../../docs/AGENT_ENTRY.md',import.meta.url),'utf8');
const recipe=docs.split("PYTHONPATH=agents python3 - <<'PYMICROVM'\n")[1]?.split('\nPYMICROVM')[0];
test('MicroVM attachment precedes guide lookup and binding export contains only exact copied fields',()=>{
 const prompt=workflowPrompt('no-automation',context);
 assert.ok(prompt.indexOf('First locate and source')<prompt.indexOf('Then read'));
 const assignment=prompt.match(/export MV_TASK_BINDING='([^']+)'/);
 assert.deepEqual(JSON.parse(assignment[1]),{workload_id:'workload-fixture',generation:3,owner_id:'actor-fixture',profile_id:'guest-command-arm64-v1',backend:'firecracker',isa:'aarch64'});
 assert.match(prompt,/Construct guest commands from the one-sentence objective/);
});
test('shipped recipe exercises public properties, bounded readiness, exact binding and verified command results',()=>{
 assert.equal(typeof recipe,'string');
 const harness=String.raw`
import json, os, sys, types
recipe=json.loads(sys.argv[1])
binding=dict(workload_id='workload-fixture',generation=3,owner_id='actor-fixture',profile_id='guest-command-arm64-v1',backend='firecracker',isa='aarch64')
class Guest:
 def __init__(self):self.session=dict(binding,ownership='held',phase='ready');self.uncertain=False;self.closed=False;self.calls=[];self.events=[]
 def run(self,command,timeout_ms):
  self.calls.append(command);self.events.append((command,self.session['generation']))
  return dict(exit_code=(1 if mode=='multi_bad_readback' and command=='read fixture notes' else 0),signal=None,cause='exit',output_complete=complete,stdout=b'answer',stderr=b'')
class Rewind:
 def __init__(self,g):self.g=g;self.status=None;self.marks=[]
 def wait_ready(self,timeout):assert timeout==5;return ready
 def mark(self,label):
  self.marks.append(label);self.g.events.append(('mark',self.g.session['generation']));self.g.session['generation']+=1
  self.status=dict(self.g.session,profile_id='rewind-arm64-v1');return self.status.copy()
class Client:
 def __init__(self):self.guest_commands=Guest();self.rewind=Rewind(self.guest_commands)
 def __enter__(self):return self
 def __exit__(self,*args):pass
module=types.ModuleType('tools.mw_run_backend')
sys.modules['tools']=types.ModuleType('tools');sys.modules['tools.mw_run_backend']=module
os.environ.update(MV_TASK_BINDING=json.dumps(binding),MV_TASK_COMMAND='objective-derived fixture command',MV_TASK_MUTATES='no')
for mode in ('success','mark','not_ready','foreign','incomplete','uncertain','multi','multi_bad_readback'):
 ready=mode!='not_ready';complete=mode!='incomplete';client=Client()
 if mode=='foreign':client.guest_commands.session['owner_id']='actor-foreign'
 if mode=='uncertain':client.guest_commands.uncertain=True
 os.environ['MV_TASK_MUTATES']='yes' if mode=='mark' else 'no'
 if mode in ('multi','multi_bad_readback'):
  os.environ['MV_TASK_PLAN']=json.dumps([dict(command='create fixture notes',mark_before=False),dict(command='read fixture notes',mark_before=False),dict(command='delete fixture notes',mark_before=True),dict(command='verify fixture deletion',mark_before=False)])
 else:os.environ.pop('MV_TASK_PLAN',None)
 module.connect=lambda env:client
 failed=False
 try:exec(compile(recipe,'AGENT_ENTRY.md','exec'),{})
 except SystemExit:failed=True
 assert failed==(mode not in ('success','mark','multi')),mode
 assert len(client.guest_commands.calls)==(4 if mode=='multi' else 2 if mode=='multi_bad_readback' else 1 if mode in ('success','mark','incomplete') else 0),mode
 assert len(client.rewind.marks)==(1 if mode in ('mark','multi') else 0),mode
 if mode=='multi':assert client.guest_commands.events==[('create fixture notes',3),('read fixture notes',3),('mark',3),('delete fixture notes',4),('verify fixture deletion',4)]
 if mode=='multi_bad_readback':assert client.guest_commands.events==[('create fixture notes',3),('read fixture notes',3)]
 assert json.loads(os.environ['MV_TASK_BINDING'])==binding
`;
 const run=spawnSync('python3',['-c',harness,JSON.stringify(recipe)],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
});
