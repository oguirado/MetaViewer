package capsule

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"metaviewer/daemon-adapter/internal/cli"
)

// DAM-FIX close-F2: refusal reasons reach the wire as stable uppercase codes.
func TestWireCodeKnownRefusals(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{fault("binding", detailProfileBound), "PROFILE_ALREADY_BOUND"},
		{fault("uncertain", detailCapacityOrQuarantine), "SURFACE_CAPACITY_OR_QUARANTINE"},
		{fault("identity_unavailable", detailIdentityUnavailable), "IDENTITY_UNAVAILABLE"},
		{fault("RAM_ADMISSION_REFUSED", "x"), "RAM_ADMISSION_REFUSED"},
		{fault("POLICY", "x"), "POLICY"},
		{fault("NET_EGRESS_IO", "x"), "NET_EGRESS_IO"},
		// A lowercase code with another detail gets the generic prefixed form.
		{fault("binding", "native container already observed"), "ADAPTER_BINDING"},
		{fault("uncertain", "native command deadline or cancellation"), "ADAPTER_UNCERTAIN"},
		{fault("malformed_cli", "x"), "ADAPTER_MALFORMED_CLI"},
		{fmt.Errorf("wrapped: %w", fault("binding", detailProfileBound)), "PROFILE_ALREADY_BOUND"},
		{errors.Join(errors.New("cause"), fault("refused", "x")), "ADAPTER_REFUSED"},
		{errors.New("plain"), "ADAPTER_ERROR"},
		{nil, "ADAPTER_ERROR"},
	} {
		if got := WireCode(tc.err); got != tc.want {
			t.Errorf("WireCode(%v) = %q, want %q", tc.err, got, tc.want)
		}
	}
}

// Every fault code the adapter can produce, plus hostile shapes, must yield a
// code the UI authority wire passes through (the masking of close-F2 was exactly
// a lowercase code failing that shape).
func TestWireCodeAlwaysMatchesWireShape(t *testing.T) {
	codes := []string{"configuration", "usage", "setup", "unavailable", "malformed", "refused", "cli_failed", "invalid_exit",
		"unknown_family", "schema", "unknown_op", "surface", "profile", "binding", "uncertain", "malformed_cli", "input",
		"nested_depth", "execution", "unsupported", "handshake", "identity_unavailable", "adapter", "POLICY", "LOGIN_ACTIVE",
		"", "x", "a-b.c d", "é", strings.Repeat("long", 40), "9lives", "_"}
	for _, code := range codes {
		got := WireCode(&cli.Fault{Code: code, Detail: "d"})
		if !wireCodePattern.MatchString(got) {
			t.Errorf("code %q mapped to %q, outside the wire shape", code, got)
		}
		if got == "adapter" {
			t.Errorf("code %q kept the masking lowercase form", code)
		}
	}
}

// L-02: a start that fails with the bare native "unavailable" (exit status 4,
// identity unavailable or exclusively held) becomes a typed, actionable refusal,
// and the quarantine that proves nothing about native absence stays.
func TestIdentityUnavailableStartIsTypedAndKeepsQuarantine(t *testing.T) {
	r := &scriptRunner{err: cli.ExitFault("srf-identity-surface", 4, "")}
	m := testManager(t, r)
	_, err := m.Handle(context.Background(), req("create", lostSlotCreate))
	requireFault(t, err, "identity_unavailable")
	if got := WireCode(err); got != "IDENTITY_UNAVAILABLE" {
		t.Fatalf("wire code %q", got)
	}
	for _, want := range []string{"exclusively held", "abandoned", "reclaim", "ABSENT"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("detail lacks %q: %v", want, err)
		}
	}
	if !m.AdmissionProfiles()["demo"] {
		t.Fatal("quarantine dropped after a start whose native absence is unproven")
	}
	// A same-profile retry is refused before any native call, with its own code.
	n := len(r.calls)
	_, err = m.Handle(context.Background(), req("create", lostSlotCreate))
	requireFault(t, err, "uncertain")
	if got := WireCode(err); got != "SURFACE_CAPACITY_OR_QUARANTINE" || len(r.calls) != n {
		t.Fatalf("retry: wire %q, extra native calls %d", got, len(r.calls)-n)
	}
}

// Negative control: other start failures keep their own fault, so the typed
// refusal is specific to exit status 4 and does not blanket every failure.
func TestIdentityUnavailableDoesNotCaptureOtherStartFailures(t *testing.T) {
	for _, tc := range []struct {
		exit int
		code string
	}{{6, "refused"}, {3, "setup"}, {2, "usage"}, {5, "malformed"}} {
		r := &scriptRunner{err: cli.ExitFault("srf-identity-surface", tc.exit, "")}
		m := testManager(t, r)
		_, err := m.Handle(context.Background(), req("create", lostSlotCreate))
		requireFault(t, err, tc.code)
		if got := WireCode(err); got == "IDENTITY_UNAVAILABLE" {
			t.Errorf("exit %d wrongly typed as identity unavailable", tc.exit)
		}
	}
}

// The fault that masked close-F2 on the wire: a second create on a bound profile.
func TestProfileAlreadyBoundHasStableWireCode(t *testing.T) {
	r := &scriptRunner{output: []byte(startOK)}
	m := testManager(t, r)
	createID(t, m)
	_, err := m.Handle(context.Background(), req("create", lostSlotCreate))
	requireFault(t, err, "binding")
	if got := WireCode(err); got != "PROFILE_ALREADY_BOUND" {
		t.Fatalf("wire code %q", got)
	}
}
