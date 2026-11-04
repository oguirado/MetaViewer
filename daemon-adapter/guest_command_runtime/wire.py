"""Bounded full-duplex guest frames. One reader and one serialized writer.

The mandatory metadata validator is supplied by the versioned protocol layer.
Transport failure poisons this connection; a partially sent command is never
retried. Idle time is bounded by the caller's absolute guest lifetime, while a
partial frame has its own fixed deadline.
"""
import json
from contextlib import contextmanager
import math
import select
import socket
import struct
import threading
import time

HEADER = struct.Struct('!4sBBHIIQ')
MAGIC = b'MVGC'
VERSION = 1
MAX_METADATA = 4096
MAX_PAYLOAD = 65536
MAX_SEQUENCE = (1 << 64) - 1
KINDS = frozenset(range(1, 6))
MAX_JSON_DEPTH = 32


class WireError(RuntimeError):
    pass


def scalar_safe(value, depth=0):
    if depth > MAX_JSON_DEPTH:
        raise WireError('metadata nesting limit')
    if type(value) is float and not math.isfinite(value):
        raise WireError('nonfinite metadata number')
    if type(value) is str:
        try:
            value.encode('utf-8', errors='strict')
        except UnicodeError as error:
            raise WireError('invalid Unicode scalar') from error
    elif type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise WireError('metadata key must be a string')
            scalar_safe(key, depth+1)
            scalar_safe(item, depth+1)
    elif type(value) is list:
        for item in value:
            scalar_safe(item, depth+1)


def strict_object(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise WireError('duplicate metadata key')
            value[key] = item
        return value

    def constant(_):
        raise WireError('nonfinite metadata number')

    try:
        value = json.loads(raw.decode('utf-8', errors='strict'),
                           object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise WireError('invalid metadata JSON') from error
    if type(value) is not dict:
        raise WireError('metadata must be an object')
    scalar_safe(value)
    return value


def frame_bytes(kind, sequence, metadata, payload, validate):
    if type(kind) is not int or kind not in KINDS:
        raise WireError('unknown frame kind')
    if type(sequence) is not int or not 1 <= sequence <= MAX_SEQUENCE:
        raise WireError('sequence out of range')
    if type(metadata) is not dict or type(payload) is not bytes:
        raise WireError('invalid frame types')
    if not callable(validate):
        raise WireError('metadata validator required')
    scalar_safe(metadata)
    validate(kind, metadata, len(payload))
    try:
        raw = json.dumps(metadata, ensure_ascii=False, allow_nan=False,
                         separators=(',', ':'), sort_keys=True).encode('utf-8')
    except (ValueError, TypeError, UnicodeError) as error:
        raise WireError('unencodable metadata') from error
    if not 1 <= len(raw) <= MAX_METADATA or len(payload) > MAX_PAYLOAD:
        raise WireError('frame length out of range')
    return HEADER.pack(MAGIC, VERSION, kind, 0, len(raw), len(payload), sequence) + raw + payload


class FramedSocket:
    def __init__(self, sock, validate, *, partial_seconds=3, clock=time.monotonic):
        if not callable(validate) or not math.isfinite(partial_seconds) or partial_seconds <= 0:
            raise WireError('invalid transport configuration')
        self.sock = sock
        self.validate = validate
        self.partial_seconds = partial_seconds
        self.clock = clock
        self.tx_sequence = 1
        self.rx_sequence = 1
        self.poisoned = False
        self.tx_lock = threading.Lock()
        self.rx_lock = threading.Lock()

    def close(self):
        self.poisoned = True
        self.sock.close()

    def _check(self, deadline):
        if self.poisoned:
            raise WireError('connection is terminal')
        if not isinstance(deadline, (int, float)) or isinstance(deadline, bool) or not math.isfinite(deadline):
            raise WireError('finite absolute deadline required')
        remaining = deadline - self.clock()
        if remaining <= 0:
            raise WireError('frame deadline expired')
        return remaining

    @contextmanager
    def _locked(self, lock, deadline):
        if not lock.acquire(timeout=self._check(deadline)):
            raise WireError('frame lock deadline expired')
        try:
            self._check(deadline)
            yield
        finally:
            lock.release()

    def send(self, kind, metadata, payload=b'', *, deadline):
        # Validation occurs before taking responsibility for any socket write.
        with self._locked(self.tx_lock, deadline):
            self._check(deadline)
            raw = frame_bytes(kind, self.tx_sequence, metadata, payload, self.validate)
            self.tx_sequence += 1
            try:
                offset = 0
                while offset < len(raw):
                    _, writable, _ = select.select([], [self.sock], [], self._check(deadline))
                    if not writable:
                        raise WireError('frame write timed out')
                    try:
                        count = self.sock.send(raw[offset:], socket.MSG_DONTWAIT)
                    except BlockingIOError:
                        continue
                    if count <= 0:
                        raise WireError('short frame write')
                    offset += count
            except BaseException:
                self.poisoned = True
                raise

    def receive(self, *, lifetime_deadline):
        with self._locked(self.rx_lock, lifetime_deadline):
            self._check(lifetime_deadline)
            deadline = lifetime_deadline
            started = False

            def read(size):
                nonlocal deadline, started
                data = bytearray()
                while len(data) < size:
                    ready, _, _ = select.select([self.sock], [], [], self._check(deadline))
                    if not ready:
                        raise WireError('frame read timed out')
                    try:
                        part = self.sock.recv(size - len(data), socket.MSG_DONTWAIT)
                    except BlockingIOError:
                        continue
                    if not part:
                        raise WireError('frame EOF')
                    if not started:
                        started = True
                        deadline = min(lifetime_deadline, self.clock() + self.partial_seconds)
                    data.extend(part)
                return bytes(data)

            try:
                magic, version, kind, flags, metadata_size, payload_size, sequence = HEADER.unpack(read(HEADER.size))
                if magic != MAGIC or version != VERSION or kind not in KINDS or flags != 0:
                    raise WireError('unsupported frame header')
                if not 1 <= metadata_size <= MAX_METADATA or payload_size > MAX_PAYLOAD:
                    raise WireError('frame length out of range')
                if sequence != self.rx_sequence or sequence > MAX_SEQUENCE:
                    raise WireError('frame sequence mismatch')
                metadata = strict_object(read(metadata_size))
                self.validate(kind, metadata, payload_size)
                payload = read(payload_size)
                self.rx_sequence += 1
                return kind, metadata, payload
            except BaseException:
                self.poisoned = True
                raise
