package record

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"metaviewer/daemon-adapter/internal/cli"
	"os"
	"path/filepath"
	"syscall"
)

type frameReply struct {
	Path       string          `json:"path"`
	Seq        *uint64         `json:"seq"`
	Hash       string          `json:"sha256_rgb24"`
	Width      *uint64         `json:"width"`
	Height     *uint64         `json:"height"`
	MonoNS     *int64          `json:"capture_mono_ns"`
	Generation json.RawMessage `json:"generation,omitempty"`
	Window     json.RawMessage `json:"window,omitempty"`
	State      json.RawMessage `json:"state,omitempty"`
}

type frameWindow struct {
	ID    string `json:"id"`
	X     int64  `json:"x"`
	Y     int64  `json:"y"`
	W     uint64 `json:"w"`
	H     uint64 `json:"h"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

func validateWindow(f frameReply, s Surface) error {
	if s.Family == "srf-holdings-capsule" {
		if len(f.Window) != 0 {
			return errors.New("unexpected Holdings window")
		}
		return nil
	}
	var id string
	if json.Unmarshal(f.Window, &id) == nil && id == s.Window {
		return nil
	}
	var window frameWindow
	if cli.ParseLine(f.Window, 1<<20, &window) != nil || window.ID != s.Window || window.W != *f.Width || window.H != *f.Height {
		return errors.New("invalid frame window binding")
	}
	return nil
}

func (m *Manager) capture(ctx context.Context, requestID, id string, r *recording) ([]Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s := m.cfg.Surfaces[r.surface]
	argv := []string{filepath.Join(m.cfg.BinDir, s.Family), "frame", "--container", s.Container}
	if s.Family == "srf-identity-surface" {
		argv = append(argv, "--window", s.Window)
	}
	out, err := m.cfg.Runner.Run(ctx, argv, nil)
	if err != nil {
		return nil, err
	}
	var f frameReply
	if err = cli.ParseLine(out, 1<<20, &f); err != nil {
		return nil, err
	}
	if f.Seq == nil || *f.Seq == 0 || f.Width == nil || f.Height == nil || *f.Width == 0 || *f.Height == 0 || f.MonoNS == nil || *f.MonoNS < 0 || uint64(*f.MonoNS) < m.cfg.OriginNS {
		return nil, errors.New("invalid frame metadata")
	}
	if err := validateWindow(f, s); err != nil {
		return nil, err
	}
	generation := *f.Seq
	if len(f.Generation) > 0 {
		var g uint64
		if err = json.Unmarshal(f.Generation, &g); err == nil && g > 0 {
			generation = g
		} else {
			var container string
			if json.Unmarshal(f.Generation, &container) != nil || container != s.Container {
				return nil, errors.New("invalid frame generation")
			}
		}
	}
	mono := uint64(*f.MonoNS) - m.cfg.OriginNS
	if r.captured && (generation <= r.generation || mono < r.lastNS || mono-r.lastNS < 1_000_000_000/r.fps) {
		return nil, errors.New("stale or over-rate frame")
	}
	// Validate geometry before decoding pixels or allocating a capture copy.
	if *f.Width > capBytes/4 || *f.Height > capBytes/4/(*f.Width) || *f.Width*(*f.Height)*4 > m.cfg.MemoryBytes {
		return nil, errors.New("frame geometry exceeds memory")
	}
	if !under("/dev/shm", s.FramesRoot) || !under(s.FramesRoot, f.Path) {
		return nil, errors.New("frame is outside surface RAM root")
	}
	file, err := ramFile(f.Path)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(file, int64(r.ring)+1))
	closeErr := file.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if len(data) == 0 || uint64(len(data)) > r.ring {
		return nil, errors.New("frame exceeds ring")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || uint64(cfg.Width) != *f.Width || uint64(cfg.Height) != *f.Height {
		return nil, errors.New("PNG geometry mismatch")
	}
	image, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	digest := sha256.New()
	for y := image.Bounds().Min.Y; y < image.Bounds().Max.Y; y++ {
		for x := image.Bounds().Min.X; x < image.Bounds().Max.X; x++ {
			red, green, blue, alpha := image.At(x, y).RGBA()
			if alpha != 65535 {
				return nil, errors.New("RGB frame must be opaque")
			}
			_, _ = digest.Write([]byte{byte(red >> 8), byte(green >> 8), byte(blue >> 8)})
		}
	}
	if hex.EncodeToString(digest.Sum(nil)) != f.Hash {
		return nil, errors.New("RGB witness mismatch")
	}
	if m.root == "" {
		m.root, err = os.MkdirTemp("/dev/shm", "metaviewer-record-")
		if err != nil {
			return nil, err
		}
	}
	owned, err := os.CreateTemp(m.root, "frame-*.png")
	if err != nil {
		return nil, err
	}
	path := owned.Name()
	_, err = owned.Write(data)
	closeErr = owned.Close()
	if err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	if closeErr != nil {
		_ = os.Remove(path)
		return nil, closeErr
	}
	size := uint64(len(data))
	base := Event{Schema: "record_event/v0.2", RequestID: requestID, SurfaceID: r.surface, RecordingID: id, MonoNS: mono}
	var events []Event
	dropped := uint64(0)
	evicted := uint64(0)
	for r.size-evicted > r.ring-size {
		evicted += r.frames[dropped].bytes
		dropped++
	}
	for i := uint64(0); i < dropped; i++ {
		if err = os.Remove(r.frames[i].path); err != nil {
			_ = os.Remove(path)
			return nil, err
		}
	}
	r.frames = append(r.frames[dropped:], frame{path: path, hash: f.Hash, bytes: size, generation: generation})
	r.size = r.size - evicted + size
	r.generation = generation
	r.lastNS = mono
	r.captured = true
	if dropped > 0 {
		e := base
		e.Event = "dropped"
		e.Policy = "ram_ring_oldest"
		e.DroppedFrames = ptr(dropped)
		events = append(events, e)
	}
	e := base
	e.Event = "frame_captured"
	e.RAMPath = path
	e.SHA256 = f.Hash
	e.ByteCount = ptr(size)
	return append(events, e), nil
}

func (m *Manager) export(base Event, r *recording) (result Event, exportErr error) {
	d := m.cfg.Destination
	if d == nil {
		return Event{}, &Refusal{"POLICY", "host destination is not authorized"}
	}
	// Bound archive overhead as well as payload before the first disk write.
	size := uint64(1024)
	for _, f := range r.frames {
		block := ((f.bytes+511)/512)*512 + 512
		if block > capBytes-size {
			return Event{}, errors.New("export exceeds contract byte bound")
		}
		size += block
	}
	// Read verified owned copies before opening the exact, non-overwriting grant.
	files := make([]*os.File, 0, len(r.frames))
	defer func() {
		for _, f := range files {
			_ = f.Close()
		}
	}()
	for _, f := range r.frames {
		file, err := ramFile(f.path)
		if err != nil {
			return Event{}, err
		}
		files = append(files, file)
	}
	parent, destination, baseName, err := openNoLinksParent(d.Path, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL, 0600)
	if err != nil {
		return Event{}, err
	}
	// Only this successful O_EXCL create grants cleanup ownership. A failed
	// export must free the exact destination so the active capture can retry.
	complete := false
	defer func() {
		if !complete {
			var removeErr error
			fdInfo, fErr := destination.Stat()
			pathInfo, lErr := os.Lstat(d.Path)
			if fErr == nil && lErr == nil && os.SameFile(fdInfo, pathInfo) {
				removeErr = syscall.Unlinkat(int(parent.Fd()), baseName)
				if errors.Is(removeErr, os.ErrNotExist) || errors.Is(removeErr, syscall.ENOENT) {
					removeErr = nil
				}
			}
			closeErr := destination.Close()
			exportErr = errors.Join(exportErr, closeErr, removeErr)
		}
		_ = parent.Close()
	}()
	digest := sha256.New()
	counter := &countWriter{writer: io.MultiWriter(destination, digest)}
	archive := tar.NewWriter(counter)
	for i, f := range r.frames {
		if err = archive.WriteHeader(&tar.Header{Name: fmt.Sprintf("frame-%06d.png", i+1), Mode: 0600, Size: int64(f.bytes)}); err != nil {
			return Event{}, err
		}
		if _, err = io.CopyN(archive, files[i], int64(f.bytes)); err != nil {
			return Event{}, err
		}
	}
	if err = archive.Close(); err != nil {
		return Event{}, err
	}
	if err = destination.Sync(); err != nil {
		return Event{}, err
	}
	if err = destination.Close(); err != nil {
		return Event{}, err
	}
	complete = true
	base.Event = "exported"
	base.DestinationCapabilityID = d.CapabilityID
	base.DestinationPath = d.Path
	base.SHA256 = hex.EncodeToString(digest.Sum(nil))
	base.ByteCount = ptr(counter.count)
	return base, nil
}

type countWriter struct {
	writer io.Writer
	count  uint64
}

func (w *countWriter) Write(data []byte) (int, error) {
	n, e := w.writer.Write(data)
	w.count += uint64(n)
	return n, e
}
