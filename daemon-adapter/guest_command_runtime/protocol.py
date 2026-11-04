"""Wire/public byte bounds shared by the command controller."""
import base64
import hashlib
import json
import struct
from .schema import Invalid


def reservation_id(session_id, request_id):
    if type(session_id) is not str or not 1 <= len(session_id) <= 128:
        raise Invalid('session identity')
    session = session_id.encode('utf-8')
    request = request_id.encode('ascii')
    if len(session) > 512:
        raise Invalid('session identity bytes')
    raw = (b'MetaViewer/guest-command/reservation/v1\0' + struct.pack('!I',len(session)) +
           session + struct.pack('!I',len(request)) + request)
    return 'reservation-'+hashlib.sha256(raw).hexdigest()


def prepare_exec(request, binding, contracts):
    contracts.validate('guest_command_request.schema.json', request)
    params = request['params']
    contracts.cwd(params['cwd'])
    command = params['command_utf8'].encode('utf-8')
    if not 1 <= len(command) <= 16384 or b'\0' in command:
        raise Invalid('command bytes')
    try:
        stdin = base64.b64decode(params['stdin_b64'], validate=True)
    except (ValueError, UnicodeError) as error:
        raise Invalid('stdin encoding') from error
    if len(stdin) > 49152 or base64.b64encode(stdin).decode('ascii') != params['stdin_b64']:
        raise Invalid('stdin bytes or noncanonical encoding')
    if params['workload_id'] != binding['workload_id'] or params['generation'] != binding['generation']:
        raise Invalid('command target mismatch')
    meta = {'kind':'exec', **binding, 'request_id':request['request_id'],
            'job_id':params['job_id'], 'cwd':params['cwd'], 'timeout_ms':params['timeout_ms'],
            'command_bytes':len(command), 'stdin_bytes':len(stdin)}
    payload = command+stdin
    contracts.wire(2,meta,len(payload))
    if len(json.dumps(meta,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()) > 4096:
        raise Invalid('metadata bytes')
    return meta,payload
