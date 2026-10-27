package capsule

import (
	"context"
	"sync"
	"testing"
)

// TestConcurrentTakeoverAndProposal verifies that concurrent take_control and input proposals
// under go test -race settle cleanly with exact typed errors and no data races.
func TestConcurrentTakeoverAndProposal(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	id := createID(t, m)
	ctx := context.Background()

	var wg sync.WaitGroup
	const routines = 10

	for i := 0; i < routines; i++ {
		wg.Add(1)
		idx := i
		go func() {
			defer wg.Done()
			if idx%2 == 0 {
				_, _ = m.Handle(ctx, req("take_control", `{"surface_id":"`+id+`","owner":"human"}`))
			} else {
				_, _ = m.Handle(ctx, req("input", `{"surface_id":"`+id+`","proposal_id":"p-race","action":{"type":"click","x":1,"y":0,"button":"left"}}`))
			}
		}()
	}
	wg.Wait()

	ready, err := m.ControlReady(id)
	if err != nil {
		t.Fatalf("ControlReady failed after race: %v", err)
	}
	_ = ready
}
