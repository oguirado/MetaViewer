package daemon

// [TARGET, unit decision] Registration supplies the trusted session/endpoints.
// The client sends hello first, matching the core transport handshake. Core
// messages must retain that binding; reconnect/session migration is not implicit.
// [TARGET, unit decision] Control operations preempt in-flight data while barrier
// gates ensure data queued after take_control/release_control waits for completion;
// bounded FIFO data staging decouples socket reading from saturated dataCh so control
// frames are never head-of-line blocked behind dataCh; lanes drain before session
// cancellation on clean EOF while abnormal read/framing/validation/route/schema/auth
// failures cancel the session before worker join, and sessionErr is checked on exit.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	locks := &surfaceLocks{}
	ctx = context.WithValue(ctx, streamKey{}, streamSession{ctx: ctx, work: &sync.Mutex{}, locks: locks, emit: func(c context.Context, body json.RawMessage) error {
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
	type queuedEnvelope struct {
		in   ipc.Envelope
		wait <-chan struct{}
		done chan struct{}
	}
	const maxDataBacklog = 256
	dataIn := make(chan queuedEnvelope)
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
	dispatch := func(in ipc.Envelope, lock *sync.Mutex) {
		if lock != nil {
			lock.Lock()
		}
		replies, err := handler(ctx, in)
		if err != nil {
			if lock != nil {
				lock.Unlock()
			}
			fail(fmt.Errorf("dispatch: %w", err))
			return
		}
		for _, reply := range replies {
			if err = write(ctx, in, reply); err != nil {
				if lock != nil {
					lock.Unlock()
				}
				if ctx.Err() == nil {
					fail(err)
				}
				return
			}
		}
		if lock != nil {
			lock.Unlock()
		}
	}
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		defer close(dataCh)
		var pending []queuedEnvelope
		inCh := dataIn
		for inCh != nil || len(pending) > 0 {
			if ctx.Err() != nil {
				return
			}
			var outCh chan<- queuedEnvelope
			var next queuedEnvelope
			if len(pending) > 0 {
				outCh = dataCh
				next = pending[0]
			}
			curIn := inCh
			if len(pending) >= maxDataBacklog {
				curIn = nil
			}
			select {
			case <-ctx.Done():
				return
			case item, ok := <-curIn:
				if !ok {
					inCh = nil
					continue
				}
				pending = append(pending, item)
			case outCh <- next:
				pending[0] = queuedEnvelope{}
				pending = pending[1:]
				if len(pending) == 0 {
					pending = nil
				}
			}
		}
	}()
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
			var op struct {
				Op     string `json:"op"`
				Params struct {
					SurfaceID string `json:"surface_id"`
				} `json:"params"`
			}
			_ = json.Unmarshal(item.in.Body, &op)
			var lock *sync.Mutex
			if op.Op != "frame_unsubscribe" && op.Op != "destroy" && op.Op != "frame_subscribe" {
				session := ctx.Value(streamKey{}).(streamSession)
				if op.Params.SurfaceID != "" {
					lock = session.surfaceLock(op.Params.SurfaceID)
				} else {
					lock = session.work
				}
			}
			dispatch(item.in, lock)
		}
	}()
	go func() {
		defer wg.Done()
		for item := range ctrlCh {
			if ctx.Err() != nil {
				close(item.done)
				return
			}
			dispatch(item.in, nil)
			close(item.done)
		}
	}()
	stopWorkers := sync.OnceFunc(func() {
		close(dataIn)
		close(ctrlCh)
		wg.Wait()
		cancelSession()
	})
	defer stopWorkers()
	exitLoop := func(loopErr error) error {
		visited := ctx.Err() != nil
		if loopErr != nil && !visited && !errors.Is(loopErr, io.EOF) {
			fail(loopErr)
		}
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
			if ctx.Err() == nil && !errors.Is(err, io.EOF) {
				fail(err)
			}
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
		if !isHello && body.Schema != "surface_request/v0.2" && body.Schema != "record_request/v0.2" {
			err = errors.New("core surface request required")
			fail(err)
			return exitLoop(err)
		}
		authority.Lock()
		err = policy.Authenticate(ctx, cred, in)
		if err == nil {
			err = policy.Reserve(ctx, ipc.SenderKey{SessionID: in.SessionID, Component: in.From.Component, Instance: in.From.Instance}, in.Seq, in.Nonce)
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
		target := dataIn
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

// [TARGET, unit decision] Async delivery is session-bound, synchronous and bounded.
// Keep this transport seam in daemon until IPC exposes a public stream API.
type streamKey struct{}

type surfaceLocks struct {
	mu    sync.Mutex
	byID  map[string]*sync.Mutex
	other sync.Mutex
}

func (l *surfaceLocks) lock(id string) *sync.Mutex {
	if l == nil {
		return nil
	}
	if id == "" {
		return &l.other
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.byID == nil {
		l.byID = make(map[string]*sync.Mutex)
	}
	m := l.byID[id]
	if m == nil {
		m = &sync.Mutex{}
		l.byID[id] = m
	}
	return m
}

type streamSession struct {
	ctx   context.Context
	work  *sync.Mutex
	locks *surfaceLocks
	emit  func(context.Context, json.RawMessage) error
}

func (s streamSession) surfaceLock(id string) *sync.Mutex {
	if s.locks != nil {
		return s.locks.lock(id)
	}
	return s.work
}
