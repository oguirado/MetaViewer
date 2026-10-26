package capsule

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestActualWindowGeometry(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	p := m.cfg.Profiles["demo"]
	p.Width, p.Height = 3, 2
	m.cfg.Profiles["demo"] = p
	out, err := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":3,"h":2}}`))
	if err != nil {
		t.Fatal(err)
	}
	var ev struct{ Data struct{ Surface Surface } }
	if err = json.Unmarshal(out[0], &ev); err != nil {
		t.Fatal(err)
	}
	id := ev.Data.Surface.SurfaceID
	if ev.Data.Surface.Geometry != (Geometry{2, 1}) {
		t.Errorf("created geometry = %+v, want actual window", ev.Data.Surface.Geometry)
	}
	r.output = []byte(`{"surface_id":"w1","kind":"click","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
	for i, xy := range [][2]int{{2, 1}, {2, 0}, {1, 1}} {
		n := len(r.calls)
		_, err = m.Handle(context.Background(), req("input", fmt.Sprintf(`{"surface_id":%q,"proposal_id":"outside-%d","action":{"type":"click","x":%d,"y":%d,"button":"left"}}`, id, i, xy[0], xy[1])))
		if err == nil || len(r.calls) != n {
			t.Errorf("outside click %v executed or accepted: %v", xy, err)
		}
	}
	out, err = m.Handle(context.Background(), req("input", fmt.Sprintf(`{"surface_id":%q,"proposal_id":"inside","action":{"type":"click","x":1,"y":0,"button":"left"}}`, id)))
	if err != nil || len(out) != 1 || !strings.Contains(string(out[0]), `"input_applied"`) {
		t.Fatalf("inside click: %s %v", out, err)
	}
	if !reflect.DeepEqual(r.calls[len(r.calls)-1][1:], []string{"input", "--container", "srf-id-demo", "--window", "w1", "--click", "1,0", "--button", "1"}) {
		t.Fatal("inside click coordinates changed")
	}
	b := m.bindings[id]
	f := NativeFrame{Path: b.FramesRoot + "/f.png", Seq: 1, SHA256RGB24: strings.Repeat("0", 64), Width: 3, Height: 2, CaptureMonoNS: 200, Generation: b.Container, Window: &Window{ID: "w1", W: 3, H: 2}}
	r.output, _ = json.Marshal(f)
	if _, _, err = m.Capture(context.Background(), id); err == nil {
		t.Error("profile-sized frame accepted outside actual window")
	}
	f.Width, f.Height, f.Window.W, f.Window.H = 2, 1, 2, 1
	r.output, _ = json.Marshal(f)
	got, _, err := m.Capture(context.Background(), id)
	if err != nil || got.Surface.Geometry != (Geometry{2, 1}) {
		t.Fatalf("actual capture geometry: %+v %v", got.Surface.Geometry, err)
	}
	f.Width, f.Window.W = 1, 1
	r.output, _ = json.Marshal(f)
	got, _, err = m.Capture(context.Background(), id)
	if err != nil || got.Surface.Geometry != (Geometry{1, 1}) || m.bindings[id].Surface.Geometry != (Geometry{1, 1}) {
		t.Errorf("capture did not persist current window: %+v %v", got.Surface.Geometry, err)
	}
	n := len(r.calls)
	_, err = m.Handle(context.Background(), req("input", fmt.Sprintf(`{"surface_id":%q,"proposal_id":"after-shrink","action":{"type":"click","x":1,"y":0,"button":"left"}}`, id)))
	if err == nil || len(r.calls) != n {
		t.Error("click outside captured window executed")
	}
}

func TestHoldingsCaptureExactGeometry(t *testing.T) {
	r := &scriptRunner{}
	m := testManager(t, r)
	id := holdingsBinding(m)
	b := m.bindings[id]
	b.FramesRoot = "/dev/shm/holdings/frames"
	m.bindings[id] = b
	f := NativeFrame{Path: b.FramesRoot + "/f.png", Seq: 1, SHA256RGB24: strings.Repeat("0", 64), Width: 1, Height: 1, CaptureMonoNS: 200, Generation: b.Container}
	r.output, _ = json.Marshal(f)
	if _, _, err := m.Capture(context.Background(), id); err == nil {
		t.Error("smaller Holdings frame accepted")
	}
	f.Width = 2
	r.output, _ = json.Marshal(f)
	if _, _, err := m.Capture(context.Background(), id); err != nil {
		t.Fatalf("exact Holdings capture: %v", err)
	}
}
