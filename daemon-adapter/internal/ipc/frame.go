package ipc

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

type Framer struct {
	conn            net.Conn
	cfg             Config
	reader          *bufio.Reader
	readMu, writeMu sync.Mutex
}

func NewFramer(conn net.Conn, cfg Config) (*Framer, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if conn == nil {
		return nil, errors.New("connection required")
	}
	size := cfg.MaxFrameBytes
	if size > 4096 {
		size = 4096
	}
	return &Framer{conn: conn, cfg: cfg, reader: bufio.NewReaderSize(conn, size)}, nil
}
func arm(ctx context.Context, timeout time.Duration, set func(time.Time) error) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := set(deadline); err != nil {
		return nil, err
	}
	done := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { _ = set(time.Now()); close(done) })
	return func() {
		if !stop() {
			<-done
		}
	}, nil
}
func (f *Framer) Read(ctx context.Context) ([]byte, error) {
	f.readMu.Lock()
	defer f.readMu.Unlock()
	stop, err := arm(ctx, f.cfg.ReadTimeout, f.conn.SetReadDeadline)
	if err != nil {
		return nil, err
	}
	defer stop()
	var line []byte
	for {
		part, err := f.reader.ReadSlice('\n')
		if len(part) > f.cfg.MaxFrameBytes-len(line) {
			return nil, errors.New("frame limit exceeded")
		}
		line = append(line, part...)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(line) > 0 {
				return nil, io.ErrUnexpectedEOF
			}
			return nil, err
		}
		break
	}
	line = line[:len(line)-1]
	if err := ValidateJSON(line, f.cfg); err != nil {
		return nil, err
	}
	return line, nil
}
func (f *Framer) Write(ctx context.Context, value []byte) error {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if len(value) >= f.cfg.MaxFrameBytes || bytes.ContainsAny(value, "\r\n") {
		return errors.New("invalid outbound frame")
	}
	if err := ValidateJSON(value, f.cfg); err != nil {
		return err
	}
	stop, err := arm(ctx, f.cfg.WriteTimeout, f.conn.SetWriteDeadline)
	if err != nil {
		return err
	}
	defer stop()
	data := append(append([]byte(nil), value...), '\n')
	for len(data) > 0 {
		n, err := f.conn.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}
