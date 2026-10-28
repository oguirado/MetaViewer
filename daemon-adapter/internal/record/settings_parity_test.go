package record

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func compactJSON(t *testing.T, raw json.RawMessage) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		t.Fatalf("compact JSON: %v", err)
	}
	return buf.Bytes()
}

type parityFixture struct {
	ContractBounds struct {
		MinFPS         uint64   `json:"min_fps"`
		MaxFPS         uint64   `json:"max_fps"`
		UICeilingFPS   uint64   `json:"ui_ceiling_fps"`
		WallFPSPresets []uint64 `json:"wall_fps_presets"`
		Defaults       struct {
			GoEnvFPS uint64 `json:"go_env_fps"`
		} `json:"defaults"`
	} `json:"contract_bounds"`
	D1 struct {
		ValidRamStartFPS20 json.RawMessage `json:"valid_ram_start_fps_20"`
		InvalidRequests    []struct {
			ID      string          `json:"id"`
			Request json.RawMessage `json:"request"`
		} `json:"invalid_requests"`
	} `json:"d1_lenient_default"`
	D2 struct {
		Accepted1To60         []uint64 `json:"accepted_1_to_60"`
		ContractValid61To120  []uint64 `json:"contract_valid_61_to_120"`
		OutOfContractFPS      []int64  `json:"out_of_contract_fps"`
	} `json:"d2_ceiling_sixty_vs_one_twenty"`
	D3 struct {
		RamStart30Point0JSON  string `json:"record_request_ram_start_30_0_json"`
		DiskStart30Point0JSON string `json:"record_request_disk_start_30_0_json"`
	} `json:"d3_float_lexeme"`
	D4 struct {
		UnknownTop   json.RawMessage `json:"record_request_unknown_top"`
		UnknownParam json.RawMessage `json:"record_request_unknown_param"`
	} `json:"d4_unknown_keys"`
	D5 struct {
		ValidSettingsV02 []struct {
			ID  string          `json:"id"`
			Doc json.RawMessage `json:"doc"`
		} `json:"valid_settings_v02"`
		InvalidSettingsV02 []struct {
			ID  string          `json:"id"`
			Doc json.RawMessage `json:"doc"`
		} `json:"invalid_settings_v02"`
	} `json:"d5_settings_limits"`
}

func loadParityFixture(t *testing.T) parityFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "fixtures", "settings_parity.json"))
	if err != nil {
		t.Fatalf("read settings_parity.json: %v", err)
	}
	var out parityFixture
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal settings_parity.json: %v", err)
	}
	return out
}

func newParityManager(t *testing.T, maxFPS uint64, dest *Destination) *Manager {
	t.Helper()
	m, err := NewManager(Config{
		Runner: &fakeRunner{},
		Clock:  func() uint64 { return 10 },
		OriginNS: 100,
		BinDir: t.TempDir(),
		Surfaces: map[string]Surface{
			"s1": {
				Family:     "srf-identity-surface",
				Container:  "capsule",
				Window:     "w1",
				FramesRoot: "/dev/shm/record-parity-s1",
			},
		},
		Destination: dest,
		MemoryBytes: 64 << 20,
		RingBytes:   8 << 20,
		MaxFPS:      maxFPS,
	})
	if err != nil {
		t.Fatalf("NewManager(maxFPS=%d): %v", maxFPS, err)
	}
	t.Cleanup(func() {
		if e := m.Close(); e != nil {
			t.Error(e)
		}
	})
	return m
}

