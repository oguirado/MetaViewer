#!/usr/bin/env python3
"""Read-only custody and bounded native process helpers copied from accepted ARM harness.

Provenance: mc04-runtime/arm_harness.py sha256
0ff103d8297f15afd6735a092b0e183b72828bd2766718e20555cc13ec31e2fc.
Only definitions before the standalone run/CLI entry are included.
"""
import argparse
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time

PORT = 19001
MEMORY = 256
VCPUS = 1
MAX_ASSET = 128 * 1024 * 1024


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def elf64_arm(data, static=False):
    require(len(data) >= 64 and data[:7] == b'\x7fELF\x02\x01\x01', 'not ELF64 little-endian')
    typ, machine = struct.unpack_from('<HH', data, 16)
    require(machine == 183 and typ in (2, 3), 'not AArch64 executable ELF')
    phoff = struct.unpack_from('<Q', data, 32)[0]
    entsize, count = struct.unpack_from('<HH', data, 54)
    require(entsize >= 56 and count > 0 and phoff >= 64 and phoff + entsize * count <= len(data), 'invalid ELF program headers')
    executable = False
    for i in range(count):
        ptype, flags, offset, _, _, filesz, memsz, _ = struct.unpack_from('<IIQQQQQQ', data, phoff + i * entsize)
        require(offset + filesz <= len(data) and memsz >= filesz, 'invalid ELF segment')
        if static:
            require(ptype not in (2, 3), 'init must have no PT_DYNAMIC or PT_INTERP')
        executable |= ptype == 1 and bool(flags & 1) and filesz > 0
    require(executable, 'no executable load segment')


def pinned_asset(path, expected, static=False, max_bytes=MAX_ASSET, kernel=False):
    require(re.fullmatch(r'[0-9a-f]{64}', expected) is not None, 'SHA256 must be explicit lowercase hex')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        require(stat.S_ISREG(st.st_mode) and 0 < st.st_size <= max_bytes, 'asset must be bounded regular file')
        data = f.read(max_bytes + 1)
    require(len(data) <= max_bytes, 'asset grew beyond bound')
    require(hashlib.sha256(data).hexdigest() == expected, 'asset SHA256 mismatch')
    if kernel:
        require(len(data) >= 64 and data[56:60] == b"ARM\x64", "not raw ARM64 Linux Image")
        flags = struct.unpack_from("<Q", data, 24)[0]
        require(flags & 1 == 0 and (flags >> 1) & 3 == 1, "ARM64 kernel must be LE 4K pages")
        require(0 < struct.unpack_from("<Q", data, 16)[0] <= MEMORY * 1024 * 1024, "invalid ARM64 image size")
    else:
        elf64_arm(data, static)
    return data


def initramfs(init):
    """Root-owned fixed newc metadata, deterministic order and gzip mtime."""
    out = bytearray()
    entries = [('.', stat.S_IFDIR | 0o755, b''), ('proc', stat.S_IFDIR | 0o555, b''),
               ('init', stat.S_IFREG | 0o755, init), ('TRAILER!!!', 0, b'')]
    for inode, (name, mode, data) in enumerate(entries, 1):
        name = name.encode() + b'\0'
        fields = [inode, mode, 0, 0, 2 if stat.S_ISDIR(mode) else 1, 0, len(data), 0, 0, 0, 0, len(name), 0]
        out += b'070701' + ''.join(f'{x:08x}' for x in fields).encode() + name
        out += b'\0' * (-len(out) % 4)
        out += data
        out += b'\0' * (-len(out) % 4)
    out += b'\0' * (-len(out) % 512)
    return gzip.compress(bytes(out), compresslevel=9, mtime=0)


