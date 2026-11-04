#!/usr/bin/env python3
"""Explicit recovery of one sealed orphan; no discovery, signals, or force mode."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

# Fixed sibling source packages only, never caller-selected import roots.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rewind_runtime.config import load
from rewind_runtime.recovery import recover_owned
from guest_command_runtime.wire import strict_object


def retained_expected(path):
    path=Path(path)
    if not path.is_absolute() or path.resolve(strict=True)!=path:
        raise ValueError('expected custody path alias')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    with os.fdopen(fd,'rb') as stream:
        st=os.fstat(stream.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode) not in (0o400,0o600) or st.st_nlink!=1 or not 1<=st.st_size<=65536:
            raise ValueError('retained expected custody')
        raw=stream.read(65537);end=os.fstat(stream.fileno());named=path.lstat()
        if any(getattr(st,k)!=getattr(end,k) or getattr(st,k)!=getattr(named,k) for k in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns')):
            raise ValueError('expected custody changed')
    result=strict_object(raw)
    if set(result)!={'base','root','ledger_sha256'}:
        raise ValueError('expected custody keys')
    for key in ('base','root'):
        value=result[key]
        if type(value)is not dict or set(value)!={'device','inode'} or any(type(n)is not int or n<0 for n in value.values()):
            raise ValueError('expected identity')
    value=result['ledger_sha256']
    if type(value)is not str or len(value)!=64 or any(c not in '0123456789abcdef' for c in value):
        raise ValueError('expected ledger digest')
    return result


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',required=True)
    parser.add_argument('--root',required=True)
    parser.add_argument('--expected',required=True,help='previously retained trusted custody JSON; never generated from current orphan')
    parser.add_argument('--proof',required=True,help='new exclusive proof file outside the runtime base')
    args=parser.parse_args(argv)
    config=load(args.config)
    expected=retained_expected(args.expected)
    proof=recover_owned(config,Path(args.root),expected,Path(args.proof))
    raw=json.dumps(proof,sort_keys=True,separators=(',',':')).encode()
    print(json.dumps({'schema':'rewind-recovery-result/v1','reclaimed_root':args.root,'proof_sha256':hashlib.sha256(raw).hexdigest()}))
    return 0


if __name__=='__main__':
    try:sys.exit(main())
    except (OSError,RuntimeError,ValueError) as error:
        print('recovery refused: '+str(error),file=sys.stderr);sys.exit(1)
