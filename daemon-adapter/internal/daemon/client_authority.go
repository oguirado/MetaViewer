package daemon

// [TARGET, unit decision] Replay reservations are fsynced before dispatch.
// The bounded private ledger has an exclusive lock; corruption fails closed.
// [TARGET, unit decision] Failed appends are truncated and synced before retry;
// an unverified rollback disables further reservations for this authority.
import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"metaviewer/daemon-adapter/internal/ipc"
	"os"
	"path/filepath"
	"syscall"
)

type replayEntry struct {
	Key   ipc.SenderKey
	Seq   uint64
	Nonce string
}

// replayFile permits deterministic disk-failure tests without changing persistence.
type replayFile interface {
	io.Writer
	Stat() (os.FileInfo, error)
	Sync() error
	Truncate(int64) error
	Close() error
}
type clientAuthority struct {
	file        replayFile
	failed      bool
	seq         map[ipc.SenderKey]uint64
	nonces      map[string]bool
	count       int
	bytes       int64
	origin, out uint64
	bound       *ipc.Envelope
}

func newClientAuthority(path string, origin uint64) (*clientAuthority, error) {
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT|syscall.O_APPEND|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	fail := func(e error) (*clientAuthority, error) { _ = f.Close(); return nil, e }
	if err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fail(err)
	}
	parent, err := os.Open(filepath.Dir(path))
	if err != nil {
		return fail(err)
	}
	err = parent.Sync()
	_ = parent.Close()
	if err != nil {
		return fail(err)
	}
	st, err := f.Stat()
	if err != nil {
		return fail(err)
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) || owner.Nlink != 1 || st.Mode() != 0600 || st.Size() > 32<<20 {
		return fail(errors.New("private bounded replay ledger required"))
	}
	a := &clientAuthority{file: f, seq: map[ipc.SenderKey]uint64{}, nonces: map[string]bool{}, origin: origin, bytes: st.Size()}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 8192)
	for scanner.Scan() {
		var r replayEntry
		if err = json.Unmarshal(scanner.Bytes(), &r); err != nil {
			return fail(err)
		}
		if err = a.admit(r); err != nil {
			return fail(err)
		}
	}
	if err = scanner.Err(); err != nil {
		return fail(err)
	}
	if st.Size() > 0 {
		last := make([]byte, 1)
		if _, err = f.ReadAt(last, st.Size()-1); err != nil || last[0] != '\n' {
			return fail(errors.New("incomplete replay ledger"))
		}
	}
	return a, nil
}
func nonceKey(r replayEntry) string {
	b, _ := json.Marshal(struct {
		Key   ipc.SenderKey
		Nonce string
	}{r.Key, r.Nonce})
	return string(b)
}
func (a *clientAuthority) check(r replayEntry) error {
	if a.count >= 100000 || r.Seq == 0 || r.Seq <= a.seq[r.Key] || r.Nonce == "" || a.nonces[nonceKey(r)] {
		return errors.New("replay or capacity refused")
	}
	return nil
}
func (a *clientAuthority) admit(r replayEntry) error {
	if err := a.check(r); err != nil {
		return err
	}
	a.seq[r.Key] = r.Seq
	a.nonces[nonceKey(r)] = true
	a.count++
	return nil
}
func (a *clientAuthority) Authenticate(_ context.Context, c ipc.PeerCredentials, e ipc.Envelope) error {
	if !ipc.PeerAdmitted(c, uint32(os.Getuid())) {
		return errors.New("peer refused")
	}
	if a.bound == nil {
		a.bound = &e
		return nil
	}
	if e.SessionID != a.bound.SessionID || e.From != a.bound.From || e.To != a.bound.To {
		return errors.New("sender binding refused")
	}
	return nil
}
func (a *clientAuthority) Reserve(_ context.Context, key ipc.SenderKey, seq uint64, nonce string) error {
	r := replayEntry{key, seq, nonce}
	if a.failed {
		return errors.New("replay rollback unverified")
	}
	if err := a.check(r); err != nil {
		return err
	}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if a.bytes+int64(len(b)) > 32<<20 {
		return errors.New("replay byte capacity refused")
	}
	st, err := a.file.Stat()
	if err != nil {
		return err
	}
	rollback := func(cause error) error {
		if err := a.file.Truncate(st.Size()); err != nil {
			a.failed = true
			return errors.Join(cause, err)
		}
		if err := a.file.Sync(); err != nil {
			a.failed = true
			return errors.Join(cause, err)
		}
		return cause
	}
	n, err := a.file.Write(b)
	if err != nil {
		return rollback(err)
	}
	if n != len(b) {
		return rollback(io.ErrShortWrite)
	}
	if err := a.file.Sync(); err != nil {
		return rollback(err)
	}
	// Commit replay state only after durable append. check already passed.
	if err := a.admit(r); err != nil {
		return rollback(err)
	}
	a.bytes += int64(len(b))
	return nil
}
func (a *clientAuthority) Wrap(_ context.Context, in ipc.Envelope, body json.RawMessage) (ipc.Envelope, error) {
	key := ipc.SenderKey{SessionID: in.SessionID, Component: in.To.Component, Instance: in.To.Instance}
	a.out = a.seq[key] + 1
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return ipc.Envelope{}, err
	}
	token := hex.EncodeToString(nonce[:])
	now := monotonic()
	if now < a.origin {
		return ipc.Envelope{}, errors.New("monotonic origin refused")
	}
	if err := a.Reserve(context.Background(), key, a.out, token); err != nil {
		return ipc.Envelope{}, err
	}
	return ipc.Envelope{Schema: "envelope/v0.2", MsgID: "daemon-" + token, TsNS: now - a.origin, From: in.To, To: in.From, SessionID: in.SessionID, Seq: a.out, Nonce: token, Body: body}, nil
}
