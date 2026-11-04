package headless

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func profileFixture(t *testing.T) (string, map[string]any) {
	t.Helper()
	m := fixture(t, &fakeProcess{})
	pin := m.profile.Runner
	files := []File{}
	for _, r := range []string{"mc06-controller/controller.py", "mc06-controller/arm_backend.py", "mc06-controller/contract_guard.py", "mc04-runtime/arm_harness.py", "mc05-contract-candidate/reference_model.py", "mc05-contract-candidate/contracts/v0.2/headless_request.schema.json", "mc05-contract-candidate/contracts/v0.2/headless_event.schema.json", "mc05-contract-candidate/contracts/v0.2/headless_session.schema.json"} {
		files = append(files, File{r, pin.Path, pin.SHA256})
	}
	config := map[string]any{"schema": "mc06-host-config/v1", "owner_id": m.profile.OwnerID, "generation": 1, "runtime_admitted": false, "artifacts": map[string]Pin{"engine": pin, "kernel": pin, "init": pin}, "resources": map[string]int{"mem_size_mib": 256, "vcpu_count": 1}, "deadlines": map[string]int{"startup_seconds": 30, "job_seconds": 5, "stop_seconds": 5}, "runtime_root": m.profile.RuntimeRoot, "external_cgroup": "/unassigned"}
	p := map[string]any{"schema": "mv-headless-host/v1", "owner_id": m.profile.OwnerID, "guardian_unit": "test.service", "python": pin, "python_prefix": "/usr", "runner": pin, "controller_relative": "mc06-controller/controller.py", "files": files, "config_template": config, "state_root": m.profile.StateRoot, "runtime_root": m.profile.RuntimeRoot}
	return filepath.Join(m.profile.StateRoot, "profile.json"), p
}
func TestStrictProfileClosure(t *testing.T) {
	for _, kind := range []string{"valid", "extra", "missing-file", "owner", "resource", "duplicate", "mode"} {
		t.Run(kind, func(t *testing.T) {
			path, p := profileFixture(t)
			switch kind {
			case "extra":
				p["renderer_path"] = "/forbidden"
			case "missing-file":
				p["files"] = p["files"].([]File)[:7]
			case "owner":
				p["owner_id"] = "actor-other"
			case "resource":
				p["config_template"].(map[string]any)["resources"] = map[string]int{"mem_size_mib": 1024, "vcpu_count": 1}
			}
			b, _ := json.Marshal(p)
			if kind == "duplicate" {
				b = append([]byte(`{"schema":"bad",`), b[1:]...)
			}
			os.WriteFile(path, b, 0600)
			if kind == "mode" {
				os.Chmod(path, 0644)
			}
			_, e := Load(path)
			if (kind == "valid") != (e == nil) {
				t.Fatalf("%s: %v", kind, e)
			}
		})
	}
}
