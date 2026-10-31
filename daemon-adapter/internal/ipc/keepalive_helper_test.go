package ipc

import (
	"encoding/json"
	"testing"
)

func TestKeepaliveReplyDetection(t *testing.T) {
	list := `{"schema":"surface_request/v0.2","op":"list","params":{}}`
	for name, tc := range map[string]struct {
		msgID, body string
		probe       bool
	}{
		"tagged list":         {"core-keepalive-1-8", list, true},
		"untagged list":       {"m-1", list, false},
		"near prefix":         {"core-keepalive", list, false},
		"tagged other op":     {"core-keepalive-2", `{"schema":"surface_request/v0.2","op":"destroy","params":{"surface_id":"s"}}`, false},
		"tagged wrong schema": {"core-keepalive-3", `{"schema":"record_request/v0.2","op":"list"}`, false},
		"tagged malformed":    {"core-keepalive-4", `[`, false},
	} {
		t.Run(name, func(t *testing.T) {
			body, ok := KeepaliveReply(Envelope{MsgID: tc.msgID, Body: json.RawMessage(tc.body)})
			if ok != tc.probe {
				t.Fatalf("probe=%v want %v", ok, tc.probe)
			}
			if ok && string(body) != `{"schema":"surface_event/v0.2","event":"error","data":{"surface_id":"daemon","code":"DAEMON_KEEPALIVE","detail":"core-keepalive"}}` {
				t.Fatalf("reply drifted: %s", body)
			}
			if !ok && body != nil {
				t.Fatalf("non-probe returned a body: %s", body)
			}
		})
	}
}

func TestKeepaliveReplyIsNotAliased(t *testing.T) {
	in := Envelope{MsgID: "core-keepalive-1", Body: json.RawMessage(`{"schema":"surface_request/v0.2","op":"list"}`)}
	first, _ := KeepaliveReply(in)
	first[0] = 'X'
	second, _ := KeepaliveReply(in)
	if second[0] != '{' {
		t.Fatal("shared reply buffer was mutated")
	}
}
