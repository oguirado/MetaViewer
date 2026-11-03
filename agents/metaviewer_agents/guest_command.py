"""Sequential guest shell jobs over one exclusively claimed authenticated channel.

No host shell, reconnection, resend or second receiver. Unknown keeps ownership;
only the core's correlated stopped/native_absent event confirms release.
"""
from __future__ import annotations

import base64
import copy
from concurrent.futures import Future
import hashlib
import queue
import secrets
import threading
import time

from .envelope import validate_envelope


class GuestCommandError(RuntimeError):
    pass


class GuestCommandUnknown(GuestCommandError):
    pass


def _reservation(session_id, request_id):
    parts = [session_id.encode('utf-8'), request_id.encode('ascii')]
    raw = b'MetaViewer/guest-command/reservation/v1\0'
    for part in parts:
        raw += len(part).to_bytes(4, 'big') + part
    return 'reservation-' + hashlib.sha256(raw).hexdigest()


def _heartbeat_due(now, last_send):
    return now - last_send >= 10.0


def _timeout(value):
    if type(value) is not int or not 1 <= value <= 60000:
        raise ValueError('timeout_ms must be an integer within 1..60000')
    return value


def _command(command, cwd, stdin):
    if not isinstance(command, str) or not 1 <= len(command.encode('utf-8')) <= 16384 or '\0' in command:
        raise ValueError('invalid command UTF-8 bytes')
    if not isinstance(cwd, str) or len(cwd.encode('utf-8')) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in cwd):
        raise ValueError('invalid cwd bytes')
    if cwd and (cwd.startswith('/') or any(p in ('', '.', '..') or len(p.encode('utf-8')) > 255 for p in cwd.split('/'))):
        raise ValueError('cwd must stay below the guest workspace')
    if not isinstance(stdin, bytes) or len(stdin) > 49152 or len(command.encode('utf-8')) + len(stdin) > 65536:
        raise ValueError('invalid stdin bytes')


class GuestOperation:
    """An operation handle; waiting never reissues its request."""
    def __init__(self, body, deadline):
        self._body = copy.deepcopy(body)
        self._request_id = body['request_id']
        self._op = body['op']
        self._job_id = body['params'].get('job_id')
        self._future = Future()
        self._accepted = threading.Event()
        self.deadline = deadline
        self.sent = False
        self.unknown = False
        self.refused = False
        self.stdout = bytearray()
        self.stderr = bytearray()
        self.indices = {'stdout': 0, 'stderr': 0}
        self._pump_thread = None

    @property
    def body(self):
        return copy.deepcopy(self._body)

    @property
    def request_id(self):
        return self._request_id

    @property
    def op(self):
        return self._op

    @property
    def job_id(self):
        return self._job_id

    @property
    def accepted(self):
        return self._accepted.is_set()

    def done(self):
        return self._future.done()

    def result(self, timeout=None):
        if threading.current_thread() is self._pump_thread and not self._future.done():
            raise GuestCommandError("IO owner cannot synchronously wait for itself")
        return copy.deepcopy(self._future.result(timeout))

    def wait_accepted(self, timeout=None):
        if threading.current_thread() is self._pump_thread and not self._accepted.is_set():
            raise GuestCommandError("IO owner cannot wait for itself")
        end = None if timeout is None else time.monotonic() + timeout
        while not self._accepted.is_set():
            if self._future.done():
                self._future.result()
                return False
            if end is not None and time.monotonic() >= end:
                return False
            self._accepted.wait(0.005)
        return True



