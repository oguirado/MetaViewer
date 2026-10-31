package frames

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"metaviewer/daemon-adapter/internal/capsule"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type sharedRunRunner struct{ output []byte }

func (r *sharedRunRunner) Run(context.Context, []string, []byte) ([]byte, error) {
	return r.output, nil
}
func TestSharedRootManagerPublisherIsolation(t *testing.T) {
	root, _, base := ramFixture(t)
	p := publisher(t, root)
	r := &sharedRunRunner{}
	profiles := map[string]capsule.Profile{}
	for i := 0; i < 2; i++ {
		profiles[fmt.Sprintf("capsule-%d", i)] = capsule.Profile{Kind: "browser", NativeKind: "browser", Width: 2, Height: 1, Display: fmt.Sprintf(":%d", 100+i), RAMRoot: root}
	}
	m, err := capsule.NewManager(capsule.Config{BinDir: t.TempDir(), Profiles: profiles, MaxSurfaces: 4, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 100}, r, func() uint64 { return 200 })
	if err != nil {
		t.Fatal(err)
	}
	var bindings []capsule.Binding
	var natives []capsule.NativeFrame
	var refs []Ref
	source, err := os.ReadFile(base.Path)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		id := fmt.Sprintf("capsule-%d", i)
		run := fmt.Sprintf("run-%d", i)
		r.output = []byte(fmt.Sprintf(`{"container":"srf-id-%s","run_id":"%s","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1}]}`, id, run))
		out, err := m.Handle(context.Background(), capsule.Request{Schema: "surface_request/v0.2", Op: "create", Params: json.RawMessage(fmt.Sprintf(`{"kind":"browser","profile_id":"%s","geometry":{"w":2,"h":1}}`, id))})
		if err != nil {
			t.Fatal(err)
		}
		var event struct {
			Data struct{ Surface capsule.Surface }
		}
		if err := json.Unmarshal(out[0], &event); err != nil {
			t.Fatal(err)
		}
		b, err := m.SubscriptionBinding(event.Data.Surface.SurfaceID)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(b.FramesRoot, 0700); err != nil {
			t.Fatal(err)
		}
		f := base
		f.Path = filepath.Join(b.FramesRoot, "f.png")
		f.Generation = b.Container
		f.CaptureMonoNS = 200
		if err := os.WriteFile(f.Path, source, 0600); err != nil {
			t.Fatal(err)
		}
		r.output, _ = json.Marshal(f)
		b, f, err = m.Capture(context.Background(), b.Surface.SurfaceID)
		if err != nil {
			t.Fatal(err)
		}
		ref, err := p.Publish(b.Surface.SurfaceID, b, f)
		if err != nil {
			t.Fatal(err)
		}
		bindings = append(bindings, b)
		natives = append(natives, f)
		refs = append(refs, ref)
	}
	for i, b := range bindings {
		f := natives[i]
		f.Seq = 2
		f.Path = natives[1-i].Path
		r.output, _ = json.Marshal(f)
		if _, _, err := m.Capture(context.Background(), b.Surface.SurfaceID); err == nil {
			t.Fatal("manager read foreign run")
		}
		// readSource rejects the foreign allocation before traversing its files.
		if _, err := p.Publish(b.Surface.SurfaceID, b, f); err == nil {
			t.Fatal("publisher accepted foreign run")
		}
		retained := p.surfaces[b.Surface.SurfaceID]
		if len(retained.refs) != 1 || retained.refs[0].RAMWSPath != refs[i].RAMWSPath {
			t.Fatal("foreign frame retained")
		}
		got, err := os.ReadFile(refs[i].RAMWSPath)
		if err != nil || !bytes.Equal(got, []byte{255, 0, 0, 0, 255, 0}) {
			t.Fatal("retained pixels changed", err)
		}
	}
}
