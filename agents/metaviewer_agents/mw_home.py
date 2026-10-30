"""Private MemoryWeb home admission; no browser profile persistence.

[TARGET, unit decision] At most 10000 entries and 32 nested directories;
invalid paths use MW_HOME_PATH, filesystem access failures MW_HOME_MODE.
Existing unsafe homes are refused, never silently repaired.
"""

import errno
import os
from pathlib import Path
import re
import stat


MAX_ENTRIES = 10000
MAX_DEPTH = 32
MAX_FILE_BYTES = 1024 * 1024
MAX_WORKFLOW_BYTES = 65536
PROFILE_NAMES = frozenset({
    "Cookies", "Cookies-journal", "Login Data", "Login Data-journal",
    "Web Data", "History", "Preferences", "Secure Preferences", "Local Storage",
    "IndexedDB", "Session Storage", "Sessions", "Current Session", "Current Tabs",
    "Network Persistent State", "cookies.sqlite", "key4.db", "logins.json",
})
PROFILE_NAMES_CASEFOLDED = frozenset(name.casefold() for name in PROFILE_NAMES)
PROFILE_DIRECTORIES = frozenset({
    "default", "leveldb", "local storage", "session storage", "indexeddb",
    "storage", "service worker", "cache", "code cache", "gpucache",
})
SQLITE_WAL_MAGIC = (b"\x37\x7f\x06\x82", b"\x37\x7f\x06\x83")


class HomeError(ValueError):
    """An admission refusal with a stable machine-readable code."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def resolve_home(repo_root, override=None) -> Path:
    """Return an absolute lexical path, preserving symlinks for admission."""
    path = Path(override) if override is not None else Path(repo_root) / "memoryweb"
    if override is not None and not path.is_absolute():
        raise HomeError("MW_HOME_PATH")
    if ".." in path.parts:
        raise HomeError("MW_HOME_PATH")
    return path.absolute()


def _directory(path):
    """Open each ancestor without following links, including the home itself."""
    path = Path(path).absolute()
    if ".." in path.parts:
        raise HomeError("MW_HOME_PATH")
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            metadata = os.stat(part, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(metadata.st_mode):
                raise HomeError("MW_HOME_SYMLINK")
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def _mode(metadata):
    if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o700):
        raise HomeError("MW_HOME_MODE")


def canonical_home(path):
    """Resolve a home only after refusing links in it and every ancestor.

    The final directory may be absent; parents must exist as for ensure_home.
    This preflight does not create a home before Git admission succeeds.
    """
    path = Path(path).absolute()
    if ".." in path.parts:
        raise HomeError("MW_HOME_PATH")
    try:
        parent = _directory(path.parent)
        try:
            try:
                metadata = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                metadata = None
            if metadata is not None and stat.S_ISLNK(metadata.st_mode):
                raise HomeError("MW_HOME_SYMLINK")
            resolved = path.resolve()
            if resolved != path:
                raise HomeError("MW_HOME_SYMLINK")
            return resolved
        finally:
            os.close(parent)
    except OSError as error:
        raise HomeError("MW_HOME_SYMLINK" if error.errno == errno.ELOOP
                        else "MW_HOME_MODE") from error


def ensure_home(path):
    """Create the final directory privately; parents must already exist."""
    path = Path(path).absolute()
    try:
        parent = _directory(path.parent)
        try:
            try:
                os.mkdir(path.name, mode=0o700, dir_fd=parent)
            except FileExistsError:
                pass
        finally:
            os.close(parent)
        fd = _directory(path)
        try:
            _mode(os.fstat(fd))
        finally:
            os.close(fd)
    except OSError as error:
        raise HomeError("MW_HOME_SYMLINK" if error.errno == errno.ELOOP
                        else "MW_HOME_MODE") from error
    return path


def check_home(path, is_tracked):
    """Refuse tracked, unsafe, oversized or profile-bearing homes.

    The injected predicate must raise on indeterminate tracking status.
    Traversal uses directory descriptors and reads only the magic header.
    """
    path = Path(path).absolute()
    if is_tracked(path):
        raise HomeError("MW_HOME_TRACKED")
    count = 0

    def walk(fd, depth, workflow=False):
        nonlocal count
        with os.scandir(fd) as entries:
            for entry in entries:
                count += 1
                if count > MAX_ENTRIES:
                    raise HomeError("MW_HOME_CAPACITY")
                metadata = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                if entry.name == ".git":
                    raise HomeError("MW_HOME_NESTED_REPO")
                if stat.S_ISLNK(metadata.st_mode):
                    raise HomeError("MW_HOME_SYMLINK")
                name = entry.name.casefold()
                if (name in PROFILE_NAMES_CASEFOLDED
                        or any(name.endswith(suffix)
                               and name[:-len(suffix)] in PROFILE_NAMES_CASEFOLDED
                               for suffix in ("-wal", "-shm", "-journal"))):
                    raise HomeError("MW_HOME_PROFILE")
                if stat.S_ISDIR(metadata.st_mode):
                    # Refusing leveldb itself also excludes CURRENT, LOCK, LOG,
                    # LOG.old, MANIFEST-*, *.ldb and *.log anywhere inside it.
                    if (name in PROFILE_DIRECTORIES
                            or re.fullmatch(r"profile [0-9]+", name)):
                        raise HomeError("MW_HOME_PROFILE")
                    if depth >= MAX_DEPTH:
                        raise HomeError("MW_HOME_CAPACITY")
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY
                                    | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        walk(child, depth + 1, workflow or entry.name == "workflows")
                    finally:
                        os.close(child)
                elif stat.S_ISREG(metadata.st_mode):
                    child = os.open(entry.name, os.O_RDONLY | os.O_NONBLOCK
                                    | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        current = os.fstat(child)
                        if not stat.S_ISREG(current.st_mode):
                            raise HomeError("MW_HOME_MODE")
                        limit = MAX_WORKFLOW_BYTES if workflow else MAX_FILE_BYTES
                        if current.st_size > limit:
                            raise HomeError("MW_HOME_SIZE")
                        header = os.read(child, 16)
                        if (header == b"SQLite format 3\0"
                                or header[:4] in SQLITE_WAL_MAGIC):
                            raise HomeError("MW_HOME_PROFILE")
                    finally:
                        os.close(child)
                else:
                    raise HomeError("MW_HOME_MODE")

    try:
        fd = _directory(path)
        try:
            _mode(os.fstat(fd))
            walk(fd, 0)
        finally:
            os.close(fd)
    except OSError as error:
        raise HomeError("MW_HOME_SYMLINK" if error.errno == errno.ELOOP
                        else "MW_HOME_MODE") from error
    return path


# [TARGET, unit decision] Select an entire site, never merge workflow files.
# Built-ins are a read-only source; callers never install them into the home.
def site_root(home, site, repo_root=None):
    if not isinstance(site, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", site):
        raise HomeError("MW_SITE_ID")
    home = Path(home).absolute()
    candidate = home / "sites" / site
    for part in (candidate, *candidate.parents):
        if part.is_symlink():
            raise HomeError("MW_HOME_SYMLINK")
    if candidate.exists():
        if not candidate.is_dir():
            raise HomeError("MW_SITE_PATH")
        return home
    repo = Path(repo_root) if repo_root is not None else Path(__file__).resolve().parents[2]
    builtin = repo / "memoryweb-builtin"
    candidate = builtin / "sites" / site
    for part in (candidate, *candidate.parents):
        if part.is_symlink():
            raise HomeError("MW_HOME_SYMLINK")
    if not candidate.is_dir():
        raise HomeError("MW_SITE_MISSING")
    return builtin
