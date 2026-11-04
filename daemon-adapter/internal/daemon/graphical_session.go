package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

// A distinct core-authenticated family; the MicroVM command handler is unchanged.
func dispatchGraphicalSession(ctx context.Context, m *capsule.Manager, profiles map[string]capsule.Profile, pubs map[string]*frames.Publisher, e ipc.Envelope) ([]json.RawMessage, error) {
	if e.From.Component != "core" {
		return nil, errors.New("core graphical session authority required")
	}
	var q capsule.GraphicalRequest
	if err := json.Unmarshal(e.Body, &q); err != nil {
		return nil, err
	}
	run := func(work context.Context, emit func(context.Context, []json.RawMessage) error) error {
		publish := func(b capsule.Binding, f capsule.NativeFrame) (string, uint64, error) {
			p, ok := profiles[b.Surface.ProfileID]
			if !ok {
				p, ok = m.ProfileFor(b.Surface.ProfileID)
			}
			if !ok || pubs[p.RAMRoot] == nil {
				return "", 0, errors.New("graphical frame publisher unavailable")
			}
			ref, err := pubs[p.RAMRoot].PublishForced(b.Surface.SurfaceID, b, f)
			if err != nil {
				return "", 0, err
			}
			raw, err := json.Marshal(ref)
			if err != nil {
				return "", 0, err
			}
			if err = emit(work, []json.RawMessage{raw}); err != nil {
				return "", 0, err
			}
			return ref.SHA256, ref.Generation, nil
		}
		raw, err := m.HandleGraphicalSession(work, e.Body, publish)
		if err != nil {
			m.CompleteGraphicalEmission(q.SurfaceID, q.RequestID, false)
			return err
		}
		if len(raw) == 0 {
			return nil
		} // Physical destroy superseded this operation.
		err = emit(work, []json.RawMessage{raw})
		m.CompleteGraphicalEmission(q.SurfaceID, q.RequestID, err == nil)
		return err
	}
	if stream, ok := ctx.Value(streamKey{}).(streamSession); ok {
		go func() {
			work, cancel := context.WithTimeout(stream.ctx, 30*time.Second)
			defer cancel()
			_ = run(work, func(ctx context.Context, rows []json.RawMessage) error {
				for _, row := range rows {
					if err := stream.emit(ctx, row); err != nil {
						return err
					}
				}
				return nil
			})
		}()
		return nil, nil
	}
	var out []json.RawMessage
	err := run(ctx, func(_ context.Context, rows []json.RawMessage) error { out = append(out, rows...); return nil })
	return out, err
}
