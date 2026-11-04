"""Explicit sealed-orphan reclamation. Never starts, signals, or scans workloads.

The caller must retain the exact ledger digest and directory identities from its
own custody record. Unsealed legacy allocations and incomplete spawn records are
deliberately unavailable to this API. No recovery is performed by normal claim.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from guest_command_runtime.wire import strict_object
from .config import validate


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def identity(st):
    return {'device': st.st_dev, 'inode': st.st_ino}


def stable(st):
    return tuple(getattr(st, name) for name in ('st_dev', 'st_ino', 'st_mode',
                 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def digest_config(config):
    return hashlib.sha256(json.dumps(validate(config), sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def directory(path):
    path = Path(path)
    require(path.is_absolute() and path == path.resolve(strict=True), 'directory alias')
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    st = os.fstat(fd)
    try:
        require(st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o700,
                'directory custody')
        require(identity(st) == identity(path.lstat()), 'directory changed')
        return fd, st
    except BaseException:
        os.close(fd)
        raise


def read_file(directory_fd, name, mode, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                 dir_fd=directory_fd)
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid()
                and stat.S_IMODE(st.st_mode) == mode and st.st_nlink == 1
                and st.st_size <= limit, 'file custody')
        data = bytearray()
        while len(data) <= limit:
            block = os.read(fd, min(1 << 20, limit + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        require(len(data) == st.st_size and stable(os.fstat(fd)) == stable(st), 'file changed')
        require(stable(os.stat(name, dir_fd=directory_fd, follow_symlinks=False)) == stable(st),
                'file replaced')
        return bytes(data), st
    finally:
        os.close(fd)


def ledger_records(raw):
    require(raw and raw.endswith(b'\n'), 'torn ledger')
    head = '0' * 64
    rows = []
    for number, line in enumerate(raw.splitlines(), 1):
        row = strict_object(line)
        require(set(row) == {'seq', 'prev', 'payload', 'sha256'}
                and type(row['seq']) is int and row['seq'] == number
                and row['prev'] == head and type(row['payload']) is str, 'ledger sequence')
        head = hashlib.sha256((str(number) + '\n' + head + '\n' + row['payload']).encode()).hexdigest()
        require(row['sha256'] == head, 'ledger hash')
        value = strict_object(row['payload'].encode())
        require(set(value) == {'op', 'stage', 'data'} and type(value['data']) is dict,
                'ledger payload')
        rows.append(value)
    return rows


def validate_history(rows, owner):
    """Closed shapes emitted by Native and Controller; not arbitrary audit JSON."""
    def keys(data, expected):
        require(type(data) is dict and set(data) == set(expected), 'ledger data shape')
    def token(value, prefix):
        require(type(value) is str and re.fullmatch(prefix + r'[a-z0-9][a-z0-9._-]{0,63}', value), 'ledger identity')
    def integer(value, maximum=2**53-1):
        require(type(value) is int and 0 <= value <= maximum, 'ledger integer')
    def evidence(data):
        keys(data, ('pid','start_ticks','returncode','forced_cleanup','mapped_point','closed'))
        for key in ('pid','start_ticks'):
            require(data[key] is None or (type(data[key]) is int and data[key] > 0), 'process evidence')
        require(data['returncode'] is None or type(data['returncode']) is int, 'return code')
        require(data['forced_cleanup'] is None or type(data['forced_cleanup']) is bool, 'forced cleanup')
        require(type(data['closed']) is bool, 'closed evidence')
        if data['mapped_point'] is not None:token(data['mapped_point'],'point-')
    pending_owner = None
    pending_run = None
    pending_point = None
    published_points = set()
    seen = set()
    for row in rows:
        op, stage, data = row['op'], row['stage'], row['data']
        if stage == 'owner_intent':
            require(op in ('pause','mark','resume','restore') and pending_owner is None and pending_run is None, 'owner ordering')
            keys(data, ('request_id','next_binding'));token(data['request_id'],'request-')
            require(data['request_id'] not in seen, 'request replay');seen.add(data['request_id'])
            value=data['next_binding']
            if op in ('pause','mark'):require(value is None,'unexpected next binding')
            else:
                from .controller import binding
                binding(value,owner)
            pending_owner=(op,data['request_id'])
        elif stage == 'owner_complete':
            keys(data, ('request_id',))
            require(pending_owner == (op,data['request_id']), 'owner completion correlation')
            pending_owner=None
        elif op == 'run':
            require(pending_owner is None, 'run while owner pending')
            if stage == 'intent':
                keys(data, ('request_id','job_id'));token(data['request_id'],'request-');token(data['job_id'],'job-')
                require(pending_run is None and data['request_id'] not in seen,'run replay/order')
                seen.add(data['request_id']);pending_run=(data['request_id'],data['job_id'])
            elif stage == 'complete':
                keys(data, ('request_id','job_id','stdout_bytes','stderr_bytes'))
                require(pending_run == (data['request_id'],data['job_id']), 'run completion correlation')
                integer(data['stdout_bytes'],65536);integer(data['stderr_bytes'],65536)
                require(data['stdout_bytes']+data['stderr_bytes']<=65536,'run output bound');pending_run=None
            else:raise RuntimeError('unknown run stage')
        elif (op,stage) in (('spawn','returned'),('spawn','bound'),('boot','complete'),('stop','complete')):evidence(data)
        elif (op,stage) == ('allocate','sealed'):
            keys(data, ('sha256',));require(type(data['sha256']) is str and re.fullmatch('[0-9a-f]{64}',data['sha256']),'seal digest')
        elif (op,stage) == ('mark','intent'):
            keys(data, ('point_id','victim'));token(data['point_id'],'point-')
            if data['victim'] is not None:token(data['victim'],'point-')
            require(pending_point is None and data['point_id'] not in published_points,'point replay/order')
            pending_point=(data['point_id'],data['victim'])
        elif (op,stage) == ('mark','published'):
            keys(data, ('point','victim'));point=data['point']
            keys(point, ('point_id','created_order','created_mono_ns','compatibility_hash','counter','state','memory'))
            token(point['point_id'],'point-');integer(point['created_order']);integer(point['created_mono_ns'])
            require(point['created_order']>0 and point['created_mono_ns']>0,'point clock/order')
            require(type(point['compatibility_hash']) is str and re.fullmatch('[0-9a-f]{64}',point['compatibility_hash']),'point compatibility')
            if point['counter'] is not None:integer(point['counter'])
            for field in ('state','memory'):
                spec=point[field];keys(spec,('device','inode','bytes','sha256'))
                for name in ('device','inode','bytes'):integer(spec[name])
                require(type(spec['sha256']) is str and re.fullmatch('[0-9a-f]{64}',spec['sha256']),'point digest')
            if data['victim'] is not None:token(data['victim'],'point-')
            require(pending_point==(point['point_id'],data['victim']),'point publication correlation')
            published_points.add(point['point_id']);pending_point=None
        elif (op,stage) == ('restore','intent'):
            keys(data, ('point_id',));token(data['point_id'],'point-')
            require(data['point_id'] in published_points,'restore of unpublished point')
        elif (op,stage) == ('reset','intent'):
            keys(data, ('generation','authority_epoch'))
            for value in data.values():integer(value);require(value>0,'reset integer')
        elif (op,stage) == ('reset','complete'):
            keys(data, ('counter',));integer(data['counter'])
        elif (op,stage) in {('allocate','intent'),('spawn','intent'),('boot','intent'),('pause','intent'),('pause','complete'),('resume','intent'),('stop','intent')}:
            keys(data, ())
        else:raise RuntimeError('unknown or uncertain ledger operation')
    require(pending_run is None and pending_owner is None and pending_point is None,'operation incomplete')


def recover_owned(config, root, expected, proof_path):
    """Purge one exact sealed dead allocation, after durable external proof.

    expected is a trusted caller capture, not a claim read from this allocation.
    Reused PID numbers are conservatively refused. Cgroup must be absent, not
    merely empty; missing identity, unreadable procfs, and partial spawn hold.
    """
    config = validate(config)
    require(type(expected) is dict and set(expected) == {'base', 'root', 'ledger_sha256'},
            'expected custody required')
    root = Path(root)
    base = Path(config['runtime_root'])
    require(root.parent == base and re.fullmatch(r'rewind-[a-zA-Z0-9_-]+', root.name), 'exact runtime root')
    require(base.parts[:3] == ('/', 'dev', 'shm'), 'RAM root required')
    bfd, bst = directory(base)
    rfd = None
    locks = []
    try:
        require(identity(bst) == expected['base'], 'base replaced')
        require(set(os.listdir(bfd)) == {'.rewind-owner.lock', root.name}, 'foreign base member')
        rfd, rst = directory(root)
        require(identity(rst) == expected['root'], 'root replaced')
        for dfd, name in ((bfd, '.rewind-owner.lock'), (rfd, 'owner.lock')):
            data, st = read_file(dfd, name, 0o600, 0)
            fd = os.open(name, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dfd)
            locks.append(fd)
            require(stable(os.fstat(fd)) == stable(st), 'lock replaced')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        seal_raw, seal_st = read_file(rfd, 'recovery.json', 0o600, 65536)
        seal = strict_object(seal_raw)
        require(set(seal) == {'schema', 'config_sha256', 'base', 'root', 'external_cgroup', 'cgroup', 'assets', 'owner'}
                and seal['schema'] == 'rewind-recovery-seal/v1'
                and seal['config_sha256'] == digest_config(config)
                and seal['base'] == expected['base'] and seal['root'] == expected['root']
                and seal['external_cgroup'] == config['external_cgroup'], 'seal mismatch')
        cg = Path(config['external_cgroup'])
        require(cg.is_absolute() and str(cg).startswith('/sys/fs/cgroup/')
                and 'newton-ia.slice' in cg.parts and '..' not in cg.parts, 'cgroup path')
        require(not os.path.lexists(cg), 'original cgroup not absent')
        raw, ledger_st = read_file(rfd, 'ledger.jsonl', 0o600, 4 << 20)
        require(hashlib.sha256(raw).hexdigest() == expected['ledger_sha256'], 'unexpected ledger')
        rows = ledger_records(raw)
        validate_history(rows, config['owner_id'])
        require(rows[0] == {'op': 'allocate', 'stage': 'intent', 'data': {}}, 'allocation origin')
        seals = [x for x in rows if x['op'] == 'allocate' and x['stage'] == 'sealed']
        require(len(seals) == 1 and len(rows) > 1 and rows[1] == seals[0]
                and seals[0]['data'] == {'sha256': hashlib.sha256(seal_raw).hexdigest()}, 'unsealed allocation')
        pending = False
        returned = None
        owner = seal['owner']
        require(type(owner) is dict and set(owner) == {'pid', 'start_ticks'}
                and type(owner['pid']) is int and owner['pid'] > 1
                and type(owner['start_ticks']) is int and owner['start_ticks'] > 0, 'owner identity')
        pids = [(owner['pid'], owner['start_ticks'])]
        allowed = {('allocate', 'intent'), ('allocate', 'sealed'), ('spawn', 'intent'),
                   ('spawn', 'returned'), ('spawn', 'bound'), ('boot', 'intent'),
                   ('boot', 'complete'), ('pause', 'intent'), ('pause', 'complete'),
                   ('mark', 'intent'), ('mark', 'published'), ('resume', 'intent'),
                   ('restore', 'intent'), ('reset', 'intent'), ('reset', 'complete'),
                   ('stop', 'intent'), ('stop', 'complete')}
        allowed |= {('run','intent'),('run','complete')} | {
            (op,stage) for op in ('pause','mark','resume','restore')
            for stage in ('owner_intent','owner_complete')}
        for row in rows:
            require((row['op'], row['stage']) in allowed, 'unknown ledger operation')
            if row['op'] == 'spawn':
                if row['stage'] == 'intent':
                    require(not pending, 'overlapping spawn')
                    pending = True
                    returned = None
                elif row['stage'] == 'returned':
                    require(pending and returned is None and type(row['data'].get('pid')) is int
                            and row['data']['pid'] > 1, 'spawn ordering')
                    returned = row['data']['pid']
                elif row['stage'] == 'bound':
                    data = row['data']
                    require(pending and returned == data.get('pid') and type(data.get('pid')) is int and data['pid'] > 1
                            and type(data.get('start_ticks')) is int and data['start_ticks'] > 0,
                            'spawn identity missing')
                    pids.append((data['pid'], data['start_ticks']))
                    pending = False
                else:
                    raise RuntimeError('unknown spawn stage')
        require(len(pids) > 1 and not pending, 'spawn in flight or identity absent')
        for pid, start in pids:
            require(not os.path.lexists('/proc/' + str(pid)), 'PID present or reused')
        files = {'recovery.json': (seal_raw, seal_st), 'ledger.jsonl': (raw, ledger_st)}
        require(set(seal['assets']) == {'fc', 'Image', 'initrd.gz'}, 'asset set')
        for name, spec in seal['assets'].items():
            data, st = read_file(rfd, name, 0o500 if name == 'fc' else 0o400, 128 << 20)
            require(spec == dict(identity(st), bytes=len(data), sha256=hashlib.sha256(data).hexdigest()), 'asset changed')
            files[name] = (None, st)
        require(seal['assets']['fc']['sha256'] == config['artifacts']['engine']['sha256']
                and seal['assets']['Image']['sha256'] == config['artifacts']['kernel']['sha256'], 'artifact pin mismatch')
        # Only completely published and still identical points may be reclaimed.
        for row in rows:
            if row['op'] == 'mark' and row['stage'] == 'intent':
                key = row['data'].get('point_id')
                require(type(key) is str and re.fullmatch(r'point-[a-zA-Z0-9_-]{1,100}', key), 'point identity')
                published = [x for x in rows if x['op'] == 'mark' and x['stage'] == 'published'
                             and x['data'].get('point', {}).get('point_id') == key]
                require(len(published) == 1, 'unpublished point')
                point = published[0]['data']['point']
                for suffix, field in (('.state', 'state'), ('.mem', 'memory')):
                    name = key + suffix
                    if name not in os.listdir(rfd):
                        continue  # a fully published point can have been retired
                    data, st = read_file(rfd, name, 0o600, 1 << 30)
                    require(point[field] == dict(identity(st), bytes=len(data), sha256=hashlib.sha256(data).hexdigest()), 'point changed')
                    files[name] = (None, st)
        for name in ('owner.lock', 'api.sock', 'vsock.sock'):
            if name in os.listdir(rfd):
                st = os.stat(name, dir_fd=rfd, follow_symlinks=False)
                require(st.st_uid == os.getuid() and st.st_nlink == 1
                        and (name == 'owner.lock' or (stat.S_ISSOCK(st.st_mode)
                             and stat.S_IMODE(st.st_mode) == 0o700)), 'socket custody')
                files[name] = (None, st)
        require(set(os.listdir(rfd)) == set(files), 'unknown runtime member')
        proof = {'schema': 'rewind-orphan-proof/v1', 'root': str(root), 'expected': expected,
                 'seal_sha256': hashlib.sha256(seal_raw).hexdigest(), 'pids': pids,
                 'external_cgroup': str(cg), 'seal': seal, 'ledger_records': rows,
                 'files': {n: identity(v[1]) for n, v in files.items()}}
        proof_path = Path(proof_path)
        require(base not in proof_path.parents, 'proof must survive purge')
        pfd, _ = directory(proof_path.parent)
        try:
            fd = os.open(proof_path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=pfd)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(json.dumps(proof, sort_keys=True, separators=(',', ':')).encode())
                stream.flush()
                os.fsync(stream.fileno())
            os.fsync(pfd)
        finally:
            os.close(pfd)
        require(identity(root.lstat()) == expected['root'] and identity(base.lstat()) == expected['base'], 'directory changed before purge')
        require(not os.path.lexists(cg) and all(not os.path.lexists('/proc/' + str(p)) for p, _ in pids), 'resource appeared')
        require(set(os.listdir(rfd)) == set(files), 'inventory changed')
        require(set(os.listdir(bfd)) == {'.rewind-owner.lock', root.name}
                and stable(os.stat('.rewind-owner.lock', dir_fd=bfd, follow_symlinks=False))
                    == stable(os.fstat(locks[0])), 'base changed before purge')
        for name, (_, st) in files.items():
            require(stable(os.stat(name, dir_fd=rfd, follow_symlinks=False)) == stable(st), 'member changed')
        for name in files:
            os.unlink(name, dir_fd=rfd)
        os.fsync(rfd)
        os.rmdir(root.name, dir_fd=bfd)
        os.fsync(bfd)
        return proof
    finally:
        for fd in reversed(locks):
            os.close(fd)
        if rfd is not None:
            os.close(rfd)
        os.close(bfd)
