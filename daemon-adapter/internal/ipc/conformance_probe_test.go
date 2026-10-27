package ipc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func buildProbeSchemaFS(t *testing.T, schemaDir, envelopeOverride string) fs.FS {
	t.Helper()
	if envelopeOverride == "" {
		return os.DirFS(schemaDir)
	}
	entries, err := os.ReadDir(schemaDir)
	if err != nil {
		t.Fatal(err)
	}
	memFS := fstest.MapFS{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".schema.json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(schemaDir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		memFS[entry.Name()] = &fstest.MapFile{Data: raw}
	}
	memFS["envelope.schema.json"] = &fstest.MapFile{Data: []byte(envelopeOverride)}
	return memFS
}

func TestConformanceProbe(t *testing.T) {
	schemaDir := os.Getenv("MV_SCHEMA_DIR")
	if schemaDir == "" {
		schemaDir = "../../../contracts/v0.2"
	}
	source := buildProbeSchemaFS(t, schemaDir, os.Getenv("MV_ENVELOPE_SCHEMA_JSON"))
	p, err := NewPolicy(ceilingConfig(), source, &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	inPath := os.Getenv("MV_PROBE_IN")
	if inPath == "" {
		inPath = os.Getenv("CONFORMANCE_INPUT")
	}
	if inPath == "" {
		raw, err := os.ReadFile(filepath.Join(schemaDir, "../examples/v0.2/envelope.valid.json"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := p.ValidateEnvelope(raw); err != nil {
			t.Fatalf("valid envelope fixture refused: %v", err)
		}
		bad := strings.Replace(string(raw), `"seq": 1`, `"seq": 0`, 1)
		if _, err := p.ValidateEnvelope([]byte(bad)); err == nil {
			t.Fatal("invalid envelope fixture admitted")
		}
		return
	}
	inFile, err := os.Open(inPath)
	if err != nil {
		t.Fatal(err)
	}
	defer inFile.Close()

	var outFile *os.File
	if outPath := os.Getenv("MV_PROBE_OUT"); outPath != "" {
		outFile, err = os.Create(outPath)
		if err != nil {
			t.Fatal(err)
		}
		defer outFile.Close()
	}

	scanner := bufio.NewScanner(inFile)
	scanner.Buffer(make([]byte, 1024*1024), 2*1024*1024)
	for scanner.Scan() {
		_, vErr := p.ValidateEnvelope(scanner.Bytes())
		admit := vErr == nil
		if outFile != nil {
			fmt.Fprintln(outFile, admit)
		}
		t.Logf("PROBE_VERDICT: %v", admit)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestRefAndSiblingConstConformance(t *testing.T) {
	schemaDir := "../../../contracts/v0.2"
	rawEnv, err := os.ReadFile("../../../contracts/examples/v0.2/envelope.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	rawFrame, err := os.ReadFile("../../../contracts/examples/v0.2/frame_ref.valid.json")
	if err != nil {
		t.Fatal(err)
	}
	var envMap map[string]any
	if err := json.Unmarshal(rawEnv, &envMap); err != nil {
		t.Fatal(err)
	}
	var frameGen1 map[string]any
	if err := json.Unmarshal(rawFrame, &frameGen1); err != nil {
		t.Fatal(err)
	}
	frameGen2 := map[string]any{}
	for k, v := range frameGen1 {
		frameGen2[k] = v
	}
	frameGen2["generation"] = 2

	frameBadSha := map[string]any{}
	for k, v := range frameGen1 {
		frameBadSha[k] = v
	}
	frameBadSha["sha256"] = "not-a-valid-sha256"

	makeSynthEnvelopeSchema := func(constVal map[string]any) string {
		constBytes, err := json.Marshal(constVal)
		if err != nil {
			t.Fatal(err)
		}
		return fmt.Sprintf(`{
			"$defs": {
				"token": {
					"type": "string",
					"pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
					"minLength": 1,
					"maxLength": 128
				}
			},
			"type": "object",
			"additionalProperties": false,
			"required": ["schema", "msg_id", "ts_ns", "from", "to", "session_id", "seq", "nonce", "body"],
			"maxProperties": 256,
			"properties": {
				"schema": {"type": "string", "const": "envelope/v0.2", "maxLength": 128},
				"msg_id": {"$ref": "#/$defs/token"},
				"ts_ns": {"type": "integer", "minimum": 0, "maximum": 9007199254740991},
				"from": {
					"type": "object",
					"additionalProperties": false,
					"required": ["component", "instance"],
					"maxProperties": 256,
					"properties": {
						"component": {"type": "string", "enum": ["core", "ui", "daemon", "agent", "vision", "wender"], "maxLength": 65536},
						"instance": {"$ref": "#/$defs/token"}
					}
				},
				"to": {
					"type": "object",
					"additionalProperties": false,
					"required": ["component", "instance"],
					"maxProperties": 256,
					"properties": {
						"component": {"type": "string", "enum": ["core", "ui", "daemon", "agent", "vision", "wender"], "maxLength": 65536},
						"instance": {"$ref": "#/$defs/token"}
					}
				},
				"session_id": {"$ref": "#/$defs/token"},
				"seq": {"type": "integer", "minimum": 1, "maximum": 9007199254740991},
				"nonce": {"$ref": "#/$defs/token"},
				"body": {
					"oneOf": [{
						"$ref": "frame_ref.schema.json",
						"const": %s
					}]
				}
			}
		}`, string(constBytes))
	}

	wrapBody := func(body map[string]any) []byte {
		clone := map[string]any{}
		for k, v := range envMap {
			clone[k] = v
		}
		clone["body"] = body
		b, err := json.Marshal(clone)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	pGoodConst, err := NewPolicy(ceilingConfig(), buildProbeSchemaFS(t, schemaDir, makeSynthEnvelopeSchema(frameGen1)), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pGoodConst.ValidateEnvelope(wrapBody(frameGen1)); err != nil {
		t.Fatalf("positive control ($ref and sibling const both satisfied) refused: %v", err)
	}
	if _, err := pGoodConst.ValidateEnvelope(wrapBody(frameGen2)); err == nil {
		t.Fatal("regression case ($ref satisfied but sibling const violated) admitted")
	}

	pBadConst, err := NewPolicy(ceilingConfig(), buildProbeSchemaFS(t, schemaDir, makeSynthEnvelopeSchema(frameBadSha)), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pBadConst.ValidateEnvelope(wrapBody(frameBadSha)); err == nil {
		t.Fatal("negative control (sibling const satisfied but $ref violated) admitted")
	}
}

func TestIntegerRailDivergence(t *testing.T) {
	cfg := ceilingConfig()
	p, err := NewPolicy(cfg, os.DirFS("../../../contracts/v0.2"), &dummyPolicy{})
	if err != nil {
		t.Fatal(err)
	}

	overSafeInt := []byte(`{"schema":"envelope/v0.2","seq":9007199254740992,"msg_id":"m1","ts_ns":1,"from":{"component":"agent","instance":"a1"},"to":{"component":"daemon","instance":"d1"},"session_id":"s1","nonce":"n1","body":{"schema":"surface_request/v0.2","op":"list","params":{}}}`)
	if err := ValidateJSON(overSafeInt, cfg); err != nil {
		t.Fatalf("ValidateJSON unexpectedly refused syntactically valid JSON integer: %v", err)
	}
	if _, err := p.ValidateEnvelope(overSafeInt); err == nil {
		t.Fatal("ValidateEnvelope policy admitted seq = 2^53")
	}

	atSafeInt := []byte(`{"schema":"envelope/v0.2","seq":9007199254740991,"msg_id":"m1","ts_ns":1,"from":{"component":"agent","instance":"a1"},"to":{"component":"daemon","instance":"d1"},"session_id":"s1","nonce":"n1","body":{"schema":"surface_request/v0.2","op":"list","params":{}}}`)
	if _, err := p.ValidateEnvelope(atSafeInt); err != nil {
		t.Fatalf("ValidateEnvelope policy refused seq = 2^53 - 1: %v", err)
	}
}
