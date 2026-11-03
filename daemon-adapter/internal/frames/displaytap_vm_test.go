package frames

import (
	"errors"
	"testing"

	"metaviewer/daemon-adapter/internal/capsule"
)

func TestVMDisplayRefusesHostTransport(t *testing.T) {
	// Even a plausible host X11 binding cannot turn guest pixels into a host
	// window. Refuse before reading native state or choosing a capture command.
	b := capsule.Binding{
		NativeKind: "vm", Container: "srf-vm-demo", RunID: "vm-run",
		Window: "w1", HostXID: 42, HostWitness: "synthetic-witness",
		BinDir: "/synthetic/bin", HostDisplay: ":0",
		Surface: capsule.Surface{Display: ":100", Geometry: capsule.Geometry{W: 2, H: 1}},
	}
	got, err := ResolveDisplayTarget(b, t.TempDir())
	if !errors.Is(err, ErrDisplayUnsupported) || got != (DisplayTarget{}) {
		t.Fatalf("VM display admitted a host transport: %+v %v", got, err)
	}
}
