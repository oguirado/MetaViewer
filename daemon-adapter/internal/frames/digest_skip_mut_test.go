package frames

import (
	"testing"
	"time"
)

func TestDigestSkipGappedSequence(t *testing.T) {
	p, b, f, reads := digestSkipFixture(t)
	const id = "sg-gap"
	b.Surface.SurfaceID = id
	first, changed, _, err := p.PublishWithTimings(id, b, f, true)
	if err != nil || !changed || *reads != 1 {
		t.Fatalf("first frame: changed=%v reads=%d err=%v", changed, *reads, err)
	}
	f.Seq = 9
	ref, changed, stages, err := p.PublishWithTimings(id, b, f, true)
	if err != nil || changed || ref != first || stages.Skipped != 1 || *reads != 1 {
		t.Fatalf("gapped skip: ref=%+v changed=%v stages=%+v reads=%d err=%v", ref, changed, stages, *reads, err)
	}
	if got := p.surfaces[id].seq; got != f.Seq {
		t.Errorf("skip sequence=%d, want native sequence=%d", got, f.Seq)
	}
	f.Seq = 5
	if _, _, _, err := p.PublishWithTimings(id, b, f, true); err == nil {
		t.Error("rollback after gapped skip accepted")
	}
	if *reads != 1 {
		t.Fatalf("rollback read source: reads=%d", *reads)
	}
}

func TestDigestSkipStaleAttemptDisarms(t *testing.T) {
	p, b, f, reads := digestSkipFixture(t)
	const id = "sg-stale"
	b.Surface.SurfaceID = id
	first, changed, _, err := p.PublishWithTimings(id, b, f, true)
	if err != nil || !changed || *reads != 1 {
		t.Fatalf("first frame: changed=%v reads=%d err=%v", changed, *reads, err)
	}
	if _, _, _, err := p.PublishWithTimings(id, b, f, true); err == nil {
		t.Fatal("stale sequence accepted")
	}
	if *reads != 1 {
		t.Fatalf("validation rejection read source: reads=%d", *reads)
	}
	f.Seq = 2
	ref, changed, stages, err := p.PublishWithTimings(id, b, f, true)
	if err != nil || changed || ref != first || stages.Skipped != 0 || *reads != 2 {
		t.Fatalf("stale attempt did not disarm: ref=%+v changed=%v stages=%+v reads=%d err=%v", ref, changed, stages, *reads, err)
	}
	f.Seq = 3
	ref, changed, stages, err = p.PublishWithTimings(id, b, f, true)
	if err != nil || changed || ref != first || stages.Skipped != 1 || *reads != 2 {
		t.Fatalf("verified read did not rearm: ref=%+v changed=%v stages=%+v reads=%d err=%v", ref, changed, stages, *reads, err)
	}
}

func TestDigestSkipRefreshesRetention(t *testing.T) {
	root, b, f := ramFixture(t)
	const id = "sg-ret"
	b.Surface.SurfaceID = id
	p, err := NewPublisher(PublishConfig{RAMRoot: root, MaxFrameBytes: 4096, MaxPixels: 64, MaxSurfaces: 4, MinRetention: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := p.Close(); err != nil {
			t.Error(err)
		}
	})
	now := time.Unix(100, 0)
	p.now = func() time.Time { return now }
	reads := 0
	p.sourceRead = func(fd int, root, path string) ([]byte, error) {
		reads++
		return p.readSource(fd, root, path)
	}
	first, changed, _, err := p.PublishWithTimings(id, b, f, true)
	if err != nil || !changed || reads != 1 {
		t.Fatalf("first frame: changed=%v reads=%d err=%v", changed, reads, err)
	}
	old := p.surfaces[id]
	if len(old.published) != len(old.refs) || len(old.published) == 0 || !old.published[len(old.published)-1].Equal(now) {
		t.Fatalf("initial retention timestamps=%v, want latest=%v", old.published, now)
	}
	now = now.Add(time.Second)
	f.Seq = 2
	ref, changed, stages, err := p.PublishWithTimings(id, b, f, true)
	if err != nil || changed || ref != first || stages.Skipped != 1 || stages.Decode != 0 || stages.Hash != 0 || stages.Write != 0 || reads != 1 {
		t.Fatalf("retention skip: ref=%+v changed=%v stages=%+v reads=%d err=%v", ref, changed, stages, reads, err)
	}
	old = p.surfaces[id]
	if len(old.published) != len(old.refs) || len(old.published) == 0 || !old.published[len(old.published)-1].Equal(now) {
		t.Fatalf("skip retention timestamps=%v, want latest=%v", old.published, now)
	}
}
