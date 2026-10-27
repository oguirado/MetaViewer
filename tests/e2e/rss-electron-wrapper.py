#!/usr/bin/env python3
"""[TARGET, unit decision] Add an e2e host bootstrap to the frozen RSS probe.

Exec preserves the Electron PID and the budget gate's cleanup/receipt checks.
The shared perf instrument and its budgets are used without modification.
"""
import os
from pathlib import Path
import sys

electron = os.environ['MV_RSS_ELECTRON']
bootstrap = Path(__file__).with_name('rss-main.mjs')
os.execv(electron, [electron, str(bootstrap), *sys.argv[1:]])
