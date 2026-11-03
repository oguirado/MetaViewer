package ipc

import "encoding/json"

// EnvelopeSchema selects an explicit contract identity; validation is separate.
// Both identities share the authenticated connection and sender replay domain.
func EnvelopeSchema(body json.RawMessage) string {
	var h struct {
		Schema string `json:"schema"`
	}
	if json.Unmarshal(body, &h) == nil {
		switch h.Schema {
		case "rewind_request/v0.2", "rewind_event/v0.2":
			return "rewind_envelope/v0.2"
		case "headless_request/v0.2", "headless_event/v0.2", "guest_command_request/v0.2", "guest_command_event/v0.2":
			return "capsule_envelope/v0.2"
		}
	}
	return "envelope/v0.2"
}
