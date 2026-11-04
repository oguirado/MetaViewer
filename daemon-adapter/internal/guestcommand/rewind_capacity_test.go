package guestcommand

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/ipc"
)

func capacityHistory(r *RewindManager, count int) {
	for i := 0; i < count; i++ {
		id := fmt.Sprintf("request-history-%d", i)
		r.pending[id] = &pending{op: "pause", accepted: true, done: true}
		r.families[id] = "rewind_request/v0.2"
		r.plans[id] = rewindPlan{Generation: 1, Epoch: 1, Phase: "paused"}
	}
}

func capacityRequest(id, family, op, workload string, generation int) json.RawMessage {
	params := map[string]any{"workload_id": workload, "generation": generation}
	if family == "rewind_request/v0.2" {
		params["authority_epoch"] = 1
	}
	b, _ := json.Marshal(map[string]any{"schema": family, "request_id": id, "op": op, "params": params})
	return b
}

func capacityRefusal(t *testing.T, out []json.RawMessage, err error, code string) {
	t.Helper()
	if err != nil || len(out) != 1 {
		t.Fatalf("expected %s refusal, got %s / %v", code, out, err)
	}
	var event struct{ Data struct{ Code string } }
	if json.Unmarshal(out[0], &event) != nil || event.Data.Code != code {
		t.Fatalf("expected %s refusal, got %s", code, out[0])
	}
}

func TestRewindCapacityReservesStopWithoutDiscardingHistory(t *testing.T) {
	r, child := rewindFixture(t)
	capacityHistory(r, 255)
	resume := capacityRequest("request-resume-full", "rewind_request/v0.2", "resume", r.workload, 1)
	out, err := r.Handle(context.Background(), resume, r.sessionID, r.validate, r.emit)
	capacityRefusal(t, out, err, "CAPACITY")
	if len(r.pending) != 255 || len(r.families) != 255 || len(r.plans) != 255 || len(child.sent) != 0 {
		t.Fatal("capacity refusal mutated history or dispatched")
	}
	stop := capacityRequest("request-stop-full", "guest_command_request/v0.2", "stop", r.workload, 1)
	if out, err = r.Handle(context.Background(), stop, r.sessionID, r.validate, r.emit); err != nil || len(out) != 0 || len(child.sent) != 1 || len(r.pending) != 256 {
		t.Fatalf("reserved Stop not dispatched once: %s / %v", out, err)
	}
	out, err = r.Handle(context.Background(), stop, r.sessionID, r.validate, r.emit)
	capacityRefusal(t, out, err, "DUPLICATE")
	fresh := capacityRequest("request-stop-again", "guest_command_request/v0.2", "stop", r.workload, 1)
	out, err = r.Handle(context.Background(), fresh, r.sessionID, r.validate, r.emit)
	capacityRefusal(t, out, err, "CAPACITY")
	for _, p := range r.pending {
		p.done = true
	}
	out, err = r.Handle(context.Background(), stop, r.sessionID, r.validate, r.emit)
	capacityRefusal(t, out, err, "DUPLICATE")
	if len(child.sent) != 1 || len(r.pending) != 256 {
		t.Fatal("Stop replay or history eviction")
	}
}

func TestRewindCapacityStopStillRequiresSessionAndTarget(t *testing.T) {
	r, child := rewindFixture(t)
	capacityHistory(r, 255)
	stop := capacityRequest("request-stop", "guest_command_request/v0.2", "stop", r.workload, 1)
	if _, err := r.Handle(context.Background(), stop, "foreign", r.validate, r.emit); err == nil {
		t.Fatal("foreign session used reserved Stop")
	}
	for _, body := range []json.RawMessage{
		capacityRequest("request-stale", "guest_command_request/v0.2", "stop", r.workload, 2),
		capacityRequest("request-foreign", "guest_command_request/v0.2", "stop", "workload-foreign", 1),
	} {
		out, err := r.Handle(context.Background(), body, r.sessionID, r.validate, r.emit)
		capacityRefusal(t, out, err, "STALE")
	}
	forged := capacityRequest("request-crossed", "rewind_request/v0.2", "stop", r.workload, 1)
	out, err := r.Handle(context.Background(), forged, r.sessionID, r.validate, r.emit)
	capacityRefusal(t, out, err, "CAPACITY")
	if len(r.pending) != 255 || len(child.sent) != 0 {
		t.Fatal("invalid target consumed reserved Stop")
	}
}

// Validation is the real production policy; authority methods must not run
// during the pure envelope-validation stage exercised here.
type capacityAuthority struct{}

