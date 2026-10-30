package capsule

// [TARGET, unit decision] Adapter-local start evidence freezes the actual argv
// mode and exact record bytes before native start; no wire fields are added.
import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"syscall"
)

const egressStartedSchema = "metaviewer.capsule_egress_started/v1"

type EgressStarted struct {
	Schema        string `json:"schema"`
	CapsuleID     string `json:"capsule_id"`
	EffectiveMode string `json:"effective_mode"`
	RecordSHA256  string `json:"record_sha256"`
	StartMonoNS   uint64 `json:"start_mono_ns"`
	StartWallNS   int64  `json:"start_wall_ns"`
}

func (m *Manager) egressState() string {
	if r, ok := m.runner.(*ProcessRunner); ok {
		return r.stateDir
	}
	return os.Getenv("MV_SRF_STATE_DIR")
}
func egressRecordDigest(state, identity string) (string, error) {
	dir, err := egressDirectory(state, false)
	if errors.Is(err, syscall.ENOENT) {
		return "absent", nil
	}
	if err != nil {
		return "", err
	}
	defer dir.Close()
	b, err := readEgressFile(dir, identity+".json")
	if errors.Is(err, syscall.ENOENT) {
		return "absent", nil
	}
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}
func removeEgressStarted(state, identity string) error {
	dir, err := egressDirectory(state, false)
	if errors.Is(err, syscall.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	defer dir.Close()
	err = syscall.Unlinkat(int(dir.Fd()), identity+".started.json")
	if errors.Is(err, syscall.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	return dir.Sync()
}