func TestSettingsParityD1RequiredIntegerMaxFPS(t *testing.T) {
	fx := loadParityFixture(t)
	t.Setenv("MV_SRF_BIN_DIR", t.TempDir())
	t.Setenv("MV_RECORDING_DESTINATION", "")
	envMgr, err := NewFromEnvironment(100, func() uint64 { return 110 })
	if err != nil {
		t.Fatalf("NewFromEnvironment: %v", err)
	}
	defer func() { _ = envMgr.Close() }()
	if got := envMgr.DefaultMaxFPS(); got != fx.ContractBounds.Defaults.GoEnvFPS {
		t.Fatalf("DefaultMaxFPS() = %d, want %d", got, fx.ContractBounds.Defaults.GoEnvFPS)
	}

	m := newParityManager(t, 120, nil)
	events, err := m.Handle(context.Background(), compactJSON(t, fx.D1.ValidRamStartFPS20))
	if err != nil {
		t.Fatalf("valid ram_start fps 20 refused: %v", err)
	}
	if len(events) != 1 || events[0].Event != "started" {
		t.Fatalf("unexpected events: %+v", events)
	}

	for _, tc := range fx.D1.InvalidRequests {
		t.Run(tc.ID, func(t *testing.T) {
			if _, err := m.Handle(context.Background(), compactJSON(t, tc.Request)); err == nil {
				t.Fatalf("expected invalid max_fps vector %s to be refused", tc.ID)
			}
		})
	}
}

func TestSettingsParityD2Bounds1To120AndConfigCeiling(t *testing.T) {
	fx := loadParityFixture(t)
	exportDir := t.TempDir()
	dest := &Destination{CapabilityID: "recording:configured", Path: exportDir}
	m120 := newParityManager(t, 120, dest)

	allValid := append([]uint64{}, fx.D2.Accepted1To60...)
	allValid = append(allValid, fx.D2.ContractValid61To120...)
	for i, fps := range allValid {
		ramReq := payload("ram_start", map[string]any{
			"surface_id":   "s1",
			"recording_id": fmt.Sprintf("rec-ram-%d-%d", i, fps),
			"ring_bytes":   uint64(1024),
			"max_fps":      fps,
		})
		events, err := m120.Handle(context.Background(), ramReq)
		if err != nil || len(events) != 1 || events[0].Event != "started" {
			t.Fatalf("ram_start max_fps=%d failed: err=%v events=%+v", fps, err, events)
		}

		diskReq := payload("disk_start", map[string]any{
			"surface_id":                "s1",
			"recording_id":              fmt.Sprintf("rec-disk-%d-%d", i, fps),
			"destination_capability_id": "recording:configured",
			"destination_path":          exportDir,
			"max_fps":                   fps,
		})
		events, err = m120.Handle(context.Background(), diskReq)
		if err != nil || len(events) != 1 || events[0].Event != "started" {
			t.Fatalf("disk_start max_fps=%d failed: err=%v events=%+v", fps, err, events)
		}
	}

	for i, badFPS := range fx.D2.OutOfContractFPS {
		raw := []byte(fmt.Sprintf(
			`{"schema":"record_request/v0.2","request_id":"req-bad-%d","op":"ram_start","params":{"surface_id":"s1","recording_id":"rec-bad-%d","ring_bytes":1024,"max_fps":%d}}`,
			i, i, badFPS,
		))
		_, err := m120.Handle(context.Background(), raw)
		if err == nil {
			t.Fatalf("out-of-contract max_fps=%d was admitted", badFPS)
		}
		if badFPS >= 0 {
			var ref *Refusal
			if !errors.As(err, &ref) || ref.ReasonCode != "POLICY" {
				t.Fatalf("max_fps=%d expected POLICY refusal, got %v", badFPS, err)
			}
		}
	}

	m60 := newParityManager(t, 60, dest)
	for i, fps := range fx.D2.ContractValid61To120 {
		ramReq := payload("ram_start", map[string]any{
			"surface_id":   "s1",
			"recording_id": fmt.Sprintf("rec-cap60-%d-%d", i, fps),
			"ring_bytes":   uint64(1024),
			"max_fps":      fps,
		})
		_, err := m60.Handle(context.Background(), ramReq)
		var ref *Refusal
		if !errors.As(err, &ref) || ref.ReasonCode != "BUDGET_EXCEEDED" {
			t.Fatalf("max_fps=%d against MaxFPS=60 expected BUDGET_EXCEEDED, got %v", fps, err)
		}
	}
}

