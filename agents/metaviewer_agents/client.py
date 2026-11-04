"""Synchronous bounded mailbox client over an owner-only Unix socket.

A CoreClient owns one connection to the core daemon: it validates every
outbound frame before writing, enforces byte caps before decoding, and
pins the sender identity and sequence after the first send. Any inbound
violation, transport failure or timeout closes the socket and leaves the
instance terminal; callers then start over with a fresh client instead of
retrying on compromised state. Single-thread ownership only.

[TARGET, unit decision] Explicit hello/v0.2 exchanges take trusted peer
registration and deps.lock entries from the caller; a matching core hello
acknowledges acceptance. Legacy transport-only connections remain supported.
"""

from __future__ import annotations

import copy
import math
import os
import re
import select
import socket
import stat
import struct
import time
import threading
from functools import wraps
import uuid

from .envelope import (
    EnvelopeError,
    dumps_envelope,
    loads_envelope,
    validate_envelope,
)

__all__ = ["ClientError", "CoreClient", "ToolClient"]

_MAX_TIMEOUT_S = 10_000_000.0


class ClientError(Exception):
    """Closed client failure carrying a fixed machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _map_envelope_error(exc: EnvelopeError) -> ClientError:
    if exc.code == "unknown_version":
        return ClientError("unknown_version", "unknown contract version")
    if exc.code == "length":
        return ClientError("length", "frame exceeds byte limit")
    if exc.code == "bad_shape":
        return ClientError("bad_shape", "invalid frame shape")
    return ClientError("schema", "invalid frame shape")


def _silent_close(sock: socket.socket | None) -> None:
    if sock is not None:
        try:
            sock.close()
        except OSError:
            pass


class CoreClient:
    """Bounded FIFO client for the core mailbox socket."""

    def __init__(self, socket_path: str | os.PathLike[str], *,
                 timeout_s: float, max_line_bytes: int,
                 max_reply_bytes: int) -> None:
        if type(max_line_bytes) is not int or max_line_bytes <= 0:
            raise ClientError("length", "byte cap is not a positive int")
        if type(max_reply_bytes) is not int or max_reply_bytes <= 0:
            raise ClientError("length", "byte cap is not a positive int")
        if isinstance(timeout_s, bool) or not isinstance(timeout_s, (int, float)):
            raise ClientError("timeout", "timeout is not finite positive")
        try:
            timeout_f = float(timeout_s)
        except OverflowError:
            raise ClientError("timeout", "timeout is not finite positive") from None
        if (not math.isfinite(timeout_f) or timeout_f <= 0
                or timeout_f > _MAX_TIMEOUT_S):
            raise ClientError("timeout", "timeout is not finite positive")
        self._socket_path = socket_path
        self._timeout_s = timeout_f
        self._max_line_bytes = max_line_bytes
        self._max_reply_bytes = max_reply_bytes
        self._next_seq = 1
        self._sock: socket.socket | None = None
        self._terminal = False
        self._rx = bytearray()
        self._pinned: tuple | None = None
        self._hello_complete = False
        self._io_owner = None
        self._last_received_seq = None
        self._rx_started = None

    @property
    def connected(self) -> bool:
        """Whether the live channel completed the explicit hello exchange."""
        return self._hello_complete and self._sock is not None and not self._terminal

    def handshake(self, envelope: dict, *, expected_peer: dict,
                  dependency_pins: list[dict]) -> dict:
        """Exchange hello/v0.2 against trusted registration and dependency pins.

        [TARGET, unit decision] The caller supplies the local hello, exact
        expected core hello and dependency entries projected from deps.lock.
        The core's registered hello is its acceptance (serve::connection).
        This opt-in exchange precedes every verb on this channel; legacy
        transport-only callers retain their explicit connect/send interface.
        Any failed exchange is terminal, including local pin mismatches.
        """
        if self._terminal or self._next_seq != 1 or self._hello_complete:
            self._terminate()
            raise ClientError("socket", "hello requires a fresh client")
        try:
            validate_envelope(envelope)
            local = envelope["body"]
            if (local["schema"] != "hello/v0.2"
                    or local["component"] != envelope["from"]["component"]
                    or local["dependencies"] != dependency_pins):
                raise ClientError("version", "hello does not match registration")
            expected = copy.deepcopy(envelope)
            expected["from"], expected["to"] = expected["to"], expected["from"]
            expected["body"] = copy.deepcopy(expected_peer)
            validate_envelope(expected)
            if (expected_peer["schema"] != "hello/v0.2"
                    or expected_peer["component"] != envelope["to"]["component"]):
                raise ClientError("version", "invalid peer registration")
            self.connect()
            reply = self.call(envelope)
            if (reply["body"] != expected["body"]
                    or reply["from"] != expected["from"]
                    or reply["to"] != expected["to"]
                    or reply["session_id"] != expected["session_id"]):
                raise ClientError("version", "peer hello does not match registration")
            self._hello_complete = True
            return reply
        except EnvelopeError as exc:
            self._terminate()
            raise _map_envelope_error(exc) from None
        except ClientError:
            self._terminate()
            raise

    @property
    def next_seq(self) -> int:
        """Sequence the next outbound envelope must carry."""
        return self._next_seq

    def _terminate(self) -> None:
        _silent_close(self._sock)
        self._sock = None
        self._terminal = True
        self._rx.clear()

    def _check_endpoint(self, path: str) -> None:
        try:
            parent_stat = os.lstat(os.path.dirname(path))
        except OSError:
            raise ClientError("socket",
                              "socket directory unavailable") from None
        if (stat.S_ISLNK(parent_stat.st_mode)
                or not stat.S_ISDIR(parent_stat.st_mode)
                or parent_stat.st_uid != os.getuid()
                or stat.S_IMODE(parent_stat.st_mode) != 0o700):
            raise ClientError("socket", "socket directory not owner-only")
        try:
            node_stat = os.lstat(path)
        except OSError:
            raise ClientError("socket", "socket unavailable") from None
        if (stat.S_ISLNK(node_stat.st_mode)
                or not stat.S_ISSOCK(node_stat.st_mode)
                or node_stat.st_uid != os.getuid()
                or stat.S_IMODE(node_stat.st_mode) != 0o600):
            raise ClientError("socket", "socket endpoint not owner-only")

    def _check_peer(self, sock: socket.socket) -> None:
        # Filesystem checks cannot prove who accepted the connection, so
        # the connected peer uid is verified before the first write and
        # any gap in that proof fails closed.
        peercred = getattr(socket, "SO_PEERCRED", None)
        if peercred is None:
            raise ClientError("socket", "peer verification unavailable")
        try:
            raw = sock.getsockopt(socket.SOL_SOCKET, peercred,
                                  struct.calcsize("3i"))
        except OSError:
            raise ClientError("socket",
                              "peer verification unavailable") from None
        try:
            _, uid, _ = struct.unpack("3i", raw)
        except struct.error:
            raise ClientError("socket",
                              "peer verification unavailable") from None
        if uid != os.getuid():
            raise ClientError("socket", "foreign socket peer")

    def connect(self) -> None:
        """Open the verified channel; a no-op while already connected."""
        if self._terminal:
            raise ClientError("socket", "client is terminal")
        if self._sock is not None:
            return
        try:
            path = os.fspath(self._socket_path)
        except TypeError:
            raise ClientError("socket", "invalid socket path") from None
        if (not isinstance(path, str) or chr(0) in path
                or not os.path.isabs(path)):
            raise ClientError("socket", "invalid socket path")
        if (not math.isfinite(self._timeout_s) or self._timeout_s <= 0
                or self._timeout_s > _MAX_TIMEOUT_S):
            raise ClientError("timeout", "timeout is not finite positive")
        self._check_endpoint(path)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(self._timeout_s)
            sock.connect(path)
            self._check_peer(sock)
        except ClientError:
            _silent_close(sock)
            raise
        except (OverflowError, ValueError):
            _silent_close(sock)
            raise ClientError("timeout",
                              "timeout is not finite positive") from None
        except (socket.timeout, TimeoutError):
            _silent_close(sock)
            raise ClientError("timeout",
                              "connection timed out") from None
        except OSError:
            _silent_close(sock)
            raise ClientError("socket", "connection failed") from None
        self._sock = sock

    def _check_io_owner(self):
        if self._io_owner is not None and self._io_owner != threading.get_ident():
            raise ClientError("busy", "channel has an exclusive IO owner")

    def send(self, envelope: dict) -> int:
        """Validate and emit one frame; returns the sequence sent.

        The envelope must already carry ``next_seq``; validation failures
        consume nothing and leave a connected socket usable, while a
        transport failure closes it and leaves the instance terminal.
        """
        self._check_io_owner()
        sock = self._sock
        if self._terminal or sock is None:
            raise ClientError("socket", "client is not connected")
        try:
            validate_envelope(envelope)
        except EnvelopeError as exc:
            raise _map_envelope_error(exc) from None
        if envelope["seq"] != self._next_seq:
            raise ClientError("schema", "sequence does not match")
        identity = (envelope["from"]["component"],
                    envelope["from"]["instance"],
                    envelope["to"]["component"], envelope["to"]["instance"],
                    envelope["session_id"])
        if self._pinned is not None and identity != self._pinned:
            raise ClientError("schema", "sender identity changed")
        try:
            raw = dumps_envelope(envelope, max_bytes=self._max_line_bytes)
        except EnvelopeError as exc:
            raise _map_envelope_error(exc) from None
        try:
            sock.settimeout(self._timeout_s)
            sock.sendall(raw)
        except (socket.timeout, TimeoutError):
            self._terminate()
            raise ClientError("timeout", "send timed out") from None
        except OSError:
            self._terminate()
            raise ClientError("socket", "send failed") from None
        self._pinned = identity
        sent = self._next_seq
        self._next_seq += 1
        return sent

    def recv_nowait(self):
        """Exclusive-pump bounded read; None means no complete frame yet."""
        self._check_io_owner()
        if self._terminal or self._sock is None:
            raise ClientError("socket", "client is not connected")
        cap = self._max_reply_bytes
        now = time.monotonic()
        if self._rx and self._rx_started is None:
            self._rx_started = now
        if self._rx_started is not None and now - self._rx_started >= self._timeout_s:
            self._terminate()
            raise ClientError("timeout", "partial frame timed out")
        if b"\n" not in self._rx:
            try:
                self._sock.setblocking(False)
                data = self._sock.recv(cap + 1 - len(self._rx))
            except BlockingIOError:
                return None
            except OSError:
                self._terminate()
                raise ClientError("socket", "receive failed") from None
            if not data:
                self._terminate()
                raise ClientError("socket", "peer closed the connection")
            if self._rx_started is None:
                self._rx_started = now
            self._rx.extend(data)
        mark = self._rx.find(b"\n")
        if len(self._rx) > cap and mark < 0 or mark + 1 > cap:
            self._terminate()
            raise ClientError("length", "reply exceeds byte limit")
        if mark < 0:
            return None
        line = bytes(self._rx[:mark+1]); del self._rx[:mark+1]
        if not self._rx:
            self._rx_started = None
        try:
            result = loads_envelope(line, max_bytes=cap)
        except EnvelopeError as exc:
            self._terminate()
            raise _map_envelope_error(exc) from None
        self._last_received_seq = result["seq"]
        return result

    def recv(self) -> dict:
        """Return the next validated inbound frame in FIFO order.

        Reads stay within the reply cap plus one sentinel byte, so an
        oversized frame is refused before any decode; a single monotonic
        deadline covers the whole call and received bytes never extend it.
        Any failure closes the socket and leaves the instance terminal.
        """
        sock = self._sock
        if self._terminal or sock is None:
            raise ClientError("socket", "client is not connected")
        self._check_io_owner()
        cap = self._max_reply_bytes
        buf = self._rx
        deadline = time.monotonic() + self._timeout_s
        while True:
            mark = buf.find(b"\n")
            if mark >= 0:
                line = bytes(buf[:mark + 1])
                del buf[:mark + 1]
                if len(line) > cap:
                    self._terminate()
                    raise ClientError("length", "reply exceeds byte limit")
                try:
                    result = loads_envelope(line, max_bytes=cap)
                    self._last_received_seq = result["seq"]
                    return result
                except EnvelopeError as exc:
                    self._terminate()
                    raise _map_envelope_error(exc) from None
            if len(buf) > cap:
                self._terminate()
                raise ClientError("length", "reply exceeds byte limit")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._terminate()
                raise ClientError("timeout", "receive timed out")
            try:
                sock.settimeout(remaining)
                chunk = sock.recv(cap + 1 - len(buf))
            except (socket.timeout, TimeoutError):
                self._terminate()
                raise ClientError("timeout", "receive timed out") from None
            except OSError:
                self._terminate()
                raise ClientError("socket", "receive failed") from None
            if chunk == b"":
                partial = len(buf) > 0
                self._terminate()
                if partial:
                    raise ClientError("schema", "unterminated frame at EOF")
                raise ClientError("socket", "peer closed the connection")
            buf += chunk

    def call(self, envelope: dict) -> dict:
        """Emit one frame and return the next inbound frame, in order."""
        self.send(envelope)
        return self.recv()

    def close(self) -> None:
        """Idempotently shut down; the instance stays terminal after."""
        sock, self._sock = self._sock, None
        self._terminal = True
        self._rx.clear()
        _silent_close(sock)

    def __enter__(self) -> CoreClient:
        self.connect()
        return self

    def __exit__(self, exc_type: object, exc: object,
                 traceback: object) -> None:
        self.close()


_RECORD_OP_EVENTS = {
    "ram_start": frozenset({"started", "refused"}),
    "disk_start": frozenset({"started", "refused"}),
    "ram_stop": frozenset({"frame_captured", "dropped", "stopped", "refused"}),
    "disk_stop": frozenset({"exported", "stopped", "refused"}),
    "screenshot": frozenset({"started", "frame_captured", "exported", "stopped", "refused"}),
}


def _exclusive_tool_io(method):
    @wraps(method)
    def guarded(self, *args, **kwargs):
        with self._io_lock:
            if self._guest_claim is not None:
                raise ClientError("busy", "tool client is claimed by a guest command session")
            return method(self, *args, **kwargs)
    return guarded


class ToolClient:
    """Production tool mailbox, usable by tools and the MCP bridge.

    [TARGET, unit decision] Trusted registrations use the core's startup
    config. An owner-only sequence file serializes connections and persists
    sequence reservations before writes, including failed sends. Never erase
    this file while reusing a core session. Use as a context manager.
    """

    # Legacy isolated test doubles construct with __new__; they remain unclaimed
    # and serialize through this fallback. Real clients receive per-instance locks.
    _io_lock = threading.RLock()
    _guest_claim = None

    def __init__(self, socket_path, *, session_id, local, core,
                 dependency_pins, sequence_path, timeout_s,
                 max_line_bytes, max_reply_bytes):
        self._io_lock = threading.RLock()
        self._guest_claim = None
        self.active = CoreClient(socket_path, timeout_s=timeout_s,
                                 max_line_bytes=max_line_bytes,
                                 max_reply_bytes=max_reply_bytes)
        self.session_id = session_id
        self.local = copy.deepcopy(local)
        self.core = copy.deepcopy(core)
        self.pins = copy.deepcopy(dependency_pins)
        self.sequence_path = sequence_path
        self._sequence_fd = None
        self._ready = False
        self._receipts = {}
        self._frame_surfaces = set()
        self._frame_subscriptions = set()
        self._frames = {}

    @property
    def guest_commands(self):
        """Claim the existing entered agent channel; never create a native guest."""
        from .guest_command import GuestCommandSession
        if self._guest_claim is None:
            return GuestCommandSession.claim(self, observe_owned=True)
        if not isinstance(self._guest_claim, GuestCommandSession):
            raise ClientError('busy', 'another IO owner holds the channel')
        return self._guest_claim

    @property
    def rewind(self):
        """REWIND helper on the same guest-command IO pump."""
        return self.guest_commands.rewind

    def _accept_frame_event(self, body):
        """Retain only validated frames/lifecycle notices for registered surfaces."""
        from .tools import ToolValidationError, _check_frame, _check_surface
        if not isinstance(body,dict):
            raise ToolValidationError('asynchronous body must be an object')
        schema = body.get('schema')
        if schema == 'frame_ref/v0.2':
            frame = body
        elif schema == 'surface_event/v0.2':
            if set(body) != {'schema', 'event', 'data'} or not isinstance(body['data'], dict):
                raise ToolValidationError('invalid asynchronous surface event')
            data = body['data']
            if body['event'] == 'frame_ready' and set(data) == {'frame_ref'}:
                frame = data['frame_ref']
            elif body['event'] in ('created', 'state_changed', 'destroyed') and set(data) == {'surface'}:
                _check_surface(data['surface'])
                if data['surface']['surface_id'] not in self._frame_surfaces:
                    raise ToolValidationError('uncorrelated asynchronous surface')
                return True
            else:
                raise ToolValidationError('invalid asynchronous surface event')
        else:
            return False
        _check_frame(frame)
        sid = frame['surface_id']
        if sid not in self._frame_surfaces:
            raise ToolValidationError('uncorrelated asynchronous frame')
        old = self._frames.get(sid)
        if old is None or frame['generation'] > old['generation']:
            self._frames[sid] = copy.deepcopy(frame)
        elif frame['generation'] == old['generation'] and frame != old:
            raise ToolValidationError('conflicting asynchronous frame')
        return True

    def subscribe_frames(self, surface_id, *, timeout_ms):
        return self._frame_subscription(surface_id, True, timeout_ms)

    def unsubscribe_frames(self, surface_id, *, timeout_ms):
        return self._frame_subscription(surface_id, False, timeout_ms)

    @_exclusive_tool_io
    def drain_frames(self, *, timeout_ms):
        """Consume at most one ready authenticated frame, with no pending tool call.

        The same owner calls this while waiting for an external planner. There
        is no background reader and an unexpected tool result is never discarded.
        """
        from .tools import _check_timeout, ToolValidationError
        _check_timeout(timeout_ms, 'timeout_ms')
        if not self._ready:
            raise ClientError('socket', 'tool client requires hello')
        if b'\n' not in self.active._rx and not select.select([self.active._sock], [], [], 0)[0]:
            return False
        previous = self.active._timeout_s
        try:
            self.active._timeout_s = min(previous, timeout_ms / 1000)
            reply = self.active.recv()
            if (reply['from'] != self.core['endpoint'] or reply['to'] != self.local['endpoint']
                    or reply['session_id'] != self.session_id):
                raise ToolValidationError('uncorrelated asynchronous envelope')
            if not self._accept_frame_event(reply['body']):
                raise ToolValidationError('unexpected response while draining frames')
            return True
        except BaseException:
            self.close()
            raise
        finally:
            self.active._timeout_s = previous

    @_exclusive_tool_io
    def _frame_subscription(self, surface_id, subscribe, timeout_ms):
        from .tools import _check_id, _check_timeout, ToolValidationError
        _check_id(surface_id, 'surface_id')
        _check_timeout(timeout_ms, 'timeout_ms')
        if not self._ready:
            raise ClientError('socket', 'tool client requires hello')
        if surface_id not in self._frame_surfaces and len(self._frame_surfaces) >= 128:
            raise ToolValidationError('frame surface capacity exceeded')
        if not subscribe and surface_id not in self._frame_subscriptions:
            raise ToolValidationError('frame subscription is not owned by this client')
        body = dict(schema='surface_request/v0.2',
                    op='frame_subscribe' if subscribe else 'frame_unsubscribe',
                    params=dict(surface_id=surface_id))
        envelope = self._envelope(body, 'agent-frames-' + uuid.uuid4().hex)
        previous = self.active._timeout_s
        try:
            self.active._timeout_s = min(previous, timeout_ms / 1000)
            self._reserve()
            self.active.send(envelope)
            self._frame_surfaces.add(surface_id)
            if subscribe:
                self._frame_subscriptions.add(surface_id)
            else:
                self._frame_subscriptions.remove(surface_id)
        except BaseException:
            self.close()
            raise
        finally:
            self.active._timeout_s = previous

    def _envelope(self, body, msg_id):
        from .envelope import make_envelope
        return make_envelope(msg_id=msg_id,
                             from_component="agent",
                             from_instance=self.local["endpoint"]["instance"],
                             to_component="core",
                             to_instance=self.core["endpoint"]["instance"],
                             session_id=self.session_id,
                             seq=self.active.next_seq, body=body)

    def _reserve(self):
        # Reserve before send via atomic temp-write + fsync + replace so a
        # partial or zero-byte write can never regress or truncate sequence_path.
        import fcntl
        seq_path = os.fspath(self.sequence_path)
        tmp_path = seq_path + ".tmp"
        data = str(self.active.next_seq + 1).encode("ascii")
        tmp_fd = None
        try:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass
            tmp_fd = os.open(
                tmp_path,
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            )
            info = os.fstat(tmp_fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
                raise ClientError("socket", "invalid sequence file")
            if os.write(tmp_fd, data) != len(data):
                raise ClientError("socket", "sequence reservation failed")
            os.fsync(tmp_fd)
            fcntl.flock(tmp_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.replace(tmp_path, seq_path)
        except BaseException as exc:
            if tmp_fd is not None:
                try:
                    os.close(tmp_fd)
                except OSError:
                    pass
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            if isinstance(exc, ClientError):
                raise
            raise ClientError("socket", "sequence reservation failed") from None
        old_fd, self._sequence_fd = self._sequence_fd, tmp_fd
        if old_fd is not None:
            try:
                os.close(old_fd)
            except OSError:
                pass

    @_exclusive_tool_io
    def __enter__(self):
        import fcntl
        import secrets
        try:
            hello = self.local["hello"]
            if (self.local["endpoint"]["component"] != "agent"
                    or self.core["endpoint"]["component"] != "core"
                    or hello["component"] != "agent"
                    or hello["dependencies"] != self.pins
                    or self.core["hello"]["component"] != "core"):
                raise ClientError("version", "invalid trusted registration")
            self.active._check_endpoint(os.fspath(self.active._socket_path))
            fd = os.open(self.sequence_path,
                         os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            self._sequence_fd = fd
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
                raise ClientError("socket", "invalid sequence file")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                # [TARGET, unit decision] Contention is a closed refusal;
                # retain the lock and never admit a second sequence writer.
                lane = self.local["endpoint"]["instance"]
                raise ClientError("busy", f"registered agent lane {lane} is busy "
                                  "with a running goal; wait for it to finish or explicitly "
                                  "stop it before starting another goal") from None
            raw = os.read(fd, 32)
            if raw and not re.fullmatch(rb"[1-9][0-9]{0,15}", raw):
                raise ClientError("schema", "invalid sequence state")
            self.active._next_seq = int(raw) if raw else 1
            request = self._envelope(hello, secrets.token_hex(16))
            expected = copy.deepcopy(request)
            expected["from"], expected["to"] = request["to"], request["from"]
            expected["body"] = copy.deepcopy(self.core["hello"])
            validate_envelope(expected)
            self.active.connect()
            self._reserve()
            reply = self.active.call(request)
            if any(reply[key] != expected[key]
                   for key in ("schema", "from", "to", "session_id", "body")):
                raise ClientError("version", "peer hello does not match registration")
            self._ready = True
            return self
        except BaseException:
            self.close()
            raise

    @_exclusive_tool_io
    def request(self, body, expect, *, timeout_ms):
        from .tools import ToolValidationError
        if not self._ready:
            raise ClientError("socket", "tool client requires hello")
        if type(timeout_ms) is not int or not 1 <= timeout_ms <= 60000:
            raise ClientError("timeout", "invalid request timeout")
        if (not isinstance(body, dict)
                or not isinstance(body.get("request_id"), str)
                or not body["request_id"]):
            raise ClientError("bad_shape", "missing request_id")
        try:
            envelope = self._envelope(body, body["request_id"])
        except EnvelopeError as exc:
            raise _map_envelope_error(exc) from None
        previous = self.active._timeout_s
        deadline = time.monotonic() + min(previous, timeout_ms / 1000)
        try:
            self.active._timeout_s = max(0.000001, deadline - time.monotonic())
            self._reserve()
            self.active.send(envelope)
            async_count = 0
            headless_accepted = None
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise ClientError("timeout", "request timed out")
                self.active._timeout_s = left
                reply = self.active.recv()
                if (reply["from"] != envelope["to"]
                        or reply["to"] != envelope["from"]
                        or reply["session_id"] != self.session_id):
                    raise ToolValidationError("uncorrelated envelope")
                result = reply["body"]
                if self._accept_frame_event(result):
                    async_count += 1
                    if async_count > 512:
                        raise ToolValidationError('frame event capacity exceeded')
                    continue
                # Core forwards settled receipts asynchronously before tool replies.
                # Retain bounded evidence, never turn it into missing focus proof.
                if result.get("schema") == "action_receipt/v0.2":
                    self._receipts[result["proposal_id"]] = copy.deepcopy(result)
                    if len(self._receipts) > 128:
                        del self._receipts[next(iter(self._receipts))]
                    continue
                if expect == "record_event/v0.2":
                    params = (body.get("params")
                              if isinstance(body.get("params"), dict) else {})
                    want_surface = params.get("surface_id")
                    want_recording = params.get("recording_id",
                                                params.get("capture_id"))
                    allowed = _RECORD_OP_EVENTS.get(body.get("op"), frozenset())
                    correlated = (
                        result.get("schema") == "record_event/v0.2"
                        and result.get("request_id") == body["request_id"]
                        and isinstance(want_surface, str)
                        and result.get("surface_id") == want_surface
                        and isinstance(want_recording, str)
                        and result.get("recording_id") == want_recording
                        and result.get("event") in allowed
                    )
                elif expect == "headless_event/v0.2":
                    correlated = (result.get("schema") == expect
                                  and result.get("request_id") == body["request_id"])
                    if not correlated:
                        raise ToolValidationError("uncorrelated headless event")
                    kind = result.get("event")
                    data = result.get("data", {})
                    if kind == "accepted":
                        if headless_accepted is not None or data.get("op") != body.get("op"):
                            raise ToolValidationError("duplicate or wrong headless acceptance")
                        headless_accepted = copy.deepcopy(data["session"])
                        continue
                    if kind == "refused":
                        if headless_accepted is not None:
                            raise ToolValidationError("headless refusal after acceptance")
                    elif kind == "outcome_unknown":
                        if data.get("op") != body.get("op"):
                            raise ToolValidationError("wrong headless unknown operation")
                        if headless_accepted is not None and any(
                                data.get("session", {}).get(key) != headless_accepted.get(key)
                                for key in ("workload_id", "generation", "owner_id")):
                            raise ToolValidationError("uncorrelated headless unknown session")
                    else:
                        expected = {"create": ("state_changed", "ready"),
                                    "run": ("completed", "completed"),
                                    "stop": ("state_changed", "stopped")}.get(body.get("op"))
                        session = data.get("session", {})
                        if (headless_accepted is None
                                or expected != (kind, session.get("phase"))
                                or any(session.get(key) != headless_accepted.get(key)
                                       for key in ("workload_id", "generation", "owner_id"))):
                            raise ToolValidationError("invalid headless terminal event")
                elif expect == "mv_tool_result/v0.2":
                    correlated = (
                        result.get("schema") == "mv_tool_result/v0.2"
                        and isinstance(body.get("op"), str)
                        and result.get("request_id") == body["request_id"]
                        and result.get("op") == body.get("op")
                    )
                else:
                    correlated = False
                if not correlated:
                    raise ToolValidationError("uncorrelated tool result")
                return result
        except BaseException:
            self.close()
            raise
        finally:
            self.active._timeout_s = previous

    def receipt(self, proposal_id):
        """Return received core evidence, without claiming tool verification."""
        return copy.deepcopy(self._receipts.get(proposal_id))

    def close(self):
        claim = self._guest_claim
        if claim is not None:
            claim.close()
        self._close_transport()

    def _close_transport(self):
        self._ready = False
        self.active.close()
        if self._sequence_fd is not None:
            os.close(self._sequence_fd)
            self._sequence_fd = None

    def __exit__(self, *exc):
        self.close()
