package ipc

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type dummyAuth struct{}

func (d *dummyAuth) Authenticate(context.Context, PeerCredentials, Envelope) error { return nil }
func (d *dummyAuth) Reserve(context.Context, SenderKey, uint64, string) error      { return nil }
func (d *dummyAuth) Wrap(context.Context, Envelope, json.RawMessage) (Envelope, error) {
	return Envelope{}, nil
}

func TestConformanceProbe(t *testing.T) {
	inputPath := os.Getenv("CONFORMANCE_INPUT")
	if inputPath == "" {
		t.Skip("CONFORMANCE_INPUT not set")
	}

	file, err := os.Open(inputPath)
	if err != nil {
		t.Fatalf("failed to open CONFORMANCE_INPUT: %v", err)
	}
	defer file.Close()

	cfg := Config{
		SocketPath:       "dummy.sock",
		UID:              uint32(os.Getuid()),
		MaxFrameBytes:    1048576,
		MaxDepth:         32,
		MaxStringBytes:   65536,
		MaxKeys:          256,
		MaxArrayItems:    4096,
		MaxReplayEntries: 256,
		MaxConnections:   10,
		HelloTimeout:     5 * time.Second,
		ReadTimeout:      30 * time.Second,
		WriteTimeout:     5 * time.Second,
		ProbeTimeout:     5 * time.Second,
		ShutdownTimeout:  5 * time.Second,
	}

	contractsDir := filepath.Join("..", "..", "..", "contracts", "v0.2")
	p, err := NewPolicy(cfg, os.DirFS(contractsDir), &dummyAuth{})
	if err != nil {
		t.Fatalf("NewPolicy failed: %v", err)
	}

	scanner := bufio.NewScanner(file)
	buf := make([]byte, 2*1048576)
	scanner.Buffer(buf, 2*1048576)

	for scanner.Scan() {
		_, err := p.ValidateEnvelope(scanner.Bytes())
		if err == nil {
			fmt.Println("PROBE_VERDICT:true")
		} else {
			fmt.Println("PROBE_VERDICT:false")
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scanner error: %v", err)
	}
}
