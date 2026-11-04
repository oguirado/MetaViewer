// Package headless owns one host-configured, persistent headless controller.
package headless

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
)

type Pin struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}
type File struct {
	Relative string `json:"relative"`
	Path     string `json:"path"`
	SHA256   string `json:"sha256"`
}
type Profile struct {
	Schema             string          `json:"schema"`
	OwnerID            string          `json:"owner_id"`
	GuardianUnit       string          `json:"guardian_unit"`
	Python             Pin             `json:"python"`
	PythonPrefix       string          `json:"python_prefix"`
	Runner             Pin             `json:"runner"`
	ControllerRelative string          `json:"controller_relative"`
	Files              []File          `json:"files"`
	ConfigTemplate     json.RawMessage `json:"config_template"`
	StateRoot          string          `json:"state_root"`
	RuntimeRoot        string          `json:"runtime_root"`
}

var unitPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,180}\.(service|scope)$`)
var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var ownerPattern = regexp.MustCompile(`^actor-[0-9a-f]{64}$`)

func canonical(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("absolute canonical path required")
	}
	actual, err := filepath.EvalSymlinks(path)
	if err != nil || actual != path {
		return errors.New("symlink or absent path")
	}
	return nil
}
func privateDir(path string) error {
	if err := canonical(path); err != nil {
		return err
	}
	st, err := os.Stat(path)
	if err != nil || !st.IsDir() || st.Mode().Perm() != 0700 {
		return errors.New("private directory required")
	}
	if st.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) {
		return errors.New("foreign directory")
	}
	return nil
}
func readRegular(path string, private bool, max int64) ([]byte, error) {
	if err := canonical(path); err != nil {
		return nil, err
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || max < 0 {
		return nil, errors.New("regular bounded source required")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	s := st.Sys().(*syscall.Stat_t)
	if !os.SameFile(before, st) || !st.Mode().IsRegular() || st.Size() > max || s.Nlink != 1 || (s.Uid != 0 && s.Uid != uint32(os.Getuid())) || st.Mode().Perm()&0022 != 0 || (private && (s.Uid != uint32(os.Getuid()) || st.Mode().Perm()&0077 != 0)) {
		return nil, errors.New("file custody refused")
	}
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	after, err := f.Stat()
	if err != nil {
		return nil, err
	}
	now, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	a := after.Sys().(*syscall.Stat_t)
	if int64(len(b)) > max || !os.SameFile(st, after) || !os.SameFile(st, now) || st.Size() != after.Size() || st.ModTime() != after.ModTime() || s.Ctim != a.Ctim || s.Mode != a.Mode || s.Uid != a.Uid || s.Nlink != a.Nlink {
		return nil, errors.New("source changed during read")
	}
	if err = canonical(path); err != nil {
		return nil, err
	}
	return b, nil
}
func pinnedExecutable(p Pin) ([]byte, error) {
	b, e := pinned(p, 64<<20)
	if e != nil {
		return nil, e
	}
	st, e := os.Lstat(p.Path)
	if e != nil {
		return nil, e
	}
	if st.Mode().Perm()&0111 == 0 {
		return nil, errors.New("executable permission required")
	}
	return b, nil
}
func pinned(p Pin, max int64) ([]byte, error) {
	if !digestPattern.MatchString(p.SHA256) {
		return nil, errors.New("digest required")
	}
	b, e := readRegular(p.Path, false, max)
	if e != nil {
		return nil, e
	}
	s := sha256.Sum256(b)
	if hex.EncodeToString(s[:]) != p.SHA256 {
		return nil, errors.New("pin mismatch")
	}
	return b, nil
}
func Load(path string) (*Profile, error) {
	b, e := readRegular(path, true, 65536)
	if e != nil {
		return nil, e
	}
	if e = uniqueJSON(b); e != nil {
		return nil, e
	}
	var p Profile
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if e = d.Decode(&p); e != nil {
		return nil, e
	}
	if d.Decode(new(any)) != io.EOF {
		return nil, errors.New("trailing profile")
	}
	if p.Schema != "mv-headless-host/v1" || !ownerPattern.MatchString(p.OwnerID) || !unitPattern.MatchString(p.GuardianUnit) || p.ControllerRelative != "mc06-controller/controller.py" {
		return nil, errors.New("profile identity")
	}
	if e = privateDir(p.StateRoot); e != nil {
		return nil, e
	}
	if e = privateDir(p.RuntimeRoot); e != nil {
		return nil, e
	}
	if e = canonical(p.PythonPrefix); e != nil {
		return nil, errors.New("canonical Python prefix required")
	}
	if p.StateRoot == p.RuntimeRoot {
		return nil, errors.New("distinct roots required")
	}
	if _, e = pinnedExecutable(p.Python); e != nil {
		return nil, e
	}
	if _, e = pinned(p.Runner, 1<<20); e != nil {
		return nil, e
	}
	required := map[string]bool{"mc06-controller/controller.py": false, "mc06-controller/arm_backend.py": false, "mc06-controller/contract_guard.py": false, "mc04-runtime/arm_harness.py": false, "mc05-contract-candidate/reference_model.py": false, "mc05-contract-candidate/contracts/v0.2/headless_request.schema.json": false, "mc05-contract-candidate/contracts/v0.2/headless_event.schema.json": false, "mc05-contract-candidate/contracts/v0.2/headless_session.schema.json": false}
	for _, f := range p.Files {
		v, ok := required[f.Relative]
		if !ok || v {
			return nil, errors.New("dependency closure")
		}
		required[f.Relative] = true
		if _, e = pinned(Pin{f.Path, f.SHA256}, 2<<20); e != nil {
			return nil, e
		}
	}
	for _, ok := range required {
		if !ok {
			return nil, errors.New("missing dependency")
		}
	}
	var config map[string]json.RawMessage
	if json.Unmarshal(p.ConfigTemplate, &config) != nil {
		return nil, errors.New("config template")
	}
	var owner, root string
	json.Unmarshal(config["owner_id"], &owner)
	json.Unmarshal(config["runtime_root"], &root)
	if owner != p.OwnerID || root != p.RuntimeRoot {
		return nil, errors.New("config authority mismatch")
	}
	if e = validateTemplate(p.ConfigTemplate); e != nil {
		return nil, e
	}
	return &p, nil
}

func uniqueJSON(raw []byte) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	var walk func() error
	walk = func() error {
		t, e := d.Token()
		if e != nil {
			return e
		}
		delim, ok := t.(json.Delim)
		if !ok {
			return nil
		}
		if delim == '{' {
			seen := map[string]bool{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return e
				}
				s, ok := k.(string)
				if !ok || seen[s] {
					return errors.New("duplicate JSON key")
				}
				seen[s] = true
				if e = walk(); e != nil {
					return e
				}
			}
		} else if delim == '[' {
			for d.More() {
				if e = walk(); e != nil {
					return e
				}
			}
		} else {
			return errors.New("JSON delimiter")
		}
		_, e = d.Token()
		return e
	}
	if e := walk(); e != nil {
		return e
	}
	if _, e := d.Token(); e != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}

func validateTemplate(raw []byte) error {
	var c struct {
		Schema     string         `json:"schema"`
		Owner      string         `json:"owner_id"`
		Generation int64          `json:"generation"`
		Admitted   *bool          `json:"runtime_admitted"`
		Artifacts  map[string]Pin `json:"artifacts"`
		Resources  struct {
			Memory int `json:"mem_size_mib"`
			CPU    int `json:"vcpu_count"`
		} `json:"resources"`
		Deadlines map[string]int `json:"deadlines"`
		Root      string         `json:"runtime_root"`
		Cgroup    string         `json:"external_cgroup"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(&c); e != nil {
		return e
	}
	if c.Schema != "mc06-host-config/v1" || c.Admitted == nil || c.Generation < 1 || c.Generation > 9007199254740991 || c.Resources.Memory != 256 || c.Resources.CPU != 1 || len(c.Artifacts) != 3 || len(c.Deadlines) != 3 {
		return errors.New("config template contract")
	}
	for _, k := range []string{"startup_seconds", "job_seconds", "stop_seconds"} {
		if c.Deadlines[k] < 1 || c.Deadlines[k] > 30 {
			return errors.New("deadline contract")
		}
	}
	for _, k := range []string{"engine", "kernel", "init"} {
		p, ok := c.Artifacts[k]
		if !ok || !filepath.IsAbs(p.Path) || filepath.Clean(p.Path) != p.Path || !digestPattern.MatchString(p.SHA256) {
			return errors.New("artifact contract")
		}
	}
	return nil
}
