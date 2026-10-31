package ipc

import (
	"encoding/json"
	"strings"
)

// [TARGET, unit decision] One shared definition of the core liveness probe so the
// plain client and the production streaming path cannot drift apart again.
const keepalivePrefix = "core-keepalive-"

var keepaliveReply = json.RawMessage(`{"schema":"surface_event/v0.2","event":"error","data":{"surface_id":"daemon","code":"DAEMON_KEEPALIVE","detail":"core-keepalive"}}`)

// KeepaliveReply reports whether an already admitted envelope is the core's
// tagged liveness probe (surface_request/v0.2 op list, msg_id core-keepalive-*)
// and returns the fixed acknowledgement body. The probe is answered without
// enumerating surfaces or mutating capsule state; callers must not invoke the
// handler for it.
func KeepaliveReply(in Envelope) (json.RawMessage, bool) {
	if !strings.HasPrefix(in.MsgID, keepalivePrefix) {
		return nil, false
	}
	var probe struct{ Schema, Op string }
	if json.Unmarshal(in.Body, &probe) != nil || probe.Schema != "surface_request/v0.2" || probe.Op != "list" {
		return nil, false
	}
	return append(json.RawMessage(nil), keepaliveReply...), true
}
