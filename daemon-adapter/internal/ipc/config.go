package ipc

import (
	"errors"
	"time"
)

type Config struct {
	SocketPath                                                      string
	UID                                                             uint32
	MaxFrameBytes, MaxDepth, MaxStringBytes, MaxKeys, MaxArrayItems int
	MaxReplayEntries, MaxConnections                                int
	ReadTimeout, WriteTimeout, ProbeTimeout, ShutdownTimeout        time.Duration
}

func (c Config) Validate() error {
	if c.SocketPath == "" || c.MaxFrameBytes < 2 || c.MaxDepth < 1 || c.MaxStringBytes < 1 || c.MaxKeys < 1 || c.MaxArrayItems < 1 || c.MaxReplayEntries < 1 || c.MaxConnections < 1 || c.ReadTimeout <= 0 || c.WriteTimeout <= 0 || c.ProbeTimeout <= 0 || c.ShutdownTimeout <= 0 {
		return errors.New("explicit transport policy required")
	}
	return nil
}
