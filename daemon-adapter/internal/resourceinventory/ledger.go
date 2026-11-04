// Package resourceinventory records allocations before effects. It never infers
// absence from missing evidence and never resumes a crashed producer.
package resourceinventory

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"metaviewer/daemon-adapter/internal/ipc"
)

const maxJournal = 8 << 20
const maxRows = 8192
const maxPayload = 65536
const maxSafe = 9007199254740991

type Row struct {
	Schema  string `json:"schema"`
	Seq     uint64 `json:"seq"`
	Prev    string `json:"prev"`
	Payload string `json:"payload"`
	SHA256  string `json:"sha256"`
}
type Producer struct {
	mu                         sync.Mutex
	cfg                        Config
	name                       string
	root, lock, journal, lease *os.File
	rootStat                   syscall.Stat_t
	closed, poisoned           bool
	syncFile                   func(*os.File) error
}
type History struct {
	Rows          []Row
	Last          map[string]uint64
	Sealed        map[string]bool
	Resources     map[string]map[string]any
	Guardian, App map[string]any
	Coordinator   bool
}

func hash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func rowHash(seq uint64, prev, payload string) string {
	return hash([]byte(strconv.FormatUint(seq, 10) + "\n" + prev + "\n" + payload))
}
func decode(b []byte, out any) error {
	if err := ipc.ValidateJSON(b, ipc.Config{MaxFrameBytes: 512 << 10, MaxDepth: 32, MaxStringBytes: 256 << 10, MaxKeys: 256, MaxArrayItems: 8192}); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	d.DisallowUnknownFields()
	if e := d.Decode(out); e != nil {
		return e
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing inventory JSON")
	}
	return nil
}
func number(v any) (uint64, error) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, errors.New("integer required")
	}
	i, e := strconv.ParseUint(string(n), 10, 64)
	if e != nil || i > maxSafe {
		return 0, errors.New("integer bound")
	}
	return i, nil
}
func text(m map[string]any, key string) string { s, _ := m[key].(string); return s }
func object(v any) map[string]any              { m, _ := v.(map[string]any); return m }
func same(a, b any) bool                       { x, _ := json.Marshal(a); y, _ := json.Marshal(b); return bytes.Equal(x, y) }
func fail(s string) error                      { return errors.New("resource inventory: " + s) }
func fields(m map[string]any, names string) error {
	keys := strings.Split(names, ",")
	if len(m) != len(keys) {
		return fail("closed payload fields")
	}
	for _, k := range keys {
		if _, ok := m[k]; !ok {
			return fail("missing " + k)
		}
	}
	return nil
}

var stageFields = map[string]string{
	"session":        "stage,producer,run_id,actor,unit,root_device,root_inode,source_commit,asar_sha256,session_helper_sha256,setup_helper_sha256,producer_pins,package_manifest,registry_sha256",
	"guardian_bound": "stage,producer,id,unit,invocation,cgroup,device,inode",
	"app_pending":    "stage,producer,id", "app_bound": "stage,producer,id,pid,start_ticks,cgroup",
	"native_pending": "stage,producer,id,generation,profile_id,native_kind,container_name,image_id,payload,payload_device,payload_inode",
	"native_bound":   "stage,producer,id,container_name,run_id,cid,native_pid,native_state_path,native_state_sha256", "native_closed": "stage,producer,id",
	"service_pending": "stage,producer,id,unit", "service_bound": "stage,producer,id,unit,invocation,cgroup,device,inode,pid,start_ticks", "service_closed": "stage,producer,id",
	"helper_pending": "stage,producer,id,name,image_id,payload,payload_device,payload_inode", "helper_bound": "stage,producer,id,cid", "helper_removed": "stage,producer,id",
	"unknown": "stage,producer,id,reason", "producer_sealed": "stage,producer,last_seq", "coordinator_sealed": "stage,producer,producer_ids,last_seq,inventory_sha256",
}

