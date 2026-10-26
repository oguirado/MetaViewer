package daemon

// [TARGET, unit decision] The configured dispatch seam accepts an externally
// authenticated hello without replying. Create publishes one initial frame after
// creation, synchronously and with transport backpressure; continuous capture
// remains the responsibility of the existing subscription service.
import (
	"context"
	"encoding/json"
	"errors"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

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
		if err != nil || request.Op != "create" {
			return events, err
		}
		if len(events) != 1 {
			return nil, errors.New("create must return one surface")
		}
		var created struct {
			Data struct {
				Surface capsule.Surface `json:"surface"`
			} `json:"data"`
		}
		if err := json.Unmarshal(events[0], &created); err != nil {
			return nil, err
		}
		id := created.Data.Surface.SurfaceID
		binding, native, err := manager.Capture(ctx, id)
		if err != nil {
			return nil, err
		}
		ref, err := publisher.Publish(id, binding, native)
		if err != nil {
			return nil, err
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
