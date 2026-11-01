#!/usr/bin/env python3
"""Opt-in own-window rehearsal; sends native X input only to the isolated :97 app."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

LEDGER = Path('/home/admin/Música/TeamWork_Antigravity2/campaigns/metaviewer-0/out/pids.log')


def request(root, op, timeout=15, **kw):
    row = dict(id=uuid.uuid4().hex, op=op, **kw)
    pending = root/'rehearse.tmp'
    pending.write_text(json.dumps(row))
    pending.replace(root/'rehearse.json')
    start = time.monotonic()
    while time.monotonic()-start < timeout:
        try:
            result = json.loads((root/'rehearse-result.json').read_text())
            if result['id'] == row['id']:
                with (root/'rehearsal.jsonl').open('a') as f:
                    f.write(json.dumps(dict(request=row, response=result))+'\n')
                if 'error' in result:
                    raise RuntimeError(result['error'])
                return result['result']
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(.02)
    raise TimeoutError(op)


def run(root, *args):
    env = dict(os.environ, DISPLAY=':97')
    p = subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    with LEDGER.open('a') as f:
        f.write(json.dumps(dict(unit='XPRA-DEMO-SEGMENT-R2', pid=p.pid,
                               kind='rehearsal-command', root=str(root)))+'\n')
    out, err = p.communicate()
    with (root/'commands.jsonl').open('a') as f:
        f.write(json.dumps(dict(command=list(args), rc=p.returncode))+'\n')
    if p.returncode:
        raise RuntimeError(f'{args[0]} rc={p.returncode}: {err.decode()[:200]}')
    return out.decode().strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('op', choices=['status', 'page', 'hover-in', 'hover-out', 'type',
                                     'pixel', 'cadence', 'query-default', 'query-rgb', 'close', 'mount'])
    parser.add_argument('--delay', type=int, default=2)
    parser.add_argument('--seconds', type=int, default=5)
    parser.add_argument('--x', type=int, default=15)
    parser.add_argument('--y', type=int, default=105)
    parser.add_argument('--product', action='store_true')
    parser.add_argument('--native', action='store_true')
    parser.add_argument('--query', choices=['legacy','full'], default='legacy')
    parser.add_argument('--role', choices=['human','agent'], default='human')
    args = parser.parse_args()
    if not (0<=args.delay<=100 and 1<=args.seconds<=90 and 0<=args.x<1280 and 0<=args.y<900):
        raise SystemExit('REHEARSAL_BOUNDS_REFUSED')
    root = args.root
    if not str(root).startswith('/tmp/claude-1000/xpra-spike/operator-') or root.resolve() != root:
        raise SystemExit('ROOT_REFUSED')
    with LEDGER.open('a') as f:
        f.write(json.dumps(dict(unit='XPRA-DEMO-SEGMENT-R2', pid=os.getpid(),
                               kind='rehearsal', root=str(root)))+'\n')
    ready = json.loads((root/'ready.json').read_text())
    # A local native window must belong to precisely the recorded Electron PID.
    windows = run(root, '/usr/bin/xdotool', 'search', '--onlyvisible', '--pid', str(ready['pid'])).splitlines()
    if not windows:
        raise SystemExit('OWN_WINDOW_ABSENT')
    window = windows[-1]
    run(root, '/usr/bin/xdotool', 'windowfocus', '--sync', window)
    op = args.op
    if op == 'mount':
        print(json.dumps(request(root,op,timeout=170,product=args.product,native=args.native,query=args.query,role=args.role)))
    elif op == 'page':
        page = '''<!doctype html><style>body{margin:0;background:#222;color:white}#bits{display:flex;position:absolute;top:0;left:0}#bits i{width:30px;height:30px;background:black}#hover{position:absolute;left:50px;top:100px;width:200px;height:70px;background:cyan}#hover:hover{background:orange}input{position:absolute;left:50px;top:200px;width:300px;height:60px;background:red;font:24px sans-serif}marquee{position:absolute;top:40px;width:100%;font:24px sans-serif}</style><div id=bits></div><marquee>XPRA live remote marquee</marquee><div id=hover>CSS hover</div><input id=field placeholder="type xpra-demo-r2"><script>for(let i=0;i<16;i++)bits.appendChild(document.createElement('i'));let n=0;function frame(){n++;[...bits.children].forEach((e,i)=>e.style.background=n&(1<<i)?'lime':'black');requestAnimationFrame(frame)}frame();field.oninput=()=>field.style.background=field.value==='xpra-demo-r2'?'lime':'red';</script>'''
        from urllib.parse import quote
        run(root, '/usr/bin/xdotool', 'key', '--clearmodifiers', 'ctrl+l')
        run(root, '/usr/bin/xdotool', 'type', '--clearmodifiers', '--delay', str(args.delay), 'data:text/html,'+quote(page))
        run(root, '/usr/bin/xdotool', 'key', '--clearmodifiers', 'Return')
        print('nonsecret marquee/counter/input/hover page entered through own :97 window')
    elif op in ('hover-in', 'hover-out', 'type'):
        run(root, '/usr/bin/xdotool', 'mousemove', '--sync', str(args.x), str(args.y))
        if op == 'type':
            run(root, '/usr/bin/xdotool', 'click', '1')
            run(root, '/usr/bin/xdotool', 'type', '--clearmodifiers', '--delay', '40', 'xpra-demo-r2')
        # Let the asynchronous remote paint arrive before a separate pixel probe.
        time.sleep(.3)
        print(op+' native input rc=0')
    elif op == 'close':
        request(root,'close',timeout=1)
        print('own harness close acknowledged')
    else:
        result = request(root, op, timeout=args.seconds+15, seconds=args.seconds, x=args.x, y=args.y)
        print(json.dumps(result))
        if op == 'cadence':
            (root/('cadence-'+str(args.seconds)+'.json')).write_text(json.dumps(result))


if __name__ == '__main__':
    main()
