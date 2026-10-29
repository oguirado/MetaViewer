package capsule

import (
	"context"
	"errors"
	"testing"
)

func TestResidentClockAndInputEpoch(t *testing.T) {
	for _, name := range []string{"valid", "before session", "future", "epoch", "error", "pending"} {
		t.Run(name, func(t *testing.T) {
			r := &scriptRunner{output: []byte(startOK)}
			m := testManager(t, r)
			id := createID(t, m)
			expected := errors.New("typed ring refusal")
			read := false
			if name == "pending" {
				m.pending["input"] = &pendingInput{surface: id}
			}
			_, f, err := m.CaptureResident(context.Background(), id, func(Binding) (NativeFrame, error) {
				read = true
				mono := uint64(150)
				switch name {
				case "before session":
					mono = 99
				case "future":
					mono = 201
				case "epoch":
					m.mu.Lock()
					m.nextInputEpoch(id)
					m.mu.Unlock()
				case "error":
					return NativeFrame{}, expected
				}
				return NativeFrame{CaptureMonoNS: mono}, nil
			})
			if name == "valid" {
				if err != nil || f.TSNS != 50 {
					t.Fatalf("%+v %v", f, err)
				}
			} else if err == nil {
				t.Fatal("resident gate accepted invalid capture")
			}
			if name == "error" && !errors.Is(err, expected) {
				t.Fatal("refusal replaced")
			}
			if name == "pending" && read {
				t.Fatal("read during pending input")
			}
			if len(r.calls) != 1 {
				t.Fatal("resident capture invoked CLI")
			}
		})
	}
}

func TestResidentVerifiedStopRecovery(t *testing.T) {
	for _, verified := range []bool{false, true} {
		t.Run(map[bool]string{false: "uncertain", true: "verified"}[verified], func(t *testing.T) {
			r := &scriptRunner{output: []byte(startOK)}
			m := testManager(t, r)
			id := createID(t, m)
			b := m.bindings[id]
			r.output = []byte(`{"stopped":"` + b.Container + `","removed_verified":false}`)
			if verified {
				r.output = []byte(`{"stopped":"` + b.Container + `","removed_verified":true}`)
			}
			err := m.RefuseResident(context.Background(), b)
			if !verified {
				if err == nil || !m.quarantined[b.Surface.ProfileID] {
					t.Fatal("unverified stop released quarantine")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if m.quarantined[b.Surface.ProfileID] || m.bindings[id].Surface.State != "destroyed" {
				t.Fatal("M-STOP-QUARANTINE")
			}
			r.output = []byte(startOK)
			createID(t, m)
		})
	}
}
