"""Bounded command recorder for the header/menu unit."""
import os
import sys
from pathlib import Path
import p18_run

p18_run.EVIDENCE = Path(__file__).resolve().parents[1] / '.p18b-evidence'
original = p18_run.subprocess.Popen
def spawn(*args, **kwargs):
    kwargs['env']['CARGO_TARGET_DIR'] = '/home/admin/.cache/cargo-target/mv-wt-p18b'
    return original(*args, **kwargs)
p18_run.subprocess.Popen = spawn
if __name__ == '__main__':
    raise SystemExit(p18_run.run(sys.argv[1], sys.argv[2:]))
