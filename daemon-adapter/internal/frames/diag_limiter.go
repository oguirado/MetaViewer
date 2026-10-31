package frames

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

// [TARGET, unit decision] LOG-QUIET: per-surface diagnostic rate limiter (30 s default window).
// Aggregates skipped_polls per surface over each window and aligns stage_summary cadence,
// while MV_ADAPTER_DIAG=verbose restores per-event diagnostic lines and errors/warnings are never rate-limited.

const (
	// DefaultDiagnosticsInterval is the default per-surface diagnostic aggregation window (30 s [TARGET]).
	DefaultDiagnosticsInterval = 30 * time.Second
	// verboseStageSummaryInterval is the stage_summary cadence when MV_ADAPTER_DIAG=verbose
	// and DiagnosticsInterval is not explicitly set.
	verboseStageSummaryInterval = 5 * time.Second
	// DiagModeEnvVar selects diagnostic verbosity ("verbose" restores per-event lines).
	DiagModeEnvVar = "MV_ADAPTER_DIAG"
	// DiagModeVerbose is the DiagModeEnvVar value that restores per-event diagnostic lines.
	DiagModeVerbose = "verbose"
)

type surfaceSkipWindow struct {
	windowStart   time.Time
	windowSkipped uint64
}

type diagLimiter struct {
	mu                   sync.Mutex
	skips                map[string]*surfaceSkipWindow
	errorWindows         map[string]time.Time
	verboseOverride      *bool
	faultDisableLimiter  bool
	faultRateLimitErrors bool
	faultIgnoreVerbose   bool
}

func newDiagLimiter() *diagLimiter {
	return &diagLimiter{
		skips:        make(map[string]*surfaceSkipWindow),
		errorWindows: make(map[string]time.Time),
	}
}

func (l *diagLimiter) isVerbose() bool {
	if l == nil {
		return strings.EqualFold(strings.TrimSpace(os.Getenv(DiagModeEnvVar)), DiagModeVerbose)
	}
	l.mu.Lock()
	ignore := l.faultIgnoreVerbose
	override := l.verboseOverride
	l.mu.Unlock()
	if ignore {
		return false
	}
	if override != nil {
		return *override
	}
	return strings.EqualFold(strings.TrimSpace(os.Getenv(DiagModeEnvVar)), DiagModeVerbose)
}

func (l *diagLimiter) isRateLimitDisabled() bool {
	if l == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.faultDisableLimiter
}

func (l *diagLimiter) initSurface(id string, start time.Time) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.skips == nil {
		l.skips = make(map[string]*surfaceSkipWindow)
	}
	w := l.skips[id]
	if w == nil {
		l.skips[id] = &surfaceSkipWindow{windowStart: start}
	} else if w.windowStart.IsZero() {
		w.windowStart = start
	}
}

func (l *diagLimiter) recordSkippedPolls(id string, missed uint64, now time.Time, interval time.Duration) (uint64, bool) {
	if l.isRateLimitDisabled() || l.isVerbose() {
		return missed, true
	}
	if l == nil {
		return missed, true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.skips == nil {
		l.skips = make(map[string]*surfaceSkipWindow)
	}
	w := l.skips[id]
	if w == nil {
		w = &surfaceSkipWindow{windowStart: now}
		l.skips[id] = w
	}
	if w.windowStart.IsZero() {
		w.windowStart = now
	}
	w.windowSkipped += missed
	if !now.Before(w.windowStart.Add(interval)) && w.windowSkipped > 0 {
		sum := w.windowSkipped
		w.windowSkipped = 0
		w.windowStart = now
		return sum, true
	}
	return 0, false
}

func (l *diagLimiter) allowErrorOrWarning(id string, now time.Time, interval time.Duration) bool {
	if l == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.faultRateLimitErrors {
		return true
	}
	if l.errorWindows == nil {
		l.errorWindows = make(map[string]time.Time)
	}
	if last, ok := l.errorWindows[id]; ok && now.Before(last.Add(interval)) {
		return false
	}
	l.errorWindows[id] = now
	return true
}

func writeSessionCloseSkippedPolls(w io.Writer, skipped uint64) {
	if w == nil || skipped == 0 {
		return
	}
	_, _ = fmt.Fprintf(w, "adapter: session closed with total_skipped_polls=%d\n", skipped)
}
