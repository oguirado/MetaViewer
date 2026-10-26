package ipc

import (
	"context"
	"encoding/json"
)

type Endpoint struct {
	Component string `json:"component"`
	Instance  string `json:"instance"`
}
type Envelope struct {
	Schema    string          `json:"schema"`
	MsgID     string          `json:"msg_id"`
	TsNS      uint64          `json:"ts_ns"`
	From      Endpoint        `json:"from"`
	To        Endpoint        `json:"to"`
	SessionID string          `json:"session_id"`
	Seq       uint64          `json:"seq"`
	Nonce     string          `json:"nonce"`
	Body      json.RawMessage `json:"body"`
}
type SenderKey struct{ SessionID, Component, Instance string }

// Policy is supplied by the authority integration. Reserve must survive reconnect and restart.
// ValidateEnvelope must validate the complete closed body before Reserve can run.
// Authenticate binds the sender instance and verifies the pinned hello.
// Wrap allocates the adapter's own sequence and identity.
type Policy interface {
	ValidateEnvelope([]byte) (Envelope, error)
	Authenticate(context.Context, PeerCredentials, Envelope) error
	Reserve(context.Context, SenderKey, uint64, string) error
	Wrap(context.Context, Envelope, json.RawMessage) (Envelope, error)
}
