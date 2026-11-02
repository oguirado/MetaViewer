package capsule

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"metaviewer/daemon-adapter/internal/cli"
)

func isHostWindowMinimizedReason(s string) bool {
	lower := strings.ToLower(s)
	return strings.Contains(lower, "minimized") || strings.Contains(lower, "iconic") || strings.Contains(lower, "unmapped")
}

func isHostWindowTerminalReason(s string) bool {
	lower := strings.ToLower(s)
	if isHostWindowMinimizedReason(lower) {
		return false
	}
	return strings.Contains(lower, "host_window_unavailable:") ||
		strings.Contains(lower, "witness") ||
		strings.Contains(lower, "closed") ||
		strings.Contains(lower, "no such window") ||
		strings.Contains(lower, "badwindow") ||
		strings.Contains(lower, "baddrawable") ||
		strings.Contains(lower, "destroyed") ||
		strings.Contains(lower, "not found") ||
		strings.Contains(lower, "gone")
}

// DecodeHostWindowXWD decodes one big-endian 32-bpp ZPixmap XWD frame
// (srf-fbread getimage / srf-host-window capture format) into RGB24 bytes.
func DecodeHostWindowXWD(data []byte) ([]byte, int, int, error) {
	if len(data) < 100 {
		return nil, 0, 0, errors.New("XWD frame too short")
	}
	be := binary.BigEndian
	size := int(be.Uint32(data[0:]))
	w, ht := int(be.Uint32(data[16:])), int(be.Uint32(data[20:]))
	order, bpp, bpl, ncolors := be.Uint32(data[28:]), be.Uint32(data[44:]), int(be.Uint32(data[48:])), int(be.Uint32(data[76:]))
	if size < 100 || size > 4096 || be.Uint32(data[4:]) != 7 || be.Uint32(data[8:]) != 2 || order > 1 || bpp != 32 || w < 1 || ht < 1 || w > 4096 || ht > 4096 || bpl < 4*w || bpl > 4*w+64 || ncolors < 0 || ncolors > 256 {
		return nil, 0, 0, errors.New("invalid XWD header")
	}
	off := size + ncolors*12
	need := off + bpl*ht
	if len(data) < need {
		return nil, 0, 0, errors.New("truncated XWD pixels")
	}
	pix := data[off:need]
	rgb := make([]byte, w*ht*3)
	for y := 0; y < ht; y++ {
		src := pix[y*bpl:]
		dst := rgb[y*w*3:]
		for x := 0; x < w; x++ {
			if order == 0 {
				dst[x*3], dst[x*3+1], dst[x*3+2] = src[x*4+2], src[x*4+1], src[x*4]
			} else {
				dst[x*3], dst[x*3+1], dst[x*3+2] = src[x*4+1], src[x*4+2], src[x*4+3]
			}
		}
	}
	return rgb, w, ht, nil
}

func (m *Manager) attachHostWindow(qProfileID, id, version string, p Profile, spec *HostWindowSpec, geom Geometry) ([]json.RawMessage, error) {
	container := fmt.Sprintf("srf-hw-%s-%d", qProfileID, spec.XID)
	shortID := strings.TrimPrefix(id, "surface-")
	if len(shortID) > 16 {
		shortID = shortID[:16]
	}
	runIDStr := "run-hw-" + shortID
	framesRoot := filepath.Join(p.RAMRoot, runIDStr, "frames", "w1")
	for _, old := range m.bindings {
		if old.Surface.State != "destroyed" && (old.RunID == runIDStr || old.FramesRoot == framesRoot || under(old.FramesRoot, framesRoot) || under(framesRoot, old.FramesRoot) || old.Container == container) {
			return nil, fault("binding", "native run or frame allocation already observed")
		}
	}
	if err := os.MkdirAll(framesRoot, 0700); err != nil {
		return nil, fault("configuration", "failed to allocate host-window frames directory")
	}
	if err := os.Chmod(framesRoot, 0700); err != nil {
		return nil, fault("configuration", "failed to secure host-window frames directory")
	}
	b := Binding{
		Role: "agent",
		Surface: Surface{
			Schema:     "surface/" + version,
			SurfaceID:  id,
			Kind:       "desktop_capsule",
			Display:    p.Display,
			Geometry:   geom,
			State:      "active",
			Visibility: "unfolded",
			Control:    "agent",
			ProfileID:  qProfileID,
		},
		Container:      container,
		RunID:          runIDStr,
		Window:         "w1",
		FramesRoot:     framesRoot,
		NativeKind:     "host-window",
		Program:        "host-window",
		HostXID:        spec.XID,
		HostWitness:    spec.Witness,
		HostTitle:      spec.Title,
		HostProgram:    spec.Program,
		HostDisplay:    spec.Display,
		HostXauthority: spec.Xauthority,
		BinDir:         m.cfg.BinDir,
	}
	m.bindings[id] = b
	delete(m.quarantined, qProfileID)
	return []json.RawMessage{surfaceEvent(version, "created", b.Surface)}, nil
}

