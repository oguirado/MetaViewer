//! Explicit bounded stream and owner-only Unix socket operations.
use crate::wire::error_type;
use crate::{
    decode_envelope_with_limits, DecodeError, Endpoint, Envelope, WireLimits, HANDSHAKE_DEADLINE,
};
use std::fs::{self, DirBuilder, Metadata, Permissions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Component as PathComponent, Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameError {
    Io,
    Timeout,
    Oversized,
    Incomplete,
    InvalidUtf8,
    Decode(DecodeError),
    Encode,
}
impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for FrameError {}

pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<Envelope>, FrameError> {
    read_frame_with_limits(r, &WireLimits::default()).await
}
pub async fn read_frame_with_limits<R: AsyncRead + Unpin>(
    r: &mut R,
    limits: &WireLimits,
) -> Result<Option<Envelope>, FrameError> {
    tokio::time::timeout(limits.read_deadline, async {
        let mut data = Vec::new();
        let mut byte = [0];
        loop {
            let n = r.read(&mut byte).await.map_err(|_| FrameError::Io)?;
            if n == 0 {
                return if data.is_empty() {
                    Ok(None)
                } else {
                    Err(FrameError::Incomplete)
                };
            }
            if data.len() >= limits.max_frame_bytes() {
                return Err(FrameError::Oversized);
            }
            if byte[0] == b'\n' {
                let raw = std::str::from_utf8(&data).map_err(|_| FrameError::InvalidUtf8)?;
                return decode_envelope_with_limits(raw, limits)
                    .map(Some)
                    .map_err(FrameError::Decode);
            }
            if data
                .len()
                .checked_add(1)
                .is_none_or(|n| n >= limits.max_frame_bytes())
            {
                return Err(FrameError::Oversized);
            }
            data.push(byte[0]);
        }
    })
    .await
    .map_err(|_| FrameError::Timeout)?
}
struct BoundedBuffer {
    bytes: Vec<u8>,
    cap: usize,
}
impl Write for BoundedBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self
            .bytes
            .len()
            .checked_add(bytes.len())
            .is_none_or(|n| n >= self.cap)
        {
            return Err(io::ErrorKind::FileTooLarge.into());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub async fn write_frame<W: AsyncWrite + Unpin>(
    w: &mut W,
    env: &Envelope,
) -> Result<(), FrameError> {
    write_frame_with_limits(w, env, &WireLimits::default()).await
}
pub async fn write_frame_with_limits<W: AsyncWrite + Unpin>(
    w: &mut W,
    env: &Envelope,
    limits: &WireLimits,
) -> Result<(), FrameError> {
    let mut buffer = BoundedBuffer {
        bytes: Vec::new(),
        cap: limits.max_frame_bytes(),
    };
    serde_json::to_writer(&mut buffer, env).map_err(|e| {
        if e.is_io() {
            FrameError::Oversized
        } else {
            FrameError::Encode
        }
    })?;
    let raw = std::str::from_utf8(&buffer.bytes).map_err(|_| FrameError::Encode)?;
    decode_envelope_with_limits(raw, limits).map_err(FrameError::Decode)?;
    buffer.bytes.push(b'\n');
    tokio::time::timeout(limits.write_deadline, async {
        w.write_all(&buffer.bytes)
            .await
            .map_err(|_| FrameError::Io)?;
        w.flush().await.map_err(|_| FrameError::Io)
    })
    .await
    .map_err(|_| FrameError::Timeout)?
}

error_type!(BindError {
    MissingRuntimeDir,
    UnsafeRuntimeDir,
    NotSocket,
    LiveSocket,
    ProbeInconclusive,
    IdentityChanged,
    WrongMode,
    Io
});
error_type!(PeerCredError {
    Unavailable,
    ForeignUid
});
pub fn check_uid_equal(peer_uid: u32, expected_uid: u32) -> Result<(), PeerCredError> {
    if peer_uid == expected_uid {
        Ok(())
    } else {
        Err(PeerCredError::ForeignUid)
    }
}
pub fn verify_peer_cred(
    stream: &UnixStream,
    expected_uid: u32,
) -> Result<tokio::net::unix::UCred, PeerCredError> {
    let cred = stream.peer_cred().map_err(|_| PeerCredError::Unavailable)?;
    check_uid_equal(cred.uid(), expected_uid)?;
    Ok(cred)
}
fn same_inode(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino() && a.uid() == b.uid()
}
fn private_dir(path: &Path, uid: u32) -> Result<Metadata, BindError> {
    let mut prefix = PathBuf::new();
    for component in path.components() {
        if matches!(component, PathComponent::ParentDir) {
            return Err(BindError::UnsafeRuntimeDir);
        }
        prefix.push(component.as_os_str());
        if fs::symlink_metadata(&prefix)
            .map_err(|_| BindError::MissingRuntimeDir)?
            .file_type()
            .is_symlink()
        {
            return Err(BindError::UnsafeRuntimeDir);
        }
    }
    let meta = fs::symlink_metadata(path).map_err(|_| BindError::MissingRuntimeDir)?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o7777 != 0o700 {
        return Err(BindError::UnsafeRuntimeDir);
    }
    Ok(meta)
}
/// The private directory prevents other UIDs from traversing the socket during
/// bind/chmod. No process-wide umask mutation or unsafe call is required.
pub async fn bind_owner_only(
    path: &Path,
    expected_uid: u32,
    probe_deadline: Duration,
) -> Result<UnixListener, BindError> {
    if probe_deadline.is_zero() || path.file_name().is_none() {
        return Err(BindError::ProbeInconclusive);
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or(BindError::MissingRuntimeDir)?;
    match DirBuilder::new().mode(0o700).create(parent) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(BindError::Io),
    }
    let directory = private_dir(parent, expected_uid)?;
    match fs::symlink_metadata(path) {
        Ok(old) => {
            if !old.file_type().is_socket() || old.uid() != expected_uid {
                return Err(BindError::NotSocket);
            }
            match tokio::time::timeout(probe_deadline, UnixStream::connect(path)).await {
                Ok(Ok(_)) => return Err(BindError::LiveSocket),
                Ok(Err(e)) if e.kind() == io::ErrorKind::ConnectionRefused => {}
                _ => return Err(BindError::ProbeInconclusive),
            }
            let now = fs::symlink_metadata(path).map_err(|_| BindError::IdentityChanged)?;
            if !same_inode(&old, &now)
                || !same_inode(&directory, &private_dir(parent, expected_uid)?)
            {
                return Err(BindError::IdentityChanged);
            }
            fs::remove_file(path).map_err(|_| BindError::Io)?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(BindError::Io),
    }
    if !same_inode(&directory, &private_dir(parent, expected_uid)?) {
        return Err(BindError::IdentityChanged);
    }
    let listener = UnixListener::bind(path).map_err(|_| BindError::Io)?;
    let before = fs::symlink_metadata(path).map_err(|_| BindError::Io)?;
    if !before.file_type().is_socket() || before.uid() != expected_uid {
        return Err(BindError::IdentityChanged);
    }
    fs::set_permissions(path, Permissions::from_mode(0o600)).map_err(|_| BindError::Io)?;
    let after = fs::symlink_metadata(path).map_err(|_| BindError::Io)?;
    if !same_inode(&before, &after) || !same_inode(&directory, &private_dir(parent, expected_uid)?)
    {
        return Err(BindError::IdentityChanged);
    }
    if after.mode() & 0o7777 != 0o600 {
        return Err(BindError::WrongMode);
    }
    Ok(listener)
}

#[derive(Clone, Debug)]
pub struct HandshakePolicy {
    expected_uid: u32,
    sender: Endpoint,
    recipient: Endpoint,
    session_id: String,
    hello: crate::wire::payload::Hello,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadyPeer {
    uid: u32,
    endpoint: Endpoint,
    recipient: Endpoint,
    session_id: String,
}
impl ReadyPeer {
    pub fn uid(&self) -> u32 {
        self.uid
    }
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    /// Check every subsequent envelope against the authenticated registration.
    pub fn check_sender(&self, env: &Envelope) -> Result<(), HandshakeError> {
        if env.from != self.endpoint
            || env.to != self.recipient
            || env.session_id != self.session_id
        {
            return Err(HandshakeError::IdentityMismatch);
        }
        if matches!(env.body, crate::Command::Hello(_)) {
            return Err(HandshakeError::AlreadyReady);
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandshakeError {
    Peer(PeerCredError),
    Frame(FrameError),
    ExpectedHello,
    VersionMismatch,
    PinMismatch,
    IdentityMismatch,
    AlreadyReady,
    MissingPolicy,
    Timeout,
}
impl std::fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for HandshakeError {}
impl HandshakePolicy {
    /// All expected identity and pin values come from trusted registration.
    pub fn new(
        expected_uid: u32,
        sender: Endpoint,
        recipient: Endpoint,
        session_id: String,
        hello: crate::wire::payload::Hello,
    ) -> Result<Self, HandshakeError> {
        let candidate = Envelope {
            schema: "envelope/v0.2".into(),
            msg_id: "registration".into(),
            ts_ns: crate::Clock::new(0),
            from: sender.clone(),
            to: recipient.clone(),
            session_id: session_id.clone(),
            seq: 1,
            nonce: "registration".into(),
            body: crate::Command::Hello(Box::new(hello.clone())),
        };
        let raw = serde_json::to_string(&candidate).map_err(|_| HandshakeError::MissingPolicy)?;
        decode_envelope_with_limits(&raw, &WireLimits::default())
            .map_err(|_| HandshakeError::MissingPolicy)?;
        if serde_json::to_value(sender.component).ok()
            != serde_json::to_value(&hello.component).ok()
        {
            return Err(HandshakeError::IdentityMismatch);
        }
        Ok(Self {
            expected_uid,
            sender,
            recipient,
            session_id,
            hello,
        })
    }
}
pub async fn handshake(
    stream: &mut UnixStream,
    policy: &HandshakePolicy,
    limits: &WireLimits,
) -> Result<ReadyPeer, HandshakeError> {
    handshake_at(stream, policy, limits, tokio::time::Instant::now()).await
}
/// Carry the monotonic acceptance instant from the listener so scheduling delay
/// cannot extend the handshake deadline.
pub async fn handshake_at(
    stream: &mut UnixStream,
    policy: &HandshakePolicy,
    limits: &WireLimits,
    accepted_at: tokio::time::Instant,
) -> Result<ReadyPeer, HandshakeError> {
    verify_peer_cred(stream, policy.expected_uid).map_err(HandshakeError::Peer)?;
    let now = tokio::time::Instant::now();
    let deadline = accepted_at
        .checked_add(HANDSHAKE_DEADLINE)
        .ok_or(HandshakeError::MissingPolicy)?;
    if accepted_at > now {
        return Err(HandshakeError::MissingPolicy);
    }
    if deadline <= now {
        return Err(HandshakeError::Timeout);
    }
    tokio::time::timeout_at(deadline, async {
        let env = read_frame_with_limits(stream, limits)
            .await
            .map_err(HandshakeError::Frame)?
            .ok_or(HandshakeError::ExpectedHello)?;
        if env.from != policy.sender
            || env.to != policy.recipient
            || env.session_id != policy.session_id
        {
            return Err(HandshakeError::IdentityMismatch);
        }
        let crate::Command::Hello(hello) = env.body else {
            return Err(HandshakeError::ExpectedHello);
        };
        if hello.contract_version != policy.hello.contract_version {
            return Err(HandshakeError::VersionMismatch);
        }
        if hello.component != policy.hello.component {
            return Err(HandshakeError::IdentityMismatch);
        }
        if *hello != policy.hello {
            return Err(HandshakeError::PinMismatch);
        }
        Ok(ReadyPeer {
            uid: policy.expected_uid,
            endpoint: policy.sender.clone(),
            recipient: policy.recipient.clone(),
            session_id: policy.session_id.clone(),
        })
    })
    .await
    .map_err(|_| HandshakeError::Timeout)?
}
