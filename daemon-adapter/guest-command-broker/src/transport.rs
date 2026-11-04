//! Single nonblocking guest connection with bounded framing and serialized writes.
use crate::{
    bootstrap::now_ms,
    guard::GuestAuthority,
    refused,
    sandbox::owned,
    wire::{self, Frame, Header, Metadata, Receiver, Sender},
    Result,
};
use std::{
    collections::VecDeque,
    os::fd::{AsRawFd, OwnedFd},
};
const QUEUE_MAX: usize = 131072;
struct Pending {
    bytes: Vec<u8>,
    offset: usize,
    deadline: u64,
    output: Option<(bool, u64)>,
}
pub struct Transport {
    fd: OwnedFd,
    input: Vec<u8>,
    first: Option<u64>,
    receiver: Option<Receiver>,
    sender: Option<Sender>,
    nonce: String,
    queue: VecDeque<Pending>,
    queued: usize,
    end: u64,
    pub stdout_sent: u64,
    pub stderr_sent: u64,
}
fn poll(a: &GuestAuthority, fd: i32, events: i16, ms: i32) -> Result<()> {
    a.check()?;
    let mut p = libc::pollfd {
        fd,
        events,
        revents: 0,
    };
    let n = unsafe { libc::poll(&mut p, 1, ms) };
    if n < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
pub fn accept(a: &GuestAuthority, end: u64, nonce: String) -> Result<Transport> {
    a.check()?;
    let socket = owned(unsafe {
        libc::socket(
            libc::AF_VSOCK,
            libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
            0,
        )
    })?;
    let mut addr: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
    addr.svm_family = libc::AF_VSOCK as _;
    addr.svm_cid = libc::VMADDR_CID_ANY;
    addr.svm_port = 19001;
    if unsafe {
        libc::bind(
            socket.as_raw_fd(),
            (&addr as *const libc::sockaddr_vm).cast(),
            std::mem::size_of_val(&addr) as _,
        )
    } != 0
        || unsafe { libc::listen(socket.as_raw_fd(), 1) } != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    loop {
        if now_ms()? >= end {
            return Err(refused("connection lifetime"));
        }
        let mut peer: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
        let mut n = std::mem::size_of_val(&peer) as libc::socklen_t;
        let fd = unsafe {
            libc::accept4(
                socket.as_raw_fd(),
                (&mut peer as *mut libc::sockaddr_vm).cast(),
                &mut n,
                libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            )
        };
        if fd >= 0 {
            let fd = owned(fd)?;
            if n as usize != std::mem::size_of_val(&peer)
                || peer.svm_family != libc::AF_VSOCK as libc::sa_family_t
                || peer.svm_cid != 2
            {
                return Err(refused("host CID"));
            }
            // The sole listener closes here: later connections cannot rebind a session.
            return Ok(Transport {
                fd,
                input: Vec::with_capacity(wire::HEADER),
                first: None,
                receiver: None,
                sender: None,
                nonce,
                queue: VecDeque::new(),
                queued: 0,
                end,
                stdout_sent: 0,
                stderr_sent: 0,
            });
        }
        let e = std::io::Error::last_os_error();
        if e.kind() != std::io::ErrorKind::WouldBlock && e.kind() != std::io::ErrorKind::Interrupted
        {
            return Err(e);
        }
        poll(a, socket.as_raw_fd(), libc::POLLIN, 25)?;
    }
}
impl Transport {
    #[cfg(feature = "rewind-profile")]
    pub(crate) fn rewound(fd: OwnedFd, binding: &crate::rewind::Binding) -> Self {
        Self { fd, input: Vec::with_capacity(wire::HEADER), first: None,
            receiver: None, sender: None, nonce: binding.nonce.clone(),
            queue: VecDeque::new(), queued: 0, end: u64::MAX - 10000,
            stdout_sent: 0, stderr_sent: 0 }
    }
    pub fn receive(&mut self, a: &GuestAuthority) -> Result<Option<Frame>> {
        a.check()?;
        let now = now_ms()?;
        if now >= wire::frame_deadline(self.first, self.end) {
            return Err(refused("frame/lifetime deadline"));
        }
        let need = if self.input.len() < wire::HEADER {
            wire::HEADER
        } else {
            Header::parse(&self.input[..wire::HEADER])?.frame_len()
        };
        let mut buf = [0u8; 4096];
        let count = (need - self.input.len()).min(buf.len());
        if count > 0 {
            let n = unsafe { libc::recv(self.fd.as_raw_fd(), buf.as_mut_ptr().cast(), count, 0) };
            if n == 0 {
                return Err(refused("connection EOF"));
            }
            if n < 0 {
                let e = std::io::Error::last_os_error();
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::Interrupted
                {
                    return Ok(None);
                }
                return Err(e);
            }
            if self.first.is_none() {
                self.first = Some(now);
            }
            self.input.extend_from_slice(&buf[..n as usize]);
        }
        if self.input.len() < wire::HEADER {
            return Ok(None);
        }
        let total = Header::parse(&self.input[..wire::HEADER])?.frame_len();
        if self.input.len() != total {
            return Ok(None);
        }
        if now_ms()? >= wire::frame_deadline(self.first, self.end) {
            return Err(refused("partial frame deadline"));
        }
        if self.receiver.is_none() {
            let first = Frame::decode(&self.input)?;
            if first.metadata.kind() != "hello" {
                return Err(refused("first frame not HELLO"));
            }
            // Host CID plus the boot nonce authenticates the profile-supplied owner.
            self.receiver = Some(Receiver::new(
                self.nonce.clone(),
                first.metadata.text("owner_id")?.to_owned(),
            ));
        }
        let frame = self.receiver.as_mut().unwrap().accept(&self.input)?;
        self.input.clear();
        self.first = None;
        if self.sender.is_none() {
            self.sender = Some(self.receiver.as_mut().unwrap().sender()?);
        }
        Ok(Some(frame))
    }
    pub fn ready(&mut self) -> Result<()> {
        let m = self
            .sender
            .as_ref()
            .ok_or_else(|| refused("HELLO required"))?
            .ready_metadata()?;
        self.enqueue(&m, &[], None)
    }
    pub fn event(&self, kind: &str, fields: serde_json::Value) -> Result<Metadata> {
        let base = self
            .sender
            .as_ref()
            .ok_or_else(|| refused("HELLO required"))?
            .ready_metadata()?;
        let mut value: serde_json::Value =
            serde_json::from_slice(&base.canonical()?).map_err(|_| refused("event base"))?;
        value["kind"] = serde_json::json!(kind);
        let map = fields.as_object().ok_or_else(|| refused("event fields"))?;
        for (k, v) in map {
            if ["kind", "workload_id", "generation", "reservation_id"].contains(&k.as_str()) {
                return Err(refused("immutable event binding"));
            }
            value[k] = v.clone();
        }
        Metadata::parse(&serde_json::to_vec(&value).map_err(|_| refused("event encoding"))?)
    }
    pub fn enqueue(
        &mut self,
        m: &Metadata,
        payload: &[u8],
        output: Option<(bool, u64)>,
    ) -> Result<()> {
        if self.queued + wire::HEADER + wire::MAX_META + payload.len() > QUEUE_MAX {
            return Err(refused("send queue bound"));
        }
        let bytes = self
            .sender
            .as_mut()
            .ok_or_else(|| refused("HELLO required"))?
            .encode(m, payload)?;
        self.queued += bytes.len();
        self.queue.push_back(Pending {
            bytes,
            offset: 0,
            deadline: now_ms()?.saturating_add(3000).min(self.end),
            output,
        });
        Ok(())
    }
    pub fn flush(&mut self, a: &GuestAuthority) -> Result<()> {
        a.check()?;
        for _ in 0..8 {
            let Some(p) = self.queue.front_mut() else {
                return Ok(());
            };
            if now_ms()? >= p.deadline {
                return Err(refused("send deadline"));
            }
            let n = unsafe {
                libc::send(
                    self.fd.as_raw_fd(),
                    p.bytes[p.offset..].as_ptr().cast(),
                    p.bytes.len() - p.offset,
                    libc::MSG_NOSIGNAL,
                )
            };
            if n < 0 {
                let e = std::io::Error::last_os_error();
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::Interrupted
                {
                    return Ok(());
                }
                return Err(e);
            }
            if n == 0 {
                return Err(refused("send zero"));
            }
            p.offset += n as usize;
            if p.offset == p.bytes.len() {
                let p = self.queue.pop_front().unwrap();
                self.queued -= p.bytes.len();
                if let Some((stderr, n)) = p.output {
                    if stderr {
                        self.stderr_sent += n
                    } else {
                        self.stdout_sent += n
                    }
                }
            }
        }
        Ok(())
    }
    pub fn idle(&self) -> bool {
        self.queue.is_empty()
    }
    pub fn reset_counts(&mut self) -> Result<()> {
        if !self.idle() {
            return Err(refused("pending frames at new job"));
        }
        self.stdout_sent = 0;
        self.stderr_sent = 0;
        Ok(())
    }
    pub fn wait(&self, a: &GuestAuthority) -> Result<()> {
        poll(
            a,
            self.fd.as_raw_fd(),
            libc::POLLIN
                | if self.queue.is_empty() {
                    0
                } else {
                    libc::POLLOUT
                },
            10,
        )
    }
}
