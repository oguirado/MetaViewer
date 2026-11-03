package frames

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"metaviewer/daemon-adapter/internal/cli"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestV027FixK1MinimizeRestore(t *testing.T) {
	root, b, f := ramFixture(t)
	src := &lossAwareCaptureSource{b: b, f: f, failPolls: map[int]error{}}
	for i := 2; i <= 6; i++ {
		src.failPolls[i] = &cli.Fault{Code: "host_window_unavailable", Detail: "host_window_unavailable: window minimized"}
	}
	events := make(chan json.RawMessage, 16)
	subs, err := NewSubscriptions(context.Background(), SubscriptionConfig{MaxSubscriptions: 1, PollInterval: time.Millisecond, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, src, publisher(t, root), func(_ context.Context, msg json.RawMessage) error { events <- msg; return nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = subs.Close(context.Background()) })
	if err = subs.Subscribe(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		select {
		case msg := <-events:
			var ev struct {
				Event string `json:"event"`
			}
			_ = json.Unmarshal(msg, &ev)
			if ev.Event != "frame_ready" {
				t.Fatalf("minimize terminated verified stream: %s", msg)
			}
		case <-time.After(time.Second):
			t.Fatal("no restored verified frame")
		}
	}
}

func TestV027FixK1ResizeEOFHelper(t *testing.T) {
	if os.Getenv("MV_V027_FIX_K1_EOF") != "1" {
		return
	}
	fmt.Fprintln(os.Stderr, "host_window_unavailable: resized: 2x1 -> 4x2")
	os.Exit(2)
}
func TestV027FixK1ResizeEOF(t *testing.T) {
	target := displayTestTarget()
	target.HostWindow = true
	target.Witness = "w"
	target.BinDir = t.TempDir()
	root, err := os.MkdirTemp("/dev/shm", "v027-fix-k1-display-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err = os.Mkdir(filepath.Join(root, "metaviewer"), 0700); err != nil {
		t.Fatal(err)
	}
	path, err := DisplayRingPath(root, "surface")
	if err != nil {
		t.Fatal(err)
	}
	var gotW, gotH int
	tap := NewDisplayTaps(context.Background(), DisplayTapConfig{RuntimeDir: root, OnResize: func(_ string, w, h int) { gotW, gotH = w, h }, Command: func(ctx context.Context, _ DisplayTarget) *exec.Cmd {
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestV027FixK1ResizeEOFHelper$")
		cmd.Env = append(os.Environ(), "MV_V027_FIX_K1_EOF=1")
		return cmd
	}})
	err = tap.session(context.Background(), "surface", path, target)
	if !errors.Is(err, errDisplayResized) || gotW != 4 || gotH != 2 {
		t.Fatalf("resize EOF used generic failure: %v (%dx%d)", err, gotW, gotH)
	}
}
func TestV027FixK1NativeXWDResize(t *testing.T) {
	target := displayTestTarget()
	changed := target
	changed.Width = 4
	changed.Height = 2
	raw := displayTestXWD(changed, 10)
	calls := 0
	err := displayDecodeXWD(bytes.NewReader(raw), target, func(rgb []byte, _ uint64, got DisplayTarget) error {
		calls++
		if got.Width != 4 || got.Height != 2 || len(rgb) != 24 {
			t.Fatalf("wrong geometry: %+v", got)
		}
		return nil
	})
	if !errors.Is(err, io.EOF) || calls != 1 {
		t.Fatalf("changed-size native XWD rejected: %v (%d frames)", err, calls)
	}
	binary.BigEndian.PutUint32(raw[28:], 2)
	if err = displayDecodeXWD(bytes.NewReader(raw), target, func([]byte, uint64, DisplayTarget) error { t.Fatal("malformed frame accepted"); return nil }); err == nil {
		t.Fatal("invalid order passed")
	}
}

func TestV027FixK1NativeSenderHelper(t *testing.T) {
	if os.Getenv("MV_V027_FIX_K1_NATIVE") != "1" {
		return
	}
	target := displayTestTarget()
	target.Width = 4
	target.Height = 2
	_, _ = os.Stdout.Write(displayTestXWD(target, 10))
	os.Exit(0)
}
func TestV027FixK1NativeSessionResize(t *testing.T) {
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte("#!/bin/sh\nexec \"$MV_V027_FIX_K1_TEST_BINARY\" -test.run=^TestV027FixK1NativeSenderHelper$\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("MV_V027_FIX_K1_NATIVE", "1")
	t.Setenv("MV_V027_FIX_K1_TEST_BINARY", os.Args[0])
	root, err := os.MkdirTemp("/dev/shm", "v027-fix-k1-native-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err = os.Mkdir(filepath.Join(root, "metaviewer"), 0700); err != nil {
		t.Fatal(err)
	}
	path, err := DisplayRingPath(root, "surface")
	if err != nil {
		t.Fatal(err)
	}
	var w, h int
	tap := NewDisplayTaps(context.Background(), DisplayTapConfig{RuntimeDir: root, OnResize: func(_ string, a, b int) { w, h = a, b }})
	err = tap.session(context.Background(), "surface", path, displayTestTarget())
	if !errors.Is(err, errDisplayResized) || w != 4 || h != 2 {
		t.Fatalf("native geometry missed resize recovery: %v %dx%d", err, w, h)
	}
}