func validateBody(b map[string]any) error {
	stage, producer := text(b, "stage"), text(b, "producer")
	f, ok := stageFields[stage]
	if !ok {
		return fail("unknown stage")
	}
	if e := fields(b, f); e != nil {
		return e
	}
	if producer != "setup" && producer != "graphical" && producer != "guestcommand" {
		return fail("producer")
	}
	owner := "setup"
	if strings.HasPrefix(stage, "native_") {
		owner = "graphical"
	}
	if strings.HasPrefix(stage, "service_") {
		owner = "guestcommand"
	}
	if stage != "unknown" && stage != "producer_sealed" && producer != owner {
		return fail("stage owner")
	}
	for k, v := range b {
		switch k {
		case "root_device", "root_inode", "device", "inode", "pid", "start_ticks", "payload_device", "payload_inode", "last_seq":
			n, e := number(v)
			if e != nil || ((k != "last_seq" && k != "root_device" && k != "device" && k != "payload_device") && n == 0) {
				return fail("numeric payload")
			}
		case "producer_pins", "package_manifest", "native_pid", "producer_ids":
		default:
			s, ok := v.(string)
			if !ok || s == "" || len(s) > 4096 {
				return fail("string payload")
			}
		}
	}
	for _, k := range []string{"source_commit"} {
		if v, ok := b[k]; ok && !hexLen(v, 40) {
			return fail(k)
		}
	}
	for _, k := range []string{"asar_sha256", "session_helper_sha256", "setup_helper_sha256", "registry_sha256", "native_state_sha256", "inventory_sha256", "cid"} {
		if v, ok := b[k]; ok && !hexLen(v, 64) {
			return fail(k)
		}
	}
	if v, ok := b["invocation"]; ok && !hexLen(v, 32) {
		return fail("invocation")
	}
	if v, ok := b["native_pid"]; ok {
		m := object(v)
		if e := fields(m, "pid,start"); e != nil {
			return e
		}
		for _, k := range []string{"pid", "start"} {
			n, e := number(m[k])
			if e != nil || n == 0 {
				return fail("native PID identity")
			}
		}
	}
	if v, ok := b["image_id"]; ok {
		if !strings.HasPrefix(v.(string), "sha256:") || !hexLen(strings.TrimPrefix(v.(string), "sha256:"), 64) {
			return fail("image identity")
		}
	}
	return nil
}
func hexLen(v any, n int) bool {
	s, ok := v.(string)
	if !ok || len(s) != n {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func parseHistory(cfg Config, raw []byte, st syscall.Stat_t) (History, error) {
	h := History{Last: map[string]uint64{}, Sealed: map[string]bool{}, Resources: map[string]map[string]any{}}
	if len(raw) > maxJournal || len(raw) > 0 && raw[len(raw)-1] != '\n' {
		return h, fail("torn or oversized journal")
	}
	lines := bytes.Split(bytes.TrimSuffix(raw, []byte("\n")), []byte("\n"))
	if len(raw) == 0 {
		lines = nil
	}
	if len(lines) > maxRows {
		return h, fail("row bound")
	}
	prev := strings.Repeat("0", 64)
	for _, line := range lines {
		var row Row
		if e := decode(line, &row); e != nil {
			return h, e
		}
		if row.Schema != "capsule_resource_inventory/v0.2" || row.Seq != uint64(len(h.Rows)+1) || row.Prev != prev || len(row.Payload) > maxPayload || row.SHA256 != rowHash(row.Seq, row.Prev, row.Payload) {
			return h, fail("chain mismatch")
		}
		var b map[string]any
		if e := decode([]byte(row.Payload), &b); e != nil {
			return h, e
		}
		if e := validateBody(b); e != nil {
			return h, e
		}
		stage, p := text(b, "stage"), text(b, "producer")
		if h.Coordinator || (h.Sealed[p] && stage != "coordinator_sealed") {
			return h, fail("write after seal")
		}
		if len(h.Rows) == 0 && stage != "session" {
			return h, fail("header required")
		}
		switch stage {
		case "session":
			if len(h.Rows) != 0 || !same(b, cfg.header(st)) {
				return h, fail("header binding")
			}
		case "guardian_bound":
			if text(b, "id") != "guardian" || h.Guardian != nil || text(b, "unit") != cfg.unit() || !validGroup(text(b, "cgroup"), cfg.unit()) {
				return h, fail("guardian binding")
			}
			h.Guardian = b
		case "app_pending":
			if text(b, "id") != "app" || h.Guardian == nil || h.App != nil {
				return h, fail("app admission")
			}
			h.App = map[string]any{"pending": b}
		case "app_bound":
			if text(b, "id") != "app" || h.App == nil || h.App["bound"] != nil || text(b, "cgroup") != text(h.Guardian, "cgroup") {
				return h, fail("app binding")
			}
			h.App["bound"] = b
		case "native_pending", "service_pending", "helper_pending":
			key := p + ":" + text(b, "id")
			if h.Resources[key] != nil || (h.App == nil && stage != "helper_pending") {
				return h, fail("allocation admission")
			}
			if stage == "native_pending" {
				kind := text(b, "native_kind")
				profile := text(b, "profile_id")
				prefix := map[string]string{"vm": "srf-vm-", "browser": "srf-id-", "program": "srf-pg-"}[kind]
				if !cfg.allowsProfile(kind, profile) || prefix == "" || text(b, "container_name") != prefix+profile || text(b, "generation") != text(b, "id") || text(b, "image_id") != cfg.Images[kind] || text(b, "payload") != filepath.Join(cfg.Root, "store", "profiles", profile) {
					return h, fail("foreign native allocation")
				}
			}
			if stage == "helper_pending" {
				if strings.HasPrefix(text(b, "name"), "mv-provision-") {
					name := text(b, "name")
					suffix := len(name) - 13
					if cfg.IdentityProvisioner == nil || cfg.Images["browser"] == "" || suffix <= len("mv-provision-") || !hexLen(name[suffix+1:], 12) || name[suffix] != '-' {
						return h, fail("foreign identity helper")
					}
					profile := name[len("mv-provision-"):suffix]
					if !validProgramProfile(profile) || text(b, "id") != name || text(b, "image_id") != cfg.Images["browser"] || text(b, "payload") != filepath.Join(cfg.Root, "store", "profiles", profile) {
						return h, fail("foreign identity helper tuple")
					}
				} else {
					matched := ""
					for kind, image := range cfg.Images {
						if text(b, "name") == "mv-arm64-payload-"+kind+"-"+cfg.RunID && text(b, "image_id") == image && text(b, "payload") == filepath.Join(cfg.Root, "store", "profiles", cfg.profile(kind)) {
							matched = kind
						}
					}
					if matched == "" {
						return h, fail("foreign helper allocation")
					}
				}
			}
			if stage == "service_pending" && !serviceUnit.MatchString(text(b, "unit")) {
				return h, fail("service name")
			}
			h.Resources[key] = map[string]any{"pending": b}
		case "native_bound", "service_bound", "helper_bound", "native_closed", "service_closed", "helper_removed":
			key := p + ":" + text(b, "id")
			r := h.Resources[key]
			family := strings.Split(stage, "_")[0]
			if r == nil || text(object(r["pending"]), "stage") != family+"_pending" {
				return h, fail("unreserved allocation")
			}
			pending := object(r["pending"])
			if strings.HasSuffix(stage, "_bound") {
				if r["bound"] != nil || r["closed"] != nil {
					return h, fail("duplicate binding")
				}
				if family == "native" && (text(b, "container_name") != text(pending, "container_name") || text(b, "run_id") != text(pending, "container_name") || text(b, "native_state_path") != filepath.Join(cfg.Root, "native-state", text(b, "container_name")+".json")) {
					return h, fail("native binding")
				}
				if family == "service" && (text(b, "unit") != text(pending, "unit") || !validGroup(text(b, "cgroup"), text(b, "unit"))) {
					return h, fail("service binding")
				}
				r["bound"] = b
			} else {
				if r["bound"] == nil || r["closed"] != nil {
					return h, fail("closure without binding")
				}
				r["closed"] = b
			}
		case "unknown":
			if len(text(b, "reason")) > 256 {
				return h, fail("unknown reason bound")
			}
			h.Resources["unknown:"+strconv.FormatUint(row.Seq, 10)] = map[string]any{"unknown": b}
		case "producer_sealed":
			n, e := number(b["last_seq"])
			if e != nil || n != h.Last[p] {
				return h, fail("producer seal sequence")
			}
			h.Sealed[p] = true
		case "coordinator_sealed":
			n, e := number(b["last_seq"])
			ids := []string{}
			for _, r := range h.Rows {
				ids = append(ids, r.SHA256)
			}
			if e != nil || n != uint64(len(h.Rows)) || len(h.Sealed) != 3 || !same(b["producer_ids"], []string{"graphical", "guestcommand", "setup"}) || text(b, "inventory_sha256") != hash([]byte(strings.Join(ids, "\n"))) {
				return h, fail("coordinator seal")
			}
			h.Coordinator = true
		}
		h.Rows = append(h.Rows, row)
		h.Last[p] = row.Seq
		prev = row.SHA256
	}
	return h, nil
}
func (p *Producer) transaction(body map[string]any) error {
	if p.closed || p.poisoned {
		return fail("producer fenced")
	}
	if text(body, "producer") != p.name {
		return fail("foreign producer")
	}
	if e := p.checkRoot(); e != nil {
		return e
	}
	if e := lockBounded(p.lock); e != nil {
		return e
	}
	defer syscall.Flock(int(p.lock.Fd()), syscall.LOCK_UN)
	if _, e := p.journal.Seek(0, 0); e != nil {
		return e
	}
	raw, e := io.ReadAll(io.LimitReader(p.journal, maxJournal+1))
	if e != nil {
		return e
	}
	h, e := parseHistory(p.cfg, raw, p.rootStat)
	if e != nil {
		return e
	}
	if h.Sealed[p.name] || h.Coordinator {
		return fail("producer already sealed")
	}
	if len(h.Rows) == 0 {
		return fail("setup header absent")
	}
	if text(body, "stage") == "producer_sealed" {
		body["last_seq"] = h.Last[p.name]
	}
	payload, e := json.Marshal(body)
	if e != nil {
		return e
	}
	if len(payload) > maxPayload {
		return fail("payload bound")
	}
	prev := strings.Repeat("0", 64)
	if len(h.Rows) > 0 {
		prev = h.Rows[len(h.Rows)-1].SHA256
	}
	row := Row{Schema: "capsule_resource_inventory/v0.2", Seq: uint64(len(h.Rows) + 1), Prev: prev, Payload: string(payload)}
	row.SHA256 = rowHash(row.Seq, row.Prev, row.Payload)
	line, e := json.Marshal(row)
	if e != nil {
		return e
	}
	line = append(line, '\n')
	candidate := append(append([]byte(nil), raw...), line...)
	if _, e = parseHistory(p.cfg, candidate, p.rootStat); e != nil {
		return e
	}
	if _, e = p.journal.Seek(0, io.SeekEnd); e != nil {
		return e
	}
	for data := line; len(data) > 0; {
		n, err := p.journal.Write(data)
		if err != nil || n == 0 {
			p.poisoned = true
			return fail("append uncertain")
		}
		data = data[n:]
	}
	if e = p.syncFile(p.journal); e == nil {
		e = p.syncFile(p.root)
	}
	if e != nil {
		p.poisoned = true
		return e
	}
	if e = p.checkRoot(); e != nil {
		p.poisoned = true
		return e
	}
	return nil
}
func (p *Producer) Append(stage, id string, values map[string]any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	b := map[string]any{"stage": stage, "producer": p.name}
	if id != "" {
		b["id"] = id
	}
	for k, v := range values {
		if _, ok := b[k]; ok {
			return fail("reserved payload key")
		}
		b[k] = v
	}
	return p.transaction(b)
}
func (p *Producer) Unknown(id string) error {
	return p.Append("unknown", id, map[string]any{"reason": "allocation outcome uncertain"})
}
func (p *Producer) Seal() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	e := p.transaction(map[string]any{"stage": "producer_sealed", "producer": p.name, "last_seq": 0})
	p.closed = true
	for _, f := range []*os.File{p.journal, p.lock, p.lease, p.root} {
		if f != nil {
			_ = f.Close()
		}
	}
	return e
}
func validGroup(group, unit string) bool {
	prefix := fmt.Sprintf("/user.slice/user-%d.slice/user@%d.service/", os.Getuid(), os.Getuid())
	return group == prefix+"newton-ia.slice/"+unit || group == prefix+"newton.slice/newton-ia.slice/"+unit
}

func lockBounded(f *os.File) error {
	end := time.Now().Add(2 * time.Second)
	for {
		e := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if e == nil {
			return nil
		}
		if e != syscall.EWOULDBLOCK && e != syscall.EAGAIN {
			return e
		}
		if !time.Now().Before(end) {
			return fail("shared inventory lock busy")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
