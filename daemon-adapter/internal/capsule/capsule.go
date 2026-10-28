package capsule

// [TARGET, unit decision] GroundTruth models the contracts/v0.2 observation.ground_truth
// witness ({source:"holdings_lane", state_sha256, tick}) and parses native
// Holdings observe JSON strictly (hex64 state_sha256, tick in 0..9007199254740991).
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"metaviewer/daemon-adapter/internal/cli"
	"strconv"
	"unicode/utf8"
)

const MaxHoldingsTick uint64 = 9007199254740991
const MaxHoldingsStateBytes int = 1 << 20
const maxHoldingsStateDepth int = 64

type GroundTruth struct {
	Source      string `json:"source"`
	StateSHA256 string `json:"state_sha256"`
	Tick        uint64 `json:"tick"`
	State       string `json:"-"`
}

func ValidateGroundTruth(gt *GroundTruth) error {
	if gt == nil || gt.Source != "holdings_lane" || !digest.MatchString(gt.StateSHA256) || gt.Tick > MaxHoldingsTick {
		return errors.New("invalid holdings ground truth")
	}
	if gt.State != "" {
		if len(gt.State) > MaxHoldingsStateBytes || validateHoldingsStateJSON([]byte(gt.State)) != nil {
			return errors.New("invalid holdings ground truth state")
		}
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

func validateHoldingsStateJSON(raw []byte) error {
	if len(raw) == 0 || len(raw) > MaxHoldingsStateBytes || !utf8.Valid(raw) {
		return errors.New("holdings state size or utf8 invalid")
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errors.New("holdings state must be a JSON object")
	}
	p := stateJSONValidator{src: trimmed}
	if err := p.parseValue(0); err != nil {
		return err
	}
	p.skipWS()
	if p.pos != len(p.src) {
		return errors.New("trailing bytes in holdings state")
	}
	return nil
}

type stateJSONValidator struct {
	src []byte
	pos int
}

func (p *stateJSONValidator) skipWS() {
	for p.pos < len(p.src) {
		switch p.src[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *stateJSONValidator) parseValue(depth int) error {
	if depth > maxHoldingsStateDepth {
		return errors.New("holdings state exceeds max depth")
	}
	p.skipWS()
	if p.pos >= len(p.src) {
		return errors.New("unexpected end of holdings state")
	}
	switch p.src[p.pos] {
	case '{':
		return p.parseObject(depth)
	case '[':
		return p.parseArray(depth)
	case '"':
		return p.parseString()
	case 't':
		return p.parseLiteral("true")
	case 'f':
		return p.parseLiteral("false")
	case 'n':
		return p.parseLiteral("null")
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		return p.parseInteger()
	default:
		return errors.New("unexpected token in holdings state")
	}
}

func (p *stateJSONValidator) parseLiteral(lit string) error {
	if p.pos+len(lit) > len(p.src) || string(p.src[p.pos:p.pos+len(lit)]) != lit {
		return errors.New("invalid literal in holdings state")
	}
	p.pos += len(lit)
	return nil
}

func (p *stateJSONValidator) parseObject(depth int) error {
	p.pos++ // '{'
	p.skipWS()
	if p.pos < len(p.src) && p.src[p.pos] == '}' {
		p.pos++
		return nil
	}
	seen := make(map[string]struct{})
	for {
		p.skipWS()
		if p.pos >= len(p.src) || p.src[p.pos] != '"' {
			return errors.New("expected object key in holdings state")
		}
		start := p.pos
		if err := p.parseString(); err != nil {
			return err
		}
		var key string
		if err := json.Unmarshal(p.src[start:p.pos], &key); err != nil {
			return err
		}
		if _, dup := seen[key]; dup {
			return errors.New("duplicate key in holdings state")
		}
		seen[key] = struct{}{}
		p.skipWS()
		if p.pos >= len(p.src) || p.src[p.pos] != ':' {
			return errors.New("expected ':' in holdings state")
		}
		p.pos++
		if err := p.parseValue(depth + 1); err != nil {
			return err
		}
		p.skipWS()
		if p.pos >= len(p.src) {
			return errors.New("unterminated object in holdings state")
		}
		if p.src[p.pos] == ',' {
			p.pos++
			continue
		}
		if p.src[p.pos] == '}' {
			p.pos++
			return nil
		}
		return errors.New("expected ',' or '}' in holdings state")
	}
}

func (p *stateJSONValidator) parseArray(depth int) error {
	p.pos++ // '['
	p.skipWS()
	if p.pos < len(p.src) && p.src[p.pos] == ']' {
		p.pos++
		return nil
	}
	for {
		if err := p.parseValue(depth + 1); err != nil {
			return err
		}
		p.skipWS()
		if p.pos >= len(p.src) {
			return errors.New("unterminated array in holdings state")
		}
		if p.src[p.pos] == ',' {
			p.pos++
			continue
		}
		if p.src[p.pos] == ']' {
			p.pos++
			return nil
		}
		return errors.New("expected ',' or ']' in holdings state")
	}
}

func (p *stateJSONValidator) parseString() error {
	start := p.pos
	p.pos++ // '"'
	for p.pos < len(p.src) {
		b := p.src[p.pos]
		if b == '"' {
			p.pos++
			var s string
			return json.Unmarshal(p.src[start:p.pos], &s)
		}
		if b == '\\' {
			p.pos += 2
			continue
		}
		if b < 0x20 {
			return errors.New("unescaped control char in holdings state")
		}
		p.pos++
	}
	return errors.New("unterminated string in holdings state")
}

func (p *stateJSONValidator) parseInteger() error {
	if p.src[p.pos] == '-' {
		p.pos++
	}
	digitsStart := p.pos
	if p.pos >= len(p.src) {
		return errors.New("missing digits in holdings state integer")
	}
	if p.src[p.pos] == '0' {
		p.pos++
		if p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
			return errors.New("leading zero in holdings state integer")
		}
	} else if p.src[p.pos] >= '1' && p.src[p.pos] <= '9' {
		for p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
			p.pos++
		}
	} else {
		return errors.New("invalid integer in holdings state")
	}
	if p.pos < len(p.src) && (p.src[p.pos] == '.' || p.src[p.pos] == 'e' || p.src[p.pos] == 'E') {
		return errors.New("float or exponent forbidden in holdings state")
	}
	digits := string(p.src[digitsStart:p.pos])
	v, err := strconv.ParseUint(digits, 10, 64)
	if err != nil || v > MaxHoldingsTick {
		return errors.New("integer out of safe range in holdings state")
	}
	return nil
}

func extractHoldingsObserveState(stateField, obsField json.RawMessage) (string, error) {
	if len(stateField) > 0 && len(obsField) > 0 {
		return "", errors.New("ambiguous holdings observe state")
	}
	raw := stateField
	if len(obsField) > 0 {
		trimmedObs := bytes.TrimSpace(obsField)
		if len(trimmedObs) == 0 || trimmedObs[0] != '{' {
			return "", errors.New("invalid holdings observation wrapper")
		}
		var nested struct {
			State json.RawMessage `json:"state"`
		}
		dec := json.NewDecoder(bytes.NewReader(trimmedObs))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&nested); err != nil || dec.More() || len(nested.State) == 0 {
			return "", errors.New("invalid holdings observation.state")
		}
		raw = nested.State
	}
	if len(raw) == 0 {
		return "", nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(raw) > MaxHoldingsStateBytes || len(trimmed) == 0 || len(trimmed) > MaxHoldingsStateBytes {
		return "", errors.New("holdings observe state exceeds 1 MiB cap")
	}
	if err := validateHoldingsStateJSON(trimmed); err != nil {
		return "", err
	}
	return string(trimmed), nil
}

func ParseHoldingsObserve(raw []byte, maxBytes int) (*GroundTruth, error) {
	fail := func(detail string) (*GroundTruth, error) {
		return nil, fault("malformed_cli", detail)
	}
	if maxBytes <= 0 {
		maxBytes = MaxHoldingsStateBytes + (64 << 10)
	}
	if len(raw) == 0 || len(raw) > maxBytes || !utf8.Valid(raw) {
		return fail("CLI output is not a bounded closed JSON object")
	}
	line := bytes.TrimSuffix(raw, []byte{'\n'})
	trimmedLine := bytes.TrimSpace(line)
	if len(trimmedLine) == 0 || bytes.ContainsAny(line, "\r\n") || trimmedLine[0] != '{' {
		return fail("CLI output is not a bounded closed JSON object")
	}
	var obs struct {
		StateSHA256      string          `json:"state_sha256"`
		Tick             json.RawMessage `json:"tick"`
		Revision         json.RawMessage `json:"revision,omitempty"`
		FrameStateSHA256 json.RawMessage `json:"frame_state_sha256,omitempty"`
		Elements         json.RawMessage `json:"elements,omitempty"`
		State            json.RawMessage `json:"state,omitempty"`
		Observation      json.RawMessage `json:"observation,omitempty"`
	}
	dec := json.NewDecoder(bytes.NewReader(trimmedLine))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&obs); err != nil || dec.More() {
		return fail("CLI output is not a bounded closed JSON object")
	}
	var tail any
	if err := dec.Decode(&tail); !errors.Is(err, io.EOF) {
		return fail("CLI output is not a bounded closed JSON object")
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
	stateJSON, err := extractHoldingsObserveState(obs.State, obs.Observation)
	if err != nil {
		return nil, fault("malformed_cli", err.Error())
	}
	gt := &GroundTruth{
		Source:      "holdings_lane",
		StateSHA256: obs.StateSHA256,
		Tick:        tick,
		State:       stateJSON,
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
