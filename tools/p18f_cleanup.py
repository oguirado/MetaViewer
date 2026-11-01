"""Read-only final audit of this unit's recorded process/container ownership."""
import json,subprocess
from pathlib import Path
from p18f_verify import OUT,record
state=json.loads((OUT/'live.json').read_text());active=[];zombies=[]
for key in state.get('seen',[]):
 pid,start=key.split(':')
 try:
  fields=Path(f'/proc/{pid}/stat').read_text().rsplit(') ',1)[1].split()
  if fields[19]==start:(zombies if fields[0]=='Z' else active).append(int(pid))
 except (OSError,IndexError):pass
owned=set(state.get('containers',[]));started=Path(state['root'])/'docker-started.jsonl'
if started.exists():owned.update(json.loads(row)['container'] for row in started.read_text().splitlines())
command=['docker','ps','--format','{{.Names}}']
process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
record(process.pid,'own capsule cleanup audit',root=state['root'])
stdout,stderr=process.communicate(timeout=10)
assert process.returncode==0,(process.returncode,stderr)
remaining=sorted(set(stdout.splitlines())&owned)
receipt=dict(remainingOwnCapsules=remaining,remainingOwnRunningPids=active,remainingOwnZombiePids=zombies,command=command,rc=process.returncode)
(OUT/'cleanup.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
assert not remaining and not active
