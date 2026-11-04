package ipc

import (
	"os"
	"testing"
)

func TestRewindPolicyDoesNotLeakFileDescriptors(t *testing.T) {
	before, e := os.ReadDir("/proc/self/fd")
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 32; i++ {
		if _, e = NewPolicy(ceilingConfig(), os.DirFS("../../../contracts/v0.2"), &dummyPolicy{}); e != nil {
			t.Fatal(e)
		}
	}
	after, e := os.ReadDir("/proc/self/fd")
	if e != nil {
		t.Fatal(e)
	}
	if len(after) > len(before) {
		t.Fatalf("policy leaked FDs: before=%d after=%d", len(before), len(after))
	}
	t.Logf("FD counts before=%d after=%d", len(before), len(after))
}
