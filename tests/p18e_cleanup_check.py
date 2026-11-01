import json
from pathlib import Path
import subprocess
from p18e_verify import OUT
state=json.loads((OUT/'live.json').read_text())
own=set(state.get('containers',[]))
started=Path(state['root'])/'docker-started.jsonl'
if started.exists():own.update(json.loads(line)['container'] for line in started.read_text().splitlines())
active=set(subprocess.check_output(['docker','ps','--format','{{.Names}}'],text=True).splitlines())
remaining=sorted(active&own)
live=[]
for entry in state.get('seen',[]):
    pid,start=entry.split(':')
    try:
        fields=Path('/proc/'+pid+'/stat').read_text().rsplit(') ',1)[1].split()
        if fields[19]==start and fields[0]!='Z':live.append(int(pid))
    except FileNotFoundError:pass
result=dict(remainingOwnCapsules=remaining,runningOwnedPids=live)
(OUT/'cleanup.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
assert not remaining and not live
