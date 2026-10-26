package ipc

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

var bindMu sync.Mutex
var socketInodes sync.Map

func owned(fi os.FileInfo, uid uint32) bool {
	s, ok := fi.Sys().(*syscall.Stat_t)
	return ok && s.Uid == uid
}
func privateDir(path string, uid uint32) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !fi.IsDir() || fi.Mode().Perm() != 0700 || !owned(fi, uid) {
		return errors.New("unsafe runtime directory")
	}
	return nil
}
func RuntimeSocketPath(runtimeDir string, uid uint32) (string, error) {
	if !filepath.IsAbs(runtimeDir) {
		return "", errors.New("absolute runtime directory required")
	}
	if err := privateDir(runtimeDir, uid); err != nil {
		return "", err
	}
	// Resolve only to detect symlinks, never to accept a redirected rendezvous.
	resolved, err := filepath.EvalSymlinks(runtimeDir)
	if err != nil || resolved != filepath.Clean(runtimeDir) {
		return "", errors.New("symlink runtime directory")
	}
	dir := filepath.Join(runtimeDir, "metaviewer")
	if err := os.Mkdir(dir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	if err := privateDir(dir, uid); err != nil {
		return "", err
	}
	return filepath.Join(dir, "surfaces.sock"), nil
}
func Listen(ctx context.Context, cfg Config) (*net.UnixListener, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(cfg.SocketPath) {
		return nil, errors.New("absolute socket path required")
	}
	dir := filepath.Dir(cfg.SocketPath)
	if err := privateDir(dir, cfg.UID); err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil || resolved != dir {
		return nil, errors.New("symlink socket parent")
	}
	bindMu.Lock()
	defer bindMu.Unlock()
	fi, err := os.Lstat(cfg.SocketPath)
	if err == nil {
		if fi.Mode()&os.ModeSocket == 0 || !owned(fi, cfg.UID) || fi.Mode().Perm() != 0600 {
			return nil, errors.New("unsafe existing socket")
		}
		conn, dialErr := (&net.Dialer{Timeout: cfg.ProbeTimeout}).DialContext(ctx, "unix", cfg.SocketPath)
		if dialErr == nil {
			conn.Close()
			return nil, errors.New("socket already served")
		}
		if !errors.Is(dialErr, syscall.ECONNREFUSED) {
			return nil, errors.New("socket staleness unproven")
		}
		current, err := os.Lstat(cfg.SocketPath)
		if err != nil || !os.SameFile(fi, current) {
			return nil, errors.New("socket changed during probe")
		}
		if err := os.Remove(cfg.SocketPath); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Call before other filesystem writers start: umask is process-wide.
	old := syscall.Umask(0177)
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: cfg.SocketPath, Net: "unix"})
	syscall.Umask(old)
	if err != nil {
		return nil, err
	}
	listener.SetUnlinkOnClose(false)
	fi, err = os.Lstat(cfg.SocketPath)
	if err != nil || fi.Mode()&os.ModeSocket == 0 || fi.Mode().Perm() != 0600 || !owned(fi, cfg.UID) {
		listener.Close()
		return nil, errors.New("unsafe bound socket")
	}
	socketInodes.Store(listener, fi)
	return listener, nil
}

// CloseListener removes only the inode owned by this listener.
func CloseListener(listener *net.UnixListener) error {
	err := listener.Close()
	if errors.Is(err, net.ErrClosed) {
		err = nil
	}
	original, ok := socketInodes.LoadAndDelete(listener)
	if !ok {
		return err
	}
	fi, statErr := os.Lstat(listener.Addr().String())
	if errors.Is(statErr, os.ErrNotExist) {
		return err
	}
	if statErr != nil {
		return errors.Join(err, statErr)
	}
	if !os.SameFile(original.(os.FileInfo), fi) {
		return errors.Join(err, errors.New("socket replaced before cleanup"))
	}
	return errors.Join(err, os.Remove(listener.Addr().String()))
}
