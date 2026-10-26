"""Private per-service reaper; component traffic uses authenticated sockets."""
import ctypes
import os
import selectors
import signal
import subprocess
import sys
import time


def signalable(pid, owned):
    return (type(pid) is int and 1 < pid <= 2147483647 and owned
            and pid != os.getpid() and pid != os.getpgrp())


def identity(pid):
    with open(f"/proc/{pid}/stat", encoding="ascii") as source:
        fields = source.read(8192).rsplit(")", 1)[1].split()
    return int(fields[1]), int(fields[19])


class Reaper:
    def __init__(self, cap):
        self.cap = cap
        self.owned = {}
        self.failed = False
        self.reaped = set()

    def discover(self):
        # Walk only retained descendants, including all threads' child lists.
        pending = [(os.getpid(), identity(os.getpid())[1])]
        for pid, (_, start) in self.owned.items():
            try:
                if identity(pid)[1] == start:
                    pending.append((pid, start))
            except (FileNotFoundError, ProcessLookupError):
                continue
        visited = set()
        while pending:
            parent, parent_start = pending.pop()
            if parent in visited:
                continue
            visited.add(parent)
            try:
                if identity(parent)[1] != parent_start:
                    continue
                with os.scandir(f"/proc/{parent}/task") as tasks:
                    for index, task in enumerate(tasks):
                        if index >= self.cap:
                            raise OverflowError("thread_budget")
                        with open(f"/proc/{parent}/task/{task.name}/children",
                                  encoding="ascii") as children:
                            raw = children.read(self.cap * 12 + 1)
                        if len(raw) > self.cap * 12:
                            raise OverflowError("descendant_budget")
                        for word in raw.split():
                            pid = int(word)
                            if pid in self.owned:
                                continue
                            if len(self.owned) >= self.cap:
                                raise OverflowError("descendant_budget")
                            if not signalable(pid, True):
                                raise PermissionError("unsafe_target")
                            try:
                                ppid, start = identity(pid)
                                if ppid != parent:
                                    continue
                                fd = os.pidfd_open(pid)
                                if identity(pid)[1] != start:
                                    os.close(fd)
                                    continue
                            except (FileNotFoundError, ProcessLookupError):
                                continue
                            self.owned[pid] = (fd, start)
                            pending.append((pid, start))
            except (FileNotFoundError, ProcessLookupError):
                continue

    def send(self, sig):
        for pid, (fd, _) in reversed(list(self.owned.items())):
            if not signalable(pid, pid in self.owned):
                raise PermissionError("unsafe_target")
            try:
                signal.pidfd_send_signal(fd, sig)
            except ProcessLookupError:
                pass

    def reap(self):
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return True
            if pid == 0:
                return False
            # Every direct/adopted child belongs exclusively to this reaper.
            if pid not in self.reaped:
                if len(self.reaped) < self.cap:
                    self.reaped.add(pid)
                    print(pid, flush=True)
                else:
                    self.failed = True

    def close(self):
        for fd, _ in self.owned.values():
            os.close(fd)


def main():
    graceful, budget, poll = map(float, sys.argv[1:4])
    cap = int(sys.argv[4])
    cwd, program = sys.argv[5:7]
    # PR_SET_CHILD_SUBREAPER scopes adoption to this dedicated process.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        return 20
    reaper = Reaper(cap)
    child = None
    try:
        child = subprocess.Popen([program, *sys.argv[7:]], cwd=cwd,
                                 stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL,
                                 stderr=sys.stderr, close_fds=True)
        if not signalable(child.pid, True):
            raise PermissionError("unsafe_target")
        # Establish direct-child ownership before any fallible discovery.
        root_fd = os.pidfd_open(child.pid)
        try:
            root_start = identity(child.pid)[1]
        except OSError:
            os.close(root_fd)
            raise
        reaper.owned[child.pid] = (root_fd, root_start)
        reaper.discover()
        print(child.pid, flush=True)
        control = selectors.DefaultSelector()
        control.register(sys.stdin, selectors.EVENT_READ)
        unexpected = False
        while not control.select(poll):
            reaper.discover()
            if child.poll() is not None:
                # Popen reaped the direct child; include its terminal evidence.
                reaper.reaped.add(child.pid)
                print(child.pid, flush=True)
                unexpected = True
                break
        control.close()
        reaper.discover()
        reaper.send(signal.SIGTERM)
        until = time.monotonic() + graceful
        while time.monotonic() < until:
            reaper.discover()
            if reaper.reap():
                return 20 if reaper.failed else (10 if unexpected else 0)
            time.sleep(poll)
        until = time.monotonic() + budget
        while time.monotonic() < until:
            # Freeze before rescanning to close the racing-fork window.
            reaper.discover()
            reaper.send(signal.SIGSTOP)
            reaper.discover()
            reaper.send(signal.SIGKILL)
            if reaper.reap():
                return 20 if reaper.failed else (10 if unexpected else 0)
            time.sleep(poll)
        return 20
    except (OSError, ValueError, OverflowError):
        # An observation failure never becomes an empty-success receipt.
        if child is not None:
            try:
                reaper.send(signal.SIGKILL)
                until = time.monotonic() + budget
                while time.monotonic() < until and not reaper.reap():
                    time.sleep(poll)
            except OSError:
                pass
        return 20
    finally:
        reaper.close()


if __name__ == "__main__":
    sys.exit(main())
