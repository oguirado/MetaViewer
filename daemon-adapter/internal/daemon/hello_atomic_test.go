package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
)

type helloAtomicSource struct{}

func (helloAtomicSource) Capture(context.Context, string) (capsule.Binding, capsule.NativeFrame, error) {
	return capsule.Binding{}, capsule.NativeFrame{}, errors.New("test source has no surfaces")
}

// ARG-s_adapter-5: failed constructors must preserve the active session.
func TestHelloAtomicConstructorFailures(t *testing.T) {
	for _, failure := range []string{"runtime", "second subscription", "missing session"} {
		t.Run(failure, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			session := streamSession{ctx: ctx, work: &sync.Mutex{}, emit: func(context.Context, json.RawMessage) error { return nil }}
			sessionCtx := context.WithValue(ctx, streamKey{}, session)
			makeSub := func() *frames.Subscriptions {
				sub, err := frames.NewSubscriptions(ctx, frames.SubscriptionConfig{MaxSubscriptions: 16, PollInterval: time.Hour, CaptureTimeout: time.Second, ShutdownTimeout: time.Second}, helloAtomicSource{}, &frames.Publisher{}, session.emit)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = sub.Close(context.Background()) })
				return sub
			}
			existing, marker := makeSub(), makeSub()
			backing := []*frames.Subscriptions{existing, marker, marker, marker}
			oldHandlerErr := errors.New("old handler")
			state := helloState{handler: func(context.Context, ipc.Envelope) ([]json.RawMessage, error) { return nil, oldHandlerErr }, subscriptions: backing[:1]}
			authority := &clientAuthority{origin: 11}
			injected := errors.New("injected constructor failure")
			fail := true
			var runtimeCalls, subCalls int
			var staged []*frames.Subscriptions
			newRuntime := func(cfg capsule.Config, clock cli.Clock) (*capsule.Manager, error) {
				runtimeCalls++
				if cfg.OriginNS != 29 || clock() != 29 {
					t.Error("fresh runtime has wrong clock origin")
				}
				if fail && failure == "runtime" {
					return nil, injected
				}
				return &capsule.Manager{}, nil
			}
			newSub := func(_ context.Context, _ frames.SubscriptionConfig, _ frames.Source, _ *frames.Publisher, _ frames.Emit) (*frames.Subscriptions, error) {
				subCalls++
				if fail && failure == "second subscription" && subCalls == 2 {
					return nil, injected
				}
				sub := makeSub()
				staged = append(staged, sub)
				return sub, nil
			}
			pubs := map[string]*frames.Publisher{"one": {}, "two": {}}
			attemptCtx := sessionCtx
			if failure == "missing session" {
				attemptCtx = ctx
			}
			err := state.accept(attemptCtx, nil, pubs, authority, func() uint64 { return 29 }, newRuntime, newSub)
			if failure == "missing session" {
				if err == nil {
					t.Fatal("missing session accepted")
				}
			} else if !errors.Is(err, injected) {
				t.Fatalf("failure = %v", err)
			}
			if authority.origin != 11 {
				t.Errorf("failed hello changed origin: %d", authority.origin)
			}
			if state.welcomed {
				t.Error("failed hello marked welcomed")
			}
			if len(state.subscriptions) != 1 || state.subscriptions[0] != existing {
				t.Error("failed hello changed shared subscriptions")
			}
			for _, sub := range backing[1:] {
				if sub != marker {
					t.Error("failed hello changed shared backing array")
				}
			}
			if _, err := state.handler(ctx, ipc.Envelope{}); !errors.Is(err, oldHandlerErr) {
				t.Error("failed hello replaced handler")
			}
			for _, sub := range staged {
				if err := sub.Subscribe(ctx, "discarded"); err == nil {
					_ = sub.Close(ctx)
					t.Error("discarded subscription remains open")
				}
			}
			if err := existing.Subscribe(ctx, "existing"); err != nil {
				t.Fatalf("existing subscription closed: %v", err)
			}
			if err := existing.Unsubscribe(ctx, "existing"); err != nil {
				t.Fatal(err)
			}
			fail = false
			staged = nil
			if err := state.accept(sessionCtx, nil, pubs, authority, func() uint64 { return 29 }, newRuntime, newSub); err != nil {
				t.Fatalf("retry: %v", err)
			}
			if !state.welcomed || authority.origin != 29 || len(state.subscriptions) != 3 || state.subscriptions[0] != existing {
				t.Error("retry did not publish complete session")
			}
			if _, err := state.handler(ctx, ipc.Envelope{Body: json.RawMessage(`{`)}); errors.Is(err, oldHandlerErr) {
				t.Error("successful hello kept old handler")
			}
			for _, sub := range staged {
				if err := sub.Subscribe(ctx, "committed"); err != nil {
					t.Errorf("committed subscription closed: %v", err)
				}
				if err := sub.Unsubscribe(ctx, "committed"); err != nil {
					t.Error(err)
				}
			}
			beforeRuntime, beforeSubs := runtimeCalls, subCalls
			if err := state.accept(sessionCtx, nil, pubs, authority, func() uint64 { return 77 }, newRuntime, newSub); err == nil {
				t.Error("duplicate hello accepted")
			}
			if runtimeCalls != beforeRuntime || subCalls != beforeSubs || authority.origin != 29 || len(state.subscriptions) != 3 {
				t.Error("duplicate hello changed state")
			}
		})
	}
}
