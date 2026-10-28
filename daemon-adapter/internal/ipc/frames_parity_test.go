package ipc

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
)

type parityFixture struct {
	Schema           string            `json:"schema"`
	ContractVersion  string            `json:"contract_version"`
	EnvelopeTemplate map[string]any    `json:"envelope_template"`
	Vectors          []parityVectorRow `json:"vectors"`
}

type parityVectorRow struct {
	ID              string            `json:"id"`
	Family          string            `json:"family"`
	Axis            string            `json:"axis"`
	ContractVerdict string            `json:"contract_verdict"`
	Findings        map[string]string `json:"findings"`
	Payload         json.RawMessage   `json:"payload"`
}

func loadFramesParityFixture(t *testing.T) parityFixture {
	t.Helper()
	raw, err := os.ReadFile("../../../tests/fixtures/frames_parity.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture parityFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Schema != "metaviewer.frames_parity/v1" || fixture.ContractVersion != "v0.2" {
		t.Fatalf("unexpected fixture header: schema=%q version=%q", fixture.Schema, fixture.ContractVersion)
	}
	if len(fixture.Vectors) != 26 {
		t.Fatalf("expected 26 parity vectors, got %d", len(fixture.Vectors))
	}
	return fixture
}

func wrapParityEnvelope(t *testing.T, template map[string]any, payload json.RawMessage) []byte {
	t.Helper()
	env := make(map[string]any, len(template)+1)
	for k, v := range template {
		env[k] = v
	}
	env["body"] = payload
	wire, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	return wire
}

func runGoPolicySuite(t *testing.T, p *SchemaPolicy, fixture parityFixture) (skipped []string, failures []string) {
	t.Helper()
	for _, vec := range fixture.Vectors {
		expectedAccept := vec.ContractVerdict == "accept"
		wire := wrapParityEnvelope(t, fixture.EnvelopeTemplate, vec.Payload)
		_, err := p.ValidateEnvelope(wire)
		actualAccept := err == nil

		if finding, ok := vec.Findings["go_policy"]; ok {
			if !strings.HasPrefix(finding, "FINDING ") {
				t.Fatalf("invalid finding tag %q on %s", finding, vec.ID)
			}
			if actualAccept == expectedAccept {
				failures = append(failures, fmt.Sprintf("%s: marked skipped with %s, but SchemaPolicy now matches contract_verdict=%s", vec.ID, finding, vec.ContractVerdict))
			} else {
				skipped = append(skipped, vec.ID+":"+finding)
			}
			continue
		}
		if actualAccept != expectedAccept {
			failures = append(failures, fmt.Sprintf("%s: expected contract_verdict=%s, got accept=%v (err=%v)", vec.ID, vec.ContractVerdict, actualAccept, err))
		}
	}
	return skipped, failures
}

func TestFramesParityVectors(t *testing.T) {
	fixture := loadFramesParityFixture(t)
	policy, err := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}

	for _, vec := range fixture.Vectors {
		vec := vec
		t.Run("policy/"+vec.ID, func(t *testing.T) {
			expectedAccept := vec.ContractVerdict == "accept"
			wire := wrapParityEnvelope(t, fixture.EnvelopeTemplate, vec.Payload)
			_, err := policy.ValidateEnvelope(wire)
			actualAccept := err == nil

			if finding, ok := vec.Findings["go_policy"]; ok {
				if actualAccept == expectedAccept {
					t.Fatalf("%s resolved on %s; remove skip", finding, vec.ID)
				}
				t.Skipf("%s: Go SchemaPolicy diverges from contract verdict %s on %s", finding, vec.ContractVerdict, vec.ID)
			}
			if actualAccept != expectedAccept {
				t.Fatalf("%s: expected contract_verdict=%s, got accept=%v (err=%v)", vec.ID, vec.ContractVerdict, actualAccept, err)
			}
		})

		for _, key := range []string{"go_publisher_sha", "go_record_capture", "go_daemon_list_snapshots"} {
			if finding, ok := vec.Findings[key]; ok {
				key, finding := key, finding
				t.Run(key+"/"+vec.ID, func(t *testing.T) {
					t.Skipf("%s: Go non-policy path (%s) diverges from contract verdict %s on %s", finding, key, vec.ContractVerdict, vec.ID)
				})
			}
		}
	}
}

func mutateFrameRefSHA256Pattern(root *schemaNode, re *regexp.Regexp) int {
	visited := map[*schemaNode]bool{}
	count := 0
	var walk func(n *schemaNode)
	walk = func(n *schemaNode) {
		if n == nil || visited[n] {
			return
		}
		visited[n] = true
		if n.props != nil {
			if schemaProp := n.props["schema"]; schemaProp != nil && schemaProp.constant == "frame_ref/v0.2" {
				if shaProp := n.props["sha256"]; shaProp != nil {
					shaProp.pattern = re
					count++
				}
			}
			for _, child := range n.props {
				walk(child)
			}
		}
		if n.ref != nil {
			walk(n.ref)
		}
		if n.items != nil {
			walk(n.items)
		}
		for _, ch := range n.choices {
			walk(ch)
		}
	}
	walk(root)
	return count
}

func TestFramesParityKillsMutatedGoPolicy(t *testing.T) {
	// Mutation in daemon-adapter/internal/ipc/policy.go:220/401:
	// compiling the frame_ref.sha256 regex case-insensitively `(?i)^[0-9a-f]{64}$`
	// so uppercase SHA-256 digests are accepted.
	fixture := loadFramesParityFixture(t)
	mutatedPolicy, err := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	patched := mutateFrameRefSHA256Pattern(mutatedPolicy.envelope, regexp.MustCompile(`(?i)^[0-9a-f]{64}$`))
	if patched == 0 {
		t.Fatal("failed to locate frame_ref/v0.2 sha256 schemaNode for mutation")
	}
	_, failures := runGoPolicySuite(t, mutatedPolicy, fixture)
	killed := false
	for _, f := range failures {
		if strings.HasPrefix(f, "frame_ref_invalid_sha256_upper:") {
			killed = true
			break
		}
	}
	if !killed {
		t.Fatalf("expected mutated Go SchemaPolicy to be killed by frame_ref_invalid_sha256_upper, got failures=%v", failures)
	}
}
