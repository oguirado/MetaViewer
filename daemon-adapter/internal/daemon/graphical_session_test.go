package daemon

import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/ipc"
	"testing"
)

func TestGraphicalDispatchRefusesNonCoreBeforeManager(t *testing.T) {
	for _, component := range []string{"ui", "agent", "adapter"} {
		_, err := dispatchGraphicalSession(context.Background(), nil, nil, nil, ipc.Envelope{From: ipc.Endpoint{Component: component}, Body: json.RawMessage(`{"schema":"graphical_session_request/v0.2"}`)})
		if err == nil {
			t.Fatalf("%s bypassed core authority", component)
		}
	}
}
