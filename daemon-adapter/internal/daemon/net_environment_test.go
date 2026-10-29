package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"metaviewer/daemon-adapter/internal/ipc"
)

func TestNetworkModesEnvironment(t *testing.T) {
	t.Setenv("MV_SRF_NET_MODES", "")
	if err := os.Unsetenv("MV_SRF_NET_MODES"); err != nil {
		t.Fatal(err)
	}
	modes, err := networkModesFromEnv()
	if err != nil || modes != nil {
		t.Fatalf("absent: %v %v", modes, err)
	}
	for _, raw := range []string{"", "null", `{}`, `"open"`, `["OPEN"]`, `["open","open"]`, `["allowlisted"]`, `["open",null]`, `["open"] {}`} {
		t.Setenv("MV_SRF_NET_MODES", raw)
		if _, err := networkModesFromEnv(); err == nil {
			t.Fatalf("accepted %q", raw)
		}
		if _, err := RuntimeFromEnv(); err == nil || !strings.Contains(err.Error(), "MV_SRF_NET_MODES") {
			t.Fatalf("startup accepted %q: %v", raw, err)
		}
	}
	for _, raw := range []string{`[]`, `["legacy"]`, `["open","proxied"]`, `["legacy","open","proxied"]`} {
		t.Setenv("MV_SRF_NET_MODES", raw)
		var want []string
		if err := json.Unmarshal([]byte(raw), &want); err != nil {
			t.Fatal(err)
		}
		got, err := networkModesFromEnv()
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: %v %v", raw, got, err)
		}
	}
}

// The real daemon constructor must pass startup knowledge into Manager.Create.
func TestNetworkModesEnvironmentWiring(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{{`[]`, "legacy"}, {`["legacy","open","proxied"]`, "open"}} {
		t.Run(tc.want, func(t *testing.T) {
			nvEnvironment(t)
			t.Setenv("MV_SRF_NET_MODES", tc.raw)
			log := filepath.Join(t.TempDir(), "calls")
			binary := filepath.Join(os.Getenv("MV_SRF_BIN_DIR"), "srf-identity-surface")
			original, err := os.ReadFile(binary)
			if err != nil {
				t.Fatal(err)
			}
			instrumented := strings.Replace(string(original), "op=sys.argv[1]\n", fmt.Sprintf("op=sys.argv[1]\nopen(%q,'a').write(' '.join(sys.argv[1:])+'\\n')\n", log), 1)
			if err := os.WriteFile(binary, []byte(instrumented), 0700); err != nil {
				t.Fatal(err)
			}
			runtime, err := RuntimeFromEnv()
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()
			t.Setenv("MV_SRF_NET_MODES", `null`) // hello must retain the startup snapshot.
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ctx = context.WithValue(ctx, streamKey{}, streamSession{ctx: ctx, work: &sync.Mutex{}, emit: func(context.Context, json.RawMessage) error { return nil }})
			if _, err := runtime.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"hello/v0.2"}`)}); err != nil {
				t.Fatal(err)
			}
			events, err := runtime.Handler(ctx, ipc.Envelope{Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"create","params":{"kind":"browser","profile_id":"demo","geometry":{"w":1280,"h":900}}}`)})
			if err != nil || len(events) == 0 {
				t.Fatalf("create: %s %v", events, err)
			}
			calls, err := os.ReadFile(log)
			if err != nil {
				t.Fatal(err)
			}
			lines := strings.Split(strings.TrimSpace(string(calls)), "\n")
			if len(lines) != 2 || !strings.HasPrefix(lines[0], "start ") || !strings.HasPrefix(lines[1], "frame ") {
				t.Fatalf("unexpected native calls: %s", calls)
			}
			hasOpen := strings.Contains(lines[0], "--net open")
			if hasOpen != (tc.want == "open") || strings.Contains(string(calls), "capabilities") || strings.Contains(string(calls), "--audit") {
				t.Fatalf("startup knowledge lost: %s", calls)
			}

		})
	}
}
