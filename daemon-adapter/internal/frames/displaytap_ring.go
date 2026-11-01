package frames

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"unsafe"
)

type displayRing struct {
	path       string
	generation uint64
	file       *os.File
	data       []byte
	seq        uint64
	target     DisplayTarget
}

// DisplayRingPath returns the per-capsule tmpfs ring path for surface id.
func DisplayRingPath(runtimeDir, id string) (string, error) {
	if !ringComponent.MatchString(id) {
		return "", &DisplayTapRefusal{Code: "DISPLAY_INVALID", Detail: "invalid DISPLAY surface id"}
	}
	if runtimeDir == "" {
		runtimeDir = DisplayBaseDir()
	}
	return filepath.Join(runtimeDir, "metaviewer", "display", id+".ring"), nil
}

func (r *displayRing) open(t DisplayTarget) error {
	if e := validDisplayTarget(t); e != nil {
		return e
	}
	dir := filepath.Dir(r.path)
	// Traverse without following symlinks, including the existing runtime root.
	parent, e := openRingDir(filepath.Dir(dir))
	if e != nil {
		return e
	}
	defer parent.Close()
	e = syscall.Mkdirat(int(parent.Fd()), "display", 0700)
	if e != nil && !errors.Is(e, syscall.EEXIST) {
		return e
	}
	fd, e := syscall.Openat(int(parent.Fd()), "display", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if e != nil {
		return e
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if syscall.Fstat(fd, &st) != nil || syscall.Fstatfs(fd, &fs) != nil || fs.Type != 0x01021994 || st.Uid != uint32(os.Geteuid()) || st.Mode&07777 != 0700 {
		return fmt.Errorf("DISPLAY requires private tmpfs directory %s (fstype %#x uid %d mode %o)", dir, fs.Type, st.Uid, st.Mode&07777)
	}
	n, e := syscall.Openat(fd, filepath.Base(r.path), syscall.O_RDWR|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	// [TARGET, unit decision] Reclaim an unclean-shutdown file only inside
	// the checked private tmpfs directory. Never follow links or reclaim special files.
	if errors.Is(e, syscall.EEXIST) {
		old, err := syscall.Openat(fd, filepath.Base(r.path), syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		var stale syscall.Stat_t
		var staleFS syscall.Statfs_t
		err = syscall.Fstat(old, &stale)
		fsErr := syscall.Fstatfs(old, &staleFS)
		syscall.Close(old)
		if err != nil || fsErr != nil || stale.Mode&syscall.S_IFMT != syscall.S_IFREG || stale.Mode&07777 != 0600 || stale.Uid != uint32(os.Geteuid()) || stale.Nlink != 1 || staleFS.Type != 0x01021994 {
			return errors.New("unsafe stale DISPLAY ring")
		}
		if err = syscall.Unlinkat(fd, filepath.Base(r.path)); err != nil {
			return err
		}
		n, e = syscall.Openat(fd, filepath.Base(r.path), syscall.O_RDWR|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	}
	if e != nil {
		return e
	}
	r.file = os.NewFile(uintptr(n), r.path)
	if e = syscall.Fchmod(n, 0600); e != nil {
		r.close()
		return e
	}
	size := 64 + 2*t.Width*t.Height*3
	if e = r.file.Truncate(int64(size)); e != nil {
		r.close()
		return e
	}
	r.data, e = syscall.Mmap(n, 0, size, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if e != nil {
		r.close()
		return e
	}
	r.target = t
	atomic.StoreUint64((*uint64)(unsafe.Pointer(&r.data[24])), 1)
	copy(r.data, "MVDISP1\x00")
	le := binary.LittleEndian
	le.PutUint32(r.data[8:], uint32(t.Width))
	le.PutUint32(r.data[12:], uint32(t.Height))
	le.PutUint32(r.data[16:], uint32(3*t.Width))
	le.PutUint32(r.data[20:], 1)
	le.PutUint64(r.data[40:], r.generation)
	return nil
}
func (r *displayRing) publish(rgb []byte, mono uint64, t DisplayTarget) error {
	if len(rgb) != t.Width*t.Height*3 {
		return errors.New("DISPLAY RGB length")
	}
	if r.file == nil {
		if e := r.open(t); e != nil {
			return e
		}
	} else if r.target != t {
		return errors.New("DISPLAY ring geometry changed")
	}
	seq := (*uint64)(unsafe.Pointer(&r.data[24]))
	atomic.StoreUint64(seq, r.seq+1)
	next := r.seq + 2
	slot := int((next / 2) % 2)
	copy(r.data[64+slot*len(rgb):], rgb)
	binary.LittleEndian.PutUint64(r.data[32:], mono)
	atomic.StoreUint64(seq, next)
	r.seq = next
	return nil
}
func (r *displayRing) close() {
	if r.data != nil {
		_ = syscall.Munmap(r.data)
		r.data = nil
	}
	if r.file != nil {
		r.file.Close()
		r.file = nil
		_ = os.Remove(r.path)
	}
}
