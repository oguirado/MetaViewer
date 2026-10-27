package view

import (
	"context"
	"errors"
	"fmt"
	"metaviewer/daemon-adapter/internal/cli"
	"reflect"
	"sync"
	"testing"
	"time"
)

type fakeRunner struct {
	args   []string
	input  []byte
	output []byte
	err    error
	calls  int
}

func (r *fakeRunner) Run(_ context.Context, args []string, input []byte) ([]byte, error) {
	r.calls++
	r.args = args
	r.input = input
	return r.output, r.err
}
func (r *fakeRunner) Start(ctx context.Context, args []string) (*Process, error) {
	out, err := r.Run(ctx, args, nil)
	done := make(chan struct{})
	var once sync.Once
	return &Process{Announcement: out, Done: done, Close: func() { once.Do(func() { close(done) }) }}, err
}
func TestViewLifecycle(t *testing.T) {
	r := &fakeRunner{output: []byte(`{"url":"http://127.0.0.1:1234/","native":"xpra","socket":"/runtime/view.sock"}`)}
	b := NewManager(r)
	t.Cleanup(b.Close)
	if err := b.Open(context.Background(), "srf-id-demo", true); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(r.args, []string{"srf-identity-surface", "login", "--container", "srf-id-demo"}) {
		t.Fatal(r.args)
	}
	if _, ok := b.Info("srf-id-demo"); !ok {
		t.Fatal("missing view")
	}
	r.output = []byte(`{"pasted_runes":2,"container":"srf-id-demo"}`)
	if err := b.Paste(context.Background(), "srf-id-demo", []byte("hi")); err != nil {
		t.Fatal(err)
	}
	if string(r.input) != "hi" || r.args[1] != "paste-text" || r.args[4] != "--file" {
		t.Fatal(r.args)
	}
	r.output = []byte(`{"stopped_view":"srf-id-demo","pid":42,"seconds":0.1}`)
	if err := b.Stop(context.Background(), "srf-id-demo"); err != nil {
		t.Fatal(err)
	}
	if _, ok := b.Info("srf-id-demo"); ok {
		t.Fatal("retained stopped view")
	}
	if err := b.Paste(context.Background(), "srf-id-demo", []byte("hi")); err == nil {
		t.Fatal("paste without login admitted")
	}
}
func TestViewNegatives(t *testing.T) {
	for _, out := range []string{`{}`, `{"url":"http://example.test/","native":"x","socket":"/s"}`, `{"url":"http://127.0.0.1:1/","native":"x","socket":"/s","extra":1}`, "not json\n", `{"url":"http://127.0.0.1:1/","native":"x","socket":"relative"}`} {
		r := &fakeRunner{output: []byte(out)}
		b := NewManager(r)
		t.Cleanup(b.Close)
		if err := b.Open(context.Background(), "srf-id-demo", false); err == nil {
			t.Fatal(out)
		}
		if _, ok := b.Info("srf-id-demo"); ok {
			t.Fatal("published malformed view")
		}
	}
	r := &fakeRunner{}
	b := NewManager(r)
	t.Cleanup(b.Close)
	for _, id := range []string{"", "--container", "srf-id-a/../../x", "srf-holdings-demo"} {
		if b.Open(context.Background(), id, false) == nil {
			t.Fatal(id)
		}
	}
	if r.calls != 0 {
		t.Fatal("invalid identity executed")
	}
	if b.Stop(context.Background(), "srf-id-demo") == nil || r.calls != 0 {
		t.Fatal("stop without view executed")
	}
	for _, text := range [][]byte{nil, {0xff}, make([]byte, 16385)} {
		if b.Paste(context.Background(), "srf-id-demo", text) == nil {
			t.Fatal("bad paste")
		}
	}
}
func TestFailuresCloseView(t *testing.T) {
	r := &fakeRunner{output: []byte(`{"url":"http://127.0.0.1:1234/","native":"xpra","socket":"/s"}`)}
	b := NewManager(r)
	t.Cleanup(b.Close)
	if err := b.Open(context.Background(), "srf-id-demo", false); err != nil {
		t.Fatal(err)
	}
	if b.Paste(context.Background(), "srf-id-demo", []byte("hi")) == nil {
		t.Fatal("readonly paste")
	}
	before := r.calls
	if b.Open(context.Background(), "srf-id-demo", true) == nil || r.calls != before {
		t.Fatal("duplicate open")
	}
	for _, rc := range []int{2, 3, 4, 5, 6, 7} {
		r.err = nil
		if _, ok := b.Info("srf-id-demo"); !ok {
			if err := b.Open(context.Background(), "srf-id-demo", false); err != nil {
				t.Fatal(err)
			}
		}
		r.err = cli.ExitFault("srf-identity-surface", rc, "")
		err := b.Stop(context.Background(), "srf-id-demo")
		var fault *cli.Fault
		if !errors.As(err, &fault) {
			t.Fatal(err)
		}
		if _, ok := b.Info("srf-id-demo"); ok {
			t.Fatal("failed stop retained view")
		}
	}
}

type blockingRunner struct {
	entered  chan struct{}
	release  chan struct{}
	blockRun bool
}

func (r *blockingRunner) Start(_ context.Context, args []string) (*Process, error) {
	if args[3] == "srf-id-slow" && !r.blockRun {
		close(r.entered)
		<-r.release
	}
	done := make(chan struct{})
	var once sync.Once
	return &Process{Announcement: []byte(`{"url":"http://127.0.0.1:1234/","native":"x","socket":"/runtime/s"}`), Done: done, Close: func() { once.Do(func() { close(done) }) }}, nil
}
func (r *blockingRunner) Run(_ context.Context, args []string, _ []byte) ([]byte, error) {
	if args[3] == "srf-id-slow" && r.blockRun {
		close(r.entered)
		<-r.release
	}
	return []byte(fmt.Sprintf(`{"stopped_view":%q,"pid":42,"seconds":0}`, args[3])), nil
}
func TestSlowContainerDoesNotBlockOtherViews(t *testing.T) {
	for _, run := range []bool{false, true} {
		r := &blockingRunner{entered: make(chan struct{}), release: make(chan struct{}), blockRun: run}
		b := NewManager(r)
		t.Cleanup(b.Close)
		defer b.Close()
		if err := b.Open(context.Background(), "srf-id-fast", false); err != nil {
			t.Fatal(err)
		}
		if run {
			if err := b.Open(context.Background(), "srf-id-slow", true); err != nil {
				t.Fatal(err)
			}
		}
		slow := make(chan error, 1)
		go func() {
			if run {
				slow <- b.Paste(context.Background(), "srf-id-slow", []byte("x"))
			} else {
				slow <- b.Open(context.Background(), "srf-id-slow", false)
			}
		}()
		<-r.entered
		fast := make(chan error, 1)
		go func() {
			if _, ok := b.Info("srf-id-fast"); !ok {
				fast <- errors.New("missing fast view")
				return
			}
			fast <- b.Stop(context.Background(), "srf-id-fast")
		}()
		select {
		case err := <-fast:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(time.Second):
			t.Error("cross-container operation blocked")
		}
		close(r.release)
		<-slow
	}
}
