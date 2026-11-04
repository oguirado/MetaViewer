package frames

import (
	"errors"
	"testing"
)

func TestControlRefreshSurvivesPublicationFailure(t *testing.T) {
	root, binding, native := ramFixture(t)
	p := publisher(t, root)
	before, err := p.Publish("a", binding, native)
	if err != nil {
		t.Fatal(err)
	}
	binding.FrameRefreshEpoch++
	native.Seq++
	read := p.sourceRead
	p.sourceRead = func(int, string, string) ([]byte, error) {
		return nil, errors.New("publication source unavailable")
	}
	if _, _, err := p.PublishIfChanged("a", binding, native); err == nil {
		t.Fatal("refresh must validate a real capture before publishing")
	}
	p.sourceRead = read
	native.Seq++
	after, changed, err := p.PublishIfChanged("a", binding, native)
	if err != nil || !changed || after.Generation <= before.Generation || after.SHA256 != before.SHA256 || after.RAMWSPath == before.RAMWSPath {
		t.Fatalf("refresh lost after publication failure: %+v changed=%v err=%v", after, changed, err)
	}
	native.Seq++
	polled, changed, err := p.PublishIfChanged("a", binding, native)
	if err != nil || changed || polled.Generation != after.Generation {
		t.Fatalf("ordinary static polling must resume deduplication: %+v changed=%v err=%v", polled, changed, err)
	}
}
