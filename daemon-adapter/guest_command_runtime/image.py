"""Deterministic, fixed-layout initramfs for the ARM64 command broker.

Inputs are verified executable bytes, never commands or archive paths. This
builder neither executes inputs nor extracts an externally supplied archive.
"""
import gzip
import stat
import struct


class ImageError(ValueError):
    pass


APPLETS = ('sh', 'ash', 'cat', 'echo', 'printf', 'pwd', 'ls', 'mkdir', 'rmdir',
           'rm', 'cp', 'mv', 'touch', 'head', 'tail', 'wc', 'sort', 'uniq',
           'cut', 'tr', 'sed', 'awk', 'grep', 'sleep', 'true', 'false',
           'uname', 'id', 'seq', 'env', 'find', 'xargs', 'stat', 'readlink',
           'basename', 'dirname', 'tee', 'dd', 'du', 'df', 'chmod', 'ln',
           'kill', 'ps', 'yes', 'expr', 'test', 'timeout')


def static_arm64(data, limit):
    if type(data) is not bytes or not 64 <= len(data) <= limit:
        raise ImageError('executable size or type')
    if data[:7] != b'\x7fELF\x02\x01\x01':
        raise ImageError('ELF64 little endian required')
    kind, machine = struct.unpack_from('<HH', data, 16)
    version = struct.unpack_from('<I', data, 20)[0]
    entry = struct.unpack_from('<Q', data, 24)[0]
    header_size = struct.unpack_from('<H', data, 52)[0]
    if kind != 2 or machine != 183 or version != 1 or header_size != 64:
        raise ImageError('static ARM64 ET_EXEC required')
    offset = struct.unpack_from('<Q', data, 32)[0]
    size, count = struct.unpack_from('<HH', data, 54)
    if size != 56 or count == 0 or offset < 64 or offset + size * count > len(data):
        raise ImageError('invalid program headers')
    executable = False
    for index in range(count):
        typ, flags, start, address, _, length, memory, alignment = struct.unpack_from('<IIQQQQQQ', data, offset + size*index)
        if typ in (2, 3) or start + length > len(data) or memory < length:
            raise ImageError('dynamic or malformed executable')
        if typ == 1:
            if (address + memory > (1 << 64) or
                    (alignment > 1 and (alignment & (alignment - 1) or
                                        start % alignment != address % alignment))):
                raise ImageError('invalid load alignment or address range')
            executable |= flags & 1 != 0 and entry != 0 and address <= entry < address + length
    if not executable:
        raise ImageError('missing executable segment')


def build_initramfs(broker, busybox):
    static_arm64(broker, 12 * 1024 * 1024)
    static_arm64(busybox, 4 * 1024 * 1024)
    directories = ('bin', 'dev', 'proc', 'sys', 'sys/fs', 'sys/fs/cgroup',
                   'work', 'etc', 'run', 'root')
    entries = [('.', stat.S_IFDIR | 0o755, b'', 0, 0)]
    entries += [(name, stat.S_IFDIR | (0o700 if name == 'root' else 0o755), b'', 0, 0)
                for name in directories]
    entries += [('init', stat.S_IFREG | 0o500, broker, 0, 0),
                ('bin/busybox', stat.S_IFREG | 0o555, busybox, 0, 0),
                ('etc/empty-cmdline', stat.S_IFREG | 0o400, b'', 0, 0),
                ('tmp', stat.S_IFLNK | 0o777, b'/work/tmp', 0, 0)]
    entries += [('bin/' + name, stat.S_IFLNK | 0o777, b'busybox', 0, 0)
                for name in APPLETS]
    entries += [('dev/console', stat.S_IFCHR | 0o600, b'', 5, 1),
                ('dev/null', stat.S_IFCHR | 0o666, b'', 1, 3),
                ('dev/zero', stat.S_IFCHR | 0o666, b'', 1, 5),
                ('dev/urandom', stat.S_IFCHR | 0o666, b'', 1, 9),
                ('TRAILER!!!', 0, b'', 0, 0)]
    output = bytearray()
    for inode, (name, mode, data, rmajor, rminor) in enumerate(entries, 1):
        encoded = name.encode('ascii') + b'\0'
        fields = (inode, mode, 0, 0, 2 if stat.S_ISDIR(mode) else 1, 0,
                  len(data), 0, 0, rmajor, rminor, len(encoded), 0)
        output += b'070701' + ''.join(f'{field:08x}' for field in fields).encode('ascii') + encoded
        output += b'\0' * (-len(output) % 4)
        output += data
        output += b'\0' * (-len(output) % 4)
    output += b'\0' * (-len(output) % 512)
    return gzip.compress(output, compresslevel=9, mtime=0)