class GuestCommandSession:
    """Claim an entered ToolClient. Explicit close never means guest closure."""
    @classmethod
    def claim(cls, client):
        return cls(client)

    def __init__(self, client):
        self.client = client
        self._lock = threading.RLock()
        self._queue = queue.Queue(maxsize=8)
        self._wake = threading.Event()
        self._halt = threading.Event()
        self._ops = {}
        self._events = set()
        self._create = None
        self._run = None
        self._session = None
        self._binding = None
        self._reservation = None
        self._last_result = None
        self._uncertain = False
        self._closed = False
        self._create_attempted = False
        self._job_attempts = 0
        self._last_send = time.monotonic()
        self._last_seq = client.active._last_received_seq
        self._owner = 'actor-' + hashlib.sha256(('agent:' + client.local['endpoint']['instance']).encode()).hexdigest()
        with client._io_lock:
            if not client._ready or client._guest_claim is not None or client._frame_subscriptions:
                raise GuestCommandError('exclusive authenticated ToolClient required')
            if client.local['endpoint']['component'] != 'agent':
                raise GuestCommandError('registered agent identity required')
            client._guest_claim = self
            client.active._io_owner = -1
        self._thread = threading.Thread(target=self._pump, name='mv-guest-command', daemon=True)
        self._thread.start()

    @property
    def session(self):
        with self._lock:
            return copy.deepcopy(self._session)

    @property
    def last_result(self):
        with self._lock:
            return copy.deepcopy(self._last_result)

    @property
    def uncertain(self):
        with self._lock:
            return self._uncertain

    @property
    def closed(self):
        with self._lock:
            return self._closed

    def _submit(self, op, params, timeout_ms):
        _timeout(timeout_ms)
        body = {'schema': 'guest_command_request/v0.2', 'request_id': 'request-' + secrets.token_hex(16), 'op': op, 'params': params}
        operation = GuestOperation(body, time.monotonic() + timeout_ms / 1000)
        operation._pump_thread = self._thread
        if operation.request_id in self._ops:
            raise GuestCommandError("request ID already consumed")
        if len(self._ops) >= 256:
            raise GuestCommandError('session request history exhausted')
        # Validate before reserving or exposing the operation to the pump.
        self.client._envelope(body, body['request_id'])
        self._ops[operation.request_id] = operation
        try:
            self._queue.put_nowait(operation)
        except queue.Full:
            del self._ops[operation.request_id]
            raise GuestCommandError('operation queue full') from None
        self._wake.set()
        return operation

    def create(self, *, timeout_ms=30000):
        with self._lock:
            if self._create_attempted or self._halt.is_set():
                raise GuestCommandError('create already consumed or channel closed')
            operation = self._submit('create', {'profile_id': 'guest-command-arm64-v1'}, timeout_ms)
            self._create_attempted = True
            self._create = operation
            self._reservation = _reservation(self.client.session_id, operation.request_id)
        return operation.result()

    def start(self, command, *, cwd='', stdin=b'', timeout_ms=10000):
        """Return immediately; Cancel becomes available only after accepted."""
        _command(command, cwd, stdin); _timeout(timeout_ms)
        with self._lock:
            if self._closed or self._uncertain or self._halt.is_set() or self._session is None or self._session['phase'] != 'ready' or self._run is not None:
                raise GuestCommandError('guest is not ready for another command')
            if self._job_attempts >= 64:
                raise GuestCommandError('job attempt limit reached')
            params = {k: self._session[k] for k in ('workload_id', 'generation')}
            params.update(job_id='job-' + secrets.token_hex(16), command_utf8=command, cwd=cwd, stdin_b64=base64.b64encode(stdin).decode('ascii'), timeout_ms=timeout_ms)
            operation = self._submit('run', params, min(60000, timeout_ms + 5000))
            self._run = operation
            self._job_attempts += 1
            return operation

    def run(self, command, *, cwd='', stdin=b'', timeout_ms=10000):
        return self.start(command, cwd=cwd, stdin=stdin, timeout_ms=timeout_ms).result()

    def cancel(self, *, timeout_ms=5000):
        with self._lock:
            if self._uncertain or self._closed or self._run is None or not self._run._accepted.is_set() or self._run._future.done():
                raise GuestCommandError('cancel requires an accepted active command')
            if any(o.op == 'cancel' and not o._future.done() for o in self._ops.values()):
                raise GuestCommandError('cancel already pending')
            if self._session['controls']['cancel'] is not None or self._session['controls']['stop'] is not None:
                raise GuestCommandError('control already consumed')
            params = {k: self._session[k] for k in ('workload_id', 'generation')}
            params['job_id'] = self._run.job_id
            operation = self._submit('cancel', params, timeout_ms)
        return operation.result()

    def stop(self, *, timeout_ms=15000):
        with self._lock:
            if self._closed:
                return copy.deepcopy(self._session)
            if self._halt.is_set() or self._session is None:
                raise GuestCommandError('no connected immutable guest identity to stop')
            if any(o.op == 'stop' and not o._future.done() and not o.unknown for o in self._ops.values()):
                raise GuestCommandError('stop already pending')
            params = {k: self._session[k] for k in ('workload_id', 'generation')}
            operation = self._submit('stop', params, timeout_ms)
        return operation.result()

    def close(self):
        self._halt.set(); self._wake.set()
        with self._lock:
            if not self._closed:
                self._fail('local channel closed; guest closure unproved')
        self.client.active.close()
        if threading.current_thread() is not self._thread:
            self._thread.join(timeout=4)
            if self._thread.is_alive():
                raise GuestCommandUnknown('IO owner did not terminate')

    def _fail(self, reason):
        self._uncertain = not self._closed
        for op in self._ops.values():
            if not op._future.done():
                op.unknown = True; op.deadline = None
                op._future.set_exception(GuestCommandUnknown(reason))
        # Previously completed jobs remain intact; no synthetic result or closure.

    def _issue(self, operation):
        with self._lock:
            if operation.unknown or operation._future.done():
                return
            if operation.deadline <= time.monotonic():
                raise GuestCommandUnknown('queued operation deadline expired')
            envelope = self.client._envelope(operation.body, operation.request_id)
            operation.sent = True  # possible-send begins before the durable reservation.
            self.client._reserve()
            self.client.active.send(envelope)
            self._last_send = time.monotonic()

    def _heartbeat(self, now):
        # Guest-only list has no response. Any inbound non-guest body remains a
        # protocol violation; this does not introduce a generic reply sink.
        with self._lock:
            if not _heartbeat_due(now, self._last_send):
                return
            body = {"schema": "surface_request/v0.2", "op": "list", "params": {}}
            envelope = self.client._envelope(body, "guest-keepalive-" + secrets.token_hex(16))
            self.client._reserve()
            self.client.active.send(envelope)
            self._last_send = now

    def _controls(self, session, acknowledging=None):
        for name, control in session['controls'].items():
            if control is None:
                continue
            op = self._ops.get(control['request_id'])
            if op is None or op.op != name or not op.sent:
                raise GuestCommandError('foreign control correlation')
            if control['ack'] == 'accepted' and not op._accepted.is_set() and op is not acknowledging:
                raise GuestCommandError('unobserved accepted control')
            if control['ack'] == 'refused' and not op.refused:
                raise GuestCommandError('unobserved refused control')
            if name == 'cancel' and session['job'] is not None and op.job_id != session['job']['job_id']:
                raise GuestCommandError('foreign cancel job')

    def _handle(self, envelope):
        validate_envelope(envelope)
        if envelope['from'] != self.client.core['endpoint'] or envelope['to'] != self.client.local['endpoint'] or envelope['session_id'] != self.client.session_id:
            raise GuestCommandError('foreign core envelope')
        if self._last_seq is not None and envelope['seq'] <= self._last_seq:
            raise GuestCommandError('replayed core sequence')
        self._last_seq = envelope['seq']
        e = envelope['body']
        if e.get('schema') != 'guest_command_event/v0.2':
            raise GuestCommandError('unexpected body on exclusive guest channel')
        if e['event_id'] in self._events or len(self._events) >= 8192:
            raise GuestCommandError('event replay or capacity')
        self._events.add(e['event_id'])
        if e['owner_id'] != self._owner or e['reservation_id'] != self._reservation:
            raise GuestCommandError('foreign owner/reservation')
        op = self._ops.get(e['request_id'])
        kind, data, incoming = e['event'], e['data'], e['session']
        idle_unknown = kind == 'outcome_unknown' and op is self._create and not any(not o._future.done() for o in self._ops.values())
        if op is None or not op.sent or op._future.done() and not idle_unknown and not (kind == 'outcome_unknown' and op.unknown) and not (kind == 'stopped' and op.op == 'stop' and op.unknown) and not (op.op == 'cancel' and op._accepted.is_set()):
            raise GuestCommandError('unknown or terminal request correlation')
        if incoming is not None:
            identity = tuple(incoming[k] for k in ('workload_id', 'generation', 'owner_id', 'profile_id', 'backend', 'isa'))
            if incoming['owner_id'] != self._owner or identity[3:] != ('guest-command-arm64-v1', 'firecracker', 'aarch64'):
                raise GuestCommandError('foreign guest identity')
            if self._binding is not None and identity != self._binding:
                raise GuestCommandError('guest tuple changed')
            if self._binding is None and op.op != 'create':
                raise GuestCommandError('guest identity before create')
        elif op.op != 'create' or self._binding is not None:
            raise GuestCommandError('lost known guest identity')
        if incoming is not None and kind != 'stopped' and incoming['ownership'] != 'held':
            raise GuestCommandError('premature resource release')
        if kind == 'outcome_unknown':
            if data['op'] != op.op:
                raise GuestCommandError('unknown operation mismatch')
            if incoming is not None:
                self._session = copy.deepcopy(incoming)
            self._fail('core reported unknown; no replay')
            return
        if self._uncertain and op.op != 'stop':
            raise GuestCommandError('late success after unknown')
        if kind == 'refused':
            if op._accepted.is_set() or data['op'] != op.op:
                raise GuestCommandError('invalid pre-effect refusal')
            op.refused = True
            if incoming is not None:
                self._controls(incoming)
                self._session = copy.deepcopy(incoming)
            if op is self._run:
                self._run = None
            op._future.set_exception(GuestCommandError('request refused: ' + data['code']))
            return
        if incoming is None:
            raise GuestCommandError('missing guest session')
        if kind == 'accepted':
            if op._accepted.is_set() or data['op'] != op.op:
                raise GuestCommandError('duplicate or wrong acceptance')
            if op.op == 'create':
                if incoming['phase'] != 'starting' or incoming['job'] is not None or incoming['ownership'] != 'held' or incoming['jobs_started'] != 0:
                    raise GuestCommandError('invalid create acceptance')
                self._binding = identity
            elif op.op == 'run':
                if incoming['job']['job_id'] != op.job_id or incoming['job']['state'] != 'running' or incoming['job']['stdout_bytes'] != 0 or incoming['job']['stderr_bytes'] != 0:
                    raise GuestCommandError('wrong accepted job')
            else:
                ctl = incoming['controls'][op.op]
                if ctl is None or ctl['request_id'] != op.request_id or ctl['ack'] != 'accepted':
                    raise GuestCommandError('wrong accepted control')
            self._controls(incoming, acknowledging=op)
            op._accepted.set()
            self._session = copy.deepcopy(incoming)
            if op.op == 'cancel':
                op.deadline = None
                op._future.set_result(copy.deepcopy(incoming))
            return
        if kind == 'ready':
            self._controls(incoming)
            controls = incoming['controls']
            phase = ('awaiting_control' if any(c is not None and c['ack'] == 'pending' for c in controls.values())
                     else 'stopping' if controls['stop'] is not None else 'ready')
            if op is not self._create or not op._accepted.is_set() or incoming['phase'] != phase or incoming['job'] is not None or incoming['jobs_started'] != 0:
                raise GuestCommandError('invalid ready')
            self._session = copy.deepcopy(incoming)
            op._future.set_result(copy.deepcopy(incoming)); op.deadline = None
            return
        if kind in ('output', 'job_finished'):
            if op is not self._run or not op._accepted.is_set() or data['job_id'] != op.job_id or incoming['job']['job_id'] != op.job_id:
                raise GuestCommandError('foreign job event')
            self._controls(incoming)
            if kind == 'output':
                stream = data['stream']
                raw = base64.b64decode(data['data_b64'], validate=True)
                if base64.b64encode(raw).decode('ascii') != data['data_b64'] or not 1 <= len(raw) <= 16384 or data['chunk_index'] != op.indices[stream] or len(op.stdout) + len(op.stderr) + len(raw) > 65536:
                    raise GuestCommandError('invalid output bytes/index')
                getattr(op, stream).extend(raw); op.indices[stream] += 1
                if incoming['job']['stdout_bytes'] != len(op.stdout) or incoming['job']['stderr_bytes'] != len(op.stderr):
                    raise GuestCommandError('output snapshot counts differ')
            else:
                for stream in ('stdout', 'stderr'):
                    raw = bytes(getattr(op, stream))
                    if data[stream + '_sent_bytes'] != len(raw) or data[stream + '_sha256'] != hashlib.sha256(raw).hexdigest() or incoming['job'][stream + '_bytes'] != len(raw):
                        raise GuestCommandError('output conservation failed')
                for control in ('cancel', 'stop'):
                    observed = incoming['controls'][control]
                    wanted = observed['request_id'] if observed is not None and observed['ack'] == 'accepted' else None
                    if data[control + '_request_id'] != wanted:
                        raise GuestCommandError('unobserved terminal control ID')
                job = incoming['job']; cause = data['cause']
                if not data['guest_job_empty'] or (job['exit_code'] is None) == (job['signal'] is None) or job['output_complete'] != (cause != 'output_limit'):
                    raise GuestCommandError('invalid terminal closure')
                if cause in ('cancel', 'stop') and data[cause + '_request_id'] is None:
                    raise GuestCommandError('terminal cause without accepted control')
                expected_state = {'exit': 'exited', 'cancel': 'cancelled', 'stop': 'cancelled', 'timeout': 'timed_out', 'output_limit': 'output_limit'}[cause]
                if job['state'] != expected_state:
                    raise GuestCommandError('terminal state/cause mismatch')
                result = dict(job_id=op.job_id, stdout=bytes(op.stdout), stderr=bytes(op.stderr), exit_code=job['exit_code'], signal=job['signal'], cause=cause, output_complete=job['output_complete'])
                self._last_result = result; op._future.set_result(copy.deepcopy(result)); op.deadline = None; self._run = None
            self._session = copy.deepcopy(incoming)
            return
        if kind == 'stopped':
            if op.op != 'stop' or not (op._accepted.is_set() or self._uncertain) or incoming['phase'] != 'stopped' or incoming['ownership'] != 'released' or not data['native_absent']:
                raise GuestCommandError('unproved guest closure')
            if self._run is not None and not self._uncertain:
                raise GuestCommandError('stopped before job terminal')
            self._session = copy.deepcopy(incoming); self._closed = True
            if not op._future.done():op._future.set_result(copy.deepcopy(incoming))
            self._halt.set(); return
        raise GuestCommandError('unsupported guest event')

    def _pump(self):
        self.client.active._io_owner = threading.get_ident()
        previous = self.client.active._timeout_s
        self.client.active._timeout_s = min(previous, 3.0)
        try:
            while not self._halt.is_set():
                for _ in range(8):
                    try:op = self._queue.get_nowait()
                    except queue.Empty:break
                    self._issue(op)
                self._heartbeat(time.monotonic())
                for _ in range(32):
                    envelope = self.client.active.recv_nowait()
                    if envelope is None:break
                    with self._lock:self._handle(envelope)
                with self._lock:
                    if any(not o._future.done() and o.deadline is not None and time.monotonic() >= o.deadline for o in self._ops.values()):
                        self._fail('operation deadline expired; no replay')
                self._wake.wait(0.005); self._wake.clear()
        except BaseException:
            with self._lock:self._fail('exclusive channel failed; no replay')
            self.client.active.close(); self._halt.set()
        finally:
            self.client.active._timeout_s = previous
            # The lane remains claimed until its owner explicitly closes ToolClient.
