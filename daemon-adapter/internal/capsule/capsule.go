package capsule

// [TARGET, unit decision] GroundTruth models the contracts/v0.2 observation.ground_truth
// witness ({source:"holdings_lane", state_sha256, tick}) and parses native
// Holdings observe JSON strictly (hex64 state_sha256, tick in 0..9007199254740991).
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"metaviewer/daemon-adapter/internal/cli"
	"strconv"
)

const MaxHoldingsTick uint64 = 9007199254740991

type GroundTruth struct {
	Source      string `json:"source"`
	StateSHA256 string `json:"state_sha256"`
	Tick        uint64 `json:"tick"`
}

func ValidateGroundTruth(gt *GroundTruth) error {
	if gt == nil || gt.Source != "holdings_lane" || !digest.MatchString(gt.StateSHA256) || gt.Tick > MaxHoldingsTick {
		return errors.New("invalid holdings ground truth")
	}
	return nil
}

func parseHoldingsUint53(raw json.RawMessage) (uint64, error) {
	b := bytes.TrimSpace(raw)
	if len(b) == 0 || (len(b) > 1 && b[0] == '0') {
		return 0, errors.New("invalid integer token")
	}
	for _, c := range b {
		if c < '0' || c > '9' {
			return 0, errors.New("non-digit integer token")
		}
	}
	v, err := strconv.ParseUint(string(b), 10, 64)
	if err != nil || v > MaxHoldingsTick {
		return 0, errors.New("integer token out of range")
	}
	return v, nil
}

func ParseHoldingsObserve(raw []byte, maxBytes int) (*GroundTruth, error) {
	var obs struct {
		StateSHA256      string          `json:"state_sha256"`
		Tick             json.RawMessage `json:"tick"`
		Revision         json.RawMessage `json:"revision,omitempty"`
		FrameStateSHA256 json.RawMessage `json:"frame_state_sha256,omitempty"`
		Elements         json.RawMessage `json:"elements,omitempty"`
	}
	if err := cli.ParseLine(raw, maxBytes, &obs); err != nil {
		return nil, err
	}
	if !digest.MatchString(obs.StateSHA256) {
		return nil, fault("malformed_cli", "invalid holdings state_sha256")
	}
	tick, err := parseHoldingsUint53(obs.Tick)
	if err != nil {
		return nil, fault("malformed_cli", "invalid holdings tick")
	}
	if len(obs.Revision) > 0 {
		if _, err := parseHoldingsUint53(obs.Revision); err != nil {
			return nil, fault("malformed_cli", "invalid holdings revision")
		}
	}
	if len(obs.FrameStateSHA256) > 0 {
		trimmed := bytes.TrimSpace(obs.FrameStateSHA256)
		var frameStateSHA string
		if len(trimmed) == 0 || trimmed[0] != '"' || json.Unmarshal(trimmed, &frameStateSHA) != nil || !digest.MatchString(frameStateSHA) {
			return nil, fault("malformed_cli", "invalid holdings frame_state_sha256")
		}
	}
	if len(obs.Elements) > 0 {
		trimmed := bytes.TrimSpace(obs.Elements)
		if len(trimmed) == 0 || trimmed[0] != '[' {
			return nil, fault("malformed_cli", "invalid holdings elements")
		}
		var elems []json.RawMessage
		if err := json.Unmarshal(trimmed, &elems); err != nil {
			return nil, fault("malformed_cli", "invalid holdings elements")
		}
	}
	gt := &GroundTruth{
		Source:      "holdings_lane",
		StateSHA256: obs.StateSHA256,
		Tick:        tick,
	}
	if err := ValidateGroundTruth(gt); err != nil {
		return nil, fault("malformed_cli", err.Error())
	}
	return gt, nil
}

type Request struct {
	Schema string          `json:"schema"`
	Op     string          `json:"op"`
	Params json.RawMessage `json:"params"`
}
type ErrorData struct {
	SurfaceID string `json:"surface_id"`
	Code      string `json:"code"`
	Detail    string `json:"detail"`
}
type ErrorEvent struct {
	Schema string    `json:"schema"`
	Event  string    `json:"event"`
	Data   ErrorData `json:"data"`
}

func NewErrorEvent(surfaceID string, fault *cli.Fault) (ErrorEvent, error) {
	if surfaceID == "" || len(surfaceID) > 128 || fault == nil || fault.Code == "" || len(fault.Code) > 128 || fault.Detail == "" || len(fault.Detail) > 65536 {
		return ErrorEvent{}, errors.New("error event requires supplied surface identity and fault")
	}
	return ErrorEvent{Schema: "surface_event/v0.1", Event: "error", Data: ErrorData{SurfaceID: surfaceID, Code: fault.Code, Detail: fault.Detail}}, nil
}

type Backend interface {
	Handle(context.Context, Request) ([]json.RawMessage, error)
}

// New retains the skeleton seam. Runtime configuration is explicit in NewManager.
func New(r cli.Runner, clock cli.Clock) Backend { return unconfigured{} }

type unconfigured struct{}

func (unconfigured) Handle(ctx context.Context, r Request) ([]json.RawMessage, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	return nil, &cli.Fault{Code: "configuration", Detail: "native profile and session configuration required"}
}
