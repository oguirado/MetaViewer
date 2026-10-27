package daemon

// [TARGET, unit decision] The configured dispatch seam accepts an externally
// authenticated hello without replying. Create publishes one initial frame after
// creation, synchronously and with transport backpressure; continuous capture
// remains the responsibility of the existing subscription service.
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

// CreationError preserves the committed identity when initial capture fails,
// including when verified compensation cannot complete.
type CreationError struct {
	SurfaceID       string
	Cause, Rollback error
}

func (e *CreationError) Error() string {
	return fmt.Sprintf("initial frame for %s: %v; compensation: %v", e.SurfaceID, e.Cause, e.Rollback)
}
func (e *CreationError) Unwrap() error { return errors.Join(e.Cause, e.Rollback) }

func NewHandler(manager *capsule.Manager, publisher *frames.Publisher) (ipc.Handler, error) {
	if manager == nil || publisher == nil {
		return nil, errors.New("configured manager and publisher required")
	}
	return func(ctx context.Context, envelope ipc.Envelope) ([]json.RawMessage, error) {
		var header struct {
			Schema string `json:"schema"`
		}
		if err := json.Unmarshal(envelope.Body, &header); err != nil {
			return nil, err
		}
		if header.Schema == "hello/v0.2" {
			return nil, nil
		}
		var request capsule.Request
		if err := json.Unmarshal(envelope.Body, &request); err != nil {
			return nil, err
		}
		events, err := manager.Handle(ctx, request)
		if err == nil && strings.TrimSpace(request.Op) == "list" {
			return listSnapshots(events)
		}
		if err != nil || request.Op != "create" {
			return events, err
		}
		if len(events) != 1 {
			return nil, errors.New("create must return one surface")
		}
		var created struct {
			Schema string `json:"schema"`
			Event  string `json:"event"`
			Data   struct {
				Surface capsule.Surface `json:"surface"`
			} `json:"data"`
		}
		if err := json.Unmarshal(events[0], &created); err != nil {
			return nil, err
		}
		id := created.Data.Surface.SurfaceID
		// [TARGET, unit decision] Cleanup survives caller cancellation but remains
		// bounded; uncertain removal is reported with the committed identity.
		compensate := func(cause error) ([]json.RawMessage, error) {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			params, _ := json.Marshal(map[string]string{"surface_id": id})
			_, rollback := manager.Handle(cleanup, capsule.Request{Schema: "surface_request/v0.2", Op: "destroy", Params: params})
			return nil, &CreationError{SurfaceID: id, Cause: cause, Rollback: rollback}
		}
		binding, native, err := manager.Capture(ctx, id)
		if err != nil {
			return compensate(err)
		}
		// Initial capture may report a smaller window than start readiness.
		created.Data.Surface = binding.Surface
		events[0], err = json.Marshal(created)
		if err != nil {
			return compensate(err)
		}
		ref, err := publisher.Publish(id, binding, native)
		if err != nil {
			return compensate(err)
		}
		ready, err := json.Marshal(struct {
			Schema string `json:"schema"`
			Event  string `json:"event"`
			Data   struct {
				FrameRef frames.Ref `json:"frame_ref"`
			} `json:"data"`
		}{Schema: "surface_event/v0.2", Event: "frame_ready", Data: struct {
			FrameRef frames.Ref `json:"frame_ref"`
		}{ref}})
		return append(events, ready), err
	}, nil
}

func listSnapshots(events []json.RawMessage) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, 0, len(events))
	for _, raw := range events {
		var snapshot struct {
			Schema string          `json:"schema"`
			Event  string          `json:"event"`
			Data   json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(raw, &snapshot); err != nil {
			return nil, err
		}
		if snapshot.Schema == "surface_event/v0.2" && snapshot.Event == "error" {
			out = append(out, raw)
			continue
		}
		if snapshot.Schema != "surface_event/v0.2" || snapshot.Event != "created" {
			return nil, errors.New("invalid list snapshot")
		}
		var data struct {
			Surface capsule.Surface `json:"surface"`
		}
		decoder := json.NewDecoder(bytes.NewReader(snapshot.Data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&data); err != nil || data.Surface.SurfaceID == "" {
			return nil, errors.New("invalid list snapshot")
		}
		snapshot.Event = "state_changed"
		encoded, err := json.Marshal(snapshot)
		if err != nil {
			return nil, err
		}
		out = append(out, encoded)
	}
	return out, nil
}
