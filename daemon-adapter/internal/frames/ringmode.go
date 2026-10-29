package frames

// [TARGET, unit decision] Mode selection occurs once before capture; a refused
// root selects reported legacy mode. A selected ring never retries via the CLI.
import (
	"fmt"
	"io"
	"metaviewer/daemon-adapter/internal/capsule"
	"time"
)

func SelectRingSource(legacy Source, enabled bool, fps int, report io.Writer, open func() (*RingSource, error)) (Source, time.Duration) {
	var source Source = legacy
	interval := 100 * time.Millisecond
	mode, reason := capsule.CaptureModeLegacy, "ring opt-in disabled"
	if enabled {
		ring, err := open()
		if err != nil {
			reason = err.Error()
		} else {
			source = ring
			interval = RingPollInterval(fps)
			mode = capsule.CaptureModeRing
			reason = "validated root"
		}
	}
	if enabled {
		fmt.Fprintf(report, "capture_mode=%s reason=%q\n", mode, reason)
	}
	return source, interval
}
