// [TARGET, unit decision] Test-owned entry to real capsule manager, process
// runner and immutable frame publisher. Only the native CLI is a fixture.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"os"
	"syscall"
	"time"
	"unsafe"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func monotonic() uint64 {
	var ts syscall.Timespec
	_, _, errno := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&ts)), 0)
	if errno != 0 {
		panic(errno)
	}
	return uint64(ts.Sec)*1000000000 + uint64(ts.Nsec)
}
func main() {
	root := os.Args[1]
	m, err := capsule.NewRuntime(capsule.Config{OriginNS: 1, MaxSurfaces: 2, MaxOutputBytes: 65536, Timeout: time.Second,
		Profiles: map[string]capsule.Profile{"slice": {Kind: "browser", NativeKind: "browser", RAMRoot: root, Display: ":100", Width: 2, Height: 1}}}, monotonic)
	must(err)
	pub, err := frames.NewPublisher(frames.PublishConfig{RAMRoot: root, MaxFrameBytes: 4096, MaxPixels: 2, MaxSurfaces: 2})
	must(err)
	defer pub.Close()
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var q struct {
			Op     string          `json:"op"`
			ID     string          `json:"id"`
			Params json.RawMessage `json:"params"`
		}
		must(json.Unmarshal(scanner.Bytes(), &q))
		var result any
		if q.Op == "capture" {
			b, n, e := m.Capture(context.Background(), q.ID)
			must(e)
			ref, e := pub.Publish(q.ID, b, n)
			must(e)
			result = ref
		} else {
			events, e := m.Handle(context.Background(), capsule.Request{Schema: "surface_request/v0.2", Op: q.Op, Params: q.Params})
			if e != nil {
				result = map[string]any{"error": e.Error()}
			} else {
				result = events
			}
		}
		out, e := json.Marshal(result)
		must(e)
		fmt.Println(string(out))
	}
	must(scanner.Err())
}