func (m *Manager) detachHostWindowLocked(b Binding) error {
	delete(m.hostSeq, b.Surface.SurfaceID)
	if profile, ok := m.cfg.Profiles[b.Surface.ProfileID]; ok && profile.RAMRoot != "" && b.RunID != "" {
		runDir := filepath.Join(profile.RAMRoot, b.RunID)
		if under(profile.RAMRoot, runDir) {
			_ = os.RemoveAll(runDir)
		}
	}
	return nil
}

func writeHostWindowFrameFile(framesRoot string, seq uint64, rgb []byte) (string, error) {
	if err := os.MkdirAll(framesRoot, 0700); err != nil {
		return "", err
	}
	entries, _ := os.ReadDir(framesRoot)
	name := fmt.Sprintf("frame-%d.rgb24", seq)
	tmpPath := filepath.Join(framesRoot, name+".tmp")
	finalPath := filepath.Join(framesRoot, name)
	if err := os.WriteFile(tmpPath, rgb, 0600); err != nil {
		return "", err
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	for _, entry := range entries {
		if entry.Name() != name && strings.HasPrefix(entry.Name(), "frame-") {
			_ = os.Remove(filepath.Join(framesRoot, entry.Name()))
		}
	}
	return finalPath, nil
}

func (m *Manager) captureHostWindow(ctx context.Context, id string) (Binding, NativeFrame, error) {
	m.mu.Lock()
	b, ok := m.bindings[id]
	if !ok || b.Surface.State != "active" || b.recoveryProbe != nil || m.destroying[id] {
		m.mu.Unlock()
		return Binding{}, NativeFrame{}, fault("surface", "capture requires an active surface")
	}
	if m.hasPending(id) {
		m.mu.Unlock()
		return Binding{}, NativeFrame{}, fault("POLICY", "input must be drained before capture")
	}
	epoch := m.beginCapture(id)
	profile := m.cfg.Profiles[b.Surface.ProfileID]
	args := append([]string{"capture", "--xid", strconv.FormatUint(uint64(b.HostXID), 10), "--witness", b.HostWitness, "--max-frames", "1"}, HostWindowSessionArgs(b.HostDisplay, b.HostXauthority)...)
	before := m.clock()
	m.mu.Unlock()

	out, execErr := m.executeRawHostWindow(ctx, profile, args, nil)
	after := m.clock()

	var rgb []byte
	var w, h int
	var decodeErr error
	if execErr == nil {
		rgb, w, h, decodeErr = DecodeHostWindowXWD(out)
		if decodeErr != nil {
			if reason := extractHostWindowRefusal(string(out)); reason != "" {
				execErr = fault("host_window_unavailable", reason)
			} else {
				execErr = fault("frame", "invalid host window XWD frame")
			}
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.bindings[id]
	if !ok || current.Surface.State != "active" || current.recoveryProbe != nil || m.destroying[id] || current.Container != b.Container || current.RunID != b.RunID {
		return Binding{}, NativeFrame{}, fault("surface", "capture requires an active surface")
	}
	if m.hasPending(id) || m.inputEpochs[id] != epoch {
		return Binding{}, NativeFrame{}, fault("POLICY", "input must be drained before capture")
	}
	if execErr != nil {
		errText := execErr.Error()
		if isHostWindowMinimizedReason(errText) {
			current.HostMinimized = true
			m.bindings[id] = current
			return current, NativeFrame{}, fault("host_window_unavailable", extractOrDefaultHostWindowReason(errText, "host_window_unavailable: window minimized"))
		}
		if isHostWindowTerminalReason(errText) {
			reason := extractOrDefaultHostWindowReason(errText, "host_window_unavailable: window closed or witness changed")
			current.HostLostReason = reason
			m.bindings[id] = current
			_, _ = m.markLostLocked(id, true, false)
			return m.bindings[id], NativeFrame{}, fault("host_window_unavailable", reason)
		}
		return current, NativeFrame{}, execErr
	}
	current.HostMinimized = false
	current.Surface.Geometry = Geometry{W: w, H: h}
	if pt, ok := m.cfg.Profiles[current.Surface.ProfileID]; ok {
		pt.Width = w
		pt.Height = h
		m.cfg.Profiles[current.Surface.ProfileID] = pt
	}
	if m.hostSeq == nil {
		m.hostSeq = make(map[string]uint64)
	}
	m.hostSeq[id]++
	seq := m.hostSeq[id]
	framePath, writeErr := writeHostWindowFrameFile(current.FramesRoot, seq, rgb)
	if writeErr != nil || !under(current.FramesRoot, framePath) {
		return current, NativeFrame{}, fault("frame", "native frame allocation mismatch")
	}
	m.bindings[id] = current
	delete(m.refresh, id)
	sum := sha256.Sum256(rgb)
	mono := after
	if mono < before {
		mono = before
	}
	if mono < m.cfg.OriginNS {
		mono = m.cfg.OriginNS
	}
	f := NativeFrame{
		Path:          framePath,
		Seq:           seq,
		SHA256RGB24:   hex.EncodeToString(sum[:]),
		Width:         w,
		Height:        h,
		CaptureMonoNS: mono,
		Generation:    current.Container,
		Window: &Window{
			ID:    current.Window,
			W:     w,
			H:     h,
			Title: current.HostTitle,
		},
		TSNS:      mono - m.cfg.OriginNS,
		CaptureUS: (after - before) / 1000,
	}
	return current, f, nil
}

func extractOrDefaultHostWindowReason(raw, fallback string) string {
	if r := extractHostWindowRefusal(raw); r != "" {
		return r
	}
	return fallback
}

func (m *Manager) executeRawHostWindow(ctx context.Context, p Profile, args []string, in []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, m.cfg.Timeout)
	defer cancel()
	argv := append([]string{filepath.Join(m.cfg.BinDir, "srf-host-window")}, args...)
	return m.runner.Run(ctx, argv, in)
}

func (m *Manager) inputHostWindow(ctx context.Context, surfaceID, proposalID, origin, actionType string, x, y *int, button string, keys []string, text string, version string, evidence *InputEvidence) ([]json.RawMessage, error) {
	b := m.bindings[surfaceID]
	xidStr := strconv.FormatUint(uint64(b.HostXID), 10)
	baseArgs := append([]string{"input", "--xid", xidStr, "--witness", b.HostWitness}, HostWindowSessionArgs(b.HostDisplay, b.HostXauthority)...)
	var callArgvs [][]string
	var textChunks [][]byte
	nativeAction := actionType

	switch actionType {
	case "click":
		_, valid := map[string]string{"left": "1", "middle": "2", "right": "3"}[button]
		if !valid || x == nil || y == nil || *x < 0 || *y < 0 || *x >= b.Surface.Geometry.W || *y >= b.Surface.Geometry.H || len(keys) != 0 || text != "" {
			return nil, fault("input", "invalid click")
		}
		callArgvs = [][]string{append(append([]string(nil), baseArgs...), "--click", strconv.Itoa(*x), strconv.Itoa(*y))}
	case "key":
		if len(keys) < 1 || len(keys) > 8 || x != nil || y != nil || button != "" || text != "" {
			return nil, fault("input", "invalid key")
		}
		key := strings.Join(keys, "+")
		if !regexp.MustCompile(`^[A-Za-z0-9_+]{1,32}$`).MatchString(key) {
			return nil, fault("input", "invalid key chord")
		}
		callArgvs = [][]string{append(append([]string(nil), baseArgs...), "--key", key)}
	case "type":
		if len(text) == 0 || x != nil || y != nil || button != "" || len(keys) != 0 {
			return nil, fault("input", "invalid text")
		}
		if utf8.RuneCountInString(text) > AdapterTextMaxRunes {
			return nil, fault("TEXT_TOO_LONG", "text exceeds adapter rune limit")
		}
		for _, r := range text {
			if !unicode.IsPrint(r) {
				return nil, fault("input", "text must contain printable runes")
			}
		}
		runes := []rune(text)
		for len(runes) > 0 {
			n := min(len(runes), NativeTextMaxRunes)
			chunk := string(runes[:n])
			textChunks = append(textChunks, []byte(chunk))
			callArgvs = append(callArgvs, append(append([]string(nil), baseArgs...), "--type", chunk))
			runes = runes[n:]
		}
		nativeAction = "text"
	default:
		return nil, cli.Unsupported("input action")
	}

	run, cancel := context.WithCancel(ctx)
	pending := &pendingInput{surface: surfaceID, epoch: m.nextInputEpoch(surfaceID), cancel: cancel}
	m.pending[proposalID] = pending
	m.used[proposalID] = true
	defer func() {
		cancel()
		pending.done = true
		if !pending.cancelled {
			delete(m.pending, proposalID)
		}
	}()

	dispatched := b
	var receipt NativeInputReceipt
	var sequence *TextSequenceEvidence
	if len(textChunks) > 1 {
		sequence = &TextSequenceEvidence{}
	}
	for i, argv := range callArgvs {
		if err := run.Err(); err != nil {
			return nil, err
		}
		before := m.clock()
		profile := m.cfg.Profiles[b.Surface.ProfileID]
		m.mu.Unlock()
		out, execErr := m.executeRawHostWindow(run, profile, argv, nil)
		after := m.clock()
		m.mu.Lock()
		if pending.cancelled {
			return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "input cancelled by control takeover")
		}
		b, ok := m.bindings[surfaceID]
		if !ok || b.Surface.State != "active" || b.recoveryProbe != nil || m.destroying[surfaceID] || b.Container != dispatched.Container || b.RunID != dispatched.RunID {
			return nil, fault("surface", "surface lost during input")
		}
		if b.Surface.Control != origin {
			if origin == "human" {
				return nil, fault("SURFACE_NOT_HUMAN_CONTROLLED", "agent control blocks human input")
			}
			return nil, fault("SURFACE_NOT_AGENT_CONTROLLED", "human control blocks agent input")
		}
		if execErr == nil {
			if reason := extractHostWindowRefusal(string(out)); reason != "" {
				execErr = fault("host_window_unavailable", reason)
			}
		}
		if execErr != nil {
			errText := execErr.Error()
			if isHostWindowTerminalReason(errText) {
				reason := extractOrDefaultHostWindowReason(errText, "host_window_unavailable: window closed or witness changed")
				b.HostLostReason = reason
				m.bindings[surfaceID] = b
				_, _ = m.markLostLocked(surfaceID, true, false)
				return nil, fault("host_window_unavailable", reason)
			}
			return nil, execErr
		}
		receipt = NativeInputReceipt{}
		trimmed := bytes.TrimSpace(out)
		if len(trimmed) > 0 && trimmed[0] == '{' {
			if e := cli.ParseLine(out, m.cfg.MaxOutputBytes, &receipt); e != nil {
				return nil, e
			}
			if receipt.Result == "refused" {
				return nil, fault("refused", "native input refused")
			}
		}
		mono := after
		if mono < before {
			mono = before
		}
		if mono < m.cfg.OriginNS {
			mono = m.cfg.OriginNS
		}
		if receipt.InputMonoNS != nil {
			if *receipt.InputMonoNS < m.cfg.OriginNS || *receipt.InputMonoNS > 9007199254740991 || *receipt.InputMonoNS < before || *receipt.InputMonoNS > after || after < before {
				return nil, fault("input", "unverified input receipt")
			}
		} else {
			receipt.InputMonoNS = &mono
		}
		if receipt.SurfaceID == "" {
			receipt.SurfaceID = b.Window
		}
		if receipt.Kind == "" {
			receipt.Kind = nativeAction
		}
		if receipt.Result == "" {
			receipt.Result = "ok"
		}
		if receipt.FocusVerified == nil {
			fv := true
			receipt.FocusVerified = &fv
		}
		if receipt.SurfaceID != b.Window || receipt.Kind != nativeAction || !*receipt.FocusVerified || receipt.Result != "ok" {
			return nil, fault("input", "unverified input receipt")
		}
		if sequence != nil && i < len(textChunks) {
			sum := sha256.Sum256(textChunks[i])
			sequence.Chunks = append(sequence.Chunks, TextChunkEvidence{NativeInputReceipt: receipt, Runes: utf8.RuneCount(textChunks[i]), SHA256: hex.EncodeToString(sum[:])})
		}
	}
	if m.bindings[surfaceID].Surface.State != "active" {
		return nil, fault("surface", "surface lost during input verification")
	}
	if evidence != nil {
		*evidence = InputEvidence{
			TextSequence:    sequence,
			SurfaceID:       surfaceID,
			NativeSurfaceID: receipt.SurfaceID,
			Kind:            receipt.Kind,
			InputMonoNS:     *receipt.InputMonoNS,
			InputTSNS:       *receipt.InputMonoNS - m.cfg.OriginNS,
			FocusVerified:   receipt.FocusVerified,
			Result:          receipt.Result,
		}
	}
	return []json.RawMessage{event(version, "input_applied", struct {
		SurfaceID  string `json:"surface_id"`
		ProposalID string `json:"proposal_id"`
	}{surfaceID, proposalID})}, nil
}

// UpdateHostWindowGeometry updates the bound surface and profile dimensions
// when the resident capture tap observes a window resize.
func (m *Manager) UpdateHostWindowGeometry(id string, w, h int) bool {
	if w < 1 || h < 1 || w > 4096 || h > 4096 {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.bindings[id]
	if !ok || b.Surface.State != "active" || m.destroying[id] || b.NativeKind != "host-window" {
		return false
	}
	changed := b.Surface.Geometry.W != w || b.Surface.Geometry.H != h
	b.Surface.Geometry = Geometry{W: w, H: h}
	b.HostMinimized = false
	m.bindings[id] = b
	if p, ok := m.cfg.Profiles[b.Surface.ProfileID]; ok {
		p.Width = w
		p.Height = h
		m.cfg.Profiles[b.Surface.ProfileID] = p
	}
	return changed
}

// SetHostWindowMinimized records whether the host window is currently minimized
// (waiting state; no old frame is served as live).
func (m *Manager) SetHostWindowMinimized(id string, minimized bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.bindings[id]
	if !ok || b.Surface.State != "active" || m.destroying[id] || b.NativeKind != "host-window" {
		return
	}
	b.HostMinimized = minimized
	m.bindings[id] = b
}

// MarkHostWindowLost transitions an active host-window surface to lost when
// the window closes or its witness changes, returning the state_changed event.
func (m *Manager) MarkHostWindowLost(id string, reason string) (json.RawMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.bindings[id]
	if !ok || b.NativeKind != "host-window" {
		return nil, fault("surface", "host-window surface required")
	}
	if reason != "" {
		b.HostLostReason = extractOrDefaultHostWindowReason(reason, reason)
		m.bindings[id] = b
	}
	return m.markLostLocked(id, true, false)
}
