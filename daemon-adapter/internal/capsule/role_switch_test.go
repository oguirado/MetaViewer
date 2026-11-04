package capsule

import (
	"context"
	"errors"
	"testing"
)

func TestRoleSwitchKeepsNativeLifetimeAndFencesFrames(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	id := createID(t, m)
	original := m.bindings[id]
	before := len(r.calls)
	for _, role := range []string{"human", "agent", "human", "agent"} {
		oldEpoch := m.inputEpochs[id]
		surface, err := m.SwitchRole(context.Background(), id, role)
		if err != nil {
			t.Fatal(err)
		}
		b := m.bindings[id]
		if surface.SurfaceID != id || b.Container != original.Container || b.RunID != original.RunID || b.Surface.ProfileID != original.Surface.ProfileID || b.Role != role || b.Surface.Control != role {
			t.Fatal("role switch replaced or misbound native surface")
		}
		if m.inputEpochs[id] <= oldEpoch {
			t.Fatal("role switch did not fence old input/capture")
		}
		if role == "agent" && !m.refresh[id] {
			t.Fatal("agent role did not require fresh capture")
		}
		if len(r.calls) != before {
			t.Fatal("role switch started or stopped native runtime")
		}
	}
}

func TestRoleSwitchRefusesBusyOrUnsupportedWithoutMutation(t *testing.T) {
	for _, refusal := range []string{"pending", "destroying", "lost", "vm", "host-window", "host-xpra", "bad-role"} {
		t.Run(refusal, func(t *testing.T) {
			r := &scriptRunner{output: []byte(startOK)}
			m := testManager(t, r)
			id := createID(t, m)
			role := "human"
			switch refusal {
			case "pending":
				m.pending["work"] = &pendingInput{surface: id}
			case "destroying":
				m.destroying[id] = true
			case "lost":
				b := m.bindings[id]
				b.Surface.State = "lost"
				m.bindings[id] = b
			case "vm", "host-window", "host-xpra":
				b := m.bindings[id]
				b.NativeKind = refusal
				m.bindings[id] = b
			case "bad-role":
				role = "shared"
			}
			old := m.bindings[id]
			epoch := m.inputEpochs[id]
			calls := len(r.calls)
			if _, err := m.SwitchRole(context.Background(), id, role); err == nil {
				t.Fatal("unsafe role switch accepted")
			}
			if m.bindings[id].Role != old.Role || m.bindings[id].Surface != old.Surface || m.inputEpochs[id] != epoch || len(r.calls) != calls {
				t.Fatal("refusal changed authority")
			}
		})
	}
}

type roleBindingRunner struct {
	scriptRunner
	fail      bool
	published []Binding
}

func (r *roleBindingRunner) PublishHumanBinding(b Binding, _ bool, _ uint64) error {
	if r.fail {
		return errors.New("export refused")
	}
	r.published = append(r.published, b)
	return nil
}
func TestRoleSwitchPublishesBindingBeforeCommitAndRollsBackFailure(t *testing.T) {
	r := &roleBindingRunner{scriptRunner: scriptRunner{output: []byte(startOK)}}
	m := testManager(t, &r.scriptRunner)
	m.runner = r
	id := createID(t, m)
	r.fail = true
	before := m.bindings[id]
	epoch := m.inputEpochs[id]
	if _, err := m.SwitchRole(context.Background(), id, "human"); err == nil {
		t.Fatal("binding failure hidden")
	}
	if m.bindings[id].Role != before.Role || m.inputEpochs[id] != epoch {
		t.Fatal("failed binding export changed role")
	}
	r.fail = false
	if _, err := m.SwitchRole(context.Background(), id, "human"); err != nil {
		t.Fatal(err)
	}
	if len(r.published) == 0 || r.published[len(r.published)-1].Role != "human" {
		t.Fatal("new host binding absent")
	}
	if _, err := m.Handle(context.Background(), req("release_control", `{"surface_id":"`+id+`"}`)); err == nil {
		t.Fatal("legacy human role became mutable")
	}
}
