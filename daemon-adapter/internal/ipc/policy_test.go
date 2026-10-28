package ipc

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
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
	rawEnvSchema, err := os.ReadFile("../../../contracts/v0.2/envelope.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var envSchema struct {
		Properties struct {
			Body struct {
				OneOf []struct {
					Ref string `json:"$ref"`
				} `json:"oneOf"`
			} `json:"body"`
		} `json:"properties"`
	}
	if err = json.Unmarshal(rawEnvSchema, &envSchema); err != nil {
		t.Fatal(err)
	}
	envelopeBodies := map[string]bool{"envelope": true}
	for _, b := range envSchema.Properties.Body.OneOf {
		envelopeBodies[strings.TrimSuffix(b.Ref, ".schema.json")] = true
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
			prefix, _, _ := strings.Cut(filepath.Base(file), ".")
			isEnvelopeMember := envelopeBodies[prefix]
			_, err = p.ValidateEnvelope(wire)
			if strings.Contains(file, ".valid.") && isEnvelopeMember && err != nil {
				t.Fatal(err)
			}
			if (strings.Contains(file, ".invalid.") || !isEnvelopeMember) && err == nil {
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

func TestT6R2006LoneSurrogateRefused(t *testing.T) {
	cfg := ceilingConfig()
	for _, bad := range []string{
		`{"error":"\ud800"}`,
		`{"error":"\udbff"}`,
		`{"error":"\udc00"}`,
		`{"error":"\udfff"}`,
		`{"error":"x\ud800y"}`,
		`{"error":"\ud800\u0041"}`,
		`{"error":"\ud800\ud800\udc00"}`,
		`{"\ud800":1}`,
	} {
		if err := ValidateJSON([]byte(bad), cfg); err == nil {
			t.Fatalf("lone surrogate admitted by ValidateJSON: %s", bad)
		}
	}
	// Negative control: valid UTF-8, escaped backslash before ud800, and valid astral surrogate pair pass.
	for _, good := range []string{
		`{"error":"é"}`,
		`{"error":"\\ud800"}`,
		`{"error":"\ud83d\ude00"}`,
	} {
		if err := ValidateJSON([]byte(good), cfg); err != nil {
			t.Fatalf("valid string refused by ValidateJSON (%s): %v", good, err)
		}
	}

	p, err := NewPolicy(cfg, os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	rawEnv, err := os.ReadFile("../../../contracts/examples/v0.2/envelope.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	rawReceipt, err := os.ReadFile("../../../contracts/examples/v0.2/action_receipt.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	wrapRawBody := func(bodyRaw string) []byte {
		prefix := strings.TrimSuffix(strings.TrimSpace(string(rawEnv)), "}")
		idx := strings.Index(prefix, `"body":`)
		if idx < 0 {
			t.Fatal("missing body in envelope.valid.json")
		}
		return []byte(prefix[:idx] + `"body": ` + bodyRaw + "}")
	}
	badBody := strings.Replace(string(rawReceipt), `"error": ""`, `"error": "x\ud800y"`, 1)
	if _, err := p.ValidateEnvelope(wrapRawBody(badBody)); err == nil {
		t.Fatal("lone surrogate in action_receipt.error admitted by ValidateEnvelope")
	}
	for _, goodLiteral := range []string{`"é"`, `"\ud83d\ude00"`} {
		goodBody := strings.Replace(string(rawReceipt), `"error": ""`, `"error": `+goodLiteral, 1)
		if _, err := p.ValidateEnvelope(wrapRawBody(goodBody)); err != nil {
			t.Fatalf("valid action_receipt.error %s refused: %v", goodLiteral, err)
		}
	}
}

func TestT6R2007TerminalByteCountCrossCheck(t *testing.T) {
	p, err := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	rawEnv, err := os.ReadFile("../../../contracts/examples/v0.2/envelope.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	wrapBody := func(bodyJSON string) []byte {
		var env map[string]any
		if err := json.Unmarshal(rawEnv, &env); err != nil {
			t.Fatal(err)
		}
		env["body"] = json.RawMessage(bodyJSON)
		out, err := json.Marshal(env)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	for _, badBody := range []string{
		`{"schema":"terminal_session/v0.2","request_id":"req-1","op":"write","params":{"session_id":"s-1","terminal_generation":1,"input_seq":1,"b64":"YQ==","byte_count":2}}`,
		`{"schema":"terminal_session/v0.2","request_id":"req-1","op":"write","params":{"session_id":"s-1","terminal_generation":1,"input_seq":1,"b64":"YQ==","byte_count":0}}`,
		`{"schema":"terminal_session/v0.2","request_id":"req-1","op":"data","params":{"session_id":"s-1","terminal_generation":1,"seq":1,"b64":"YQ==","byte_count":2,"truncated":false,"gap":false}}`,
		`{"schema":"terminal_session/v0.2","request_id":"req-1","op":"data","params":{"session_id":"s-1","terminal_generation":1,"seq":1,"b64":"YWJj","byte_count":2,"truncated":false,"gap":false}}`,
	} {
		if _, err := p.ValidateEnvelope(wrapBody(badBody)); err == nil {
			t.Fatalf("mismatched terminal byte_count admitted: %s", badBody)
		}
	}
	// Negative controls: matching decoded lengths for write and data are admitted.
	for _, goodBody := range []string{
		`{"schema":"terminal_session/v0.2","request_id":"req-1","op":"write","params":{"session_id":"s-1","terminal_generation":1,"input_seq":1,"b64":"YQ==","byte_count":1}}`,
		`{"schema":"terminal_session/v0.2","request_id":"req-1","op":"write","params":{"session_id":"s-1","terminal_generation":1,"input_seq":1,"b64":"","byte_count":0}}`,
		`{"schema":"terminal_session/v0.2","request_id":"req-1","op":"data","params":{"session_id":"s-1","terminal_generation":1,"seq":1,"b64":"YQ==","byte_count":1,"truncated":false,"gap":false}}`,
		`{"schema":"terminal_session/v0.2","request_id":"req-1","op":"data","params":{"session_id":"s-1","terminal_generation":1,"seq":1,"b64":"YWJj","byte_count":3,"truncated":false,"gap":false}}`,
	} {
		if _, err := p.ValidateEnvelope(wrapBody(goodBody)); err != nil {
			t.Fatalf("matching terminal byte_count refused (%s): %v", goodBody, err)
		}
	}
}

func TestSharedConformanceCases(t *testing.T) {
	p, err := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	rawEnv, err := os.ReadFile("../../../contracts/examples/v0.2/envelope.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	rawReceipt, err := os.ReadFile("../../../contracts/examples/v0.2/action_receipt.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	wrapRawBody := func(bodyRaw string) string {
		prefix := strings.TrimSuffix(strings.TrimSpace(string(rawEnv)), "}")
		idx := strings.Index(prefix, `"body":`)
		if idx < 0 {
			t.Fatal("missing body in envelope.valid.json")
		}
		return prefix[:idx] + `"body": ` + bodyRaw + "}"
	}
	builtin := []struct {
		Name  string `json:"name"`
		Raw   string `json:"raw"`
		Admit bool   `json:"admit"`
	}{
		{
			Name:  "T6R2-006-lone-surrogate-refused",
			Raw:   wrapRawBody(strings.Replace(string(rawReceipt), `"error": ""`, `"error": "x\ud800y"`, 1)),
			Admit: false,
		},
		{
			Name:  "T6R2-006-astral-pair-admitted",
			Raw:   wrapRawBody(strings.Replace(string(rawReceipt), `"error": ""`, `"error": "\ud83d\ude00"`, 1)),
			Admit: true,
		},
		{
			Name:  "T6R2-007-terminal-write-mismatch-refused",
			Raw:   wrapRawBody(`{"schema":"terminal_session/v0.2","request_id":"req-1","op":"write","params":{"session_id":"s-1","terminal_generation":1,"input_seq":1,"b64":"YQ==","byte_count":2}}`),
			Admit: false,
		},
		{
			Name:  "T6R2-007-terminal-write-match-admitted",
			Raw:   wrapRawBody(`{"schema":"terminal_session/v0.2","request_id":"req-1","op":"write","params":{"session_id":"s-1","terminal_generation":1,"input_seq":1,"b64":"YQ==","byte_count":1}}`),
			Admit: true,
		},
		{
			Name:  "R1-082-unversioned-schema-const-refused",
			Raw:   wrapRawBody(strings.Replace(string(rawReceipt), `"action_receipt/v0.2"`, `"action_receipt"`, 1)),
			Admit: false,
		},
		{
			Name:  "R1-083-above-safe-int-ceiling-refused",
			Raw:   strings.Replace(string(rawEnv), `"seq": 1`, `"seq": 9007199254740992`, 1),
			Admit: false,
		},
		{
			Name:  "R1-083-at-safe-int-ceiling-admitted",
			Raw:   strings.Replace(string(rawEnv), `"seq": 1`, `"seq": 9007199254740991`, 1),
			Admit: true,
		},
		{
			Name:  "RV7-ramws-two-segment-admitted",
			Raw:   wrapRawBody(string(rawReceipt)),
			Admit: true,
		},
		{
			Name:  "RV7-ramws-adapter-layout-admitted",
			Raw:   wrapRawBody(strings.Replace(string(rawReceipt), `"/dev/shm/ramws/demo.rgb"`, `"/dev/shm/mv-adapter-1/frames-123456/0123456789abcdef0123456789abcdef.rgb"`, 1)),
			Admit: true,
		},
		{
			Name:  "RV7-ramws-traversal-refused",
			Raw:   wrapRawBody(strings.Replace(string(rawReceipt), `"/dev/shm/ramws/demo.rgb"`, `"/dev/shm/../etc/x"`, 1)),
			Admit: false,
		},
		{
			Name:  "RV7-ramws-empty-segment-refused",
			Raw:   wrapRawBody(strings.Replace(string(rawReceipt), `"/dev/shm/ramws/demo.rgb"`, `"/dev/shm/a//b"`, 1)),
			Admit: false,
		},
		{
			Name:  "RV7-ramws-hidden-segment-refused",
			Raw:   wrapRawBody(strings.Replace(string(rawReceipt), `"/dev/shm/ramws/demo.rgb"`, `"/dev/shm/.x"`, 1)),
			Admit: false,
		},
		{
			Name:  "RV7-ramws-newline-refused",
			Raw:   wrapRawBody(strings.Replace(string(rawReceipt), `"/dev/shm/ramws/demo.rgb"`, `"/dev/shm/a\nb"`, 1)),
			Admit: false,
		},
		{
			Name:  "RV7-ramws-bare-root-refused",
			Raw:   wrapRawBody(strings.Replace(string(rawReceipt), `"/dev/shm/ramws/demo.rgb"`, `"/dev/shm"`, 1)),
			Admit: false,
		},
	}
	if path := os.Getenv("MV_CONFORMANCE_FILE"); path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &builtin); err != nil {
			t.Fatal(err)
		}
		if len(builtin) == 0 {
			t.Fatal("empty conformance case list")
		}
	}
	for _, tc := range builtin {
		_, vErr := p.ValidateEnvelope([]byte(tc.Raw))
		got := vErr == nil
		if got != tc.Admit {
			t.Fatalf("case %s: ValidateEnvelope got admit=%v (err=%v), want admit=%v", tc.Name, got, vErr, tc.Admit)
		}
	}
}

func TestPublisherFrameValidatesEndToEnd(t *testing.T) {
	p, err := NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	ramRoot, err := os.MkdirTemp("/dev/shm", "mv-pub-policy-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(ramRoot); err != nil {
			t.Error(err)
		}
	})
	outputPath, err := os.MkdirTemp(ramRoot, "frames-")
	if err != nil {
		t.Fatal(err)
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	name := hex.EncodeToString(random) + ".rgb"
	publishedPath := filepath.Join(outputPath, name)
	rawPixels := []byte{255, 0, 0, 0, 255, 0}
	if err := os.WriteFile(publishedPath, rawPixels, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(rawPixels)
	sha := hex.EncodeToString(sum[:])

	frameRef := map[string]any{
		"schema":     "frame_ref/v0.2",
		"surface_id": "surf-1",
		"generation": 1,
		"tick":       1,
		"ts_ns":      100,
		"width":      2,
		"height":     1,
		"format":     "rgb24",
		"ramws_path": publishedPath,
		"sha256":     sha,
		"capture_us": 20,
	}
	rawEnv, err := os.ReadFile("../../../contracts/examples/v0.2/envelope.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	wrapBody := func(body any) []byte {
		var env map[string]any
		if err := json.Unmarshal(rawEnv, &env); err != nil {
			t.Fatal(err)
		}
		env["body"] = body
		wire, err := json.Marshal(env)
		if err != nil {
			t.Fatal(err)
		}
		return wire
	}
	if _, err := p.ValidateEnvelope(wrapBody(frameRef)); err != nil {
		t.Fatalf("published frame_ref %q refused by ValidateEnvelope: %v", publishedPath, err)
	}
	eventBody := map[string]any{
		"schema": "surface_event/v0.2",
		"event":  "frame_ready",
		"data":   map[string]any{"frame_ref": frameRef},
	}
	if _, err := p.ValidateEnvelope(wrapBody(eventBody)); err != nil {
		t.Fatalf("published surface_event.frame_ready (%q) refused by ValidateEnvelope: %v", publishedPath, err)
	}
	for _, badPath := range []string{"/dev/shm/../etc/x", "/dev/shm/a//b", "/dev/shm/.x", "/dev/shm/a\nb", "/dev/shm"} {
		badRef := map[string]any{}
		for k, v := range frameRef {
			badRef[k] = v
		}
		badRef["ramws_path"] = badPath
		if _, err := p.ValidateEnvelope(wrapBody(badRef)); err == nil {
			t.Fatalf("invalid ramws_path %q admitted by ValidateEnvelope", badPath)
		}
	}
}
