package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func ceilingConfig() Config {
	c := testConfig("unused.sock")
	c.MaxFrameBytes, c.MaxDepth, c.MaxStringBytes, c.MaxKeys, c.MaxArrayItems = 1048576, 32, 65536, 256, 4096
	return c
}
func TestFrozenCeilings(t *testing.T) {
	c := ceilingConfig()
	if e := c.Validate(); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 5; i++ {
		b := c
		switch i {
		case 0:
			b.MaxFrameBytes++
		case 1:
			b.MaxDepth++
		case 2:
			b.MaxStringBytes++
		case 3:
			b.MaxKeys++
		case 4:
			b.MaxArrayItems++
		}
		if b.Validate() == nil {
			t.Errorf("ceiling %d bypassed", i)
		}
	}
}

const (
	minContractFixtureCount = 475
	minContractEntryCount   = 476
	minContractSchemaCount  = 20
)

func verifyContractFixtureCorpus(examplesDir, schemasDir string) ([]string, error) {
	entries, err := os.ReadDir(examplesDir)
	if err != nil {
		return nil, err
	}
	files, err := filepath.Glob(filepath.Join(examplesDir, "*.json"))
	if err != nil {
		return nil, err
	}
	schemas, err := filepath.Glob(filepath.Join(schemasDir, "*.schema.json"))
	if err != nil {
		return nil, err
	}
	if len(entries) < minContractEntryCount || len(files) < minContractFixtureCount || len(schemas) < minContractSchemaCount {
		return nil, fmt.Errorf("fixture corpus shrunk: entries=%d files=%d schemas=%d", len(entries), len(files), len(schemas))
	}
	for _, s := range schemas {
		prefix := strings.TrimSuffix(filepath.Base(s), ".schema.json")
		hasValid, hasInvalid := false, false
		for _, f := range files {
			base := filepath.Base(f)
			if strings.HasPrefix(base, prefix+".valid.") {
				hasValid = true
			}
			if strings.HasPrefix(base, prefix+".invalid.") {
				hasInvalid = true
			}
		}
		if !hasValid || !hasInvalid {
			return nil, fmt.Errorf("schema %s missing valid (%v) or invalid (%v) fixture", prefix, hasValid, hasInvalid)
		}
	}
	return files, nil
}

func TestProductionEnvelopePolicy(t *testing.T) {
	p, err := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../contracts/examples/v0.2/envelope.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]any
	if err = json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	files, err := verifyContractFixtureCorpus("../../../contracts/examples/v0.2", "../../../contracts/v0.2")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		t.Run(filepath.Base(file), func(t *testing.T) {
			body, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			var value any
			if err = json.Unmarshal(body, &value); err != nil {
				t.Fatal(err)
			}
			wire := body
			if !strings.HasPrefix(filepath.Base(file), "envelope.") {
				envelope["body"] = value
				wire, err = json.Marshal(envelope)
				if err != nil {
					t.Fatal(err)
				}
			}
			_, err = p.ValidateEnvelope(wire)
			if strings.Contains(file, ".valid.") && err != nil {
				t.Fatal(err)
			}
			if strings.Contains(file, ".invalid.") && err == nil {
				t.Fatal("invalid body admitted")
			}
		})
	}
	for _, bad := range []string{string(raw) + `{}`, strings.Replace(string(raw), `"seq": 1`, `"seq": 0`, 1), strings.Replace(string(raw), `"seq": 1`, `"seq": 9007199254740992`, 1), strings.Replace(string(raw), `"seq": 1`, `"seq": 1,"seq": 2`, 1)} {
		if _, err = p.ValidateEnvelope([]byte(bad)); err == nil {
			t.Fatal("invalid envelope admitted")
		}
	}
}

