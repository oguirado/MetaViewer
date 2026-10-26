"""Synchronous bounded mailbox client over an owner-only Unix socket.

A CoreClient owns one connection to the core daemon: it validates every
outbound frame before writing, enforces byte caps before decoding, and
pins the sender identity and sequence after the first send. Any inbound
violation, transport failure or timeout closes the socket and leaves the
instance terminal; callers then start over with a fresh client instead of
retrying on compromised state. Single-thread ownership only.
"""

from __future__ import annotations

import math
import os
import socket
import stat
import struct
import time

from .envelope import (
    EnvelopeError,
    dumps_envelope,
    loads_envelope,
    validate_envelope,
)

__all__ = ["ClientError", "CoreClient"]


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
        if (isinstance(timeout_s, bool)
                or not isinstance(timeout_s, (int, float))
                or not math.isfinite(timeout_s) or timeout_s <= 0):
            raise ClientError("timeout", "timeout is not finite positive")
        self._socket_path = socket_path
        self._timeout_s = float(timeout_s)
        self._max_line_bytes = max_line_bytes
        self._max_reply_bytes = max_reply_bytes
        self._next_seq = 1
        self._sock: socket.socket | None = None
        self._terminal = False
        self._rx = bytearray()
        self._pinned: tuple | None = None

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
        self._check_endpoint(path)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(self._timeout_s)
            sock.connect(path)
            self._check_peer(sock)
        except ClientError:
            _silent_close(sock)
            raise
        except (socket.timeout, TimeoutError):
            _silent_close(sock)
            raise ClientError("timeout",
                              "connection timed out") from None
        except OSError:
            _silent_close(sock)
            raise ClientError("socket", "connection failed") from None
        self._sock = sock

    def send(self, envelope: dict) -> int:
        """Validate and emit one frame; returns the sequence sent.

        The envelope must already carry ``next_seq``; validation failures
        consume nothing and leave a connected socket usable, while a
        transport failure closes it and leaves the instance terminal.
        """
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
                    return loads_envelope(line, max_bytes=cap)
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
