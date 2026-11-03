package capsule

// [TARGET, unit decision] State operations are core-authorized and execute outside
// Manager.mu. Native guards/leases and login markers remain the custody authority.
// The only public results are identifiers, timestamps and typed reason codes.
import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"

	"metaviewer/daemon-adapter/internal/capsule/slots"
)

type SlotStore interface {
	Save(context.Context, slots.Request) (slots.Manifest, error)
	Load(context.Context, slots.Request) (slots.Manifest, error)
	Select(context.Context, string) (slots.Manifest, error)
	List(context.Context, string) ([]slots.Entry, error)
	Delete(context.Context, slots.Request) error
	Provision(context.Context, string) error
	ReconcileAll(context.Context) error
	AcquireStopped(context.Context, slots.Request) (func(), error)
}
type StateRequest struct {
	Schema         string `json:"schema"`
	OperationID    string `json:"operation_id"`
	Op             string `json:"op"`
	ProfileID      string `json:"profile_id"`
	SlotID         string `json:"slot_id"`
	HumanConfirmed bool   `json:"credential_copy_confirmed"`
	Destination    string `json:"destination_profile_id,omitempty"`
}

var slotID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,39}$`)

func (m *Manager) initSlots() error {
	if m.cfg.Slots != nil {
		m.slots = m.cfg.Slots
		return m.slots.ReconcileAll(context.Background())
	}
	r, ok := m.runner.(*ProcessRunner)
	if !ok {
		return nil
	}
	root := ""
	for _, v := range r.env {
		if strings.HasPrefix(v, "SRF_IDENTITY_STORE_ROOT=") {
			root = strings.TrimPrefix(v, "SRF_IDENTITY_STORE_ROOT=")
		}
	}
	if root == "" {
		return nil
	}
	// Same local image candidates as tools/mv_identity.py; never pull an image.
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[runtime.GOARCH]
	if arch == "" {
		return errors.New("SLOT_ARCHITECTURE_UNSUPPORTED")
	}
	ctx, cancel := context.WithTimeout(context.Background(), m.cfg.Timeout)
	defer cancel()
	image := ""
	for _, version := range []string{"0.2.0", "0.1.1"} {
		candidate := "opensuperficies-identity-browser-" + arch + ":" + version
		if exec.CommandContext(ctx, "docker", "image", "inspect", candidate).Run() == nil {
			image = candidate
			break
		}
	}
	if image == "" {
		return errors.New("SLOT_HELPER_IMAGE_ABSENT")
	}
	store, e := slots.New(slots.Config{Root: root, Image: image, LiveProfile: m.cfg.SlotLiveProfile, CheckStopped: m.slotStopped})
	if e != nil {
		return e
	}
	if e = store.ReconcileAll(ctx); e != nil {
		return e
	}
	m.slots = store
	return nil
}
func (m *Manager) slotStopped(ctx context.Context, id string) error {
	m.mu.Lock()
	busy := m.quarantined[id]
	for _, b := range m.bindings {
		if b.Surface.ProfileID == id {
			busy = true
		}
	}
	m.mu.Unlock()
	if busy {
		return errors.New("IDENTITY_BOUND")
	}
	r, ok := m.runner.(*ProcessRunner)
	if !ok {
		return errors.New("CUSTODY_UNPROVEN")
	}
	// Reconciliation and provisioning also require lease evidence, even when
	// no container is visible yet. Callers hold the native per-identity guard.
	for _, entry := range r.env {
		if !strings.HasPrefix(entry, "SRF_IDENTITY_STORE_ROOT=") {
			continue
		}
		root := strings.TrimPrefix(entry, "SRF_IDENTITY_STORE_ROOT=")
		fd, e := syscall.Open(filepath.Join(root, "locks", id+".json"), syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return errors.New("CUSTODY_UNPROVEN")
		}
		f := os.NewFile(uintptr(fd), "lease")
		raw, e := io.ReadAll(io.LimitReader(f, 4097))
		st, se := f.Stat()
		_ = f.Close()
		var lease struct {
			Active *bool `json:"active"`
		}
		if e != nil || se != nil || !st.Mode().IsRegular() || len(raw) > 4096 || json.Unmarshal(raw, &lease) != nil || lease.Active == nil {
			return errors.New("CUSTODY_UNPROVEN")
		}
		if *lease.Active {
			return errors.New("IDENTITY_BOUND")
		}
	}
	for _, prefix := range []string{"srf-id-", "srf-pg-", "srf-vm-"} {
		name := prefix + id
		active, e := r.LoginActive(name)
		if e != nil {
			return e
		}
		if active {
			return errors.New("LOGIN_IN_PROGRESS")
		}
		out, e := exec.CommandContext(ctx, "docker", "ps", "--filter", "name=^/"+name+"$", "--format", "{{.Names}}").Output()
		if e != nil {
			return errors.New("CUSTODY_UNPROVEN")
		}
		if strings.TrimSpace(string(out)) != "" {
			return errors.New("IDENTITY_BOUND")
		}
	}
	return nil
}
func stateReason(e error) string {
	if os.IsNotExist(e) {
		return "SLOT_NOT_FOUND"
	}
	code := strings.SplitN(e.Error(), ":", 2)[0]
	if regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`).MatchString(code) {
		return code
	}
	return "SLOT_OPERATION_FAILED"
}
func (m *Manager) HandleState(ctx context.Context, r StateRequest) json.RawMessage {
	result := map[string]any{"schema": "capsule_state_event/v0.2", "operation_id": r.OperationID, "op": r.Op, "profile_id": r.ProfileID, "slot_id": r.SlotID, "event": "completed"}
	fail := func(e error) json.RawMessage {
		result["event"] = "refused"
		result["reason_code"] = stateReason(e)
		b, _ := json.Marshal(result)
		return b
	}
	if r.Schema != "capsule_state_request/v0.2" || !slotID.MatchString(r.ProfileID) || !slotID.MatchString(r.SlotID) || protectedIdentity(r.ProfileID) || r.ProfileID == m.cfg.SlotLiveProfile || !r.HumanConfirmed {
		return fail(errors.New("POLICY"))
	}
	if m.slots == nil {
		if m.slotInitErr != nil {
			return fail(m.slotInitErr)
		}
		return fail(errors.New("SLOT_STORE_UNAVAILABLE"))
	}
	m.mu.Lock()
	p, known := m.cfg.Profiles[r.ProfileID]
	m.mu.Unlock()
	kind := "browser"
	if known && p.Kind == "desktop_capsule" {
		kind = "program"
	}
	// Native metadata determines kind for identities that have not opened this session.
	if runner, ok := m.runner.(*ProcessRunner); ok {
		out, e := runner.Run(ctx, []string{filepath.Join(runner.root, "srf-identity-admin"), "show", "--id", r.ProfileID}, nil)
		if e != nil {
			return fail(e)
		}
		var meta struct {
			Browser string `json:"browser"`
		}
		if json.Unmarshal(out, &meta) != nil || (meta.Browser != "browser" && meta.Browser != "program") {
			return fail(errors.New("FOREIGN_IDENTITY"))
		}
		kind = meta.Browser
	}
	var manifest slots.Manifest
	var err error
	request := slots.Request{SourceProfileID: r.ProfileID, SlotID: r.SlotID, ProfileID: r.ProfileID, Kind: kind, Architecture: runtime.GOARCH, HumanConfirmed: r.HumanConfirmed}
	// The manifest pins the exact helper image; a different image is never inferred.
	if store, ok := m.slots.(*slots.Store); ok {
		request.Image = store.Image()
	}
	switch r.Op {
	case "list":
		release, e := m.slots.AcquireStopped(ctx, request)
		if e != nil {
			return fail(e)
		}
		defer release()
		var entries []slots.Entry
		entries, err = m.slots.List(ctx, r.ProfileID)
		if err == nil {
			result["slots"] = entries
		}
	case "save", "overwrite":
		request.CreateOnly = r.Op == "save"
		request.OverwriteOnly = r.Op == "overwrite"
		manifest, err = m.slots.Save(ctx, request)
	case "load":
		manifest, err = m.slots.Select(ctx, r.SlotID)
		if err == nil && manifest.ProfileID != r.ProfileID {
			err = errors.New("FOREIGN_SLOT")
		}
		if err == nil {
			manifest, err = m.slots.Load(ctx, request)
		}
	case "delete":
		err = m.slots.Delete(ctx, request)
	case "copy":
		if !slotID.MatchString(r.Destination) || r.Destination == r.ProfileID || r.Destination == m.cfg.SlotLiveProfile || protectedIdentity(r.Destination) {
			return fail(errors.New("IDENTITY_PROTECTED"))
		}
		release, e := m.slots.AcquireStopped(ctx, request)
		if e != nil {
			return fail(e)
		}
		defer release()
		manifest, err = m.slots.Select(ctx, r.SlotID)
		if err != nil {
			break
		}
		if manifest.ProfileID != r.ProfileID {
			return fail(errors.New("FOREIGN_SLOT"))
		}
		runner, ok := m.runner.(*ProcessRunner)
		if !ok {
			return fail(errors.New("IDENTITY_CREATION_UNAVAILABLE"))
		}
		// Native create refuses an existing identity; a failed load leaves a new,
		// stopped identity for explicit operator recovery rather than deleting data.
		_, err = runner.Run(ctx, []string{filepath.Join(runner.root, "srf-identity-admin"), "create", "--id", r.Destination, "--label", r.Destination, "--browser", kind, "--domains", ""}, nil)
		if err == nil {
			err = m.slots.Provision(ctx, r.Destination)
		}
		if err == nil {
			request.ProfileID = r.Destination
			manifest, err = m.slots.Load(ctx, request)
		}
	default:
		err = errors.New("POLICY")
	}
	if err != nil {
		return fail(err)
	}
	if manifest.Generation > 0 {
		result["generation"] = manifest.Generation
		result["sha256"] = manifest.PayloadSHA256
	}
	b, _ := json.Marshal(result)
	return b
}