func TestProductionPolicyBeforeReserve(t *testing.T) {
	for _, invalid := range []bool{false, true} {
		t.Run(fmt.Sprint(invalid), func(t *testing.T) {
			cfg := ceilingConfig()
			dir := t.TempDir()
			if err := os.Chmod(dir, 0700); err != nil {
				t.Fatal(err)
			}
			cfg.SocketPath = filepath.Join(dir, "s.sock")
			authority := &allowPolicy{}
			policy, err := NewPolicy(cfg, os.DirFS("../../../contracts/v0.2"), authority)
			if err != nil {
				t.Fatal(err)
			}
			handled := make(chan struct{}, 2)
			wire, _, cancel := startDispatch(t, cfg, policy, func(context.Context, Envelope) ([]json.RawMessage, error) { handled <- struct{}{}; return nil, nil })
			defer cancel()
			hello, err := os.ReadFile("../../../contracts/examples/v0.2/hello.valid.json")
			if err != nil {
				t.Fatal(err)
			}
			envelope := dispatchEnvelope(1, "hello/v0.2")
			envelope.MsgID = "message"
			envelope.Body = hello
			raw, err := json.Marshal(envelope)
			if err != nil {
				t.Fatal(err)
			}
			if err = wire.Write(context.Background(), raw); err != nil {
				t.Fatal(err)
			}
			select {
			case <-handled:
			case <-time.After(time.Second):
				t.Fatal("valid hello did not reach handler")
			}
			body, err := os.ReadFile("../../../contracts/examples/v0.2/surface_request.valid.json")
			if err != nil {
				t.Fatal(err)
			}
			if invalid {
				var obj map[string]any
				if err = json.Unmarshal(body, &obj); err != nil {
					t.Fatal(err)
				}
				obj["unknown"] = true
				body, err = json.Marshal(obj)
				if err != nil {
					t.Fatal(err)
				}
			}
			envelope.Seq = 2
			envelope.Nonce = "second"
			envelope.Body = body
			raw, err = json.Marshal(envelope)
			if err != nil {
				t.Fatal(err)
			}
			if err = wire.Write(context.Background(), raw); err != nil {
				t.Fatal(err)
			}
			if invalid {
				ctx, stop := context.WithTimeout(context.Background(), time.Second)
				defer stop()
				if _, err = wire.Read(ctx); !errors.Is(err, io.EOF) {
					t.Fatalf("invalid body connection not refused: %v", err)
				}
			} else {
				select {
				case <-handled:
				case <-time.After(time.Second):
					t.Fatal("valid body did not reach handler")
				}
			}
			cancel()
			authority.mu.Lock()
			defer authority.mu.Unlock()
			want := 2
			if invalid {
				want = 1
			}
			if len(authority.seen) != want {
				t.Fatalf("Reserve calls=%d want=%d", len(authority.seen), want)
			}
		})
	}
}

func TestProductionPolicyConfigurationRefusal(t *testing.T) {
	for _, raw := range []string{`{}`, `{"type":false}`, `{"type":"object","additionalProperties":true}`, `{"unsupported":true}`, `{"$ref":"https://example.org/schema"}`, `{"$ref":"envelope.schema.json"}`, `{"required":true}`, `{"pattern":"["}`} {
		source := fstest.MapFS{"envelope.schema.json": &fstest.MapFile{Data: []byte(raw)}}
		policy, err := NewPolicy(ceilingConfig(), source, &dummyPolicy{})
		if err == nil || policy != nil {
			t.Fatalf("invalid schema accepted: %s", raw)
		}
	}
	if _, err := NewPolicy(ceilingConfig(), nil, &dummyPolicy{}); err == nil {
		t.Fatal("missing corpus accepted")
	}
	if _, err := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), nil); err == nil {
		t.Fatal("missing authority accepted")
	}
}

