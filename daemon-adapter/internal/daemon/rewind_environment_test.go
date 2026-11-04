package daemon

import "testing"

func TestRewindModeRequiresExplicitExclusiveAdmission(t *testing.T) {
	for _, value := range []string{"0", "true", "yes"} {
		t.Setenv("MV_REWIND_ENABLED", value)
		if _, e := RuntimeFromEnv(); e == nil {
			t.Fatal("invalid rewind flag accepted")
		}
	}
	t.Setenv("MV_REWIND_ENABLED", "")
	t.Setenv("MV_REWIND_ONLY", "1")
	if _, e := RuntimeFromEnv(); e == nil {
		t.Fatal("rewind-only without opt-in")
	}
	t.Setenv("MV_REWIND_ENABLED", "1")
	t.Setenv("MV_GUEST_COMMAND_ONLY", "1")
	if _, e := RuntimeFromEnv(); e == nil {
		t.Fatal("conflicting modes accepted")
	}
}
