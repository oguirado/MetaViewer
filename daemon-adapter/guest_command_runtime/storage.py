"""Single-writer bounded private evidence for a command guest.

Reopening evidence is inspection-only: surviving records require explicit
native reconciliation, never automatic replay. Raw output has a separate cap.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from .wire import strict_object, scalar_safe

MAX_JOURNAL = 8 << 20
MAX_OUTPUT = 4 << 20
MAX_JOB_OUTPUT = 65536


class StorageError(RuntimeError):
    pass


def encode(value):
    scalar_safe(value)
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      sort_keys=True, separators=(',', ':')).encode('utf-8')


def write_all(fd, value):
    view = memoryview(value)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise StorageError('short evidence write')
        view = view[written:]


def private_file(fd):
    st = os.fstat(fd)
    if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or
            st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o600):
        raise StorageError('evidence must be a single-link private owned file')


class Store:
    def __init__(self, root, config_digest):
        if re.fullmatch('[0-9a-f]{64}', config_digest) is None:
            raise StorageError('configuration digest required')
        root = Path(root)
        if not root.is_absolute() or str(root) != str(root.resolve(strict=True)):
            raise StorageError('canonical evidence directory required')
        st = root.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
            raise StorageError('private owned evidence directory required')
        self.root = root
        self.dirfd = self.lockfd = self.fd = None
        self.closed = self.poisoned = False
        self.rows = []
        self.head = '0'*64
        self.jobs = {}
        self.output_bytes = 0
        try:
            self.dirfd = os.open(root, os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            bound = os.fstat(self.dirfd)
            if (bound.st_dev, bound.st_ino) != (st.st_dev, st.st_ino):
                raise StorageError('evidence directory changed')
            self.lockfd = os.open('owner.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.dirfd)
            private_file(self.lockfd)
            fcntl.flock(self.lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.fd = os.open('journal.jsonl', os.O_CREAT | os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.dirfd)
            private_file(self.fd)
            size = os.fstat(self.fd).st_size
            if size > MAX_JOURNAL:
                raise StorageError('journal too large')
            raw = os.read(self.fd, size+1)
            if len(raw) != size or (raw and not raw.endswith(b'\n')):
                raise StorageError('partial journal; explicit reconciliation required')
            if not raw and set(os.listdir(self.dirfd)) != {'owner.lock', 'journal.jsonl'}:
                raise StorageError('unaccounted evidence in fresh directory')
            for line in raw.splitlines():
                row = strict_object(line)
                if (set(row) != {'seq', 'prev', 'body', 'sha256'} or
                        type(row['seq']) is not int or row['seq'] != len(self.rows)+1 or
                        row['prev'] != self.head):
                    raise StorageError('invalid journal chain')
                digest = hashlib.sha256(encode({k: row[k] for k in ('seq','prev','body')})).hexdigest()
                if row['sha256'] != digest:
                    raise StorageError('journal digest mismatch')
                self.rows.append(row)
                self.head = digest
            self.recovery_required = bool(self.rows)
            expected = {'kind': 'owner', 'config_sha256': config_digest}
            if self.rows and self.rows[0]['body'] != expected:
                raise StorageError('configuration changed')
            if not self.rows:
                self.append(expected)
        except BaseException:
            self.close()
            raise

    def _writable(self):
        if self.closed or self.poisoned:
            raise StorageError('evidence store closed or poisoned')
        if getattr(self, 'recovery_required', False):
            raise StorageError('surviving evidence requires reconciliation')

    def append(self, body):
        self._writable()
        try:
            row = {'seq': len(self.rows)+1, 'prev': self.head, 'body': body}
            digest = hashlib.sha256(encode(row)).hexdigest()
            row['sha256'] = digest
            raw = encode(row)+b'\n'
            if len(raw) > 32768 or os.fstat(self.fd).st_size + len(raw) > MAX_JOURNAL:
                raise StorageError('journal budget exhausted')
            write_all(self.fd, raw)
            os.fsync(self.fd)
            os.fsync(self.dirfd)
            self.head = digest
            self.rows.append(strict_object(raw))
        except BaseException:
            self.poisoned = True
            raise

    def begin_output(self, job_id):
        self._writable()
        if (type(job_id) is not str or re.fullmatch(r'job-[a-z0-9][a-z0-9._-]{0,63}',job_id) is None or
                job_id in self.jobs or len(self.jobs) >= 64):
            raise StorageError('invalid or reused job output identity')
        job = {}
        try:
            for stream in ('stdout','stderr'):
                fd = os.open(job_id+'.'+stream, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o600, dir_fd=self.dirfd)
                job[stream] = {'fd': fd, 'count': 0, 'chunks': 0, 'hash': hashlib.sha256()}
                private_file(fd)
            os.fsync(self.dirfd)
            self.jobs[job_id] = job
        except BaseException:
            self.poisoned = True
            for item in job.values(): os.close(item['fd'])
            raise

    def retain(self, job_id, stream, index, data):
        self._writable()
        if job_id not in self.jobs or stream not in ('stdout','stderr'):
            raise StorageError('unknown output stream')
        job = self.jobs[job_id]; item = job[stream]
        if (type(index) is not int or index != item['chunks'] or type(data) is not bytes or
                not 1 <= len(data) <= 16384 or
                sum(value['count'] for value in job.values()) + len(data) > MAX_JOB_OUTPUT or
                self.output_bytes + len(data) > MAX_OUTPUT):
            raise StorageError('output order or budget exceeded')
        try:
            write_all(item['fd'], data)
            os.fsync(item['fd'])
            item['hash'].update(data); item['count'] += len(data); item['chunks'] += 1
            self.output_bytes += len(data)
        except BaseException:
            self.poisoned = True
            raise

    def output_summary(self, job_id):
        return {stream: {'bytes': value['count'], 'sha256': value['hash'].hexdigest(), 'chunks': value['chunks']}
                for stream, value in self.jobs[job_id].items()}

    def close(self):
        if self.closed:
            return
        self.closed = True
        for job in self.jobs.values():
            for item in job.values(): os.close(item['fd'])
        for fd in (self.fd, self.lockfd, self.dirfd):
            if fd is not None: os.close(fd)