func (capacityAuthority) Authenticate(context.Context, ipc.PeerCredentials, ipc.Envelope) error {
	return errors.New("unexpected authentication effect")
}
func (capacityAuthority) Reserve(context.Context, ipc.SenderKey, uint64, string) error {
	return errors.New("unexpected reservation effect")
}
func (capacityAuthority) Wrap(context.Context, ipc.Envelope, json.RawMessage) (ipc.Envelope, error) {
	return ipc.Envelope{}, errors.New("unexpected wrapping effect")
}

func TestRewindCapacityMalformedStopFailsCanonicalPolicy(t *testing.T) {
	cfg := ipc.Config{SocketPath: "unused.sock", MaxFrameBytes: 1048576, MaxDepth: 32, MaxStringBytes: 65536, MaxKeys: 256, MaxArrayItems: 4096, MaxReplayEntries: 256, MaxConnections: 1, HelloTimeout: time.Second, ReadTimeout: time.Second, WriteTimeout: time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second}
	policy, err := ipc.NewPolicy(cfg, os.DirFS("../../../contracts/v0.2"), capacityAuthority{})
	if err != nil {
		t.Fatal(err)
	}
	r, child := rewindFixture(t)
	capacityHistory(r, 255)
	body := capacityRequest("request-policy-stop", "guest_command_request/v0.2", "stop", r.workload, 1)
	env := ipc.Envelope{Schema: "capsule_envelope/v0.2", MsgID: "message-test", TsNS: 1, From: ipc.Endpoint{Component: "agent", Instance: "agent-test"}, To: ipc.Endpoint{Component: "core", Instance: "core-test"}, SessionID: r.sessionID, Seq: 1, Nonce: "nonce-test", Body: body}
	raw, _ := json.Marshal(env)
	if _, err := policy.ValidateEnvelope(raw); err != nil {
		t.Fatalf("nominal Stop rejected: %v", err)
	}
	for _, mutate := range []func(map[string]any){
		func(b map[string]any) { b["extra"] = true },
		func(b map[string]any) { delete(b["params"].(map[string]any), "generation") },
		func(b map[string]any) { b["params"].(map[string]any)["generation"] = true },
		func(b map[string]any) { b["schema"] = "rewind_request/v0.2" },
	} {
		var value map[string]any
		_ = json.Unmarshal(body, &value)
		mutate(value)
		env.Body, _ = json.Marshal(value)
		raw, _ = json.Marshal(env)
		if validated, err := policy.ValidateEnvelope(raw); err == nil {
			_, _ = r.Handle(context.Background(), validated.Body, r.sessionID, r.validate, r.emit)
			t.Fatal("malformed Stop reached owner")
		}
	}
	if len(r.pending) != 255 || len(child.sent) != 0 {
		t.Fatal("malformed Stop consumed history")
	}
}

type capacityCloseProcess struct {
	*fakeProcess
	closes    int
	intent    string
	sawIntent bool
}

func (p *capacityCloseProcess) Close(ctx context.Context) error {
	p.closes++
	_, err := os.Stat(p.intent)
	p.sawIntent = err == nil
	return p.fakeProcess.Close(ctx)
}

func TestRewindCapacityPoisonedStopRetainsDurableOneShot(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(fmt.Sprint(failed), func(t *testing.T) {
			r, child := rewindFixture(t)
			capacityHistory(r, 255)
			r.poisoned = true
			r.session, _ = json.Marshal(session(r.Manager, "ready", "held"))
			if failed {
				child.closeErr = errors.New("synthetic close uncertainty")
			}
			probe := &capacityCloseProcess{fakeProcess: child, intent: r.reservation + ".reconcile"}
			r.child = probe
			stop := capacityRequest("request-reconcile", "guest_command_request/v0.2", "stop", r.workload, 1)
			out, err := r.Handle(context.Background(), stop, r.sessionID, r.validate, r.emit)
			if (err != nil) != failed || probe.closes != 1 || !probe.sawIntent || len(r.pending) != 256 {
				t.Fatalf("reconcile Stop lost: %s / %v / %d closes", out, err, probe.closes)
			}
			if _, err := os.Stat(r.reservation + ".reconcile"); err != nil {
				t.Fatal("durable Stop intent missing")
			}
			if failed && (r.child == nil || !r.poisoned || r.pending["request-reconcile"].done) {
				t.Fatal("uncertain close falsely released")
			}
			if !failed && (r.child != nil || !r.pending["request-reconcile"].done || len(out) != 1) {
				t.Fatal("known close not completed")
			}
			_, _ = r.Handle(context.Background(), stop, r.sessionID, r.validate, r.emit)
			fresh := capacityRequest("request-reconcile-again", "guest_command_request/v0.2", "stop", r.workload, 1)
			out, err = r.Handle(context.Background(), fresh, r.sessionID, r.validate, r.emit)
			capacityRefusal(t, out, err, "CAPACITY")
			if probe.closes != 1 {
				t.Fatal("uncertain Stop replayed")
			}
		})
	}
}
