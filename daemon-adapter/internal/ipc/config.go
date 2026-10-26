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
	// HelloTimeout bounds the first frame; ReadTimeout bounds later idle reads.
	// Both are explicit and capped by the frozen transport contract.
	HelloTimeout, ReadTimeout                   time.Duration
	WriteTimeout, ProbeTimeout, ShutdownTimeout time.Duration
}

func (c Config) Validate() error {
	if c.MaxFrameBytes > 1048576 || c.MaxDepth > 32 || c.MaxStringBytes > 65536 || c.MaxKeys > 256 || c.MaxArrayItems > 4096 {
		return errors.New("frozen transport ceiling exceeded")
	}
	if c.SocketPath == "" || c.MaxFrameBytes < 2 || c.MaxDepth < 1 || c.MaxStringBytes < 1 || c.MaxKeys < 1 || c.MaxArrayItems < 1 || c.MaxReplayEntries < 1 || c.MaxConnections < 1 || c.HelloTimeout <= 0 || c.HelloTimeout > 5*time.Second || c.ReadTimeout <= 0 || c.ReadTimeout > 30*time.Second || c.WriteTimeout <= 0 || c.ProbeTimeout <= 0 || c.ShutdownTimeout <= 0 {
		return errors.New("explicit transport policy required")
	}
	return nil
}
