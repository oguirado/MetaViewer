package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/ipc"
)

const roleSwitchSchema = "metaviewer.role_switch/v0.3"

var roleSwitchID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

type roleSwitchRequest struct {
	Schema    string `json:"schema"`
	RequestID string `json:"request_id"`
	SurfaceID string `json:"surface_id"`
	Role      string `json:"role"`
}

func parseRoleSwitch(e ipc.Envelope) (roleSwitchRequest, error) {
	var q roleSwitchRequest
	if e.From.Component != "core" {
		return q, errors.New("core role authority required")
	}
	if err := cli.ParseLine(e.Body, 1<<20, &q); err != nil {
		return q, err
	}
	if q.Schema != roleSwitchSchema || !roleSwitchID.MatchString(q.RequestID) || !roleSwitchID.MatchString(q.SurfaceID) || (q.Role != "human" && q.Role != "agent") {
		return q, errors.New("invalid role switch")
	}
	return q, nil
}
func roleSwitchReply(q roleSwitchRequest, err error) json.RawMessage {
	result := map[string]any{"schema": "metaviewer.role_switch_result/v0.3", "request_id": q.RequestID, "surface_id": q.SurfaceID, "role": q.Role, "ok": err == nil}
	if err != nil {
		result["code"] = capsule.WireCode(err)
	}
	raw, _ := json.Marshal(result)
	return raw
}
func dispatchRoleSwitch(ctx context.Context, m *capsule.Manager, e ipc.Envelope) ([]json.RawMessage, error) {
	q, err := parseRoleSwitch(e)
	if err != nil {
		return nil, err
	}
	surface, err := m.SwitchRole(ctx, q.SurfaceID, q.Role)
	if err != nil {
		return []json.RawMessage{roleSwitchReply(q, err)}, nil
	}
	changed, _ := json.Marshal(map[string]any{"schema": "surface_event/v0.2", "event": "state_changed", "data": map[string]any{"surface": surface}})
	return []json.RawMessage{changed, roleSwitchReply(q, nil)}, nil
}
