"""Bounded command receipts and owned-process logging for P18E verification."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.p18-evidence' / 'p18e'
LEDGER = Path('/home/admin/Música/TeamWork_Antigravity2/campaigns/metaviewer-0/out/pids.log')


def record(pid, kind, **extra):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
        row = dict(unit='P18E-FIXES', pid=pid, starttime=fields[19], kind=kind, **extra)
        with LEDGER.open('a') as sink:
            sink.write(json.dumps(row) + '\n')
        return fields[19]
    except FileNotFoundError:
        return None


def run(label, argv, cwd=ROOT):
    OUT.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.pop('MV_WENDER_ROOT', None)
    env.update(MV_MW_WENDER_ROOT='/home/admin/Documentos/wender-agent-wt-pin',
               CARGO_TARGET_DIR='/home/admin/.cache/cargo-target/mv-wt-p18c',
               CAPSULE_UI_KIT_REPO='/home/admin/.cache/metaviewer-kit/kit-v0.2.1',
               ELECTRON_OVERRIDE_DIST_PATH='/home/admin/Documentos/Games/Holdings-int/app/shell/node_modules/electron/dist')
    env['PATH'] = '/home/admin/.nvm/versions/node/v24.14.0/bin:/usr/local/go/bin:/home/admin/.cargo/bin:' + env.get('PATH', '')
    argv = list(argv)
    if '--test' in argv and argv[0].endswith('/node'):
        argv = [arg for arg in argv if not arg.startswith('--test-timeout=')]
        argv.insert(argv.index('--test') + 1, '--test-timeout=60000')
    argv = ['systemd-run', '--user', '--scope', '-q', '-p', 'MemoryHigh=6G', '-p', 'MemoryMax=8G', '-p', 'MemorySwapMax=0', '--', *argv]
    start = time.monotonic()
    with (OUT / (label + '.log')).open('w') as output:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT)
        seen = set()
        def visit(pid):
            if pid in seen:
                pass
            else:
                record(pid, label)
                seen.add(pid)
            try:
                for child in Path(f'/proc/{pid}/task/{pid}/children').read_text().split():
                    visit(int(child))
            except FileNotFoundError:
                pass
        while process.poll() is None:
            visit(process.pid)
            time.sleep(.02)
        rc = process.wait()
    receipt = dict(label=label, command=argv, cwd=str(cwd), rc=rc, elapsed_s=round(time.monotonic()-start, 3))
    with (OUT / 'commands.jsonl').open('a') as sink:
        sink.write(json.dumps(receipt)+'\n')
    print(json.dumps(receipt), flush=True)
    return rc


if __name__ == '__main__':
    raise SystemExit(run(sys.argv[1], sys.argv[3:], cwd=ROOT/'ui') if sys.argv[2:3]==['--ui'] else run(sys.argv[1], sys.argv[2:]))
