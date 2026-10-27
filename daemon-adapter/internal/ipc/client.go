package ipc

// [TARGET, unit decision] Registration supplies the trusted session/endpoints.
// The client sends hello first, matching the core transport handshake. Core
// messages must retain that binding; reconnect/session migration is not implicit.
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
	dataCh := make(chan Envelope, 64)
	ctrlCh := make(chan Envelope, 64)
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
		for in := range dataCh {
			if ctx.Err() != nil {
				return
			}
			dispatch(in)
		}
	}()
	go func() {
		defer wg.Done()
		for in := range ctrlCh {
			if ctx.Err() != nil {
				return
			}
			dispatch(in)
		}
	}()
	stopWorkers := sync.OnceFunc(func() {
		cancelSession()
		close(dataCh)
		close(ctrlCh)
		wg.Wait()
	})
	defer stopWorkers()
	first := true
	for {
		raw, err := framer.Read(ctx)
		if err != nil {
			visited := ctx.Err() != nil
			stopWorkers()
			if sessionErr != nil {
				return sessionErr
			}
			if visited {
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
		authority.Lock()
		err = policy.Authenticate(ctx, cred, in)
		if err == nil {
			err = policy.Reserve(ctx, SenderKey{in.SessionID, in.From.Component, in.From.Instance}, in.Seq, in.Nonce)
		}
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
		target := dataCh
		if op.Op == "take_control" || op.Op == "release_control" {
			target = ctrlCh
		}
		select {
		case target <- in:
		case <-ctx.Done():
			stopWorkers()
			if sessionErr != nil {
				return sessionErr
			}
			return nil
		}
	}
}
