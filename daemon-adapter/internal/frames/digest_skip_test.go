package frames

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
)

func digestSkipFixture(t *testing.T) (*Publisher, capsule.Binding, capsule.NativeFrame, *int) {
	t.Helper()
	root, b, f := ramFixture(t)
	p := publisher(t, root)
	p.now = func() time.Time { return time.Unix(100, 0) }
	reads := new(int)
	p.sourceRead = func(fd int, root, path string) ([]byte, error) {
		*reads++
		return p.readSource(fd, root, path)
	}
	return p, b, f, reads
}

func digestSkipPNG(t *testing.T, f capsule.NativeFrame, width, height int, raw []byte) capsule.NativeFrame {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < width*height; i++ {
		img.SetNRGBA(i%width, i/width, color.NRGBA{R: raw[3*i], G: raw[3*i+1], B: raw[3*i+2], A: 255})
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.Path, encoded.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	f.Width, f.Height = width, height
	f.Window = &capsule.Window{ID: "w1", W: width, H: height}
	f.SHA256RGB24 = fmt.Sprintf("%x", sha256.Sum256(raw))
	return f
}

func TestDigestSkipUnchanged(t *testing.T) {
	p, b, f, reads := digestSkipFixture(t)
	first, changed, _, err := p.PublishWithTimings("a", b, f, true)
	if err != nil || !changed || *reads != 1 {
		t.Fatalf("first frame: changed=%v reads=%d err=%v", changed, *reads, err)
	}
	// Missing source makes a read/open regression fail independently of the counter.
	if err := os.Remove(f.Path); err != nil {
		t.Fatal(err)
	}
	for seq := uint64(2); seq <= 3; seq++ {
		f.Seq = seq
		ref, changed, stages, err := p.PublishWithTimings("a", b, f, true)
		if err != nil || changed || ref != first || *reads != 1 || stages.Skipped != 1 || stages.Decode != 0 || stages.Hash != 0 || stages.Write != 0 {
			t.Fatalf("digest hit: ref=%+v changed=%v reads=%d stages=%+v err=%v", ref, changed, *reads, stages, err)
		}
		if p.surfaces["a"].seq != seq {
			t.Fatal("skip did not advance sequence")
		}
	}
}

func TestDigestSkipChangedAndMismatch(t *testing.T) {
	p, b, f, reads := digestSkipFixture(t)
	if _, err := p.Publish("a", b, f); err != nil {
		t.Fatal(err)
	}
	f.Seq++
	f = digestSkipPNG(t, f, 2, 1, []byte{1, 2, 3, 4, 5, 6})
	ref, changed, stages, err := p.PublishWithTimings("a", b, f, true)
	if err != nil || !changed || *reads != 2 || stages.Skipped != 0 || ref.SHA256 != f.SHA256RGB24 {
		t.Fatalf("changed digest: %v %v reads=%d", changed, err, *reads)
	}
	f.Seq++
	f.SHA256RGB24 = fmt.Sprintf("%064x", 0)
	if _, _, _, err := p.PublishWithTimings("a", b, f, true); err == nil {
		t.Fatal("digest mismatch published")
	}
}

func TestDigestSkipGeometry(t *testing.T) {
	p, b, f, reads := digestSkipFixture(t)
	b.Surface.Geometry.H = 2
	if _, err := p.Publish("a", b, f); err != nil {
		t.Fatal(err)
	}
	f.Seq++
	// Same RGB byte stream and SHA, different shape: kills ignoring-geometry mutant.
	f = digestSkipPNG(t, f, 1, 2, []byte{255, 0, 0, 0, 255, 0})
	ref, changed, stages, err := p.PublishWithTimings("a", b, f, true)
	if err != nil || !changed || *reads != 2 || stages.Skipped != 0 || ref.Width != 1 || ref.Height != 2 {
		t.Fatalf("geometry change skipped: changed=%v reads=%d ref=%+v err=%v", changed, *reads, ref, err)
	}
}

func TestDigestSkipLifecycle(t *testing.T) {
	p, b, f, reads := digestSkipFixture(t)
	if _, err := p.Publish("a", b, f); err != nil {
		t.Fatal(err)
	}
	if err := p.Release("a"); err != nil {
		t.Fatal(err)
	}
	b.Container = "replacement"
	f.Generation = b.Container
	_, changed, stages, err := p.PublishWithTimings("a", b, f, true)
	if err != nil || !changed || *reads != 2 || stages.Skipped != 0 {
		t.Fatalf("lifecycle reused ref: changed=%v reads=%d err=%v", changed, *reads, err)
	}
}

func TestDigestSkipFailedPublishReset(t *testing.T) {
	p, b, f, reads := digestSkipFixture(t)
	if _, err := p.Publish("a", b, f); err != nil {
		t.Fatal(err)
	}
	failed := f
	failed.Seq = 2
	failed.SHA256RGB24 = fmt.Sprintf("%064x", 0)
	if _, _, _, err := p.PublishWithTimings("a", b, failed, true); err == nil {
		t.Fatal("expected failed publish")
	}
	f.Seq = 3
	_, changed, stages, err := p.PublishWithTimings("a", b, f, true)
	if err != nil || changed || *reads != 3 || stages.Skipped != 0 {
		t.Fatalf("failure did not reset: reads=%d stages=%+v err=%v", *reads, stages, err)
	}
	f.Seq++
	_, _, stages, err = p.PublishWithTimings("a", b, f, true)
	if err != nil || *reads != 3 || stages.Skipped != 1 {
		t.Fatalf("successful verification did not rearm: reads=%d err=%v", *reads, err)
	}
}

func TestDigestSkipForcedReads(t *testing.T) {
	p, b, f, reads := digestSkipFixture(t)
	if _, err := p.Publish("a", b, f); err != nil {
		t.Fatal(err)
	}
	f.Seq++
	_, changed, stages, err := p.PublishWithTimings("a", b, f, false)
	if err != nil || !changed || *reads != 2 || stages.Skipped != 0 {
		t.Fatalf("forced publish skipped: reads=%d err=%v", *reads, err)
	}
}
