package capsule

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// [TARGET, unit decision] Walk from the root using held directory descriptors:
// no component may be a symlink, and only the final component may be created.
// The caller still checks the final directory's owner and exact permissions.
func stateDirInfo(path string) (os.FileInfo, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, syscall.EINVAL
	}
	flags := syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	fd, err := syscall.Open("/", flags, 0)
	if err != nil {
		return nil, err
	}
	defer func() {
		if fd >= 0 {
			syscall.Close(fd)
		}
	}()
	if path != "/" {
		parts := strings.Split(path[1:], "/")
		for i, part := range parts {
			next, err := syscall.Openat(fd, part, flags, 0)
			if err == syscall.ENOENT && i == len(parts)-1 {
				if err = syscall.Mkdirat(fd, part, 0700); err != nil && err != syscall.EEXIST {
					return nil, err
				}
				next, err = syscall.Openat(fd, part, flags, 0)
			}
			if err != nil {
				return nil, err
			}
			syscall.Close(fd)
			fd = next
		}
	}
	file := os.NewFile(uintptr(fd), path)
	// Transfer ownership to os.File, including on a failed Stat.
	fd = -1
	defer file.Close()
	return file.Stat()
}
