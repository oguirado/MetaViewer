package daemon

import (
	"context"
	"errors"
	"fmt"
	"metaviewer/daemon-adapter/internal/ipc"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

type nvFailFile struct {
	*os.File
	writeFail, syncFail, rollbackFail bool
	shortWrite                        bool
	syncs                             int
}

func (f *nvFailFile) Write(b []byte) (int, error) {
	if f.shortWrite {
		f.shortWrite = false
		return f.File.Write(b[:len(b)/2])
	}
	if f.writeFail {
		f.writeFail = false
		n, e := f.File.Write(b[:len(b)/2])
		return n, errors.Join(e, errors.New("injected partial write"))
	}
	return f.File.Write(b)
}
func (f *nvFailFile) Sync() error {
	f.syncs++
	if f.syncFail {
		f.syncFail = false
		return errors.New("injected sync")
	}
	return f.File.Sync()
}
func (f *nvFailFile) Truncate(n int64) error {
	if f.rollbackFail {
		return errors.New("injected rollback failure")
	}
	return f.File.Truncate(n)
}
func TestNVReserveFailureAtomic(t *testing.T) {
	for _, kind := range []string{"cap", "write", "short", "sync"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "replay")
			a, err := newClientAuthority(path, monotonic())
			if err != nil {
				t.Fatal(err)
			}
			defer a.file.Close()
			key := ipc.SenderKey{SessionID: "nv", Component: "core", Instance: "nv"}
			f := &nvFailFile{File: a.file.(*os.File), writeFail: kind == "write", syncFail: kind == "sync", shortWrite: kind == "short"}
			a.file = f
			if kind == "cap" {
				a.bytes = 32<<20 - 1
			}
			before := a.bytes
			if err = a.Reserve(context.Background(), key, 1, "nonce"); err == nil {
				t.Fatal("failure accepted")
			}
			if len(a.seq) != 0 || len(a.nonces) != 0 || a.count != 0 || a.bytes != before {
				t.Errorf("failed reservation mutated state: seq=%v count=%d bytes=%d", a.seq, a.count, a.bytes)
			}
			st, err := f.Stat()
			if err != nil || st.Size() != 0 {
				t.Fatalf("append not rolled back: %v %v", st, err)
			}
			a.bytes = 0
			if err = a.Reserve(context.Background(), key, 1, "nonce"); err != nil {
				t.Fatal("identical retry", err)
			}
			if f.syncs == 0 {
				t.Fatal("successful retry was not synced")
			}
			if err = a.Reserve(context.Background(), key, 2, "nonce"); err == nil {
				t.Fatal("nonce replay accepted")
			}
			if a.count != 1 {
				t.Fatal("wrong count")
			}
			if err = f.Close(); err != nil {
				t.Fatal(err)
			}
			recovered, err := newClientAuthority(path, monotonic())
			if err != nil {
				t.Fatal("recovery after retry", err)
			}
			defer recovered.file.Close()
			if recovered.count != 1 || recovered.seq[key] != 1 {
				t.Fatal("retry not persisted exactly once")
			}
		})
	}
}
func TestNVReserveUnverifiedRollbackFailsClosed(t *testing.T) {
	a, err := newClientAuthority(filepath.Join(t.TempDir(), "replay"), monotonic())
	if err != nil {
		t.Fatal(err)
	}
	defer a.file.Close()
	f := &nvFailFile{File: a.file.(*os.File), writeFail: true, rollbackFail: true}
	a.file = f
	key := ipc.SenderKey{SessionID: "nv", Component: "core", Instance: "nv"}
	if err = a.Reserve(context.Background(), key, 1, "n"); err == nil {
		t.Fatal("write failure accepted")
	}
	f.rollbackFail = false
	if err = a.Reserve(context.Background(), key, 1, "n"); err == nil {
		t.Fatal("unverified ledger resumed")
	}
	if len(a.seq) != 0 || a.bytes != 0 {
		t.Fatal("failed reservation mutated memory")
	}
}
func TestNVWrapContinuityAfterFailure(t *testing.T) {
	a, err := newClientAuthority(filepath.Join(t.TempDir(), "replay"), monotonic())
	if err != nil {
		t.Fatal(err)
	}
	defer a.file.Close()
	f := &nvFailFile{File: a.file.(*os.File), syncFail: true}
	a.file = f
	in := ipc.Envelope{SessionID: "nv", From: ipc.Endpoint{Component: "core", Instance: "core"}, To: ipc.Endpoint{Component: "daemon", Instance: "daemon"}}
	if _, err = a.Wrap(context.Background(), in, jsonBody()); err == nil {
		t.Fatal("failed wrap accepted")
	}
	out, err := a.Wrap(context.Background(), in, jsonBody())
	if err != nil || out.Seq != 1 {
		t.Fatalf("retry sequence: %v %v", out, err)
	}
	out, err = a.Wrap(context.Background(), in, jsonBody())
	if err != nil || out.Seq != 2 {
		t.Fatalf("next sequence: %v %v", out, err)
	}
}
func jsonBody() []byte { return []byte(`{"schema":"test"}`) }

