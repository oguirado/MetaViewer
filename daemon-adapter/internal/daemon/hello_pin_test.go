package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/ipc"
)

func TestCoreHelloPinMismatchRefused(t *testing.T) {
	binary := buildRevisionBinary(t)
	for _, mode := range []string{"mismatch", "match", "request-before-hello", "invalid-pin"} {
		t.Run(mode, func(t *testing.T) {
			revisionEnvironment(t)
			t.Setenv("MV_EXPECTED_CORE_COMMIT", adapterTestRevision)
			if mode == "invalid-pin" {
				t.Setenv("MV_EXPECTED_CORE_COMMIT", "invalid")
			}
			dir := filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), "metaviewer")
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			socket := filepath.Join(dir, "core.sock")
			listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			if err := listener.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			var output bytes.Buffer
			cmd := exec.CommandContext(ctx, binary)
			cmd.Stdout, cmd.Stderr = &output, &output
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			waited := false
			defer func() {
				if !waited {
					_ = cmd.Process.Kill()
					_ = cmd.Wait()
				}
			}()
			if mode == "invalid-pin" {
				err := cmd.Wait()
				waited = true
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.ExitCode() != 2 || !strings.Contains(output.String(), "valid expected core revision required") {
					t.Fatalf("invalid pin: %v %s", err, &output)
				}
				return
			}
			conn, err := listener.AcceptUnix()
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			f, err := ipc.NewFramer(conn, ipc.Config{SocketPath: socket, UID: uint32(os.Getuid()), MaxFrameBytes: 1 << 20, MaxDepth: 32, MaxStringBytes: 65536, MaxKeys: 256, MaxArrayItems: 4096, MaxReplayEntries: 100000, MaxConnections: 1, HelloTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second})
			if err != nil {
				t.Fatal(err)
			}
			raw, err := f.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var registration ipc.Envelope
			if err := json.Unmarshal(raw, &registration); err != nil {
				t.Fatal(err)
			}
			var hello struct {
				Component string
				Commit    string `json:"component_commit"`
			}
			if err := json.Unmarshal(registration.Body, &hello); err != nil || hello.Component != "daemon" || hello.Commit != adapterTestRevision {
				t.Fatalf("daemon hello: %s (%v)", raw, err)
			}
			seq := uint64(0)
			send := func(body any) error {
				seq++
				bodyRaw, err := json.Marshal(body)
				if err != nil {
					return err
				}
				e := ipc.Envelope{Schema: "envelope/v0.2", MsgID: fmt.Sprint(seq), From: registration.To, To: registration.From, SessionID: registration.SessionID, Seq: seq, Nonce: fmt.Sprint(seq), Body: bodyRaw}
				raw, err := json.Marshal(e)
				if err != nil {
					return err
				}
				return f.Write(ctx, raw)
			}
			request := map[string]any{"schema": "surface_request/v0.2", "op": "create", "params": map[string]any{"kind": "browser", "profile_id": "unadmitted", "geometry": map[string]int{"w": 2, "h": 1}}}
			if mode != "request-before-hello" {
				commit := adapterTestRevision
				if mode == "mismatch" {
					commit = strings.Repeat("2", 40)
				}
				if err := send(map[string]any{"schema": "hello/v0.2", "contract_version": "v0.2", "component": "core", "component_version": "0.1.1", "component_commit": commit, "dependencies": []any{}}); err != nil {
					t.Fatal(err)
				}
			}
			// A request queued after a mismatched hello must never produce a reply.
			writeErr := send(request)
			reply, readErr := f.Read(ctx)
			if mode == "match" {
				if writeErr != nil || readErr != nil {
					t.Fatalf("matching pin refused: write=%v read=%v", writeErr, readErr)
				}
				var event struct {
					Body struct {
						Schema string `json:"schema"`
						Event  string `json:"event"`
					} `json:"body"`
				}
				if err := json.Unmarshal(reply, &event); err != nil || event.Body.Schema != "surface_event/v0.2" || event.Body.Event != "error" {
					t.Fatalf("request not dispatched: %s (%v)", reply, err)
				}
				_ = conn.Close()
			} else if readErr == nil {
				t.Fatalf("untrusted core reached dispatch: %s", reply)
			}
			err = cmd.Wait()
			waited = true
			var exit *exec.ExitError
			if ctx.Err() != nil || !errors.As(err, &exit) || exit.ExitCode() != 2 {
				t.Fatalf("expected nonzero refusal/closed-session exit: %v %s", err, &output)
			}
			if mode != "match" && !strings.Contains(output.String(), "core hello revision pin refused") {
				t.Fatalf("wrong refusal: %s", &output)
			}
		})
	}
}
