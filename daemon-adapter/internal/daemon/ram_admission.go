package daemon

// [TARGET, unit decision] Serialize native creates and destroys on the one core
// connection and across processes using a shared directory flock. Admission reads host
// MemAvailable before create and after initial capture. Floor: 20 GiB [CITED,
// campaign L1]; reserve: 512 MiB per incumbent [TARGET], matching the frame budget.
// Failed post-checks compensate only the new surface; rollback errors stay visible.
import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"metaviewer/daemon-adapter/internal/capsule"
	"metaviewer/daemon-adapter/internal/cli"
	"metaviewer/daemon-adapter/internal/frames"
	"metaviewer/daemon-adapter/internal/ipc"
	"metaviewer/daemon-adapter/internal/record"
)

const ramFloorKB uint64 = 20 * 1024 * 1024
const ramReserveKB uint64 = 512 * 1024

func memAvailableKB() (uint64, error) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	return parseMemAvailable(data)
}
func parseMemAvailable(data []byte) (uint64, error) {
	var value uint64
	found := false
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) == 0 || f[0] != "MemAvailable:" {
			continue
		}
		if found || len(f) != 3 || f[2] != "kB" {
			return 0, fmt.Errorf("invalid MemAvailable")
		}
		n, err := strconv.ParseUint(f[1], 10, 64)
		if err != nil {
			return 0, err
		}
		value, found = n, true
	}
	if !found {
		return 0, fmt.Errorf("MemAvailable absent")
	}
	return value, nil
}
func checkRAM(read func() (uint64, error), live int) error {
	available, err := read()
	if err != nil || live < 0 || uint64(live) > (^uint64(0)-ramFloorKB)/ramReserveKB || available < ramFloorKB+ramReserveKB*uint64(live) {
		return &cli.Fault{Code: "RAM_ADMISSION_REFUSED", Detail: "host MemAvailable below floor plus incumbent reserves, or unreadable"}
	}
	return nil
}
func validateProfileRoots(profiles map[string]capsule.Profile) error {
	roots := []string{}
	for _, p := range profiles {
		root := filepath.Clean(p.RAMRoot)
		canonical, err := filepath.EvalSymlinks(root)
		if err != nil || canonical != root {
			return configuration("canonical existing profile RAM root required")
		}
		for _, other := range roots {
			if root == other || strings.HasPrefix(root, other+string(filepath.Separator)) || strings.HasPrefix(other, root+string(filepath.Separator)) {
				return configuration("disjoint profile RAM roots required")
			}
		}
		roots = append(roots, root)
	}
	return nil
}
func wireHandler(m *capsule.Manager, profiles map[string]capsule.Profile, pubs map[string]*frames.Publisher, origin uint64, recorders ...*record.Manager) ipc.Handler {
	return admittedHandler(m, wireHandlerWithoutAdmission(m, profiles, pubs, origin, recorders...), memAvailableKB)
}
func admittedHandler(m *capsule.Manager, next ipc.Handler, read func() (uint64, error)) ipc.Handler {
	var mu sync.Mutex
	token := make([]byte, 16)
	_, tokenErr := rand.Read(token)
	owner := fmt.Sprintf("%d-%x", os.Getpid(), token)
	return func(ctx context.Context, e ipc.Envelope) ([]json.RawMessage, error) {
		var q capsule.Request
		if json.Unmarshal(e.Body, &q) != nil || q.Schema != "surface_request/v0.2" || (q.Op != "create" && q.Op != "destroy") {
			return next(ctx, e)
		}
		mu.Lock()
		defer mu.Unlock()
		if tokenErr != nil {
			return wireFailure(e, q, tokenErr)
		}
		dir, err := lockAdmissionDirectory()
		if err != nil {
			return wireFailure(e, q, admissionFault(err))
		}
		defer dir.Close()
		defer syscall.Flock(int(dir.Fd()), syscall.LOCK_UN)
		// Reconcile only our manager; never discard another daemon's records on
		// PID death: its native containers may outlive it.
		syncRecords := func() error { return syncAdmissionRecords(dir.Name(), owner, m.AdmissionProfiles()) }
		if err := syncRecords(); err != nil {
			return wireFailure(e, q, admissionFault(err))
		}
		if q.Op == "destroy" {
			events, err := next(ctx, e)
			if syncErr := syncRecords(); syncErr != nil {
				return wireFailure(e, q, admissionFault(syncErr))
			}
			return events, err
		}
		entries, err := os.ReadDir(dir.Name())
		if err != nil {
			return wireFailure(e, q, admissionFault(err))
		}
		live := len(entries)
		if err := checkRAM(read, live); err != nil {
			return wireFailure(e, q, err)
		}
		var params struct {
			ProfileID string `json:"profile_id"`
		}
		if err := json.Unmarshal(q.Params, &params); err != nil {
			return wireFailure(e, q, err)
		}
		reserved := m.AdmissionProfiles()
		reserved[params.ProfileID] = true
		if err := syncAdmissionRecords(dir.Name(), owner, reserved); err != nil {
			return wireFailure(e, q, admissionFault(err))
		}
		// Persist before spawn; even a crash between native start and response
		// leaves a conservative incumbent record.
		events, err := next(ctx, e)
		if syncErr := syncRecords(); syncErr != nil {
			return wireFailure(e, q, admissionFault(syncErr))
		}
		if err != nil {
			return events, err
		}
		var id string
		for _, raw := range events {
			var ev struct {
				Event string
				Data  struct{ Surface capsule.Surface }
			}
			if json.Unmarshal(raw, &ev) == nil && ev.Event == "created" {
				id = ev.Data.Surface.SurfaceID
			}
		}
		if id == "" {
			return events, nil
		}
		if err := checkRAM(read, live); err != nil {
			params, _ := json.Marshal(map[string]string{"surface_id": id})
			body, _ := json.Marshal(capsule.Request{Schema: q.Schema, Op: "destroy", Params: params})
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			stopped, rollback := next(cleanup, ipc.Envelope{Body: body})
			if syncErr := syncRecords(); syncErr != nil {
				return wireFailure(e, q, admissionFault(syncErr))
			}
			if rollback == nil {
				verified := false
				for _, raw := range stopped {
					var ev struct {
						Event string
						Data  struct{ Surface capsule.Surface }
					}
					if json.Unmarshal(raw, &ev) == nil && ev.Event == "state_changed" && ev.Data.Surface.SurfaceID == id && ev.Data.Surface.State == "destroyed" {
						verified = true
					}
				}
				if !verified {
					rollback = fmt.Errorf("new surface removal unverified: %s", stopped)
				}
			}
			if rollback != nil {
				return wireFailure(e, q, &CreationError{SurfaceID: id, Cause: err, Rollback: rollback})
			}
			return wireFailure(e, q, err)
		}
		return events, nil
	}
}