func TestNVReplayLedgerFdAnchoredTornLineAndParentSync(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "state")
	stateFile, err := openStateDir(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer stateFile.Close()

	fdLedgerPath := fmt.Sprintf("/proc/self/fd/%d/wire-replay.jsonl", stateFile.Fd())
	key := ipc.SenderKey{SessionID: "nv-fd", Component: "core", Instance: "core"}

	// Positive control: open via /proc/self/fd/<fd>/wire-replay.jsonl, reserve entries, close, and recover across restart.
	auth, err := newClientAuthority(fdLedgerPath, monotonic())
	if err != nil {
		t.Fatalf("open fd-anchored ledger: %v", err)
	}
	if err := auth.Reserve(context.Background(), key, 1, "nonce-1"); err != nil {
		_ = auth.file.Close()
		t.Fatalf("reserve seq 1: %v", err)
	}
	if err := auth.Reserve(context.Background(), key, 2, "nonce-2"); err != nil {
		_ = auth.file.Close()
		t.Fatalf("reserve seq 2: %v", err)
	}
	if err := auth.file.Close(); err != nil {
		t.Fatal(err)
	}

	recovered, err := newClientAuthority(fdLedgerPath, monotonic())
	if err != nil {
		t.Fatalf("recover fd-anchored ledger: %v", err)
	}
	if recovered.count != 2 || recovered.seq[key] != 2 {
		_ = recovered.file.Close()
		t.Fatalf("recovered state mismatch: count=%d seq=%d", recovered.count, recovered.seq[key])
	}
	if err := recovered.Reserve(context.Background(), key, 2, "nonce-3"); err == nil {
		_ = recovered.file.Close()
		t.Fatal("duplicate sequence accepted after restart")
	}
	if err := recovered.Reserve(context.Background(), key, 3, "nonce-1"); err == nil {
		_ = recovered.file.Close()
		t.Fatal("duplicate nonce accepted after restart")
	}
	if err := recovered.Reserve(context.Background(), key, 3, "nonce-3"); err != nil {
		_ = recovered.file.Close()
		t.Fatalf("next sequence after recovery refused: %v", err)
	}
	if err := recovered.file.Close(); err != nil {
		t.Fatal(err)
	}

	// Negative control 1: torn trailing line (valid JSON entry missing trailing newline, and truncated JSON line) must fail closed.
	diskLedgerPath := filepath.Join(stateDir, "wire-replay.jsonl")
	cleanBytes, err := os.ReadFile(diskLedgerPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, tornSuffix := range []string{
		`{"Key":{"SessionID":"nv-fd","Component":"core","Instance":"core"},"Seq":4,"Nonce":"no-newline"}`,
		`{"Key":{"SessionID":"nv-fd","Component":"core"`,
	} {
		if err := os.WriteFile(diskLedgerPath, append(append([]byte(nil), cleanBytes...), []byte(tornSuffix)...), 0600); err != nil {
			t.Fatal(err)
		}
		if bad, err := newClientAuthority(fdLedgerPath, monotonic()); err == nil {
			_ = bad.file.Close()
			t.Fatalf("torn trailing line %q accepted", tornSuffix)
		}
	}

	// Restore clean ledger and verify it opens cleanly again.
	if err := os.WriteFile(diskLedgerPath, cleanBytes, 0600); err != nil {
		t.Fatal(err)
	}
	cleanAgain, err := newClientAuthority(fdLedgerPath, monotonic())
	if err != nil {
		t.Fatalf("restored clean ledger refused: %v", err)
	}
	_ = cleanAgain.file.Close()

	// Negative control 2: failing parent.Sync() must fail closed rather than silently succeeding.
	// Kernel path walk resolves trapDir/link -> realSub and "../sub" -> realSub, while
	// lexical filepath.Dir(path) cleans "trapDir/link/../sub" to "trapDir/sub" (a FIFO where Sync returns EINVAL).
	base := t.TempDir()
	realSub := filepath.Join(base, "real", "sub")
	if err := os.MkdirAll(realSub, 0700); err != nil {
		t.Fatal(err)
	}
	trapDir := filepath.Join(base, "trap")
	if err := os.MkdirAll(trapDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realSub, filepath.Join(trapDir, "link")); err != nil {
		t.Fatal(err)
	}
	fifoPath := filepath.Join(trapDir, "sub")
	if err := syscall.Mkfifo(fifoPath, 0600); err != nil {
		t.Fatal(err)
	}
	fifoHolder, err := os.OpenFile(fifoPath, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer fifoHolder.Close()

	unsyncedPath := trapDir + "/link/../sub/wire-replay.jsonl"
	if bad, err := newClientAuthority(unsyncedPath, monotonic()); err == nil {
		_ = bad.file.Close()
		t.Fatal("authority client succeeded despite failing parent.Sync()")
	}
}
