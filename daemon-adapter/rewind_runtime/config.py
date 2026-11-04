"""Protected local admission, separate from renderer/core request data."""
import copy
import json
import os
from pathlib import Path
import re
import stat
from guest_command_runtime.config import closed, host_path
from guest_command_runtime.wire import strict_object

BROKER_SHA='0b3a451d79a01d74497038d48b9d2d5c3e47c645bb873d2c5cd2b0f7d66cd5c6'

APPROVED={'broker':BROKER_SHA,'engine':'fe726e0b43c04363ac07e358be4dee982c3947c65ed3ae10c770fef5e1cd756c','kernel':'43597af54cfbca19bcd7d7d91666a0a55e5a33632eada679827b9ac43393edcf','busybox':'52151e7f322f926b64049cdaa1410dc3ea6485525e0624b05813791c219ae933'}

def validate(value):
    closed(value,('schema','runtime_admitted','owner_id','runtime_root','external_cgroup','artifacts','startup_seconds','stop_seconds'))
    if value['schema']!='rewind-host-config/v1' or type(value['runtime_admitted']) is not bool:
        raise ValueError('explicit rewind profile required')
    if type(value['owner_id']) is not str or re.fullmatch('actor-[a-z0-9][a-z0-9._-]{0,63}',value['owner_id']) is None:
        raise ValueError('owner identity')
    for key in ('runtime_root','external_cgroup'):host_path(value[key])
    if not value['runtime_root'].startswith('/dev/shm/'):raise ValueError('RAM root required')
    for key in ('startup_seconds','stop_seconds'):
        if type(value[key]) is not int or not 1<=value[key]<=10:raise ValueError('bounded deadline required')
    closed(value['artifacts'],('engine','kernel','broker','busybox'))
    for spec in value['artifacts'].values():
        closed(spec,('path','sha256'));host_path(spec['path'])
        if type(spec['sha256']) is not str or re.fullmatch('[0-9a-f]{64}',spec['sha256']) is None:raise ValueError('asset pin')
    if any(value['artifacts'][key]['sha256']!=expected for key,expected in APPROVED.items()):raise ValueError('reviewed artifact set required')
    return copy.deepcopy(value)

def load(path):
    host_path(str(path));fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        st=os.fstat(stream.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode) not in (0o400,0o600) or st.st_nlink!=1 or not 1<=st.st_size<=65536:
            raise ValueError('protected profile custody')
        raw=stream.read(65537);after=os.fstat(stream.fileno())
        if len(raw)>65536 or (st.st_size,st.st_mtime_ns,st.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('profile changed')
    return validate(strict_object(raw))
