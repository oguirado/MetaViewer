package daemon

// [TARGET, unit decision] Registration supplies the trusted session/endpoints.
// The client sends hello first, matching the core transport handshake. Core
// messages must retain that binding; reconnect/session migration is not implicit.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"metaviewer/daemon-adapter/internal/ipc"
	"net"
	"sync"
)

// connectStreaming uses a core-to-daemon registration as the reply context for Wrap;
// registration.Body is the locally configured daemon hello, never peer data.
func connectStreaming(ctx context.Context, cfg ipc.Config, policy ipc.Policy, registration ipc.Envelope, handler ipc.Handler) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if policy == nil || handler == nil || registration.From.Component != "core" || registration.To.Component != "daemon" || registration.SessionID == "" {
		return errors.New("complete client registration required")
	}
	ctx, cancelSession := context.WithCancel(ctx)
	defer cancelSession()
	conn, err := (&net.Dialer{Timeout: cfg.HelloTimeout}).DialContext(ctx, "unix", cfg.SocketPath)
	if err != nil {
		return err
	}
	defer conn.Close()
	unix, ok := conn.(*net.UnixConn)
	if !ok {
		return errors.New("unix peer required")
	}
	cred, err := ipc.PeerCred(unix)
	if err != nil || !ipc.PeerAdmitted(cred, cfg.UID) {
		return errors.New("core peer credentials refused")
	}
	framer, err := ipc.NewFramer(conn, cfg)
	if err != nil {
		return err
	}
	var outbound sync.Mutex
	var authority sync.Mutex
	write := func(writeCtx context.Context, in ipc.Envelope, body json.RawMessage) error {
		outbound.Lock()
		defer outbound.Unlock()
		authority.Lock()
		out, err := policy.Wrap(writeCtx, in, body)
		authority.Unlock()
		if err != nil {
			return err
		}
		raw, err := json.Marshal(out)
		if err != nil {
			return err
		}
		if _, err = policy.ValidateEnvelope(raw); err != nil {
			return fmt.Errorf("outbound contract: %w", err)
		}
		return framer.Write(writeCtx, raw)
	}
	sessionCtx := ctx
	ctx = context.WithValue(ctx, streamKey{}, streamSession{ctx: ctx, work: &sync.Mutex{}, emit: func(c context.Context, body json.RawMessage) error {
		// Once a line starts, drain it under the session deadline: cancelling an
		// individual subscription must not interrupt framing or close the session.
		if err := c.Err(); err != nil {
			return err
		}
		delivery, stop := context.WithTimeout(sessionCtx, cfg.ShutdownTimeout)
		defer stop()
		err := write(delivery, registration, body)
		if err != nil {
			cancelSession()
		}
		return err
	}})
	helloCtx, cancelHello := context.WithTimeout(ctx, cfg.HelloTimeout)
	defer cancelHello()
	if _, err = handler(helloCtx, registration); err != nil {
		return err
	}
	if err = write(helloCtx, registration, registration.Body); err != nil {
		return err
	}
	cancelHello()
	first := true
	for {
		raw, err := framer.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		in, err := policy.ValidateEnvelope(raw)
		if err != nil {
			return err
		}
		var body struct{ Schema, Component string }
		if err = json.Unmarshal(in.Body, &body); err != nil {
			return err
		}
		if in.Schema != "envelope/v0.2" || in.From != registration.From || in.To != registration.To || in.SessionID != registration.SessionID || in.Seq == 0 || in.Nonce == "" {
			return errors.New("registered core route refused")
		}
		isHello := first && body.Schema == "hello/v0.2" && body.Component == "core"
		if !isHello && body.Schema != "surface_request/v0.2" {
			return errors.New("core surface request required")
		}
		if err = policy.Authenticate(ctx, cred, in); err != nil {
			return err
		}
		authority.Lock()
		err = policy.Reserve(ctx, ipc.SenderKey{SessionID: in.SessionID, Component: in.From.Component, Instance: in.From.Instance}, in.Seq, in.Nonce)
		authority.Unlock()
		if err != nil {
			return err
		}
		first = false
		if isHello {
			continue
		}
		var op struct{ Op string }
		_ = json.Unmarshal(in.Body, &op)
		work := ctx.Value(streamKey{}).(streamSession).work
		locked := op.Op != "frame_unsubscribe" && op.Op != "destroy"
		if locked {
			work.Lock()
		}
		replies, err := handler(ctx, in)
		// [TARGET, unit decision] Normalize enumeration at the common transport
		// seam: both runtime handlers return created snapshots for list, while
		// core admission correctly refuses duplicate creation commits.
		if err == nil && op.Op == "list" {
			replies, err = listSnapshots(replies)
		}
		if err != nil {
			if locked {
				work.Unlock()
			}
			return fmt.Errorf("dispatch: %w", err)
		}
		for _, reply := range replies {
			if err = write(ctx, in, reply); err != nil {
				if locked {
					work.Unlock()
				}
				if ctx.Err() != nil {
					return nil
				}
				return err
			}
		}
		if locked {
			work.Unlock()
		}
	}
}

// [TARGET, unit decision] Async delivery is session-bound, synchronous and bounded.
// Keep this transport seam in daemon until IPC exposes a public stream API.
type streamKey struct{}
type streamSession struct {
	ctx  context.Context
	work *sync.Mutex
	emit func(context.Context, json.RawMessage) error
}
