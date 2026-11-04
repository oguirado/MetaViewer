"""One owned ARM64 Firecracker process; no command or protocol semantics here.

The controller must journal intent before open(). The external service is a
dedicated, capped cgroup; this module only observes its enforcement. A return
from open means a raw vsock connection exists, not an authenticated guest.
"""
import fcntl
import hashlib
import os
from pathlib import Path
import platform
import secrets
import stat
import subprocess
import tempfile
import threading
import time

from . import native_checks as checks
from .image import build_initramfs
from .config import validate


class NativeVM:
    def __init__(self, config, record):
        self.config = validate(config)
        self.record = record
        self.process = self.pidfd = self.start = self.directory = None
        self.sock = self.lifetime = None
        self.paths = []
        self.closed = False
        self.open_attempted = False
        self.nonce = None
        self.console_thread = None
        self.console_tail = bytearray()
        self.console_bytes = 0
        self.console_hash = hashlib.sha256()
        self.console_error = None

    def _capture_console(self):
        try:
            with self.process.stdout as stream:
                while True:
                    chunk = stream.read(4096)
                    if not chunk:
                        return
                    self.console_bytes += len(chunk)
                    self.console_hash.update(chunk)
                    self.console_tail.extend(chunk)
                    del self.console_tail[:-4096]
        except BaseException as error:
            self.console_error = type(error).__name__

    def _console_summary(self):
        tail = bytes(self.console_tail)
        # Do not publish lines cut by either retention or EOF. A truncated
        # nonce cannot be redacted reliably by replacing its complete value.
        if self.console_bytes > len(tail):
            mark = tail.find(b'\n')
            tail = tail[mark+1:] if mark >= 0 else b''
        if tail and not tail.endswith(b'\n'):
            tail = tail[:tail.rfind(b'\n')+1]
        text = tail.decode('utf-8', errors='replace')
        if self.nonce:
            text = text.replace(self.nonce, '<redacted>')
        return {'bytes':self.console_bytes, 'sha256':self.console_hash.hexdigest(),
                'tail':text, 'retained_bytes_max':4096}

    def evidence(self):
        return {'pid': self.process.pid if self.process else None,
                'start_ticks': self.start,
                'returncode': self.process.poll() if self.process else None,
                'directory': str(self.directory) if self.directory else None,
                'directory_absent': not self.directory or not self.directory.exists(),
                'external_cgroup': self.config['external_cgroup'],
                'closed': self.closed}

    def live(self):
        checks.require(not self.closed and self.process is not None and
                       self.process.poll() is None, 'owned VM is not live')
        checks.check_cgroup(self.config['external_cgroup'], self.process.pid)
        checks.require(checks.pid_identity(self.process.pid) == self.start,
                       'owned PID identity changed')

    def _assets(self):
        assets = {}
        total = 0
        for name in ('engine', 'kernel', 'broker', 'busybox'):
            spec = self.config['artifacts'][name]
            ceiling = {'broker': 12 << 20, 'busybox': 4 << 20}.get(name, checks.MAX_ASSET)
            data = checks.pinned_asset(spec['path'], spec['sha256'],
                                       static=name in ('broker', 'busybox'),
                                       kernel=name == 'kernel',
                                       max_bytes=min(ceiling, checks.MAX_ASSET-total))
            assets[name] = data
            total += len(data)
        assets['initrd'] = build_initramfs(assets.pop('broker'), assets.pop('busybox'))
        return assets

    def open(self):
        checks.require(not self.open_attempted, 'native allocation is never retried')
        self.open_attempted = True
        checks.require(self.config['runtime_admitted'] is True, 'runtime not admitted')
        checks.require(platform.system() == 'Linux' and platform.machine() == 'aarch64',
                       'Linux ARM64 required')
        checks.require(hasattr(os, 'pidfd_open') and hasattr(checks.signal, 'pidfd_send_signal'),
                       'stable process identity unavailable')
        checks.check_cgroup(self.config['external_cgroup'])
        checks.require(checks.available_memory() >= 32 << 30, 'shared headroom below 32 GiB')
        checks.check_kvm()
        fd = os.open('/dev/kvm', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            checks.require(all(fcntl.ioctl(fd, 0xAE03, cap) > 0
                               for cap in (3, 14, 32, 36, 70, 89, 102)),
                           'required ARM KVM capability absent')
        finally:
            os.close(fd)
        assets = self._assets()
        base = checks.runtime_root(self.config['runtime_root'])
        self.directory = Path(tempfile.mkdtemp(prefix='gc-', dir=base))
        observed = self.directory.stat()
        self.dir_identity = (observed.st_dev, observed.st_ino)
        self.paths = [self.directory / name for name in ('fc', 'Image', 'initrd.gz', 'api.sock', 'vsock.sock')]
        try:
            self.record('allocation', self.evidence())
            for path, data in zip(self.paths[:3], (assets['engine'], assets['kernel'], assets['initrd'])):
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o500 if path == self.paths[0] else 0o400)
                with os.fdopen(fd, 'wb') as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
            del assets, data
            checks.check_cgroup(self.config['external_cgroup'])
            checks.require(checks.available_memory() >= 32 << 30, 'shared headroom changed')
            deadline = time.monotonic() + self.config['startup_seconds']
            self.nonce = secrets.token_hex(32)
            self.process = subprocess.Popen([str(self.paths[0]), '--api-sock', str(self.paths[3])],
                                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                            stderr=subprocess.STDOUT, cwd=self.directory,
                                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C'},
                                            start_new_session=True, close_fds=True)
            self.console_thread = threading.Thread(target=self._capture_console, daemon=True,
                                                   name='guest-console-drain')
            self.console_thread.start()
            self.record('child_returned', self.evidence())
            self.pidfd = os.pidfd_open(self.process.pid)
            self.start = checks.pid_identity(self.process.pid)
            self.record('child_bound', self.evidence())
            self.live()
            checks.wait_socket(self.paths[3], self.process, deadline)
            checks.request(self.paths[3], '/machine-config', {'mem_size_mib': 256, 'vcpu_count': 1}, deadline)
            checks.request(self.paths[3], '/boot-source', {
                'kernel_image_path': str(self.paths[1]), 'initrd_path': str(self.paths[2]),
                'boot_args': 'console=ttyS0 reboot=k panic=1 rdinit=/init mv_guest_command=1 mv_nonce=' + self.nonce,
            }, deadline)
            checks.request(self.paths[3], '/vsock', {'guest_cid': 3, 'uds_path': str(self.paths[4])}, deadline)
            self.lifetime = time.monotonic() + 55
            checks.request(self.paths[3], '/actions', {'action_type': 'InstanceStart'}, min(deadline, self.lifetime))
            self.sock = checks.connect_guest(self.paths[4], self.process, min(deadline, self.lifetime))
            self.sock.setblocking(False)
            return self.sock
        except BaseException:
            try:
                self.close(graceful=False)
            except BaseException:
                pass  # The caller must retain unknown ownership on cleanup failure.
            raise

    def _release_files(self):
        if self.directory is None:
            return
        observed = self.directory.lstat()
        checks.require(stat.S_ISDIR(observed.st_mode) and
                       (observed.st_dev, observed.st_ino) == self.dir_identity,
                       'owned directory identity changed')
        expected = {path.name for path in self.paths}
        checks.require(all(path.name in expected for path in self.directory.iterdir()),
                       'unknown runtime entry; retaining directory')
        for path in self.paths:
            if os.path.lexists(path):
                checks.require(not stat.S_ISDIR(path.lstat().st_mode), 'unexpected runtime subdirectory')
                path.unlink()
        self.directory.rmdir()

    def close(self, *, graceful):
        if self.closed:
            return self.evidence()
        if self.sock is not None:
            self.sock.close()
            self.sock = None
        if self.process is not None:
            if graceful:
                # Guest STOPPING alone never proves closure. Require actual exit.
                checks.require(self.process.wait(timeout=self.config['stop_seconds']) == 0,
                               'guest poweroff failed')
            else:
                checks.cleanup_process(self.process, self.pidfd, self.config['stop_seconds'])
        checks.check_cgroup(self.config['external_cgroup'])
        if self.console_thread is not None:
            self.console_thread.join(timeout=1)
            checks.require(not self.console_thread.is_alive() and self.console_error is None,
                           'console drain closure unproved')
            self.record('console', self._console_summary())
        self._release_files()
        if self.pidfd is not None:
            os.close(self.pidfd)
            self.pidfd = None
        self.closed = True
        result = self.evidence()
        self.record('native_closed', result)
        return result