func TestT6R2002IntegerLexemeStrictness(t *testing.T) {
	p, err := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../contracts/examples/v0.2/envelope.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	frameRef, err := os.ReadFile("../../../contracts/examples/v0.2/frame_ref.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	wrapBody := func(body string) []byte {
		var env map[string]any
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		env["body"] = json.RawMessage(`{"schema":"surface_event/v0.2","event":"frame_ready","data":{"frame_ref":` + body + `}}`)
		b, err := json.Marshal(env)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	for _, bad := range [][]byte{
		wrapBody(strings.Replace(string(frameRef), `"generation": 1`, `"generation": 1.0`, 1)),
		wrapBody(strings.Replace(string(frameRef), `"generation": 1`, `"generation": 1e3`, 1)),
		[]byte(strings.Replace(string(raw), `"seq": 1`, `"seq": 1.0`, 1)),
		[]byte(strings.Replace(string(raw), `"seq": 1`, `"seq": 1e3`, 1)),
	} {
		if _, err := p.ValidateEnvelope(bad); err == nil {
			t.Fatalf("non-integer lexeme admitted: %s", bad)
		}
	}
	// Negative control: integer lexemes 1 (positive) and -1 (signed integer schema) are admitted.
	if _, err := p.ValidateEnvelope(wrapBody(string(frameRef))); err != nil {
		t.Fatalf("valid integer lexeme 1 in frame_ref refused: %v", err)
	}
	if _, err := p.ValidateEnvelope(raw); err != nil {
		t.Fatalf("valid integer lexeme 1 refused: %v", err)
	}
	signedSchema := fstest.MapFS{
		"envelope.schema.json": &fstest.MapFile{Data: []byte(`{
			"type": "object",
			"additionalProperties": false,
			"required": ["schema", "body"],
			"properties": {
				"schema": {"type": "string", "const": "envelope/v0.2"},
				"body": {
					"oneOf": [{
						"type": "object",
						"additionalProperties": false,
						"required": ["delta"],
						"properties": {
							"delta": {"type": "integer", "minimum": -10, "maximum": 10}
						}
					}]
				}
			}
		}`)},
	}
	sp, err := NewPolicy(ceilingConfig(), signedSchema, &dummyPolicy{})
	if err != nil {
		t.Fatalf("signed integer schema failed to compile: %v", err)
	}
	if _, err := sp.ValidateEnvelope([]byte(`{"schema":"envelope/v0.2","body":{"delta":-1}}`)); err != nil {
		t.Fatalf("valid signed integer -1 refused: %v", err)
	}
	if _, err := sp.ValidateEnvelope([]byte(`{"schema":"envelope/v0.2","body":{"delta":-1.0}}`)); err == nil {
		t.Fatal("signed float -1.0 admitted as integer")
	}
}

func TestT6R2010NestedOpenAndEmptyOneOfRefused(t *testing.T) {
	nestedOpen := fstest.MapFS{
		"envelope.schema.json": &fstest.MapFile{Data: []byte(`{
			"type": "object",
			"additionalProperties": false,
			"required": ["schema", "body"],
			"properties": {
				"schema": {"type": "string", "const": "envelope/v0.2"},
				"body": {
					"oneOf": [{
						"type": "object",
						"required": ["nested"],
						"properties": {
							"nested": {"type": "string"}
						}
					}]
				}
			}
		}`)},
	}
	if _, err := NewPolicy(ceilingConfig(), nestedOpen, &dummyPolicy{}); err == nil {
		t.Fatal("nested object without additionalProperties:false accepted")
	}

	emptyOneOf := fstest.MapFS{
		"envelope.schema.json": &fstest.MapFile{Data: []byte(`{
			"type": "object",
			"additionalProperties": false,
			"required": ["schema", "body"],
			"properties": {
				"schema": {"type": "string", "const": "envelope/v0.2"},
				"body": {
					"oneOf": [{
						"type": "object",
						"additionalProperties": false,
						"required": ["choice"],
						"properties": {
							"choice": {"oneOf": []}
						}
					}]
				}
			}
		}`)},
	}
	if _, err := NewPolicy(ceilingConfig(), emptyOneOf, &dummyPolicy{}); err == nil {
		t.Fatal("nested empty oneOf accepted")
	}
}

func TestT6Open03FixtureCountAndSchemaCoverage(t *testing.T) {
	files, err := verifyContractFixtureCorpus("../../../contracts/examples/v0.2", "../../../contracts/v0.2")
	if err != nil {
		t.Fatalf("production fixture corpus failed check: %v", err)
	}
	if len(files) < minContractFixtureCount {
		t.Fatalf("fixture count=%d, want >= %d", len(files), minContractFixtureCount)
	}
	// Negative control: empty or incomplete directory is refused.
	if _, err := verifyContractFixtureCorpus(t.TempDir(), "../../../contracts/v0.2"); err == nil {
		t.Fatal("empty fixture directory accepted")
	}
}
