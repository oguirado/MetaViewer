package daemon

import (
	"context"
	"errors"
	"metaviewer/daemon-adapter/internal/ipc"
	"os"
	"path/filepath"
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
