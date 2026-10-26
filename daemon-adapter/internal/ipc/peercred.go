package ipc

import (
	"net"
	"syscall"
)

type PeerCredentials struct {
	PID int32
	UID uint32
	GID uint32
}

func PeerCred(conn *net.UnixConn) (PeerCredentials, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return PeerCredentials{}, err
	}
	var cred *syscall.Ucred
	var inner error
	err = raw.Control(func(fd uintptr) {
		cred, inner = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil {
		return PeerCredentials{}, err
	}
	if inner != nil {
		return PeerCredentials{}, inner
	}
	return PeerCredentials{PID: cred.Pid, UID: cred.Uid, GID: cred.Gid}, nil
}
func PeerAdmitted(cred PeerCredentials, uid uint32) bool { return cred.UID == uid }
