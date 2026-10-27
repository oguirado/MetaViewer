package ipc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

type Handler func(context.Context, Envelope) ([]json.RawMessage, error)

// [TARGET, unit decision] Serve cancels the parent context passed to every
// connection and handler on shutdown, closes the listener and all tracked client
// sockets, and waits up to cfg.ShutdownTimeout for active handler goroutines.
// If a ctx-ignoring handler exceeds ShutdownTimeout, Serve returns a deadline
// error rather than hanging; post-handler ctx.Err() checks prevent any late
// Authority.Wrap or socket write after cancellation, and defer conn.Close()
// reclaims the descriptor when the abandoned handler eventually returns.
// Serve requires externally supplied authority policy; it never substitutes a local replay map.
func Serve(ctx context.Context, listener *net.UnixListener, cfg Config, policy Policy, handler Handler, log io.Writer) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if listener == nil || policy == nil || handler == nil || log == nil {
		return errors.New("listener, complete policy, handler and log required")
	}
	defer CloseListener(listener)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var mu sync.Mutex
	var logMu sync.Mutex
	clients := make(map[*net.UnixConn]bool)
	var wg sync.WaitGroup
	refuse := func() { logMu.Lock(); defer logMu.Unlock(); fmt.Fprintln(log, "adapter: connection refused") }
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-ctx.Done()
		_ = listener.Close()
		mu.Lock()
		defer mu.Unlock()
		for conn := range clients {
			_ = conn.Close()
		}
	}()
	var serveErr error
	for {
		conn, err := listener.AcceptUnix()
		if err != nil {
			if ctx.Err() == nil {
				serveErr = err
			}
			break
		}
		mu.Lock()
		if ctx.Err() != nil {
			mu.Unlock()
			_ = conn.Close()
			break
		}
		if len(clients) >= cfg.MaxConnections {
			mu.Unlock()
			refuse()
			_ = conn.Close()
			continue
		}
		clients[conn] = true
		mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer conn.Close()
			defer func() { mu.Lock(); delete(clients, conn); mu.Unlock() }()
			cred, err := PeerCred(conn)
			if err != nil || !PeerAdmitted(cred, cfg.UID) {
				refuse()
				return
			}
			framer, err := NewFramer(conn, cfg)
			if err != nil {
				refuse()
				return
			}
			first := true
			for {
				readCtx := ctx
				cancelRead := func() {}
				if first {
					readCtx, cancelRead = context.WithTimeout(ctx, cfg.HelloTimeout)
				}
				frame, err := framer.Read(readCtx)
				cancelRead()
				if err != nil {
					return
				}
				envelope, err := policy.ValidateEnvelope(frame)
				if err != nil {
					refuse()
					return
				}
				// No version fallback: the successor union supplies hello only in v0.2.
				if envelope.Schema != "envelope/v0.2" || envelope.Seq == 0 || envelope.Nonce == "" || envelope.From.Component != "core" || envelope.To.Component != "daemon" {
					refuse()
					return
				}
				var discriminator struct {
					Schema string `json:"schema"`
				}
				if json.Unmarshal(envelope.Body, &discriminator) != nil {
					refuse()
					return
				}
				if first && discriminator.Schema != "hello/v0.2" {
					refuse()
					return
				}
				if err := policy.Authenticate(ctx, cred, envelope); err != nil {
					refuse()
					return
				}
				key := SenderKey{SessionID: envelope.SessionID, Component: envelope.From.Component, Instance: envelope.From.Instance}
				if err := policy.Reserve(ctx, key, envelope.Seq, envelope.Nonce); err != nil {
					refuse()
					return
				}
				first = false
				replies, err := handler(ctx, envelope)
				if err != nil {
					refuse()
					return
				}
				if ctx.Err() != nil {
					return
				}
				// Synchronous writes retain backpressure without an unbounded send queue.
				for _, reply := range replies {
					if ctx.Err() != nil {
						return
					}
					outgoing, err := policy.Wrap(ctx, envelope, reply)
					if err != nil {
						refuse()
						return
					}
					value, err := json.Marshal(outgoing)
					if err != nil {
						refuse()
						return
					}
					if err := framer.Write(ctx, value); err != nil {
						return
					}
				}
			}
		}()
	}
	cancel()
	<-stopped
	joined := make(chan struct{})
	go func() { wg.Wait(); close(joined) }()
	timer := time.NewTimer(cfg.ShutdownTimeout)
	defer timer.Stop()
	select {
	case <-joined:
		return serveErr
	case <-timer.C:
		return errors.Join(serveErr, errors.New("handler shutdown deadline exceeded"))
	}
}