def check_kvm(path='/dev/kvm'):
    fd = os.open(path, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        require(stat.S_ISCHR(os.fstat(fd).st_mode), 'KVM is not a character device')
        require(fcntl.ioctl(fd, 0xAE00, 0) == 12, 'KVM API is not 12')
        vm = fcntl.ioctl(fd, 0xAE01, 0)
        require(vm >= 0, 'KVM_CREATE_VM failed')
        os.close(vm)
    finally:
        os.close(fd)


def self_cgroup():
    lines = Path('/proc/self/cgroup').read_text().splitlines()
    matches = [s[3:] for s in lines if s.startswith('0::')]
    require(len(matches) == 1, 'unified cgroup membership missing')
    return matches[0]


def check_cgroup(path, child=None):
    """Read-only external enforcement evidence; never creates or moves cgroups."""
    root = Path('/sys/fs/cgroup').resolve(strict=True)
    cg = Path(path).resolve(strict=True)
    require(cg != root and root in cg.parents, 'require dedicated external cgroup v2 path')
    require(not any(p.is_dir() for p in cg.iterdir()), 'child cgroup present; descendant ownership unproved')
    expected = '/' + str(cg.relative_to(root))
    require(self_cgroup() == expected, 'harness not in supplied cgroup')
    def cap(name, ceiling):
        value = (cg / name).read_text().strip()
        require(value.isdecimal() and 0 < int(value) <= ceiling, name + ' missing or excessive')
        return int(value)
    memory = cap('memory.max', 512 * 1024 * 1024)
    pids = cap('pids.max', 64)
    swap = (cg / 'memory.swap.max').read_text().strip()
    require(swap == '0', 'external cgroup must disable swap')
    cpu = (cg / 'cpu.max').read_text().split()
    require(len(cpu) == 2 and all(x.isdecimal() for x in cpu) and 0 < int(cpu[0]) <= int(cpu[1]), 'cpu.max must cap one CPU')
    allowed = {os.getpid()} | ({child} if child is not None else set())
    members = {int(x) for x in (cg / 'cgroup.procs').read_text().split()}
    require(members == allowed, 'cgroup is not exclusively harness and owned child')
    return {'path': str(cg), 'memory_max': memory, 'pids_max': pids, 'cpu_max': cpu, 'swap_max': 0}


def available_memory():
    values = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    require('MemAvailable' in values, 'MemAvailable missing')
    value = int(values['MemAvailable'].split()[0]) * 1024
    require(value >= 1024 ** 3, 'host MemAvailable below admission floor')
    return value


def pid_identity(pid):
    # comm can include spaces and parentheses; field 22 follows the LAST ')'.
    text = Path(f'/proc/{pid}/stat').read_text()
    rest = text[text.rfind(')') + 2:].split()
    return int(rest[19])


def remaining(deadline):
    left = deadline - time.monotonic()
    require(left > 0, 'deadline expired')
    return left


def recv_line(sock, deadline, limit=256):
    data = bytearray()
    while len(data) < limit:
        sock.settimeout(remaining(deadline))
        c = sock.recv(1)
        require(c, 'unexpected EOF')
        if c == b'\n':
            return data.decode('ascii', errors='strict')
        require(32 <= c[0] <= 126, 'non-printable protocol byte')
        data += c
    raise RuntimeError('protocol line too long')


def exchange(sock, text, deadline):
    require('\n' not in text and len(text) < 256, 'invalid outgoing frame')
    sock.settimeout(remaining(deadline))
    sock.sendall(text.encode('ascii') + b'\n')
    return recv_line(sock, deadline)


def request(api, path, body, deadline):
    # Each receive is timed against the SAME absolute deadline. HTTPConnection's
    # inactivity timeout alone permits an arbitrarily slow fragmented response.
    payload = json.dumps(body).encode('utf-8')
    outgoing = (f'PUT {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n'
                f'Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n').encode('ascii') + payload
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(remaining(deadline))
        s.connect(str(api))
        s.settimeout(remaining(deadline))
        s.sendall(outgoing)
        header = bytearray()
        while not header.endswith(b'\r\n\r\n'):
            require(len(header) < 8192, 'HTTP response headers too large')
            s.settimeout(remaining(deadline))
            byte = s.recv(1)
            require(byte, 'HTTP response ended before headers')
            header += byte
        lines = header[:-4].decode('ascii', errors='strict').split('\r\n')
        require(re.fullmatch(r'HTTP/1\.[01] [0-9]{3}(?: [ -~]*)?', lines[0]) is not None, 'invalid HTTP status')
        status = int(lines[0].split(' ')[1])
        headers = {}
        for line in lines[1:]:
            name, sep, value = line.partition(':')
            name = name.lower()
            require(sep and re.fullmatch(r'[a-z0-9-]+', name) is not None and name not in headers, 'invalid or duplicate HTTP header')
            headers[name] = value.strip()
        require('transfer-encoding' not in headers, 'unsupported HTTP transfer encoding')
        length = headers.get('content-length', '0')
        require(length.isdecimal() and int(length) <= 4096, 'HTTP body exceeds bound')
        body_bytes = bytearray()
        while len(body_bytes) < int(length):
            s.settimeout(remaining(deadline))
            block = s.recv(int(length) - len(body_bytes))
            require(block, 'HTTP response ended before body')
            body_bytes += block
        remaining(deadline)
        require(status == 204 and not body_bytes, f'API {path}: {status} {bytes(body_bytes)!r}')


def wait_socket(path, process, deadline):
    while not path.exists():
        require(process.poll() is None, 'Firecracker exited before socket')
        time.sleep(min(0.02, remaining(deadline)))
    require(stat.S_ISSOCK(path.lstat().st_mode), 'expected Unix socket')


def connect_guest(path, process, deadline):
    while True:
        require(process.poll() is None, 'Firecracker exited before guest transport')
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.settimeout(min(0.5, remaining(deadline)))
            s.connect(str(path))
            s.sendall(f'CONNECT {PORT}\n'.encode())
            ack = recv_line(s, min(deadline, time.monotonic() + 0.5))
            require(re.fullmatch(r'OK [0-9]+', ack) is not None and 0 < int(ack[3:]) <= 0xffffffff, 'bad CONNECT acknowledgement')
            return s
        except (OSError, RuntimeError):
            s.close()
            time.sleep(min(0.02, remaining(deadline)))


def probe_rejected(path, process, deadline, payload):
    with connect_guest(path, process, deadline) as sock:
        sock.settimeout(remaining(deadline))
        try:
            sock.sendall(payload)
            require(sock.recv(1) == b'', 'guest accepted invalid protocol frame')
        except (ConnectionResetError, BrokenPipeError):
            # Closing an overlong frame can reset a stream with unread bytes.
            pass


def cleanup_process(process, pidfd, timeout):
    forced = False
    if process.poll() is None:
        # pidfd is a stable kernel identity, independent of /proc availability.
        # Otherwise this Popen still owns its unreaped child. Popen.send_signal
        # serializes its own poll and never signals after its returncode is set.
        # No external waiter or SIGCHLD reaper is installed by this harness.
        if pidfd is not None:
            signal.pidfd_send_signal(pidfd, signal.SIGTERM)
        else:
            process.terminate()
        forced = True
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            if pidfd is not None:
                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            else:
                process.kill()
            process.wait(timeout=timeout)
    require(process.poll() is not None, 'owned process not reaped')
    return forced


def runtime_root(path):
    base = Path(path).resolve(strict=True)
    st = base.stat()
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o700, 'runtime root must be own mode 0700 directory')
    require(len(os.fsencode(str(base))) <= 70, 'runtime root too long for Unix sockets')
    return base
