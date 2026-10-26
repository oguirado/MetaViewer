package daemon

// [TARGET, unit decision] Subscriptions share session lifetime and the profile's
// publisher. Unsubscribe and destroy drain before replying or reclaiming frames.
import (
	"context"
	"encoding/json"
	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

func subscriptionHandler(m *capsule.Manager, profiles map[string]capsule.Profile, subs map[string]*frames.Subscriptions, next ipc.Handler) ipc.Handler {
	return func(ctx context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
		var q capsule.Request
		if err := json.Unmarshal(e.Body, &q); err != nil {
			return nil, err
		}
		if q.Op != "frame_subscribe" && q.Op != "frame_unsubscribe" && q.Op != "destroy" {
			return next(ctx, e)
		}
		var p struct {
			SurfaceID string `json:"surface_id"`
		}
		fail := func(err error) ([]json.RawMessage, error) { return wireFailure(e, q, err) }
		if err := cli.ParseLine(q.Params, 1<<20, &p); err != nil {
			return fail(err)
		}

		// Drain before acquiring the manager mutex: an in-flight CLI capture holds
		// that mutex and can only finish promptly once its subscription is cancelled.
		if q.Op != "frame_subscribe" {
			for _, sub := range subs {
				if err := sub.Unsubscribe(ctx, p.SurfaceID); err != nil {
					return fail(err)
				}
			}
			if q.Op == "destroy" {
				return next(ctx, e)
			}
			return nil, nil
		}
		b, err := m.SubscriptionBinding(p.SurfaceID)
		if err != nil {
			return fail(err)
		}
		sub := subs[profiles[b.Surface.ProfileID].RAMRoot]
		if sub == nil {
			return fail(configuration("subscription publisher required"))
		}
		if err := sub.Subscribe(ctx, p.SurfaceID); err != nil {
			return fail(err)
		}
		return nil, nil
	}
}
