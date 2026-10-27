#!/usr/bin/env python3
"""[TARGET, unit decision] Native-only fixture; real adapter verifies these pixels."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
root = Path(os.environ['SRF_IDENTITY_STORE_ROOT'])
window = dict(id='w1', x=0, y=0, w=2, h=1, title='slice', url='')
op = sys.argv[1]
with (root / 'native-actions.jsonl').open('a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\n')
if op == 'start':
    result = dict(container='srf-id-slice', run_id='slice-run', windows=[window])
elif op == 'frame':
    result = dict(path=str(root / 'slice-run/frames/w1/f.png'), seq=time.monotonic_ns(),
                  sha256_rgb24=hashlib.sha256(bytes([255, 0, 0, 0, 255, 0])).hexdigest(),
                  width=2, height=1, capture_mono_ns=time.monotonic_ns(),
                  generation='srf-id-slice', window=window)
elif op == 'input':
    result = dict(surface_id='w1', kind='click', input_mono_ns=time.monotonic_ns(),
                  focus_verified=True, result='ok')
elif op == 'stop':
    result = dict(stopped='srf-id-slice', removed_verified=True)
else:
    raise SystemExit(2)
print(json.dumps(result))
