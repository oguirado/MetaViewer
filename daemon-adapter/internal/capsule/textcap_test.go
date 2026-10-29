package capsule

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

// This fake models the pinned native limit, independently of adapter constants.
type textCapRunner struct {
	chunks    []string
	failAt    int
	badAt     int
	afterCall func(int)
}

func (r *textCapRunner) Run(_ context.Context, args []string, stdin []byte) ([]byte, error) {
	if args[1] != "input" {
		return []byte(startOK), nil
	}
	r.chunks = append(r.chunks, string(stdin))
	n := len(r.chunks)
	if !utf8.Valid(stdin) || utf8.RuneCount(stdin) > 2000 || n == r.failAt {
		return nil, errors.New("native text refused")
	}
	if !reflect.DeepEqual(args[2:], []string{"--container", "srf-id-demo", "--window", "w1", "--type-stdin"}) {
		return nil, fmt.Errorf("unexpected text arguments: %q", args)
	}
	if r.afterCall != nil {
		r.afterCall(n)
	}
	focus := n != r.badAt
	return []byte(fmt.Sprintf(`{"surface_id":"w1","kind":"text","input_mono_ns":200,"focus_verified":%t,"result":"ok"}`, focus)), nil
}
func textRequest(id, text string) Request {
	params, _ := json.Marshal(map[string]any{"surface_id": id, "proposal_id": "text", "action": map[string]string{"type": "type", "text": text}})
	return req("input", string(params))
}
func textManager(t *testing.T, r *textCapRunner) (*Manager, string) {
	m := testManager(t, &scriptRunner{})
	m.runner = r
	m.cfg.MaxOutputBytes = 128 * 1024
	return m, createID(t, m)
}
func TestTextCapBoundaries(t *testing.T) {
	for _, n := range []int{2000, 2001, 16384, 16385} {
		for _, runeText := range []string{"a", "界", "🙂"} {
			t.Run(fmt.Sprintf("%d-%s", n, runeText), func(t *testing.T) {
				r := &textCapRunner{}
				m, id := textManager(t, r)
				text := strings.Repeat(runeText, n)
				// Stay inside the existing transport string cap while testing
				// oversized rune admission with four-byte Unicode text.
				if n == 16385 && runeText == "🙂" {
					text = strings.Repeat(runeText, n-4) + "abcd"
				}
				events, evidence, err := m.HandleInputWithEvidence(context.Background(), textRequest(id, text))
				if n > 16384 {
					requireFault(t, err, "TEXT_TOO_LONG")
					if len(r.chunks) != 0 || len(m.used) != 0 || len(events) != 0 || evidence != (InputEvidence{}) {
						t.Fatal("oversize proposal dispatched or consumed permit")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if len(events) != 1 || len(r.chunks) != (n+1999)/2000 || strings.Join(r.chunks, "") != text {
					t.Fatalf("delivery mismatch: events=%d chunks=%d", len(events), len(r.chunks))
				}
				if evidence.InputMonoNS != 200 || evidence.Result != "ok" {
					t.Fatalf("missing final evidence: %+v", evidence)
				}
				if len(r.chunks) == 1 {
					if evidence.TextSequence != nil {
						t.Fatal("single call evidence changed")
					}
					return
				}
				wire, marshalErr := json.Marshal(evidence)
				if marshalErr != nil || strings.Contains(string(wire), "text_sequence") || strings.Contains(string(wire), "chunks") {
					t.Fatalf("adapter-local proof leaked into closed wire evidence: %s %v", wire, marshalErr)
				}
				if evidence.TextSequence == nil || len(evidence.TextSequence.Chunks) != len(r.chunks) {
					t.Fatal("sequence proof missing")
				}
				for i, c := range r.chunks {
					proof := evidence.TextSequence.Chunks[i]
					digest := sha256.Sum256([]byte(c))
					if proof.Runes != utf8.RuneCountInString(c) || proof.Runes > 2000 || proof.SHA256 != hex.EncodeToString(digest[:]) || proof.SurfaceID != "w1" || proof.Kind != "text" || proof.InputMonoNS == nil || *proof.InputMonoNS != 200 || proof.FocusVerified == nil || !*proof.FocusVerified || proof.Result != "ok" {
						t.Fatalf("chunk %d proof mismatch: %+v", i, proof)
					}
				}
				calls := len(r.chunks)
				if _, _, err = m.HandleInputWithEvidence(context.Background(), textRequest(id, text)); err == nil || len(r.chunks) != calls {
					t.Fatal("proposal replay admitted")
				}
			})
		}
	}
}
func TestTextSequenceStopsWithoutSuccess(t *testing.T) {
	for _, mode := range []string{"native-error", "unverified", "cancelled", "takeover"} {
		t.Run(mode, func(t *testing.T) {
			r := &textCapRunner{}
			m, id := textManager(t, r)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch mode {
			case "native-error":
				r.failAt = 2
			case "unverified":
				r.badAt = 2
			case "cancelled":
				r.afterCall = func(int) { cancel() }
			case "takeover":
				r.afterCall = func(int) {
					m.mu.Lock()
					defer m.mu.Unlock()
					for _, p := range m.pending {
						p.cancelled = true
						p.cancel()
					}
				}
			}
			events, proof, err := m.HandleInputWithEvidence(ctx, textRequest(id, strings.Repeat("x", 4001)))
			wantCalls := 2
			if mode == "cancelled" || mode == "takeover" {
				wantCalls = 1
			}
			if err == nil || len(events) != 0 || proof != (InputEvidence{}) || len(r.chunks) != wantCalls {
				t.Fatalf("sequence failure produced success or continued: %v %+v calls=%d", err, proof, len(r.chunks))
			}
		})
	}
}
func TestTextCapPassThroughMutantRejected(t *testing.T) {
	r := &textCapRunner{}
	if _, err := r.Run(context.Background(), []string{"srf-identity-surface", "input"}, []byte(strings.Repeat("x", 2001))); err == nil {
		t.Fatal("native fake accepted old oversized pass-through")
	}
}
func TestTextRejectsNativeUnprintableRunes(t *testing.T) {
	for _, text := range []string{"x\n", "x\t", "x\x00"} {
		r := &textCapRunner{}
		m, id := textManager(t, r)
		_, _, err := m.HandleInputWithEvidence(context.Background(), textRequest(id, text))
		requireFault(t, err, "input")
		if len(r.chunks) != 0 {
			t.Fatal("undeliverable text dispatched")
		}
	}
}
