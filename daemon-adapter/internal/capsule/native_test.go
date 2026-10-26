package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

type scriptRunner struct {
	calls  [][]string
	output []byte
	err    error
}

func (s *scriptRunner) Run(_ context.Context, a []string, _ []byte) ([]byte, error) {
	s.calls = append(s.calls, append([]string(nil), a...))
	return s.output, s.err
}
func testManager(t *testing.T, r *scriptRunner) *Manager {
	t.Helper()
	m, e := NewManager(Config{BinDir: t.TempDir(), MaxSurfaces: 4, MaxOutputBytes: 4096, Timeout: time.Second, OriginNS: 100,
		Profiles: map[string]Profile{"demo": {Kind: "browser", NativeKind: "browser", Width: 2, Height: 1, Display: ":100", RAMRoot: "/dev/shm"}}}, r, func() uint64 { return 200 })
	if e != nil {
		t.Fatal(e)
	}
	return m
}
func req(op, params string) Request {
	return Request{Schema: "surface_request/v0.2", Op: op, Params: json.RawMessage(params)}
}

const startOK = `{"container":"srf-id-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1,"title":"","url":""}]}`

func TestNativeValidation(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	for _, s := range []string{`{"kind":"unknown","profile_id":"demo","geometry":{"w":2,"h":1}}`, `{"kind":"browser","profile_id":"../demo","geometry":{"w":2,"h":1}}`, `{"kind":"browser","profile_id":"missing","geometry":{"w":2,"h":1}}`, `{"kind":"browser","profile_id":"demo","geometry":{"w":3,"h":1}}`, `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1},"extra":true}`} {
		if _, e := m.Handle(context.Background(), req("create", s)); e == nil {
			t.Fatal("invalid request accepted")
		}
	}
	if len(r.calls) != 0 {
		t.Fatal("invalid input executed native command")
	}
}
func TestNativeOutput(t *testing.T) {
	for _, s := range []string{"", `{`, "noise", `{}`, startOK + "\n{}", `{"container":"srf-id-demo","run_id":"x","windows":[],"extra":1}`, `{"container":"bad","run_id":"x","windows":[]}`} {
		r := &scriptRunner{output: []byte(s)}
		m := testManager(t, r)
		if _, e := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`)); e == nil {
			t.Fatalf("bad native result accepted: %q", s)
		}
		if len(m.bindings) != 0 {
			t.Fatal("malformed output registered a surface")
		}
	}
}
func TestLifecycle(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	out, e := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`))
	if e != nil {
		t.Fatal(e)
	}
	if len(out) != 1 {
		t.Fatal("missing created event")
	}
	var ev struct {
		Event string `json:"event"`
		Data  struct {
			Surface Surface `json:"surface"`
		} `json:"data"`
	}
	if e = json.Unmarshal(out[0], &ev); e != nil {
		t.Fatal(e)
	}
	id := ev.Data.Surface.SurfaceID
	if ev.Event != "created" || ev.Data.Surface.State != "active" || id == "" {
		t.Fatal("invalid created event")
	}
	if !reflect.DeepEqual(r.calls[0][1:], []string{"start", "--kind", "browser", "--identity", "demo", "--windows", "1"}) {
		t.Fatalf("unexpected argv: %v", r.calls)
	}
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":false}`)
	if _, e = m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); e == nil {
		t.Fatal("unverified stop accepted")
	}
	r.output = []byte(`{"stopped":"srf-id-demo","removed_verified":true}`)
	if _, e = m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); e != nil {
		t.Fatal(e)
	}
	n := len(r.calls)
	if _, e = m.Handle(context.Background(), req("destroy", `{"surface_id":"`+id+`"}`)); e == nil || len(r.calls) != n {
		t.Fatal("terminal ID executed again")
	}
}
func TestUnknownOutcome(t *testing.T) {
	r := &scriptRunner{err: context.DeadlineExceeded}
	m := testManager(t, r)
	request := req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`)
	if _, e := m.Handle(context.Background(), request); e == nil {
		t.Fatal("timeout accepted")
	}
	r.err = nil
	r.output = []byte(startOK)
	if _, e := m.Handle(context.Background(), request); e == nil || len(r.calls) != 1 {
		t.Fatal("uncertain start was retried")
	}
	if _, _, e := m.Capture(context.Background(), "absent"); e == nil {
		t.Fatal("unknown capture accepted")
	}
	r.err = errors.New("failure")
}

func TestNativeKinds(t *testing.T) {
	for _, kind := range []string{"desktop_capsule", "vm", "game_capsule"} {
		t.Run(kind, func(t *testing.T) {
			r := &scriptRunner{}
			m := testManager(t, r)
			p := m.cfg.Profiles["demo"]
			p.Kind = kind
			switch kind {
			case "desktop_capsule":
				p.NativeKind = "program"
				p.Program = "notepad"
				r.output = []byte(`{"kind":"program","container":"srf-pg-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1,"title":"","url":""}]}`)
			case "vm":
				p.NativeKind = "vm"
				p.Program = "notepad-vm"
				r.output = []byte(`{"kind":"vm","container":"srf-vm-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":2,"h":1,"title":"","url":""}]}`)
			case "game_capsule":
				p.NativeKind = "holdings"
				p.AppDir = t.TempDir()
				r.output = []byte("[{\"slot\":1,\"container\":\"srf-ng-hcap-hc-0123456789ab-1\",\"run_id\":\"hc-0123456789ab\",\"display\":\":100\",\"width\":2,\"height\":1,\"lane_socket\":\"/tmp/lane.sock\",\"ready_line\":\"READY\",\"ready_ms\":0,\"frames_dir\":\"/dev/shm/test/frames\"}]\n")
			}
			m.cfg.Profiles["demo"] = p
			if _, e := m.Handle(context.Background(), req("create", `{"kind":"`+kind+`","profile_id":"demo","geometry":{"w":2,"h":1}}`)); e != nil {
				t.Fatal(e)
			}
			call := r.calls[0][1:]
			expected := []string{"start", "--kind", p.NativeKind, "--identity", "demo", "--windows", "1", "--program", p.Program}
			if kind == "game_capsule" {
				expected = []string{"start", "--slots", "1", "--app", p.AppDir}
			}
			if !reflect.DeepEqual(call, expected) {
				t.Fatalf("wrong kind mapping: %v", call)
			}
		})
	}
}
func TestListAndLost(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	if _, e := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`)); e != nil {
		t.Fatal(e)
	}
	var id string
	for key := range m.bindings {
		id = key
	}
	if _, e := m.MarkLost(id, false); e == nil {
		t.Fatal("unknown absence became lost")
	}
	if _, e := m.MarkLost(id, true); e != nil {
		t.Fatal(e)
	}
	if m.bindings[id].Surface.State != "lost" {
		t.Fatal("disappearance became destroyed")
	}
	if _, _, e := m.Capture(context.Background(), id); e == nil {
		t.Fatal("lost surface captured")
	}
	for i := 0; i < 2; i++ {
		out, e := m.Handle(context.Background(), req("list", `{}`))
		if e != nil || len(out) != 1 {
			t.Fatal("list dropped observed surface")
		}
	}
	if _, e := m.Handle(context.Background(), req("list", `{"extra":true}`)); e == nil {
		t.Fatal("unknown list property accepted")
	}
}
func TestInputAndCapture(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	if _, e := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`)); e != nil {
		t.Fatal(e)
	}
	var id string
	var binding Binding
	for key, b := range m.bindings {
		id = key
		binding = b
	}
	r.output = []byte(`{"surface_id":"w1","kind":"click","input_mono_ns":200,"focus_verified":true,"result":"ok"}`)
	input := `{"surface_id":"` + id + `","proposal_id":"p1","action":{"type":"click","x":1,"y":0,"button":"left"}}`
	out, e := m.Handle(context.Background(), req("input", input))
	if e != nil {
		t.Fatal(e)
	}
	var ev struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if e = json.Unmarshal(out[0], &ev); e != nil {
		t.Fatal(e)
	}
	if len(ev.Data) != 2 {
		t.Fatal("input event violates closed schema")
	}
	call := r.calls[len(r.calls)-1][1:]
	if !reflect.DeepEqual(call, []string{"input", "--container", binding.Container, "--window", "w1", "--click", "1,0", "--button", "1"}) {
		t.Fatalf("bad input argv %v", call)
	}
	n := len(r.calls)
	if _, e = m.Handle(context.Background(), req("input", `{"surface_id":"`+id+`","proposal_id":"p2","action":{"type":"click","x":2,"y":0,"button":"left"}}`)); e == nil || len(r.calls) != n {
		t.Fatal("out of bounds input executed")
	}
	r.output = []byte(`{"surface_id":"w1","kind":"click","input_mono_ns":200,"focus_verified":false,"result":"ok"}`)
	if _, e = m.Handle(context.Background(), req("input", input)); e == nil {
		t.Fatal("unfocused receipt accepted")
	}
	f := NativeFrame{Path: binding.FramesRoot + "/f.png", Seq: 1, SHA256RGB24: "0000000000000000000000000000000000000000000000000000000000000000", Width: 2, Height: 1, CaptureMonoNS: 200, Generation: binding.Container, Window: &Window{ID: "w1", W: 2, H: 1}}
	r.output, _ = json.Marshal(f)
	_, got, e := m.Capture(context.Background(), id)
	if e != nil || got.TSNS != 100 {
		t.Fatalf("clock mapping: %v", e)
	}
	f.Generation = "srf-id-other"
	r.output, _ = json.Marshal(f)
	if _, _, e = m.Capture(context.Background(), id); e == nil {
		t.Fatal("cross-container capture accepted")
	}
	f.Generation = binding.Container
	f.CaptureMonoNS = 99
	r.output, _ = json.Marshal(f)
	if _, _, e = m.Capture(context.Background(), id); e == nil {
		t.Fatal("negative session stamp accepted")
	}
}
func TestCorrelatedError(t *testing.T) {
	r := &scriptRunner{output: []byte(`{`)}
	m := testManager(t, r)
	out, e := m.HandleFor(context.Background(), "reserved-id", req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":2,"h":1}}`))
	if e != nil || len(out) != 1 {
		t.Fatal("missing correlated refusal")
	}
	var ev ErrorEvent
	if e = json.Unmarshal(out[0], &ev); e != nil {
		t.Fatal(e)
	}
	if ev.Event != "error" || ev.Schema != "surface_event/v0.2" || ev.Data.SurfaceID != "reserved-id" || len(m.bindings) != 0 {
		t.Fatal("malformed native output did not refuse")
	}
}

func TestRealFrameReplyGeometry(t *testing.T) {
	r := &scriptRunner{output: []byte(`{"container":"srf-id-demo","run_id":"demo-run","windows":[{"id":"w1","x":0,"y":0,"w":1280,"h":900,"title":"","url":""}]}`)}
	m := testManager(t, r)
	p := m.cfg.Profiles["demo"]
	p.Width, p.Height = 1280, 900
	m.cfg.Profiles["demo"] = p
	if _, e := m.Handle(context.Background(), req("create", `{"kind":"browser","profile_id":"demo","geometry":{"w":1280,"h":900}}`)); e != nil {
		t.Fatal(e)
	}
	var id string
	for key := range m.bindings {
		id = key
	}
	// Real CLI shape: PNG path, RGB24 hash, container generation and resized window.
	const reply = `{"path":"/dev/shm/demo-run/frames/w1/f000004.png","seq":4,"sha256_rgb24":"71b4000000000000000000000000000000000000000000000000000000000000","width":1280,"height":720,"capture_mono_ns":200,"generation":"srf-id-demo","window":{"id":"w1","x":0,"y":0,"w":1280,"h":720,"title":"MetaViewer","url":""}}`
	r.output = []byte(reply)
	if _, f, e := m.Capture(context.Background(), id); e != nil || f.Height != 720 {
		t.Fatalf("documented reply refused: %v", e)
	}
	var f NativeFrame
	if e := json.Unmarshal([]byte(reply), &f); e != nil {
		t.Fatal(e)
	}
	for _, mutate := range []func(*NativeFrame){
		func(f *NativeFrame) { f.Generation = "srf-id-other" },
		func(f *NativeFrame) { f.Width = 1281; f.Window.W = 1281 },
		func(f *NativeFrame) { f.Height = 901; f.Window.H = 901 },
		func(f *NativeFrame) { f.CaptureMonoNS = 199 },
		func(f *NativeFrame) { f.Path = "/dev/shm/other/frames/w1/f000004.png" },
		func(f *NativeFrame) { f.Window.ID = "w2" },
	} {
		bad := f
		window := *f.Window
		bad.Window = &window
		mutate(&bad)
		r.output, _ = json.Marshal(bad)
		if _, _, e := m.Capture(context.Background(), id); e == nil {
			t.Fatal("invalid frame accepted")
		}
	}
}
