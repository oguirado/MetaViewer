package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"metaviewer/daemon-adapter/internal/ipc"
	"strings"
)

type Runner interface {
	Run(context.Context, []string, []byte) ([]byte, error)
}
type Clock func() uint64
type Fault struct {
	Code   string
	Detail string
}

func (f *Fault) Error() string { return f.Code + ": " + f.Detail }
func ParseLine(stdout []byte, maxBytes int, dst any) error {
	fail := func() error {
		return &Fault{Code: "malformed_cli", Detail: "CLI output is not a bounded closed JSON object"}
	}
	if maxBytes < 1 || len(stdout) > maxBytes {
		return fail()
	}
	line := bytes.TrimSuffix(stdout, []byte{'\n'})
	if len(bytes.TrimSpace(line)) == 0 || bytes.ContainsAny(line, "\r\n") || bytes.TrimSpace(line)[0] != '{' {
		return fail()
	}
	if ipc.ValidateJSON(line, ipc.Config{MaxDepth: 32, MaxStringBytes: 65536, MaxKeys: 256, MaxArrayItems: 4096}) != nil {
		return fail()
	}
	d := json.NewDecoder(bytes.NewReader(line))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return fail()
	}
	return nil
}
func ExitFault(family string, exitCode int, _ string) error {
	if exitCode == 0 {
		return nil
	}
	code := "cli_failed"
	if family == "srf-identity-surface" || family == "srf-holdings-capsule" {
		codes := map[int]string{2: "usage", 3: "setup", 4: "unavailable", 5: "malformed", 6: "refused", 7: "cli_failed"}
		if c, ok := codes[exitCode]; ok {
			code = c
		} else {
			code = "invalid_exit"
		}
	} else if family != "srfd" {
		code = "unknown_family"
	}
	return &Fault{Code: code, Detail: fmt.Sprintf("CLI failed with exit status %d", exitCode)}
}
func Unsupported(operation string) error {
	return &Fault{Code: "unsupported", Detail: strings.TrimSpace(operation) + " is not configured"}
}
