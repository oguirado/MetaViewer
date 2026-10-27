package ipc

// [TARGET, unit decision] Registration supplies the trusted session/endpoints.
// The client sends hello first, matching the core transport handshake. Core
// messages must retain that binding; reconnect/session migration is not implicit.
// [TARGET, unit decision] Control operations preempt in-flight data while barrier
// gates ensure data queued after take_control/release_control waits for completion;
// lanes drain before session cancellation on clean EOF while validation/route/schema/auth
// failures cancel the session first, and sessionErr is checked on every read-loop exit.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
)

// Connect uses a core-to-daemon registration as the reply context for Wrap;
// registration.Body is the locally configured daemon hello, never peer data.
func Connect(ctx context.Context, cfg Config, policy Policy, registration Envelope, handler Handler) error {
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
	cred, err := PeerCred(unix)
	if err != nil || !PeerAdmitted(cred, cfg.UID) {
		return errors.New("core peer credentials refused")
	}
	framer, err := NewFramer(conn, cfg)
	if err != nil {
		return err
	}
	var outbound sync.Mutex
	var authority sync.Mutex
	write := func(writeCtx context.Context, in Envelope, body json.RawMessage) error {
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
	helloCtx, cancelHello := context.WithTimeout(ctx, cfg.HelloTimeout)
	defer cancelHello()
	if _, err = handler(helloCtx, registration); err != nil {
		return err
	}
	if err = write(helloCtx, registration, registration.Body); err != nil {
		return err
	}
	cancelHello()
	type queuedEnvelope struct {
		in   Envelope
		wait <-chan struct{}
		done chan struct{}
	}
	dataCh := make(chan queuedEnvelope, 64)
	ctrlCh := make(chan queuedEnvelope, 64)
	var errOnce sync.Once
	var sessionErr error
	fail := func(e error) {
		if e != nil {
			errOnce.Do(func() {
				sessionErr = e
				cancelSession()
			})
		}
	}
	dispatch := func(in Envelope) {
		replies, err := handler(ctx, in)
		if err != nil {
			fail(fmt.Errorf("dispatch: %w", err))
			return
		}
		for _, reply := range replies {
			if err = write(ctx, in, reply); err != nil {
				if ctx.Err() == nil {
					fail(err)
				}
				return
			}
		}
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for item := range dataCh {
			if item.wait != nil {
				select {
				case <-item.wait:
				case <-ctx.Done():
					return
				}
			}
			if ctx.Err() != nil {
				return
			}
			dispatch(item.in)
		}
	}()
	go func() {
		defer wg.Done()
		for item := range ctrlCh {
			if ctx.Err() != nil {
				close(item.done)
				return
			}
			dispatch(item.in)
			close(item.done)
		}
	}()
	stopWorkers := sync.OnceFunc(func() {
		close(dataCh)
		close(ctrlCh)
		wg.Wait()
		cancelSession()
	})
	defer stopWorkers()
	exitLoop := func(loopErr error) error {
		visited := ctx.Err() != nil
		stopWorkers()
		if sessionErr != nil {
			return sessionErr
		}
		if visited {
			return nil
		}
		return loopErr
	}
	first := true
	var ctrlGate <-chan struct{}
	for {
		raw, err := framer.Read(ctx)
		if err != nil {
			return exitLoop(err)
		}
		in, err := policy.ValidateEnvelope(raw)
		if err != nil {
			fail(err)
			return exitLoop(err)
		}
		var body struct{ Schema, Component string }
		if err = json.Unmarshal(in.Body, &body); err != nil {
			fail(err)
			return exitLoop(err)
		}
		if in.Schema != "envelope/v0.2" || in.From != registration.From || in.To != registration.To || in.SessionID != registration.SessionID || in.Seq == 0 || in.Nonce == "" {
			err = errors.New("registered core route refused")
			fail(err)
			return exitLoop(err)
		}
		isHello := first && body.Schema == "hello/v0.2" && body.Component == "core"
		if !isHello && body.Schema != "surface_request/v0.2" {
			err = errors.New("core surface request required")
			fail(err)
			return exitLoop(err)
		}
		authority.Lock()
		err = policy.Authenticate(ctx, cred, in)
		if err == nil {
			err = policy.Reserve(ctx, SenderKey{in.SessionID, in.From.Component, in.From.Instance}, in.Seq, in.Nonce)
		}
		authority.Unlock()
		if err != nil {
			fail(err)
			return exitLoop(err)
		}
		first = false
		if isHello {
			continue
		}
		var op struct{ Op string }
		_ = json.Unmarshal(in.Body, &op)
		target := dataCh
		item := queuedEnvelope{in: in, wait: ctrlGate}
		if op.Op == "take_control" || op.Op == "release_control" {
			done := make(chan struct{})
			ctrlGate = done
			item = queuedEnvelope{in: in, done: done}
			target = ctrlCh
		}
		select {
		case target <- item:
		case <-ctx.Done():
			return exitLoop(nil)
		}
	}
}
