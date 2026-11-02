"""Capped P18G command receipts and owned process tracking."""
import os
import sys
import tempfile
from pathlib import Path
import p18f_verify as runner
runner.OUT = Path(__file__).resolve().parents[1]/'.p18c-evidence/p18g'
# Identity fixtures deliberately cannot live inside any source repository.
with tempfile.TemporaryDirectory(prefix='p18g-tests-',dir='/tmp/claude-1000/xpra-spike') as temporary:
    os.environ['TMPDIR']=temporary
    raise SystemExit(runner.run(sys.argv[1],sys.argv[3:],cwd=runner.ROOT/'ui') if sys.argv[2:3]==['--ui'] else runner.run(sys.argv[1],sys.argv[2:]))
