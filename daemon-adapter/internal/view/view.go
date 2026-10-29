// Package view bridges operator views without granting agent admission.
package view

import (
	"context"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
)

type Backend interface {
	Open(context.Context, string, bool) error
	Stop(context.Context, string) error
}

// Runner must return the first announcement while retaining and reaping the
// foreground view process. Short commands use the ordinary bounded runner.
// [TARGET, unit decision] This explicit seam keeps process ownership at the host.
type Runner interface {
	cli.Runner
	Start(context.Context, []string) (*Process, error)
}
type ViewInfo struct {
	URL    string `json:"url"`
	Native string `json:"native"`
	Socket string `json:"socket"`
}
type Process struct {
	Announcement []byte
	Done         <-chan struct{}
	Close        func()
}
type active struct {
	child *Process

	info  ViewInfo
	login bool
}
type Manager struct {
	mu     sync.Mutex
	runner Runner
	views  map[string]*active
	busy   map[string]bool
	closed bool
	ctx    context.Context
	cancel context.CancelFunc
	idle   chan struct{}
}

var identity = regexp.MustCompile(`^srf-(id|pg|vm)-[a-z0-9][a-z0-9-]{0,39}$`)

func New() Backend { return NewManager(nil) }
func NewManager(r Runner) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{runner: r, views: make(map[string]*active), busy: make(map[string]bool), ctx: ctx, cancel: cancel}
}
func fault(code, detail string) error { return &cli.Fault{Code: code, Detail: detail} }
func (b *Manager) check(ctx context.Context, id string) error {
	if err := capsule.RefuseProtectedContainer([]string{"--container", id}); err != nil {
		return err
	}

	if err := ctx.Err(); err != nil {
		return err
	}
	if !identity.MatchString(id) {
		return fault("usage", "invalid identity capsule")
	}
	if b.runner == nil {
		return fault("configuration", "operator view runner required")
	}
	return nil
}
func (b *Manager) Open(ctx context.Context, id string, login bool) error {
	if err := b.check(ctx, id); err != nil {
		return err
	}
	b.mu.Lock()
	if b.closed || b.views[id] != nil || b.busy[id] {
		b.mu.Unlock()
		return fault("refused", "view unavailable or already registered")
	}
	b.busy[id] = true
	b.mu.Unlock()
	defer b.finish(id)
	verb := "view"
	if login {
		verb = "login"
	}
	startCtx, cancel := context.WithCancel(ctx)
	var stop func() bool
	if b.ctx != nil {
		stop = context.AfterFunc(b.ctx, cancel)
	}
	defer func() {
		if stop != nil {
			stop()
		}
		cancel()
	}()
	child, err := b.runner.Start(startCtx, []string{"srf-identity-surface", verb, "--container", id})
	if err != nil {
		return err
	}
	info, err := parseInfo(child.Announcement)
	if err != nil {
		child.Close()
		return err
	}
	v := &active{info: info, login: login, child: child}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		child.Close()
		return fault("refused", "manager closed")
	}
	b.views[id] = v
	b.mu.Unlock()
	go func() {
		<-child.Done
		b.mu.Lock()
		if b.views[id] == v {
			delete(b.views, id)
		}
		b.mu.Unlock()
	}()
	return nil
}
func (b *Manager) finish(id string) {
	b.mu.Lock()
	delete(b.busy, id)
	if len(b.busy) == 0 && b.idle != nil {
		close(b.idle)
		b.idle = nil
	}
	b.mu.Unlock()
}
func (b *Manager) acquire(id string) (*active, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	v := b.views[id]
	if v == nil || b.closed {
		return nil, fault("surface", "unknown view")
	}
	if b.busy[id] {
		return nil, fault("refused", "view operation pending")
	}
	b.busy[id] = true
	return v, nil
}

// Close releases all foreground helpers; the host calls it on shutdown.
func (b *Manager) Close() {
	b.mu.Lock()
	b.closed = true
	if b.cancel != nil {
		b.cancel()
	}
	views := b.views
	b.views = make(map[string]*active)
	var wait <-chan struct{}
	if len(b.busy) > 0 {
		if b.idle == nil {
			b.idle = make(chan struct{})
		}
		wait = b.idle
	}
	b.mu.Unlock()
	for _, v := range views {
		v.child.Close()
	}
	if wait != nil {
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		select {
		case <-wait:
		case <-timer.C:
		}
	}
}

func (b *Manager) Info(id string) (ViewInfo, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	v, ok := b.views[id]
	if !ok {
		return ViewInfo{}, false
	}
	return v.info, true
}
func (b *Manager) Stop(ctx context.Context, id string) error {
	if err := b.check(ctx, id); err != nil {
		return err
	}
	v, err := b.acquire(id)
	if err != nil {
		return err
	}
	defer b.finish(id)
	defer func() {
		v.child.Close()
		b.mu.Lock()
		if b.views[id] == v {
			delete(b.views, id)
		}
		b.mu.Unlock()
	}()
	out, err := b.runner.Run(ctx, []string{"srf-identity-surface", "view-stop", "--container", id}, nil)
	if err != nil {
		return err
	}
	var receipt struct {
		Stopped string   `json:"stopped_view"`
		PID     int      `json:"pid"`
		Seconds *float64 `json:"seconds"`
	}
	if err = cli.ParseLine(out, 65536, &receipt); err != nil {
		return err
	}
	if receipt.Stopped != id || receipt.PID <= 1 || receipt.Seconds == nil || *receipt.Seconds < 0 || *receipt.Seconds > 60 {
		return fault("malformed_cli", "invalid view stop receipt")
	}
	return nil
}
func (b *Manager) Paste(ctx context.Context, id string, text []byte) error {
	if err := b.check(ctx, id); err != nil {
		return err
	}
	if len(text) == 0 || len(text) > 16384 || !utf8.Valid(text) {
		return fault("usage", "paste requires bounded UTF-8 text")
	}
	v, err := b.acquire(id)
	if err != nil {
		return err
	}
	defer b.finish(id)
	if !v.login {
		return fault("refused", "login view required")
	}
	out, err := b.runner.Run(ctx, []string{"srf-identity-surface", "paste-text", "--container", id, "--file", "-"}, text)
	if err != nil {
		return err
	}
	var receipt struct {
		Runes     *int   `json:"pasted_runes"`
		Container string `json:"container"`
	}
	if err = cli.ParseLine(out, 65536, &receipt); err != nil {
		return err
	}
	if receipt.Container != id || receipt.Runes == nil || *receipt.Runes != utf8.RuneCount(text) {
		return fault("malformed_cli", "invalid paste receipt")
	}
	return nil
}

func parseInfo(out []byte) (ViewInfo, error) {
	var info ViewInfo
	if err := cli.ParseLine(out, 65536, &info); err != nil {
		return ViewInfo{}, err
	}
	u, err := url.Parse(info.URL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.Fragment != "" || info.Native == "" || !filepath.IsAbs(info.Socket) {
		return ViewInfo{}, fault("malformed_cli", "invalid view announcement")
	}
	host, port, err := net.SplitHostPort(u.Host)
	n, e := strconv.Atoi(port)
	if err != nil || e != nil || host != "127.0.0.1" || n < 1 || n > 65535 {
		return ViewInfo{}, fault("malformed_cli", "invalid loopback view port")
	}
	return info, nil
}
