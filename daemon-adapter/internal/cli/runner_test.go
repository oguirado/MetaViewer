package cli_test

import (
	"context"
	"errors"
	"os"
	"testing"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
)

type fakeRunner struct{ data []byte }

func (r fakeRunner) Run(context.Context, []string, []byte) ([]byte, error) { return r.data, nil }
func TestMalformedCLILineYieldsErrorEvent(t *testing.T) {
	for _, name := range []string{"cli_identity_valid.json", "cli_malformed.txt"} {
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile("../../testdata/" + name)
			if err != nil {
				t.Fatal(err)
			}
			out, err := (fakeRunner{data}).Run(context.Background(), nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			var value struct {
				Kind      string       `json:"kind"`
				Container string       `json:"container"`
				RunID     string       `json:"run_id"`
				Windows   []jsonWindow `json:"windows"`
			}
			err = cli.ParseLine(out, len(out), &value)
			if name == "cli_identity_valid.json" {
				if err != nil || value.Container == "" {
					t.Fatalf("positive: %v", err)
				}
				return
			}
			var fault *cli.Fault
			if !errors.As(err, &fault) {
				t.Fatalf("expected fault, got %v", err)
			}
			event, err := capsule.NewErrorEvent("surface-test", fault)
			if err != nil || event.Event != "error" || event.Data.Code == "" || event.Data.Detail == "" {
				t.Fatalf("bad event: %+v %v", event, err)
			}
			if _, err = capsule.NewErrorEvent("", fault); err == nil {
				t.Fatal("invented create identity accepted")
			}
		})
	}
}

type jsonWindow struct {
	ID string `json:"id"`
}

func TestParseLineControls(t *testing.T) {
	for _, input := range []string{"{}\n{}\n", "{} {}", "{\"x\":1,\"x\":2}", "{\"unknown\":1}", "[]", "null", "{}\n\n", string([]byte{'"', 255, '"'})} {
		var dst struct{}
		if cli.ParseLine([]byte(input), 128, &dst) == nil {
			t.Errorf("accepted %q", input)
		}
	}
	var dst struct{}
	if cli.ParseLine([]byte("{}\n"), 3, &dst) != nil {
		t.Fatal("valid line rejected")
	}
	if cli.ParseLine([]byte("{}\n"), 2, &dst) == nil {
		t.Fatal("cap ignored")
	}
	for _, family := range []string{"srf-identity-surface", "srf-holdings-capsule", "srfd"} {
		if cli.ExitFault(family, 0, "") != nil {
			t.Fatal("success refused")
		}
		for _, code := range []int{1, 2, 3, 4, 5, 6, 7, 9, 69} {
			if cli.ExitFault(family, code, "private stderr") == nil {
				t.Fatal("failure accepted")
			}
		}
	}
}
