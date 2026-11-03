package frames

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"metaviewer/daemon-adapter/internal/capsule"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestV027FixK5NativeSender(t *testing.T) {
	if os.Getenv("MV_V027_K5_SENDER") != "1" {
		return
	}
	target := displayTestTarget()
	for i, size := range [][2]int{{4, 2}, {target.Width, target.Height}, {3, 2}} {
		target.Width, target.Height = size[0], size[1]
		_, _ = os.Stdout.Write(displayTestXWD(target, byte(10+i)))
		if i < 2 {
			marker := os.Getenv("MV_V027_K5_NEXT") + strconv.Itoa(i)
			for {
				if _, err := os.Stat(marker); err == nil {
					break
				}
				time.Sleep(time.Millisecond)
			}
		}
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
	os.Exit(0)
}

func TestV027FixK5NativeResizeWithoutCallbackPublishes(t *testing.T) {
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte("#!/bin/sh\nexec \"$MV_V027_K5_BINARY\" -test.run=^TestV027FixK5NativeSender$\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("MV_V027_K5_SENDER", "1")
	t.Setenv("MV_V027_K5_BINARY", os.Args[0])
	root, err := os.MkdirTemp("/dev/shm", "v027-k5-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err = os.Mkdir(filepath.Join(root, "metaviewer"), 0700); err != nil {
		t.Fatal(err)
	}
	path, err := DisplayRingPath(root, "native")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MV_V027_K5_NEXT", filepath.Join(root, "next-"))
	target := displayTestTarget()
	tap := NewDisplayTaps(context.Background(), DisplayTapConfig{RuntimeDir: root, Resolve: func(string) (DisplayTarget, error) { return target, nil }})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- tap.session(ctx, "native", path, target) }()
	sizes := [][2]int{{4, 2}, {target.Width, target.Height}, {3, 2}}
	published := 0
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
wait:
	for {
		select {
		case err := <-done:
			t.Fatalf("changed native frame ended session before publication: %v", err)
		case <-deadline.C:
			break wait
		case <-ticker.C:
			raw, e := os.ReadFile(path)
			if e == nil && len(raw) >= 64 && binary.LittleEndian.Uint32(raw[8:]) == uint32(sizes[published][0]) && binary.LittleEndian.Uint32(raw[12:]) == uint32(sizes[published][1]) && binary.LittleEndian.Uint64(raw[24:]) >= 2 {
				if err := os.WriteFile(os.Getenv("MV_V027_K5_NEXT")+strconv.Itoa(published), nil, 0600); err != nil {
					t.Fatal(err)
				}
				published++
				if published == len(sizes) {
					break wait
				}
			}
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Stop failed after native resize")
	}
	if published != len(sizes) {
		t.Fatalf("native resize sequence stopped after %d published geometries", published)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("Stop retained ring: %v", err)
	}
}

func TestV027FixK5NativeWithoutWindowCannotEnterRetry(t *testing.T) {
	for _, kind := range []string{"browser", "program"} {
		_, err := ResolveDisplayTarget(capsule.Binding{NativeKind: kind}, "")
		var refusal *DisplayTapRefusal
		if !errors.As(err, &refusal) || refusal.Code != "DISPLAY_UNSUPPORTED" {
			t.Fatalf("native %s without Window entered tap: %v", kind, err)
		}
	}
}
