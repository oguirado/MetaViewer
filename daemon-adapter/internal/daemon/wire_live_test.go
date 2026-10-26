//go:build live

package daemon

import "testing"

// TestLiveCapsuleBinary requires the admitted mv-live-1 browser configuration.
// Missing live prerequisites fail; this test never skips at runtime.
func TestLiveCapsuleBinary(t *testing.T) { binaryOracle(t, true, "") }