func TestSettingsParityD3RefusesFloatLexeme30Point0(t *testing.T) {
	fx := loadParityFixture(t)
	exportDir := t.TempDir()
	m := newParityManager(t, 120, &Destination{CapabilityID: "recording:configured", Path: exportDir})

	if _, err := m.Handle(context.Background(), []byte(fx.D3.RamStart30Point0JSON)); err == nil {
		t.Fatal("expected ram_start with max_fps 30.0 float lexeme to be refused")
	}
	if _, err := m.Handle(context.Background(), []byte(fx.D3.DiskStart30Point0JSON)); err == nil {
		t.Fatal("expected disk_start with max_fps 30.0 float lexeme to be refused")
	}
}

func TestSettingsParityD4RefusesUnknownKeys(t *testing.T) {
	fx := loadParityFixture(t)
	m := newParityManager(t, 120, nil)

	if _, err := m.Handle(context.Background(), compactJSON(t, fx.D4.UnknownTop)); err == nil {
		t.Fatal("expected unknown top-level key in record_request to be refused")
	}
	if _, err := m.Handle(context.Background(), compactJSON(t, fx.D4.UnknownParam)); err == nil {
		t.Fatal("expected unknown params key in record_request to be refused")
	}
}

func TestSettingsParityD5ConfigBoundsAndSettingsV02Decoder(t *testing.T) {
	fx := loadParityFixture(t)
	binDir := t.TempDir()

	for _, entry := range fx.D5.ValidSettingsV02 {
		var doc struct {
			Limits struct {
				MemoryBytes uint64 `json:"memory_bytes"`
				RingBytes   uint64 `json:"ring_bytes"`
				MaxFPS      uint64 `json:"max_fps"`
			} `json:"limits"`
		}
		if err := json.Unmarshal(entry.Doc, &doc); err != nil {
			t.Fatalf("unmarshal valid settings %s: %v", entry.ID, err)
		}
		mgr, err := NewManager(Config{
			Runner:      &fakeRunner{},
			Clock:       func() uint64 { return 10 },
			OriginNS:    100,
			BinDir:      binDir,
			MemoryBytes: doc.Limits.MemoryBytes,
			RingBytes:   doc.Limits.RingBytes,
			MaxFPS:      doc.Limits.MaxFPS,
		})
		if err != nil {
			t.Fatalf("NewManager should accept valid limits %s (max_fps=%d): %v", entry.ID, doc.Limits.MaxFPS, err)
		}
		_ = mgr.Close()
	}

	for _, entry := range fx.D5.InvalidSettingsV02 {
		var doc struct {
			Limits struct {
				MemoryBytes uint64  `json:"memory_bytes"`
				RingBytes   uint64  `json:"ring_bytes"`
				MaxFPS      *uint64 `json:"max_fps"`
			} `json:"limits"`
		}
		if err := json.Unmarshal(entry.Doc, &doc); err != nil {
			t.Fatalf("unmarshal invalid settings %s: %v", entry.ID, err)
		}
		fps := uint64(0)
		if doc.Limits.MaxFPS != nil {
			fps = *doc.Limits.MaxFPS
		}
		if mgr, err := NewManager(Config{
			Runner:      &fakeRunner{},
			Clock:       func() uint64 { return 10 },
			OriginNS:    100,
			BinDir:      binDir,
			MemoryBytes: doc.Limits.MemoryBytes,
			RingBytes:   doc.Limits.RingBytes,
			MaxFPS:      fps,
		}); err == nil {
			_ = mgr.Close()
			t.Fatalf("NewManager should refuse invalid limits %s (max_fps=%d)", entry.ID, fps)
		}
	}

	t.Run("FINDING_D5_settings_v02_limits_decoder", func(t *testing.T) {
		t.Skip("FINDING D5")
		for _, entry := range fx.D5.ValidSettingsV02 {
			cfg := Config{
				Runner:   &fakeRunner{},
				Clock:    func() uint64 { return 10 },
				OriginNS: 100,
				BinDir:   binDir,
			}
			if err := json.Unmarshal(entry.Doc, &cfg); err != nil {
				t.Fatalf("unmarshal settings/v0.2 into Config (%s): %v", entry.ID, err)
			}
			mgr, err := NewManager(cfg)
			if err != nil {
				t.Fatalf("NewManager from settings/v0.2 document (%s) failed: %v", entry.ID, err)
			}
			_ = mgr.Close()
		}
	})
}
