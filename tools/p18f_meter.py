import json,subprocess,sys
from pathlib import Path
p=subprocess.Popen(sys.argv[1:]);rc=p.wait()
relative=Path('/proc/self/cgroup').read_text().strip().split('::',1)[1]
cgroup=Path('/sys/fs/cgroup'+relative)
print('MEMORY '+json.dumps(dict(peak_bytes=int((cgroup/'memory.peak').read_text()),rc=rc)),flush=True)
raise SystemExit(rc)
