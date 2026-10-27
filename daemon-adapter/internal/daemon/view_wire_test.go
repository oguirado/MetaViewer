package daemon

import (
	"encoding/json"
	"testing"
)

// The frozen surface_request union does not admit operator-view operations.
// Mutation: let policy.ValidateEnvelope accept unknown op values; refusals fail.
// This is an admission-boundary test, not proof of a configured view route.
func TestViewWireContractBoundary(t *testing.T) {
	nvEnvironment(t)
	r, err := RuntimeFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	e := r.Registration
	e.From, e.To = e.To, e.From
	validate := func(op string, params any) error {
		body, err := json.Marshal(map[string]any{"schema": "surface_request/v0.2", "op": op, "params": params})
		if err != nil {
			t.Fatal(err)
		}
		e.Body = body
		raw, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		_, err = r.Policy.ValidateEnvelope(raw)
		return err
	}
	if err := validate("list", map[string]any{}); err != nil {
		t.Fatalf("admitted list refused: %v", err)
	}
	for _, op := range []string{"view", "view-stop", "login", "screenshot"} {
		if err := validate(op, map[string]string{"surface_id": "srf-id-demo"}); err == nil {
			t.Fatalf("uncontracted %s reached wire authority", op)
		}
	}
}
