#!/usr/bin/env python3
"""Run the R2 fault replay against the old create-refusal branch, then remove it."""
from pathlib import Path
import subprocess
import p18_live as live

root=Path(__file__).resolve().parents[1]
module=root/'ui/electron/.p18-r2-old-roleHost.js'
test=root/'ui/test/.p18-r2-old-refusal.test.js'
assert not module.exists() and not test.exists()
try:
    source=(root/'ui/electron/roleHost.js').read_text()
    old="if (reply?.schema !== 'surface_event/v0.2' || reply.event !== 'created') throw refuse(typeof reply?.data?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(reply.data.code) ? reply.data.code : 'SURFACE_CREATE_REFUSED');"
    anchor="if (reply?.schema !== 'surface_event/v0.2' || reply.event !== 'created') throw refuse(surfaceCreateRefusal(reply));"
    assert source.count(anchor)==1
    module.write_text(source.replace(anchor,old))
    tests=(root/'ui/test/p18-modes-tiles.test.js').read_text()
    assert tests.count("'../electron/roleHost.js'")==1
    test.write_text(tests.replace("'../electron/roleHost.js'","'../electron/.p18-r2-old-roleHost.js'"))
    argv=['/home/admin/.nvm/versions/node/v24.14.0/bin/node','--test','--test-name-pattern','R2 destroy acknowledgement',str(test)]
    p=subprocess.Popen(argv,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    live.record(pid=p.pid,kind='P18-R2 old-code negative control')
    output=p.communicate()[0].decode();print(output)
    assert p.returncode==1 and 'SURFACE_CREATE_REFUSED' in output and 'ADAPTER_FRAME' in output
    print('OLD_BRANCH_REJECTED rc=1; negative-control rc=0')
finally:
    module.unlink(missing_ok=True);test.unlink(missing_ok=True)
