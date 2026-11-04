package ipc

import (
	"os"
	"path/filepath"
	"testing"
)

var commandObservationFixturePins = map[string]string{
	"guest_command_observation.invalid.bool_generation.json":  "35053b654cd35120e9ee0a2887fb7a7f3ebe79396664f8281db0965dd90f297a",
	"guest_command_observation.invalid.empty_command.json":    "8b2c15987913f859e3d3aa07a58ead8f49be8386c8770b2e6f89f4565b06a38f",
	"guest_command_observation.invalid.extra.json":            "8be5bab48072f80e383b4413ef17529b2bdee740b2a30ca1402e0b01bb474608",
	"guest_command_observation.invalid.stdin.json":            "671f20ba480eb78c76dd7d5d1e7e8313e26851acb02f2967cad32f670e47b849",
	"guest_command_observation.invalid.submitted.json":        "173ea2479cf0292d6b1436bbe6be25e99620ed4c9fd520e91bb864a38da2db3e",
	"guest_command_observation.invalid.timeout.json":          "9b0f307aa2eb643217b08158689e2804f4c641822f5b32f8cd69b26fa2a37e5c",
	"guest_command_observation.invalid.too_long_command.json": "fa4826921928a3c8d9b36978d0086a9ac8530e383dfc7e164d4be2849f5fb83d",
	"guest_command_observation.invalid.zero_generation.json":  "a55a4dff197dad32ac321276f05b263221085d294429e1f5d70c8ddf4fd83b13",
	"guest_command_observation.valid.json":                    "2bb1fb69a135f467e89f12213d3194d457c491711da2b6d0b4dcad75610ed520",
	"guest_command_observation.valid.ui.json":                 "3175979c117f329f3a96e950144ed4f650a532d33e7ef2ea0884caef17e2d3ea",
	"guest_command_observation_envelope.invalid.sender.json":  "c74eadaacb300cf8e80296f676e36d0a0f58f3d29a3cf9d7a3194c1523a06b31",
	"guest_command_observation_envelope.valid.json":           "9bb6d5b63936a8308a2b9eb5f9f2249fa9664baffd88be2d619b0f37f8b43317",
	"guest_command_observation_envelope.valid.ui.json":        "98353f157491ebe1734ae6913fe55dabfae27cac2acceb20d89e154b44500870",
}

func TestCommandObservationFixturePinsRejectChangeMissingAndUnknown(t *testing.T) {
	source := "../../../contracts/examples/v0.2"
	dir := t.TempDir()
	entries, err := os.ReadDir(source)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		raw, e := os.ReadFile(filepath.Join(source, entry.Name()))
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(dir, entry.Name()), raw, 0600); e != nil {
			t.Fatal(e)
		}
	}
	check := func() error { _, e := verifyContractFixtureCorpus(dir, "../../../contracts/v0.2"); return e }
	if e := check(); e != nil {
		t.Fatal("nominal corpus", e)
	}
	if len(commandObservationFixturePins) != 13 {
		t.Fatal("closed observation fixture count")
	}
	for name := range commandObservationFixturePins {
		path := filepath.Join(dir, name)
		raw, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(path, append(append([]byte(nil), raw...), ' '), 0600); e != nil {
			t.Fatal(e)
		}
		if check() == nil {
			t.Fatal("changed observation accepted", name)
		}
		if e = os.Remove(path); e != nil {
			t.Fatal(e)
		}
		if check() == nil {
			t.Fatal("missing observation accepted", name)
		}
		if e = os.WriteFile(path, raw, 0600); e != nil {
			t.Fatal(e)
		}
	}
	if e := os.WriteFile(filepath.Join(dir, "guest_command_observation_unknown.valid.json"), []byte(`{}`), 0600); e != nil {
		t.Fatal(e)
	}
	if check() == nil {
		t.Fatal("unknown observation accepted")
	}
}