func admissionFault(err error) error {
	return &cli.Fault{Code: "RAM_ADMISSION_REFUSED", Detail: "shared RAM admission: " + err.Error()}
}

// [TARGET, unit decision] MV_RAM_ADMISSION_DIR preserves the host runtime root
// when a stack gives its daemon a private XDG_RUNTIME_DIR. All daemons of a uid
// must share this path. Unknown/crashed reservations remain counted until native
// absence is independently verified; PID death alone never permits reclamation.
func lockAdmissionDirectory() (*os.File, error) {
	path := os.Getenv("MV_RAM_ADMISSION_DIR")
	if path == "" {
		runtime := os.Getenv("XDG_RUNTIME_DIR")
		if !filepath.IsAbs(runtime) {
			return nil, fmt.Errorf("absolute XDG_RUNTIME_DIR required")
		}
		parent, err := openStateDir(filepath.Join(runtime, "metaviewer"))
		if err != nil {
			return nil, err
		}
		parent.Close()
		path = filepath.Join(runtime, "metaviewer", "ram-admission")
	}
	dir, err := openStateDir(path)
	if err != nil {
		return nil, err
	}
	st, err := dir.Stat()
	if err != nil {
		dir.Close()
		return nil, err
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Getuid()) || st.Mode() != os.ModeDir|0700 {
		dir.Close()
		return nil, fmt.Errorf("uid-owned 0700 admission directory required")
	}
	if err := syscall.Flock(int(dir.Fd()), syscall.LOCK_EX); err != nil {
		dir.Close()
		return nil, err
	}
	return dir, nil
}

func syncAdmissionRecords(dir, owner string, profiles map[string]bool) error {
	wanted := map[string]bool{}
	for profile := range profiles {
		name := fmt.Sprintf("%s-%x", owner, sha256.Sum256([]byte(profile)))
		wanted[name] = true
		path := filepath.Join(dir, name)
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|syscall.O_NOFOLLOW, 0600)
		if err != nil {
			return err
		}
		if err := f.Sync(); err != nil {
			f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), owner+"-") && !wanted[entry.Name()] {
			if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
