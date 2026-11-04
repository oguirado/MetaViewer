#!/usr/bin/env python3
"""Reconcile only sealed source-bound ARM inventory; legacy custody remains held."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat

MAX_FILE = 131072
MAX_EVENTS = 512
PLAN_KEYS = frozenset(('schema', 'run_id', 'unit', 'app', 'source_root', 'expected_commit',
    'registry_sha256', 'script_sha256', 'setup_helper_sha256', 'ui_transport',
    'ui_xauthority_identity', 'ui_bus_identity', 'hosted'))
EVENT_KEYS = {
    'session_admitted': ('guardian', 'cgroup'),
    'identity_create_pending': ('profile',),
    'helper_create_pending': ('name', 'payload', 'inode'),
    'helper_bound': ('cid',),
    'helper_start_pending': ('cid',),
    'identity_ready': ('profile', 'helper_removed'),
    'app_spawn_pending': ('agent_instance', 'actor'),
    'app_spawned': ('pid',),
    'app_exited_closure_unproven': ('returncode',),
    'app_stop_requested': (),
    'app_stop_unknown': (),
}
MISSING_PROOFS = (
    'durable_complete_graphical_allocation_inventory',
    'original_guardian_invocation_and_cgroup_identity',
    'original_app_process_start_identity',
    'cross_manager_pending_attempt_coverage',
    'producer_shutdown_and_source_bound_inventory_seal',
    'independent_exact_resource_closure_observations',
)


class Refused(ValueError):
    pass


def need(ok, reason):
    if not ok:
        raise Refused(reason)


def closed(value, keys):
    need(type(value) is dict and set(value) == set(keys), 'closed object required')


def plan_rewind(plan):
    """Legacy plans remain normal; an explicit mode is a boolean only."""
    need(type(plan) is dict, 'session plan object required')
    mode = plan.get('rewind', False)
    need(type(mode) is bool, 'explicit rewind mode required')
    return mode


def session_root_matches(root, run, plan):
    plan_rewind(plan)
    return root.name.startswith('metaviewer-arm64-' + run + '-')


def canonical(path):
    path = str(path)
    need(path.startswith('/') and not path.startswith('//') and '\0' not in path
         and str(Path(path)) == path and '..' not in Path(path).parts,
         'canonical absolute path required')
    need(str(Path(path).resolve(strict=True)) == path, 'symlink path refused')
    return Path(path)


def private_dir(path):
    p = canonical(path)
    s = p.lstat()
    need(stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid()
         and stat.S_IMODE(s.st_mode) == 0o700, 'private owned directory required')
    return p


def identity(s):
    return tuple(getattr(s, k) for k in ('st_dev', 'st_ino', 'st_mode', 'st_uid',
        'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def private_file(s):
    need(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink == 1
         and stat.S_IMODE(s.st_mode) == 0o600, 'private single-link file required')


def read_private(path):
    p = canonical(path)
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        private_file(before)
        need(0 < before.st_size <= MAX_FILE, 'bounded nonempty evidence required')
        chunks = []
        remaining = MAX_FILE + 1
        while remaining:
            chunk = os.read(fd, min(remaining, 65536))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b''.join(chunks)
        need(len(raw) == before.st_size and identity(before) == identity(os.fstat(fd))
             == identity(p.lstat()), 'evidence changed during read')
        return raw
    finally:
        os.close(fd)


def decode(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    return json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(Refused('nonfinite JSON')))


def event_inventory(root, plan):
    paths = sorted(root.glob('event-*.json'))
    need(len(paths) <= MAX_EVENTS, 'event inventory exceeds bound')
    need([p.name for p in paths] == ['event-%04d.json' % n for n in range(len(paths))],
         'event sequence missing or unknown')
    run = plan['run_id']
    profiles = {'mv-arm64-' + run, 'arm64-browser-' + run, 'arm64-program-' + run}
    helpers = {'mv-arm64-payload-' + kind + '-' + run for kind in ('vm', 'browser', 'program')}
    result = []
    for path in paths:
        eventraw = read_private(path)
        value = decode(eventraw)
        kind = value.get('event') if type(value) is dict else None
        need(type(kind) is str and kind in EVENT_KEYS, 'unknown event kind')
        closed(value, ('event',) + EVENT_KEYS[kind])
        if kind == 'session_admitted':
            prefix = '/user.slice/user-%d.slice/user@%d.service/' % (os.getuid(), os.getuid())
            allowed = {prefix + mid + 'newton-ia.slice/' + plan['unit'] for mid in ('', 'newton.slice/')}
            need(value['guardian'] == plan['unit'] and value['cgroup'] in allowed,
                 'foreign guardian event')
        elif kind in ('identity_create_pending', 'identity_ready'):
            need(value['profile'] in profiles, 'foreign profile event')
            if kind == 'identity_ready':
                need(value['helper_removed'] is True, 'helper closure unknown')
        elif kind == 'helper_create_pending':
            need(value['name'] in helpers and value['payload'] in
                 {str(root / 'store' / 'profiles' / p) for p in profiles}, 'foreign helper event')
            need(type(value['inode']) is list and len(value['inode']) == 2
                 and all(type(n) is int and n >= 0 for n in value['inode']), 'helper inode unknown')
        elif kind in ('helper_bound', 'helper_start_pending'):
            need(type(value['cid']) is str and re.fullmatch('[0-9a-f]{64}', value['cid']), 'container ID unknown')
        elif kind == 'app_spawn_pending':
            agent = 'agent-arm64-' + run
            need(value['agent_instance'] == agent and value['actor'] ==
                 'actor-' + hashlib.sha256(('agent:' + agent).encode()).hexdigest(), 'foreign app actor')
        elif kind == 'app_spawned':
            need(type(value['pid']) is int and value['pid'] > 0, 'app PID unknown')
        elif kind == 'app_exited_closure_unproven':
            need(type(value['returncode']) is int, 'app exit unknown')
        result.append({'file': path.name, 'event': kind,
                       'sha256': hashlib.sha256(eventraw).hexdigest()})
    return result


def inspect_held(path, acquire_lock=True):
    marker = canonical(path)
    need(marker.name == 'held-session.json', 'exact held marker required')
    directory = private_dir(marker.parent)
    lockpath = canonical(directory / 'session.lock')
    fd = os.open(lockpath, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        lock_identity = os.fstat(fd)
        private_file(lock_identity)
        if acquire_lock:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        raw = read_private(marker)
        held = decode(raw)
        closed(held, ('root', 'unit', 'status'))
        need(held['status'] == 'closure-unproven', 'unknown held status')
        root = private_dir(held['root'])
        planraw = read_private(root / 'PLAN.json')
        plan = decode(planraw)
        extra = ({'rewind'} if 'rewind' in plan else set())
        if 'launcher' in plan or 'outer' in plan:
            extra |= {'launcher', 'outer'}
        closed(plan, PLAN_KEYS | extra)
        run = plan['run_id']
        need(type(run) is str and re.fullmatch('[0-9a-f]{24}', run)
             and plan['schema'] == 'metaviewer-arm64-session/v1'
             and session_root_matches(root, run, plan)
             and held['unit'] == plan['unit'] == 'metaviewer-arm64-' + run + '.scope',
             'held/plan session binding mismatch')
        for key, pattern in [('expected_commit', '[0-9a-f]{40}'),
                             ('registry_sha256', '[0-9a-f]{64}'),
                             ('script_sha256', '[0-9a-f]{64}'),
                             ('setup_helper_sha256', '[0-9a-f]{64}')]:
            need(type(plan[key]) is str and re.fullmatch(pattern, plan[key]), 'plan pin malformed')
        need(type(plan['hosted']) is bool, 'plan mode malformed')
        events = event_inventory(root, plan)
        need(event_inventory(root, plan) == events, 'event inventory changed during audit')
        need(read_private(marker) == raw and read_private(root / 'PLAN.json') == planraw
             and identity(os.fstat(fd)) == identity(lock_identity) == identity(lockpath.lstat()),
             'custody changed during audit')
        # No runtime absence is inferred from these metadata-only observations.
        # Current source lacks complete pre-effect allocation/producer-seal receipts.
        return {'schema': 'arm64-capsule-reconcile-audit/v1', 'status': 'held',
                'release_supported': False, 'closure_proven': False,
                'held_marker_sha256': hashlib.sha256(raw).hexdigest(),
                'held_marker_unchanged': True, 'run_id': run, 'unit': plan['unit'],
                'events': events, 'missing_proofs': list(MISSING_PROOFS)}
    finally:
        os.close(fd)


CONTRACT = json.loads('{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://metaviewer.local/contracts/v0.2/capsule_resource_inventory.schema.json","title":"Normal ARM64 source-bound allocation journal row","description":"New metadata-only contract. payload is exact JSON text; runtime validates decoded payload against body and cross-row lifecycle. Digest binds ASCII seq, LF, prev, LF, UTF8 payload. No existing wire envelope is changed.","type":"object","properties":{"seq":{"type":"integer","minimum":1,"maximum":9007199254740991},"prev":{"type":"string","pattern":"^[0-9a-f]{64}$"},"payload":{"type":"string","minLength":2,"maxLength":65536},"sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"schema":{"const":"capsule_resource_inventory/v0.2"}},"required":["seq","prev","payload","sha256","schema"],"additionalProperties":false,"$defs":{"body":{"oneOf":[{"$ref":"#/$defs/session"},{"$ref":"#/$defs/guardian_bound"},{"$ref":"#/$defs/app_pending"},{"$ref":"#/$defs/app_bound"},{"$ref":"#/$defs/native_pending"},{"$ref":"#/$defs/native_bound"},{"$ref":"#/$defs/native_closed"},{"$ref":"#/$defs/service_pending"},{"$ref":"#/$defs/service_bound"},{"$ref":"#/$defs/service_closed"},{"$ref":"#/$defs/helper_pending"},{"$ref":"#/$defs/helper_bound"},{"$ref":"#/$defs/helper_removed"},{"$ref":"#/$defs/unknown"},{"$ref":"#/$defs/producer_sealed"},{"$ref":"#/$defs/coordinator_sealed"}]},"session":{"type":"object","properties":{"stage":{"const":"session"},"producer":{"const":"setup"},"run_id":{"type":"string","pattern":"^[0-9a-f]{24}$"},"actor":{"type":"string","pattern":"^actor-[0-9a-f]{64}$"},"unit":{"type":"string","minLength":1,"maxLength":4096},"root_device":{"type":"integer","minimum":0,"maximum":9007199254740991},"root_inode":{"type":"integer","minimum":1,"maximum":9007199254740991},"source_commit":{"type":"string","pattern":"^[0-9a-f]{40}$"},"asar_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"session_helper_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"setup_helper_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"producer_pins":{"type":"object","properties":{"setup":{"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096},"sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["path","sha256"],"additionalProperties":false},"graphical":{"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096},"sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["path","sha256"],"additionalProperties":false},"guestcommand":{"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096},"sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["path","sha256"],"additionalProperties":false}},"required":["setup","graphical","guestcommand"],"additionalProperties":false},"package_manifest":{"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096},"sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["path","sha256"],"additionalProperties":false},"registry_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["stage","producer","run_id","actor","unit","root_device","root_inode","source_commit","asar_sha256","session_helper_sha256","setup_helper_sha256","producer_pins","package_manifest","registry_sha256"],"additionalProperties":false},"guardian_bound":{"type":"object","properties":{"stage":{"const":"guardian_bound"},"producer":{"const":"setup"},"id":{"const":"guardian"},"unit":{"type":"string","minLength":1,"maxLength":4096},"invocation":{"type":"string","pattern":"^[0-9a-f]{32}$"},"cgroup":{"type":"string","minLength":1,"maxLength":4096},"device":{"type":"integer","minimum":0,"maximum":9007199254740991},"inode":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["stage","producer","id","unit","invocation","cgroup","device","inode"],"additionalProperties":false},"app_pending":{"type":"object","properties":{"stage":{"const":"app_pending"},"producer":{"const":"setup"},"id":{"const":"app"}},"required":["stage","producer","id"],"additionalProperties":false},"app_bound":{"type":"object","properties":{"stage":{"const":"app_bound"},"producer":{"const":"setup"},"id":{"const":"app"},"pid":{"type":"integer","minimum":1,"maximum":9007199254740991},"start_ticks":{"type":"integer","minimum":1,"maximum":9007199254740991},"cgroup":{"type":"string","minLength":1,"maxLength":4096}},"required":["stage","producer","id","pid","start_ticks","cgroup"],"additionalProperties":false},"native_pending":{"type":"object","properties":{"stage":{"const":"native_pending"},"producer":{"const":"graphical"},"id":{"type":"string","minLength":1,"maxLength":4096},"generation":{"type":"string","minLength":1,"maxLength":4096},"profile_id":{"type":"string","minLength":1,"maxLength":4096},"native_kind":{"enum":["vm","browser","program"]},"container_name":{"type":"string","minLength":1,"maxLength":4096},"image_id":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"payload":{"type":"string","minLength":1,"maxLength":4096},"payload_device":{"type":"integer","minimum":0,"maximum":9007199254740991},"payload_inode":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["stage","producer","id","generation","profile_id","native_kind","container_name","image_id","payload","payload_device","payload_inode"],"additionalProperties":false},"native_bound":{"type":"object","properties":{"stage":{"const":"native_bound"},"producer":{"const":"graphical"},"id":{"type":"string","minLength":1,"maxLength":4096},"container_name":{"type":"string","minLength":1,"maxLength":4096},"run_id":{"type":"string","minLength":1,"maxLength":4096},"cid":{"type":"string","pattern":"^[0-9a-f]{64}$"},"native_pid":{"type":"object","properties":{"pid":{"type":"integer","minimum":1,"maximum":9007199254740991},"start":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["pid","start"],"additionalProperties":false},"native_state_path":{"type":"string","minLength":1,"maxLength":4096},"native_state_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["stage","producer","id","container_name","run_id","cid","native_pid","native_state_path","native_state_sha256"],"additionalProperties":false},"native_closed":{"type":"object","properties":{"stage":{"const":"native_closed"},"producer":{"const":"graphical"},"id":{"type":"string","minLength":1,"maxLength":4096}},"required":["stage","producer","id"],"additionalProperties":false},"service_pending":{"type":"object","properties":{"stage":{"const":"service_pending"},"producer":{"const":"guestcommand"},"id":{"type":"string","minLength":1,"maxLength":4096},"unit":{"type":"string","minLength":1,"maxLength":4096}},"required":["stage","producer","id","unit"],"additionalProperties":false},"service_bound":{"type":"object","properties":{"stage":{"const":"service_bound"},"producer":{"const":"guestcommand"},"id":{"type":"string","minLength":1,"maxLength":4096},"unit":{"type":"string","minLength":1,"maxLength":4096},"invocation":{"type":"string","pattern":"^[0-9a-f]{32}$"},"cgroup":{"type":"string","minLength":1,"maxLength":4096},"device":{"type":"integer","minimum":0,"maximum":9007199254740991},"inode":{"type":"integer","minimum":1,"maximum":9007199254740991},"pid":{"type":"integer","minimum":1,"maximum":9007199254740991},"start_ticks":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["stage","producer","id","unit","invocation","cgroup","device","inode","pid","start_ticks"],"additionalProperties":false},"service_closed":{"type":"object","properties":{"stage":{"const":"service_closed"},"producer":{"const":"guestcommand"},"id":{"type":"string","minLength":1,"maxLength":4096}},"required":["stage","producer","id"],"additionalProperties":false},"helper_pending":{"type":"object","properties":{"stage":{"const":"helper_pending"},"producer":{"const":"setup"},"id":{"type":"string","minLength":1,"maxLength":4096},"name":{"type":"string","minLength":1,"maxLength":4096},"image_id":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"payload":{"type":"string","minLength":1,"maxLength":4096},"payload_device":{"type":"integer","minimum":0,"maximum":9007199254740991},"payload_inode":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["stage","producer","id","name","image_id","payload","payload_device","payload_inode"],"additionalProperties":false},"helper_bound":{"type":"object","properties":{"stage":{"const":"helper_bound"},"producer":{"const":"setup"},"id":{"type":"string","minLength":1,"maxLength":4096},"cid":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["stage","producer","id","cid"],"additionalProperties":false},"helper_removed":{"type":"object","properties":{"stage":{"const":"helper_removed"},"producer":{"const":"setup"},"id":{"type":"string","minLength":1,"maxLength":4096}},"required":["stage","producer","id"],"additionalProperties":false},"unknown":{"type":"object","properties":{"stage":{"const":"unknown"},"producer":{"type":"string","enum":["setup","graphical","guestcommand"]},"id":{"type":"string","minLength":1,"maxLength":4096},"reason":{"type":"string","minLength":1,"maxLength":4096}},"required":["stage","producer","id","reason"],"additionalProperties":false},"producer_sealed":{"type":"object","properties":{"stage":{"const":"producer_sealed"},"producer":{"type":"string","enum":["setup","graphical","guestcommand"]},"last_seq":{"type":"integer","minimum":0,"maximum":9007199254740991}},"required":["stage","producer","last_seq"],"additionalProperties":false},"coordinator_sealed":{"type":"object","properties":{"stage":{"const":"coordinator_sealed"},"producer":{"const":"setup"},"producer_ids":{"const":["graphical","guestcommand","setup"]},"last_seq":{"type":"integer","minimum":1,"maximum":9007199254740991},"inventory_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["stage","producer","producer_ids","last_seq","inventory_sha256"],"additionalProperties":false}}}')
CONFIG_SCHEMA = json.loads('{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"schema":{"const":"arm64-resource-inventory-config/v1"},"journal":{"type":"string","minLength":1,"maxLength":4096},"root":{"type":"string","minLength":1,"maxLength":4096},"run_id":{"type":"string","pattern":"^[0-9a-f]{24}$"},"actor":{"type":"string","pattern":"^actor-[0-9a-f]{64}$"},"source_commit":{"type":"string","pattern":"^[0-9a-f]{40}$"},"asar_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"session_helper_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"setup_helper_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"producer_pins":{"type":"object","properties":{"setup":{"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096},"sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["path","sha256"],"additionalProperties":false},"graphical":{"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096},"sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["path","sha256"],"additionalProperties":false},"guestcommand":{"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096},"sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["path","sha256"],"additionalProperties":false}},"required":["setup","graphical","guestcommand"],"additionalProperties":false},"package_manifest":{"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096},"sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["path","sha256"],"additionalProperties":false},"registry_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"images":{"type":"object","properties":{"vm":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"browser":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"program":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"required":["vm"],"additionalProperties":false},"identity_provisioner":{"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096},"sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["path","sha256"],"additionalProperties":false}},"required":["schema","journal","root","run_id","actor","source_commit","asar_sha256","session_helper_sha256","setup_helper_sha256","producer_pins","package_manifest","registry_sha256","images"],"additionalProperties":false}')

MAX_JOURNAL = 8 << 20
MAX_ROWS = 8192
PRODUCERS = ('graphical', 'guestcommand', 'setup')


def shape(value, rule):
    if '$ref' in rule:
        rule = CONTRACT['$defs'][rule['$ref'].split('/')[-1]]
    if 'oneOf' in rule:
        matches = 0
        for child in rule['oneOf']:
            try:
                shape(value, child)
                matches += 1
            except Refused:
                pass
        need(matches == 1, 'payload union mismatch')
        return
    if 'const' in rule:
        need(type(value) is type(rule['const']) and value == rule['const'], 'constant mismatch')
    if 'enum' in rule:
        need(value in rule['enum'], 'enum mismatch')
    kind = rule.get('type')
    if kind == 'object':
        need(type(value) is dict, 'object required')
        need(set(rule.get('required', ())) <= set(value), 'missing fields')
        need(not rule.get('additionalProperties') is False or set(value) <= set(rule['properties']), 'extra fields')
        for key, child in value.items():
            shape(child, rule['properties'][key])
    elif kind == 'string':
        need(type(value) is str and rule.get('minLength', 0) <= len(value) <= rule.get('maxLength', 1 << 30), 'bounded string required')
        if 'pattern' in rule:
            need(re.fullmatch(rule['pattern'], value) is not None, 'pattern mismatch')
    elif kind == 'integer':
        need(type(value) is int and rule.get('minimum', 0) <= value <= rule.get('maximum', 9007199254740991), 'integer bounds')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def protected_pin(pin):
    closed(pin, ('path', 'sha256'))
    need(type(pin['sha256']) is str and re.fullmatch('[0-9a-f]{64}', pin['sha256']), 'pin required')
    p = canonical(pin['path'])
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid in (0, os.getuid())
             and not before.st_mode & 0o022 and 0 < before.st_size <= 1 << 30, 'protected artifact required')
        h = hashlib.sha256()
        total = 0
        while total <= before.st_size:
            chunk = os.read(fd, min(1048576, before.st_size + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            h.update(chunk)
        need(total == before.st_size and identity(before) == identity(os.fstat(fd)) == identity(p.lstat())
             and h.hexdigest() == pin['sha256'], 'artifact pin/custody changed')
    finally:
        os.close(fd)


def load_config(path):
    raw = read_private(path)
    value = decode(raw)
    shape(value, CONFIG_SCHEMA)
    root = private_dir(value['root'])
    need(canonical(path) == root / 'inventory-config.json' and value['journal'] == str(root / 'allocations.jsonl'), 'inventory config location')
    need(root.name.startswith('metaviewer-arm64-' + value['run_id'] + '-'), 'inventory root binding')
    need(value['actor'] == 'actor-' + digest(('agent:agent-arm64-' + value['run_id']).encode()), 'inventory actor binding')
    auxiliary = value.get('identity_provisioner')
    need('browser' not in value['images'] or auxiliary is not None, 'normal browser requires identity provisioner pin')
    if auxiliary is not None:
        need(Path(auxiliary['path']).name == 'mv_identity.py', 'identity provisioner path')
        protected_pin(auxiliary)
        descriptor_raw = read_private(root / 'setup.json')
        need(digest(descriptor_raw) == value['registry_sha256']
             and decode(descriptor_raw).get('identity_provisioner') == auxiliary,
             'identity provisioner descriptor binding')
    return value, raw


def read_journal(path):
    # Empty is permitted only for the producer's first append, never for release.
    p = canonical(path)
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        private_file(before)
        need(before.st_size <= MAX_JOURNAL, 'inventory exceeds bound')
        raw = os.read(fd, MAX_JOURNAL + 1)
        need(len(raw) == before.st_size and identity(before) == identity(os.fstat(fd)) == identity(p.lstat()), 'inventory changed')
        need(not raw or raw.endswith(b'\n'), 'partial inventory tail')
        return raw
    finally:
        os.close(fd)


def row_digest(seq, prev, payload):
    return digest(str(seq).encode('ascii') + b'\n' + prev.encode('ascii') + b'\n' + payload.encode('utf-8'))


def identity_helper_pending(config, body):
    name = body.get('name', '')
    match = re.fullmatch(r'mv-provision-([a-z0-9][a-z0-9-]{1,39})-([0-9a-f]{12})', name)
    need(config.get('identity_provisioner') is not None and match is not None, 'foreign identity helper name')
    profile = match.group(1)
    need(not profile.startswith(('srf-id-cuentas-', 'srf-id-perplexity-', 'srf-pg-'))
         and body.get('id') == name and body.get('image_id') == config['images'].get('browser')
         and body.get('payload') == str(Path(config['root']) / 'store' / 'profiles' / profile),
         'foreign identity helper payload/image')


def correlate_legacy_allocations(events, state):
    """Legacy event sequence is an independent allocation channel, never replaceable
    by a same-name but different-CID or different-PID proposed inventory row.
    Existing helper records are serialized by the pinned setup producer.
    """
    ledger = {v['pending']['name']: v for v in state['resources'].values()
              if v['pending']['stage'] == 'helper_pending' and v['pending']['name'].startswith('mv-arm64-payload-')}
    need(len(ledger) == sum(v['pending']['stage'] == 'helper_pending' and v['pending']['name'].startswith('mv-arm64-payload-')
                           for v in state['resources'].values()), 'duplicate helper name')
    seen, active, bound_cid = set(), None, None
    app_seen = guardian_seen = False
    for event in events:
        kind = event['event']
        if kind == 'helper_create_pending':
            name = event['name']
            need(active is None and name not in seen and name in ledger,
                 'legacy helper attempt omitted or overlapping')
            resource = ledger[name]
            pending = resource['pending']
            need(event['payload'] == pending['payload']
                 and event['inode'] == [pending['payload_device'], pending['payload_inode']],
                 'legacy helper payload identity mismatch')
            seen.add(name)
            active, bound_cid = name, None
        elif kind == 'helper_bound':
            need(active is not None and bound_cid is None, 'legacy helper binding lacks unique intent')
            bound_cid = event['cid']
            need(ledger[active]['bound']['cid'] == bound_cid, 'legacy helper CID mismatch')
        elif kind == 'helper_start_pending':
            need(active is not None and bound_cid is not None and event['cid'] == bound_cid,
                 'legacy helper start CID mismatch')
        elif kind == 'identity_ready':
            need(active is not None and bound_cid is not None
                 and event['profile'] == Path(ledger[active]['pending']['payload']).name
                 and event['helper_removed'] is True, 'legacy helper completion mismatch')
            active, bound_cid = None, None
        elif kind == 'app_spawned':
            need(not app_seen and event['pid'] == state['app']['bound']['pid'],
                 'legacy app PID mismatch')
            app_seen = True
        elif kind == 'session_admitted':
            need(not guardian_seen and event['guardian'] == state['guardian']['unit']
                 and event['cgroup'] == state['guardian']['cgroup'], 'legacy guardian mismatch')
            guardian_seen = True
    need(seen == set(ledger), 'setup helper allocation omitted')
    # A partial legacy sequence cannot discharge responsibility merely because
    # another channel proposes closure. Empty legacy channels remain valid only
    # for explicitly synthetic fixtures; real setup produces these records.
    need(active is None, 'legacy helper completion unknown')


def inventory_state(config, raw, complete=False):
    lines = raw.splitlines()
    need(len(lines) <= MAX_ROWS, 'too many inventory rows')
    rows, last, sealed, resources = [], {}, set(), {}
    guardian = app = None
    coordinator = False
    for line in lines:
        row = decode(line)
        shape(row, CONTRACT)
        need(row['seq'] == len(rows) + 1 and row['prev'] == (rows[-1]['sha256'] if rows else '0' * 64)
             and row['sha256'] == row_digest(row['seq'], row['prev'], row['payload']), 'inventory chain mismatch')
        body = decode(row['payload'].encode('utf-8'))
        shape(body, CONTRACT['$defs']['body'])
        stage, producer = body['stage'], body['producer']
        need(not coordinator and (producer not in sealed or stage == 'coordinator_sealed'), 'write after producer seal')
        if not rows:
            need(stage == 'session', 'session header required')
        if stage == 'session':
            need(not rows, 'duplicate session header')
            root_stat = private_dir(config['root']).stat()
            expected = {k: config[k] for k in ('run_id', 'actor', 'source_commit', 'asar_sha256', 'session_helper_sha256', 'setup_helper_sha256', 'producer_pins', 'package_manifest', 'registry_sha256')}
            expected.update(stage='session', producer='setup', unit='metaviewer-arm64-' + config['run_id'] + '.scope', root_device=root_stat.st_dev, root_inode=root_stat.st_ino)
            need(body == expected, 'inventory header binding mismatch')
        elif stage == 'guardian_bound':
            need(guardian is None, 'duplicate guardian')
            unit = 'metaviewer-arm64-' + config['run_id'] + '.scope'
            prefix = '/user.slice/user-%d.slice/user@%d.service/' % (os.getuid(), os.getuid())
            need(body['unit'] == unit and body['cgroup'] in {prefix + mid + 'newton-ia.slice/' + unit for mid in ('', 'newton.slice/')}, 'guardian hierarchy mismatch')
            guardian = body
        elif stage == 'app_pending':
            need(guardian is not None and app is None, 'app admission order')
            app = {'pending': body}
        elif stage == 'app_bound':
            need(app is not None and 'bound' not in app and body['cgroup'] == guardian['cgroup'], 'app binding mismatch')
            app['bound'] = body
        elif stage in ('native_pending', 'service_pending', 'helper_pending'):
            key = producer + ':' + body['id']
            need(key not in resources, 'duplicate allocation ID')
            need(app is not None or stage == 'helper_pending', 'allocation before app intent')
            if stage == 'native_pending':
                kind, run = body['native_kind'], config['run_id']
                profile = body['profile_id'] if kind == 'program' else ('mv-arm64-' if kind == 'vm' else 'arm64-' + kind + '-') + run
                # Same closed identity grammar as the unchanged adapter's
                # programProfileFor/admitProgramProfile, not a fabricated static ID.
                if kind == 'program':
                    need(re.fullmatch(r'[a-z0-9][a-z0-9-]{1,39}', profile)
                         and not profile.startswith(('srf-id-cuentas-', 'srf-id-perplexity-', 'srf-pg-')),
                         'foreign Program profile')
                prefix = {'vm': 'srf-vm-', 'browser': 'srf-id-', 'program': 'srf-pg-'}[kind]
                need(body['profile_id'] == profile and body['container_name'] == prefix + profile
                     and body['image_id'] == config['images'].get(kind) and body['generation'] == body['id']
                     and body['payload'] == str(Path(config['root']) / 'store' / 'profiles' / profile), 'foreign native allocation')
            if stage == 'helper_pending':
                run = config['run_id']
                if body['name'].startswith('mv-provision-'):
                    identity_helper_pending(config, body)
                else:
                    matches = [kind for kind in config['images'] if body['name'] == 'mv-arm64-payload-' + kind + '-' + run]
                    need(len(matches) == 1, 'foreign helper name')
                    kind = matches[0]
                    profile = ('mv-arm64-' if kind == 'vm' else 'arm64-' + kind + '-') + run
                    need(body['image_id'] == config['images'][kind] and body['payload'] == str(Path(config['root']) / 'store' / 'profiles' / profile), 'foreign helper payload/image')
            if stage == 'service_pending':
                need(re.fullmatch(r'mv-guest-command-[0-9a-f]{16,64}\.service', body['unit']), 'foreign service unit')
            resources[key] = {'pending': body}
        elif stage in ('native_bound', 'service_bound', 'helper_bound', 'native_closed', 'service_closed', 'helper_removed'):
            key = producer + ':' + body['id']
            need(key in resources, 'unreserved allocation')
            resource = resources[key]
            family = stage.split('_')[0]
            need(resource['pending']['stage'] == family + '_pending', 'allocation family mismatch')
            if stage.endswith('_bound'):
                need('bound' not in resource and 'closed' not in resource, 'duplicate/reordered binding')
                if family == 'native':
                    need(body['container_name'] == body['run_id'] == resource['pending']['container_name']
                         and body['native_state_path'] == str(Path(config['root']) / 'native-state' / (body['container_name'] + '.json')), 'native state binding mismatch')
                if family == 'service':
                    need(body['unit'] == resource['pending']['unit'], 'service binding mismatch')
                    prefix = '/user.slice/user-%d.slice/user@%d.service/' % (os.getuid(), os.getuid())
                    need(body['cgroup'] in {prefix + mid + 'newton-ia.slice/' + body['unit'] for mid in ('', 'newton.slice/')}, 'service hierarchy mismatch')
                resource['bound'] = body
            else:
                need('bound' in resource and 'closed' not in resource, 'closure without unique binding')
                resource['closed'] = body
        elif stage == 'unknown':
            resources['unknown:' + str(row['seq'])] = {'unknown': body}
        elif stage == 'producer_sealed':
            need(body['last_seq'] == last.get(producer, 0), 'producer seal sequence mismatch')
            sealed.add(producer)
        elif stage == 'coordinator_sealed':
            need(sealed == set(PRODUCERS) and body['last_seq'] == len(rows)
                 and body['inventory_sha256'] == digest('\n'.join(r['sha256'] for r in rows).encode('ascii')), 'coordinator seal mismatch')
            coordinator = True
        rows.append(row)
        last[producer] = row['seq']
    if complete:
        need(coordinator and guardian is not None and app is not None and 'bound' in app, 'unsealed/pending session')
        need(all('bound' in r and 'closed' in r and 'unknown' not in r for r in resources.values()), 'pending/unknown allocation remains held')
    return {'rows': rows, 'last': last, 'sealed': sealed, 'resources': resources, 'guardian': guardian, 'app': app, 'coordinator': coordinator}


def _append_inventory(config_path, producer, payload, producer_path, auxiliary=False):
    config, configraw = load_config(config_path)
    if auxiliary:
        pin = config.get('identity_provisioner')
        need(pin is not None and producer == 'setup' and canonical(producer_path) == canonical(pin['path']), 'identity provisioner identity mismatch')
        protected_pin(pin)
    else:
        need(producer in PRODUCERS and canonical(producer_path) == canonical(config['producer_pins'][producer]['path']), 'producer identity mismatch')
        protected_pin(config['producer_pins'][producer])
    lockpath = canonical(Path(config['root']) / 'allocations.lock')
    fd = os.open(lockpath, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        private_file(os.fstat(fd))
        import time
        lock_end = time.monotonic() + 2
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                need(time.monotonic() < lock_end, 'inventory writer lock busy')
                time.sleep(0.005)
        journal_before = canonical(config['journal']).lstat()
        raw = read_journal(config['journal'])
        state = inventory_state(config, raw)
        body = dict(payload)
        need(body.get('producer') == producer, 'producer payload mismatch')
        if auxiliary:
            need(body.get('stage') in {'helper_pending', 'helper_bound', 'helper_removed', 'unknown'}, 'identity provisioner stage refused')
            if body['stage'] == 'helper_pending':
                identity_helper_pending(config, body)
            elif body['stage'] == 'unknown' and re.fullmatch(r'identity-mutation-[0-9a-f]{24}', str(body.get('id'))):
                need(type(body.get('reason')) is str and 0 < len(body['reason'].encode('utf-8')) <= 256,
                     'identity mutation diagnostic bound')
                need(all(decode(row['payload'].encode()).get('id') != body['id'] for row in state['rows']),
                     'identity mutation ID reused')
            else:
                resource = state['resources'].get('setup:' + str(body.get('id')))
                need(resource is not None and resource['pending']['stage'] == 'helper_pending', 'identity helper reservation absent')
                identity_helper_pending(config, resource['pending'])

        if body.get('stage') == 'producer_sealed':
            body['last_seq'] = state['last'].get(producer, 0)
        if body.get('stage') == 'coordinator_sealed':
            body.update(producer_ids=list(PRODUCERS), last_seq=len(state['rows']), inventory_sha256=digest('\n'.join(r['sha256'] for r in state['rows']).encode('ascii')))
        text = json.dumps(body, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        seq = len(state['rows']) + 1
        prev = state['rows'][-1]['sha256'] if state['rows'] else '0' * 64
        row = {'schema': 'capsule_resource_inventory/v0.2', 'seq': seq, 'prev': prev, 'payload': text, 'sha256': row_digest(seq, prev, text)}
        encoded = (json.dumps(row, separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8')
        candidate = raw + encoded
        need(len(candidate) <= MAX_JOURNAL, 'inventory bound')
        inventory_state(config, candidate)
        need(read_private(config_path) == configraw and read_journal(config['journal']) == raw, 'inventory/config changed before append')
        out = os.open(config['journal'], os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            private_file(os.fstat(out))
            need(identity(os.fstat(out)) == identity(journal_before)
                 == identity(canonical(config['journal']).lstat()), 'inventory replaced before write')
            view = memoryview(encoded)
            while view:
                count = os.write(out, view)
                need(count > 0, 'short inventory write')
                view = view[count:]
            os.fsync(out)
            need(identity(os.fstat(out)) == identity(canonical(config['journal']).lstat())
                 and read_private(config_path) == configraw, 'inventory/config changed during append')
        finally:
            os.close(out)
        return row
    finally:
        os.close(fd)


def append_inventory(config_path, producer, payload, producer_path):
    return _append_inventory(config_path, producer, payload, producer_path)


def append_identity_helper(config_path, payload, source_path):
    return _append_inventory(config_path, 'setup', payload, source_path, auxiliary=True)


def seal_inventory(config_path, producer, producer_path):
    return append_inventory(config_path, producer, {'stage': 'producer_sealed', 'producer': producer}, producer_path)


def seal_coordinator(config_path, producer_path):
    return append_inventory(config_path, 'setup', {'stage': 'coordinator_sealed', 'producer': 'setup'}, producer_path)

class Observations:
    """Read-only public metadata; errors remain unknown, never empty success."""
    def _query(self, argv, allow_absent_unit=False):
        import subprocess
        uid = os.getuid()
        env = {'PATH': '/usr/bin:/bin', 'XDG_RUNTIME_DIR': '/run/user/' + str(uid),
               'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/' + str(uid) + '/bus'}
        result = subprocess.run(argv, env=env, capture_output=True, timeout=5, check=False)
        need(len(result.stdout) <= 1 << 20, 'metadata query exceeds bound')
        if result.returncode != 0:
            rows = dict(x.split('=', 1) for x in result.stdout.decode('utf-8', 'strict').splitlines() if '=' in x)
            need(allow_absent_unit and rows.get('LoadState') == 'not-found'
                 and rows.get('ActiveState') == 'inactive' and rows.get('ControlGroup') == '', 'metadata query failed')
        return result.stdout

    def docker_ids(self):
        raw = self._query(['/usr/bin/docker', 'container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'])
        rows = raw.decode('ascii').splitlines()
        need(len(rows) <= 8192 and len(rows) == len(set(rows))
             and all(re.fullmatch('[0-9a-f]{64}', row) for row in rows), 'Docker ID inventory invalid')
        return set(rows)

    def pid_start(self, pid):
        try:
            p = Path('/proc') / str(pid) / 'stat'
            with p.open('rb') as stream:
                raw = stream.read(8193)
        except FileNotFoundError:
            return None
        need(len(raw) <= 8192, 'proc stat exceeds bound')
        end = raw.rfind(b')')
        fields = raw[end + 1:].split()
        need(end > 0 and len(fields) > 19 and fields[19].isdigit(), 'process start unknown')
        return int(fields[19])

    def unit(self, unit):
        raw = self._query(['/usr/bin/systemctl', '--user', 'show', unit,
            '--property=LoadState,ActiveState,ControlGroup,InvocationID,MainPID'], allow_absent_unit=True)
        result = {}
        for line in raw.decode('utf-8', 'strict').splitlines():
            need('=' in line, 'unit output malformed')
            key, value = line.split('=', 1)
            need(key not in result, 'duplicate unit property')
            result[key] = value
        need({'LoadState', 'ActiveState', 'ControlGroup', 'InvocationID', 'MainPID'} <= set(result), 'unit witness incomplete')
        return result

    def cgroup(self, group):
        path = Path('/sys/fs/cgroup' + group)
        try:
            actual = canonical(path)
        except FileNotFoundError:
            return None
        st = actual.lstat()
        need(stat.S_ISDIR(st.st_mode), 'cgroup is not directory')
        files = list(actual.rglob('cgroup.procs'))
        need(0 < len(files) <= 128, 'cgroup subtree inventory unknown')
        members = []
        for file in files:
            need(canonical(file) == file, 'cgroup alias')
            raw = file.read_bytes()
            need(len(raw) <= 65536, 'cgroup members exceeds bound')
            values = raw.splitlines()
            need(all(v.isdigit() for v in values), 'cgroup members malformed')
            members.extend(int(v) for v in values)
        raw = (actual / 'cgroup.events').read_bytes()
        need(len(raw) <= 4096, 'cgroup events exceeds bound')
        events = dict(line.split() for line in raw.splitlines())
        need(events.get(b'populated') in (b'0', b'1'), 'cgroup population unknown')
        return {'device': st.st_dev, 'inode': st.st_ino,
                'members': members, 'populated': int(events[b'populated'])}


def prove_process(observer, pid, start):
    observed = observer.pid_start(pid)
    need(observed is None or type(observed) is int and observed > 0, 'process observation unknown')
    need(observed != start, 'original process remains present')
    return {'pid': pid, 'start': start, 'observed_start': observed}


def prove_unit(observer, bound):
    observed = observer.unit(bound['unit'])
    need(type(observed) is dict and {'LoadState', 'ActiveState', 'ControlGroup', 'InvocationID', 'MainPID'} <= set(observed), 'unit observation incomplete')
    need(observed['ActiveState'] in ('inactive', 'failed') and observed['MainPID'] == '0', 'unit still active or unknown')
    if observed['LoadState'] == 'not-found':
        need(observed['ActiveState'] == 'inactive' and observed['ControlGroup'] == '', 'collected unit ambiguous')
    else:
        need(observed['LoadState'] == 'loaded' and observed['InvocationID'] == bound['invocation']
             and observed['ControlGroup'] in ('', bound['cgroup']), 'foreign/replaced unit')
    group = observer.cgroup(bound['cgroup'])
    if group is not None:
        closed(group, ('device', 'inode', 'members', 'populated'))
        need(group['device'] == bound['device'] and group['inode'] == bound['inode']
             and group['members'] == [] and type(group['populated']) is int and group['populated'] == 0,
             'cgroup still populated or replaced')
    return {'unit': bound['unit'], 'invocation': bound['invocation'], 'cgroup': bound['cgroup'], 'unit_state': observed, 'cgroup_state': group}


def descriptor_context(root, plan, config):
    raw = read_private(root / 'setup.json')
    need(digest(raw) == config['registry_sha256'] == plan['registry_sha256'], 'descriptor binding mismatch')
    descriptor = decode(raw)
    required = {'schema','source_commit','source_root','package','python','python_prefix','artifacts','native','runner','files','vm_image','legal','producer_pins','package_manifest','reconciler'}
    need(type(descriptor) is dict and required <= set(descriptor) and set(descriptor) <= required | {'normal_profiles','identity_provisioner'} and descriptor['schema'] == 'metaviewer-arm64-setup/v1', 'descriptor schema incomplete')
    closed(descriptor['package'], ('app','asar'))
    need(type(descriptor['native']) is dict and set(descriptor['native']) in (
        {'srf-identity-admin', 'srf-identity-surface'},
        {'srf-identity-admin', 'srf-identity-surface', 'srf-holdings-capsule'}),
        'native binary closure incomplete')
    closed(descriptor['artifacts'], ('engine','kernel','broker','busybox'))
    closed(descriptor['producer_pins'], PRODUCERS)
    modules = {'guest_command_runtime/' + n + '.py' for n in ('__init__','_schemas','wire','schema','config','image','native_checks','native','protocol','storage','controller')}
    need(type(descriptor['files']) is list and len(descriptor['files']) == len(modules) and {f['relative'] for f in descriptor['files']} == modules, 'descriptor module closure incomplete')
    need(descriptor.get('identity_provisioner') == config.get('identity_provisioner'), 'auxiliary descriptor binding')
    need(descriptor['source_commit'] == config['source_commit'] == plan['expected_commit']
         and descriptor['package']['asar']['sha256'] == config['asar_sha256']
         and descriptor['producer_pins'] == config['producer_pins']
         and descriptor['package_manifest'] == config['package_manifest']
         and config['session_helper_sha256'] == plan['script_sha256']
         and config['setup_helper_sha256'] == plan['setup_helper_sha256'], 'source/package policy mismatch')
    images = {'vm': descriptor['vm_image']}
    images.update({kind: recipe['image_id'] for kind, recipe in descriptor.get('normal_profiles', {}).items()})
    need(config['images'] == images, 'image policy mismatch')
    pins = [descriptor['package']['app'], descriptor['package']['asar'], descriptor['python'],
            descriptor['runner'], descriptor['reconciler'], descriptor['package_manifest']]
    pins += list(descriptor['producer_pins'].values()) + list(descriptor['native'].values()) + list(descriptor['artifacts'].values())
    pins += [{'path': item['path'], 'sha256': item['sha256']} for item in descriptor['files']]
    for pin in pins:
        protected_pin(pin)
    need(canonical(descriptor['reconciler']['path']) == Path(__file__).resolve(), 'reconciler policy mismatch')
    protected_pin({'path': str(Path(config['producer_pins']['setup']['path']).with_name('arm64_capsules.py')), 'sha256': config['setup_helper_sha256']})
    return raw


def reconcile_held(path, config_path=None, release=False, observer=None, *, recover_crashed=False):
    """Normal release requires seals; explicit crash recovery requires bound, absent resources."""
    need(type(recover_crashed) is bool and not (release and recover_crashed), 'choose one release mode')
    releasing = release or recover_crashed
    marker = canonical(path)
    directory = private_dir(marker.parent)
    need(marker.name == 'held-session.json', 'exact held marker required')
    lock = canonical(directory / 'session.lock')
    fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    inventory_fd = None
    try:
        lockid = os.fstat(fd)
        private_file(lockid)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        marker_raw = read_private(marker)
        marker_identity = identity(marker.lstat())
        held = decode(marker_raw)
        closed(held, ('root', 'unit', 'status'))
        need(held['status'] == 'closure-unproven', 'held status unknown')
        root = private_dir(held['root'])
        root_identity = (root.stat().st_dev, root.stat().st_ino)
        plan_raw = read_private(root / 'PLAN.json')
        plan = decode(plan_raw)
        plan_rewind(plan)
        need(plan.get('schema') == 'metaviewer-arm64-session/v1' and plan.get('unit') == held['unit'], 'session plan mismatch')
        fixed = root / 'inventory-config.json'
        if config_path is None and not fixed.exists():
            need(not releasing, 'legacy session cannot release')
            return inspect_held(marker, acquire_lock=False)
        need(config_path is None or canonical(config_path) == fixed, 'foreign inventory config')
        config, config_raw = load_config(fixed)
        if recover_crashed:
            inventory_lock = canonical(root / 'allocations.lock')
            inventory_fd = os.open(inventory_lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
            inventory_identity = identity(os.fstat(inventory_fd))
            private_file(os.fstat(inventory_fd))
            fcntl.flock(inventory_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        need(held['unit'] == 'metaviewer-arm64-' + config['run_id'] + '.scope'
             and plan['run_id'] == config['run_id'], 'inventory session mismatch')
        descriptor_raw = descriptor_context(root, plan, config)
        def recheck_recovery_custody():
            if recover_crashed:
                current = private_dir(held['root']).stat()
                need((current.st_dev, current.st_ino) == root_identity
                     and identity(marker.lstat()) == marker_identity
                     and identity(os.fstat(inventory_fd)) == inventory_identity == identity(inventory_lock.lstat())
                     and descriptor_context(root, plan, config) == descriptor_raw,
                     'crash recovery custody changed')
        ledger_raw = read_journal(config['journal'])
        state = inventory_state(config, ledger_raw, complete=release)
        if not releasing:
            return {'schema': 'arm64-capsule-reconcile-audit/v1', 'status': 'held',
                    'release_supported': True, 'closure_proven': False,
                    'rows': len(state['rows']), 'sealed': state['coordinator']}
        if recover_crashed:
            need(state['guardian'] is not None and state['app'] is not None
                 and 'bound' in state['app'], 'crash inventory lacks app/guardian binding')
            need(all('pending' in item and 'bound' in item and 'unknown' not in item
                     for item in state['resources'].values()), 'crash inventory pending/unknown allocation')
        observed = observer or Observations()
        proofs = []
        cids = set()
        # Existing provisioning events cannot be omitted by a proposed new ledger.
        legacy = event_inventory(root, plan)
        helper_events = [decode(read_private(root / row['file'])) for row in legacy]
        correlate_legacy_allocations(helper_events, state)
        for resource in state['resources'].values():
            pending, bound = resource['pending'], resource['bound']
            if pending['stage'] in ('native_pending', 'helper_pending'):
                cids.add(bound['cid'])
                payload = canonical(pending['payload']).lstat()
                need(payload.st_dev == pending['payload_device'] and payload.st_ino == pending['payload_inode']
                     and stat.S_ISDIR(payload.st_mode) and payload.st_uid == payload.st_gid == 10001
                     and stat.S_IMODE(payload.st_mode) == 0o700, 'payload custody changed')
            if pending['stage'] == 'native_pending':
                proofs.append(prove_process(observed, bound['native_pid']['pid'], bound['native_pid']['start']))
            elif pending['stage'] == 'service_pending':
                proofs.append(prove_unit(observed, bound))
                proofs.append(prove_process(observed, bound['pid'], bound['start_ticks']))
        need(len(cids) == sum(v['pending']['stage'] in ('native_pending', 'helper_pending') for v in state['resources'].values()), 'duplicate container identity')
        need(cids.isdisjoint(observed.docker_ids()), 'owned container remains present')
        proofs.append(prove_process(observed, state['app']['bound']['pid'], state['app']['bound']['start_ticks']))
        proofs.append(prove_unit(observed, state['guardian']))
        need(cids.isdisjoint(observed.docker_ids()), 'owned container reappeared')
        need(read_private(marker) == marker_raw and read_private(root / 'PLAN.json') == plan_raw
             and read_private(fixed) == config_raw and read_private(root / 'setup.json') == descriptor_raw
             and read_journal(config['journal']) == ledger_raw
             and identity(os.fstat(fd)) == identity(lockid) == identity(lock.lstat()), 'custody changed before release')
        recheck_recovery_custody()
        # Persist evidence before the single atomic marker removal; never delete roots/resources.
        import secrets
        archive = directory / ('reconciled-' + config['run_id'] + '-' + secrets.token_hex(8) + '.json')
        proof = {'schema': 'arm64-capsule-reconciliation-proof/v1', 'run_id': config['run_id'],
                 'held_sha256': digest(marker_raw), 'inventory_sha256': digest(ledger_raw),
                 'head': state['rows'][-1]['sha256'], 'proofs': proofs, 'absent_container_ids': sorted(cids)}
        if recover_crashed:
            proof.update(recovery_mode='crashed-owner', coordinator_sealed=state['coordinator'],
                         producer_seals=sorted(state['sealed']))
        out = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(out, 'wb') as stream:
            stream.write((json.dumps(proof, sort_keys=True, separators=(',', ':')) + '\n').encode())
            stream.flush()
            os.fsync(stream.fileno())
        dirfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(dirfd)
            need(read_private(marker) == marker_raw and read_journal(config['journal']) == ledger_raw, 'custody changed at release')
            recheck_recovery_custody()
            os.unlink(marker)
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
        return {'schema': 'arm64-capsule-reconcile-audit/v1', 'status': 'released',
                'release_supported': True, 'closure_proven': True, 'proof': str(archive)}
    finally:
        if inventory_fd is not None:
            os.close(inventory_fd)
        os.close(fd)


# CLI deliberately requires explicit release; ordinary inspection is read-only.
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--held-session', required=True)
    parser.add_argument('--inventory-config')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--release', action='store_true')
    mode.add_argument('--recover-crashed', action='store_true',
                      help='release only a fully bound crash inventory after independent absence proofs')
    args = parser.parse_args()
    try:
        result = reconcile_held(args.held_session, args.inventory_config, args.release,
                                recover_crashed=args.recover_crashed)
    except (ValueError, OSError, TypeError, KeyError, RecursionError):
        print(json.dumps({'schema': 'arm64-capsule-reconcile-audit/v1', 'status': 'refused',
                          'release_supported': False, 'closure_proven': False}, sort_keys=True))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] == 'released' else 2


if __name__ == '__main__':
    raise SystemExit(main())
