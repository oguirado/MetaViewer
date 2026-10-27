package frames

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"metaviewer/daemon-adapter/internal/capsule"
)

func TestFourSurfaceConcurrentPublication(t *testing.T) {
	root, baseBinding, baseFrame := ramFixture(t)
	p := publisher(t, root)
	var bindings [4]capsule.Binding
	var natives [4]capsule.NativeFrame
	var pixels [4][]byte
	for i := range bindings {
		b, f := baseBinding, baseFrame
		b.Surface.SurfaceID = fmt.Sprintf("surface-%d", i)
		b.Container = fmt.Sprintf("native-%d", i)
		b.FramesRoot = filepath.Join(root, b.Surface.SurfaceID)
		if err := os.Mkdir(b.FramesRoot, 0700); err != nil {
			t.Fatal(err)
		}
		f.Generation = b.Container
		f.Path = filepath.Join(b.FramesRoot, "source.png")
		pixel := color.RGBA{R: uint8(20 + i), G: uint8(40 + i), B: uint8(60 + i), A: 255}
		img := image.NewRGBA(image.Rect(0, 0, 2, 1))
		img.SetRGBA(0, 0, pixel)
		img.SetRGBA(1, 0, pixel)
		var encoded bytes.Buffer
		if err := png.Encode(&encoded, img); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f.Path, encoded.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		pixels[i] = []byte{pixel.R, pixel.G, pixel.B, pixel.R, pixel.G, pixel.B}
		f.SHA256RGB24 = fmt.Sprintf("%x", sha256.Sum256(pixels[i]))
		bindings[i], natives[i] = b, f
	}
	type result struct {
		i   int
		ref Ref
		err error
	}
	paths := make(map[string]bool)
	var refs []result
	var previous uint64
	for seq := uint64(1); seq <= 2; seq++ {
		start := make(chan struct{})
		ready := make(chan struct{}, len(bindings))
		results := make(chan result, len(bindings))
		for i := range bindings {
			go func(i int) {
				ready <- struct{}{}
				<-start
				f := natives[i]
				f.Seq = seq
				ref, err := p.Publish(bindings[i].Surface.SurfaceID, bindings[i], f)
				results <- result{i, ref, err}
			}(i)
		}
		for range bindings {
			<-ready
		}
		close(start)
		var round []result
		for range bindings {
			r := <-results
			if r.err != nil {
				t.Fatalf("surface %d sequence %d: %v", r.i, seq, r.err)
			}
			if r.ref.SurfaceID != bindings[r.i].Surface.SurfaceID || r.ref.Tick != seq || r.ref.SHA256 != natives[r.i].SHA256RGB24 {
				t.Fatalf("cross-surface publication: %+v", r.ref)
			}
			if paths[r.ref.RAMWSPath] {
				t.Fatalf("publication reused allocation %q", r.ref.RAMWSPath)
			}
			paths[r.ref.RAMWSPath] = true
			round = append(round, r)
		}
		// Completion-channel order is not publication order. The lock-assigned
		// generations must form a single increasing sequence across both waves.
		sort.Slice(round, func(i, j int) bool { return round[i].ref.Generation < round[j].ref.Generation })
		for _, r := range round {
			if r.ref.Generation != previous+1 {
				t.Fatalf("global generation: got %d after %d", r.ref.Generation, previous)
			}
			previous = r.ref.Generation
		}
		refs = append(refs, round...)
	}
	for i, b := range bindings {
		for j := range bindings {
			f := natives[i]
			f.Seq = 3 // Fresh sequence isolates identity refusal from stale refusal.
			if i != j {
				if _, err := p.Publish(bindings[j].Surface.SurfaceID, b, f); err == nil {
					t.Fatalf("cross-surface publish %d -> %d accepted", i, j)
				}
			}
		}
		for _, seq := range []uint64{1, 2} {
			f := natives[i]
			f.Seq = seq
			if _, err := p.Publish(b.Surface.SurfaceID, b, f); err == nil {
				t.Fatalf("surface %d accepted stale sequence %d", i, seq)
			}
		}
	}
	// Both retained generations must still contain their own surface's pixels,
	// including after every foreign and stale publication attempt.
	for _, r := range refs {
		raw, err := os.ReadFile(r.ref.RAMWSPath)
		if err != nil || !bytes.Equal(raw, pixels[r.i]) {
			t.Fatalf("surface %d immutable pixels changed: %x, %v", r.i, raw, err)
		}
	}
}
