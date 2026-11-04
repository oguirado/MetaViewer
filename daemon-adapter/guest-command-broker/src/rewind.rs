//! Opt-in disposable REWIND guest. Never used by the normal broker binary.
//! Host authority must revoke old epochs across RAM rollback; guest RAM cannot prove freshness alone.
use crate::{bootstrap, dispatch, guard::GuestAuthority, refused, sandbox::{owned, Jail}, supervision::JobCgroups, transport::Transport, wire::Metadata, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, os::fd::{AsRawFd, OwnedFd}, os::unix::fs::MetadataExt};

pub const MAGIC: &[u8; 4] = b"RWR1";
pub const MAX_RESET: usize = 4096;
pub const RESET_MS: u64 = 3000;
const MAX_SAFE: u64 = 9007199254740991;

pub struct Boot { pub nonce: String }
impl Boot {
    pub fn parse(raw: &str) -> Result<Self> {
        if raw.len() > 8192 || raw.contains('\0') || raw.split_ascii_whitespace().any(|s| s.starts_with("mv_guest_command=")) {
            return Err(refused("rewind boot binding"));
        }
        let markers: Vec<_> = raw.split_ascii_whitespace().filter_map(|s| s.strip_prefix("mv_rewind=")).collect();
        let nonces: Vec<_> = raw.split_ascii_whitespace().filter_map(|s| s.strip_prefix("mv_nonce=")).collect();
        if markers != ["1"] || nonces.len() != 1 || !hex(nonces_first(&nonces), 64) { return Err(refused("rewind boot binding")); }
        Ok(Self { nonce: nonces[0].into() })
    }
}
fn nonces_first<'a>(v: &[&'a str]) -> &'a str { v.first().copied().unwrap_or("") }
fn hex(s: &str, len: usize) -> bool { s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn session(s: &str) -> bool { !s.is_empty() && s.len() <= 128 && s.as_bytes()[0].is_ascii_alphanumeric() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)) }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reset {
    pub schema: String, pub op: String, pub boot_token: String, pub session_id: String,
    pub authority_epoch: u64, pub command_generation: u64, pub workload_id: String,
    pub owner_id: String, pub reservation_id: String, pub challenge: String, pub entropy: String,
}
impl Reset {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > MAX_RESET { return Err(refused("reset size")); }
        let r: Self = serde_json::from_slice(bytes).map_err(|_| refused("closed reset JSON"))?;
        if r.schema != "rewind_guest_reset/v0.2" || r.op != "reseed" || !hex(&r.boot_token,64) || !session(&r.session_id)
            || !(1..=MAX_SAFE).contains(&r.authority_epoch) || !(1..=MAX_SAFE).contains(&r.command_generation)
            || !hex(&r.challenge,64) || !hex(&r.entropy,128) || r.entropy.bytes().all(|b| b == b'0') {
            return Err(refused("reset fields"));
        }
        // Use the unchanged MVGC validator for all identity grammars.
        r.hello(&r.boot_token)?;
        Ok(r)
    }
    fn hello(&self, nonce: &str) -> Result<Metadata> {
        Metadata::parse(&serde_json::to_vec(&json!({"kind":"hello", "workload_id":self.workload_id,
            "generation":self.command_generation,"reservation_id":self.reservation_id,"owner_id":self.owner_id,
            "profile_id":"guest-command-arm64-v1","nonce":nonce})).map_err(|_| refused("identity encoding"))?)
    }
}
fn entropy_digest(s: &str) -> String { format!("{:x}", Sha256::digest(s.as_bytes())) }
#[derive(Default)]
pub struct ResetLedger { epoch: u64, generation: u64, sessions: BTreeSet<String>, challenges: BTreeSet<String>, entropy: BTreeSet<String> }
impl ResetLedger {
    pub fn validate(&self, r: &Reset, boot: &str) -> Result<()> {
        if r.boot_token != boot || r.authority_epoch <= self.epoch || r.command_generation <= self.generation || self.sessions.len() >= 1024
            || self.sessions.contains(&r.session_id) || self.challenges.contains(&r.challenge) || self.entropy.contains(&entropy_digest(&r.entropy)) {
            return Err(refused("reset authority/replay fence"));
        }
        Ok(())
    }
    fn commit(&mut self, r: &Reset) { self.epoch = r.authority_epoch; self.generation = r.command_generation; self.sessions.insert(r.session_id.clone()); self.challenges.insert(r.challenge.clone()); self.entropy.insert(entropy_digest(&r.entropy)); }
    /// Pure model transition used by discriminating tests. Runtime additionally requires reseeding.
    pub fn record_validated(&mut self, r: &Reset, boot: &str) -> Result<()> { self.validate(r,boot)?; self.commit(r); Ok(()) }
}
pub(crate) struct Binding { pub nonce: String, pub epoch: u64, hello: Metadata }
impl Binding {
    pub(crate) fn matches_hello(&self, m: &Metadata) -> Result<()> {
        if m.kind() != "hello" || m.canonical()? != self.hello.canonical()? { return Err(refused("reset/HELLO identity mismatch")); }
        Ok(())
    }
}
#[derive(Serialize)]
struct Reply<'a> { schema: &'static str, op: &'static str, session_id: &'a str, authority_epoch: u64,
    command_generation: u64, challenge: &'a str, guest_nonce: &'a str, counter: u64, commands_fenced: bool }

/// The counter is serviced by the single PID1 event loop, never by a fork-unsafe thread.
pub struct Counter { value: u64, last: u64 }
impl Counter {
    pub fn new(now: u64) -> Self { Self { value: 0, last: now } }
    pub fn value(&self) -> u64 { self.value }
    pub fn advance(&mut self, now: u64) -> Result<bool> {
        let elapsed = now.checked_sub(self.last).ok_or_else(|| refused("counter clock reversed"))? / 1000;
        if elapsed == 0 { return Ok(false); }
        self.value = self.value.checked_add(elapsed).filter(|v| *v <= MAX_SAFE).ok_or_else(|| refused("counter exhausted"))?;
        self.last = self.last.checked_add(elapsed * 1000).ok_or_else(|| refused("counter clock overflow"))?;
        Ok(true)
    }
    pub(crate) fn tick(&mut self, now: u64) -> Result<()> {
        if self.advance(now)? { eprintln!("rewind_counter value={}", self.value); }
        Ok(())
    }
}
fn poll(a: &GuestAuthority, fd: i32, events: i16, ms: i32) -> Result<()> {
    a.check()?;
    let mut p = libc::pollfd { fd, events, revents: 0 };
    if unsafe { libc::poll(&mut p,1,ms) } < 0 {
        let e = std::io::Error::last_os_error();
        if e.kind() != std::io::ErrorKind::Interrupted { return Err(e); }
    }
    Ok(())
}
fn listener(a: &GuestAuthority) -> Result<OwnedFd> {
    a.check()?;
    let fd = owned(unsafe { libc::socket(libc::AF_VSOCK,libc::SOCK_STREAM|libc::SOCK_CLOEXEC|libc::SOCK_NONBLOCK,0) })?;
    let mut address: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
    address.svm_family=libc::AF_VSOCK as _; address.svm_cid=libc::VMADDR_CID_ANY; address.svm_port=19001;
    if unsafe { libc::bind(fd.as_raw_fd(), (&address as *const libc::sockaddr_vm).cast(), std::mem::size_of_val(&address) as _) } != 0
        || unsafe { libc::listen(fd.as_raw_fd(),1) } != 0 { return Err(std::io::Error::last_os_error()); }
    Ok(fd)
}
fn accept(a: &GuestAuthority, fd: &OwnedFd, counter: &mut Counter) -> Result<OwnedFd> {
    loop {
        counter.tick(bootstrap::now_ms()?)?;
        a.check()?;
        let mut peer: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
        let mut n=std::mem::size_of_val(&peer) as libc::socklen_t;
        let raw=unsafe { libc::accept4(fd.as_raw_fd(),(&mut peer as *mut libc::sockaddr_vm).cast(),&mut n,libc::SOCK_NONBLOCK|libc::SOCK_CLOEXEC) };
        if raw >= 0 {
            let accepted=owned(raw)?;
            if n as usize != std::mem::size_of_val(&peer) || peer.svm_family != libc::AF_VSOCK as libc::sa_family_t || peer.svm_cid != 2 { return Err(refused("rewind host CID")); }
            return Ok(accepted);
        }
        let e=std::io::Error::last_os_error();
        if e.kind()!=std::io::ErrorKind::WouldBlock && e.kind()!=std::io::ErrorKind::Interrupted { return Err(e); }
        poll(a,fd.as_raw_fd(),libc::POLLIN,25)?;
    }
}
pub fn reset_length(header: &[u8]) -> Result<usize> {
    if header.len()!=8 || &header[..4]!=MAGIC { return Err(refused("reset magic/header")); }
    let n=u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;
    if n==0 || n>MAX_RESET { return Err(refused("reset size")); }
    Ok(n)
}
fn read_reset(a: &GuestAuthority, fd: &OwnedFd, counter: &mut Counter) -> Result<Reset> {
    let end=bootstrap::now_ms()?.checked_add(RESET_MS).ok_or_else(|| refused("reset deadline"))?;
    let mut raw=Vec::with_capacity(8+MAX_RESET); let mut need=8;
    loop {
        let now=bootstrap::now_ms()?; counter.tick(now)?;
        if now>=end { return Err(refused("reset deadline")); }
        let mut buf=[0u8;4096]; let count=(need-raw.len()).min(buf.len());
        a.check()?;
        let n=unsafe { libc::recv(fd.as_raw_fd(),buf.as_mut_ptr().cast(),count,0) };
        if n==0 { return Err(refused("reset EOF")); }
        if n<0 { let e=std::io::Error::last_os_error(); if e.kind()!=std::io::ErrorKind::WouldBlock && e.kind()!=std::io::ErrorKind::Interrupted {return Err(e);} }
        else { raw.extend_from_slice(&buf[..n as usize]); }
        if raw.len()==8 && need==8 { need=8+reset_length(&raw)?; }
        if raw.len()==need { return Reset::parse(&raw[8..]); }
        poll(a,fd.as_raw_fd(),libc::POLLIN,10)?;
    }
}
fn send_reply(a: &GuestAuthority, fd: &OwnedFd, reply: &Reply<'_>, counter: &mut Counter) -> Result<()> {
    let json=serde_json::to_vec(reply).map_err(|_| refused("reply encoding"))?;
    if json.len()>MAX_RESET { return Err(refused("reply size")); }
    let mut bytes=Vec::with_capacity(json.len()+8); bytes.extend_from_slice(MAGIC); bytes.extend_from_slice(&(json.len() as u32).to_be_bytes()); bytes.extend_from_slice(&json);
    let end=bootstrap::now_ms()?.checked_add(RESET_MS).ok_or_else(|| refused("reply deadline"))?; let mut offset=0;
    while offset<bytes.len() {
        let now=bootstrap::now_ms()?; counter.tick(now)?;
        if now>=end { return Err(refused("reply deadline")); }
        a.check()?;
        let n=unsafe { libc::send(fd.as_raw_fd(),bytes[offset..].as_ptr().cast(),bytes.len()-offset,libc::MSG_NOSIGNAL) };
        if n==0 { return Err(refused("reply send zero")); }
        if n<0 {let e=std::io::Error::last_os_error(); if e.kind()!=std::io::ErrorKind::WouldBlock && e.kind()!=std::io::ErrorKind::Interrupted {return Err(e);} }
        else {offset+=n as usize;}
        if offset<bytes.len() {poll(a,fd.as_raw_fd(),libc::POLLOUT,10)?;}
    }
    Ok(())
}
/// Retain an unlinked root-only random device, never visible inside the immutable job jail.
fn random_device(a: &GuestAuthority) -> Result<OwnedFd> {
    a.check()?;
    let path=crate::sandbox::cstring("/.rewind-random")?;
    if unsafe { libc::mknod(path.as_ptr(),libc::S_IFCHR|0o600,libc::makedev(1,8)) } != 0 {return Err(std::io::Error::last_os_error());}
    let file=owned(unsafe { libc::open(path.as_ptr(),libc::O_RDWR|libc::O_CLOEXEC|libc::O_NOFOLLOW|libc::O_NONBLOCK) })?;
    let meta=std::fs::File::from(file.try_clone()?).metadata()?;
    if meta.uid()!=0 || meta.gid()!=0 || meta.mode()&libc::S_IFMT!=libc::S_IFCHR || meta.mode()&0o7777!=0o600 || meta.nlink()!=1 || meta.rdev()!=libc::makedev(1,8) {return Err(refused("random device custody"));}
    a.check()?;
    if unsafe { libc::unlink(path.as_ptr()) } != 0 {return Err(std::io::Error::last_os_error());}
    Ok(file)
}
fn reseed(a: &GuestAuthority, random: &OwnedFd, entropy: &str) -> Result<String> {
    a.check()?;
    if !hex(entropy,128) {return Err(refused("entropy encoding"));}
    #[repr(C)] struct Pool { bits: libc::c_int, size: libc::c_int, bytes: [u8;64] }
    let mut pool=Pool {bits:512,size:64,bytes:[0;64]};
    for (i,b) in pool.bytes.iter_mut().enumerate() {*b=u8::from_str_radix(&entropy[i*2..i*2+2],16).map_err(|_| refused("entropy encoding"))?;}
    let added=unsafe {libc::ioctl(random.as_raw_fd(),libc::_IOW::<[libc::c_int;2]>(b'R' as u32,3),&pool)};
    pool.bytes.fill(0);
    if added!=0 {return Err(std::io::Error::last_os_error());}
    a.check()?;
    if unsafe {libc::ioctl(random.as_raw_fd(),libc::_IO(b'R' as u32,7))}!=0 {return Err(std::io::Error::last_os_error());}
    let mut nonce=[0u8;32]; let mut offset=0;
    while offset<nonce.len() {
        a.check()?;
        let n=unsafe {libc::getrandom(nonce[offset..].as_mut_ptr().cast(),nonce.len()-offset,libc::GRND_NONBLOCK)};
        if n<0 { let e=std::io::Error::last_os_error(); if e.kind()==std::io::ErrorKind::Interrupted {continue;} return Err(e); }
        if n==0 {return Err(refused("random read zero"));} offset+=n as usize;
    }
    Ok(nonce.iter().map(|b|format!("{b:02x}")).collect())
}
pub fn serve(a: &GuestAuthority, boot: Boot) -> Result<()> {
    a.check()?;
    let jail=Jail::verify(a,bootstrap::JOB_UID,bootstrap::JOB_GID)?;
    let mut groups=JobCgroups::prepare(a)?;
    let random=random_device(a)?;
    let listener=listener(a)?;
    let mut ledger=ResetLedger::default(); let mut counter=Counter::new(bootstrap::now_ms()?);
    loop {
        if !groups.quiescent(a)? || !crate::supervision::reap_available(a)?.1 {return Err(refused("rewind fence not empty"));}
        eprintln!("rewind_fenced counter={}",counter.value());
        let fd=accept(a,&listener,&mut counter)?;
        let reset=read_reset(a,&fd,&mut counter)?; ledger.validate(&reset,&boot.nonce)?;
        let nonce=reseed(a,&random,&reset.entropy)?;
        let binding=Binding {nonce:nonce.clone(),epoch:reset.authority_epoch,hello:reset.hello(&nonce)?};
        ledger.commit(&reset);
        send_reply(a,&fd,&Reply {schema:"rewind_guest_reset/v0.2",op:"reseeded",session_id:&reset.session_id,
            authority_epoch:reset.authority_epoch,command_generation:reset.command_generation,challenge:&reset.challenge,
            guest_nonce:&nonce,counter:counter.value(),commands_fenced:true},&mut counter)?;
        match dispatch::serve_rewind(a,Transport::rewound(fd,&binding),&binding,&jail,&mut groups,&mut counter)? {
            dispatch::RewindEnd::Disconnected => {},
            dispatch::RewindEnd::Stopped => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reset_binding_refuses_old_or_foreign_hello_before_ready() {
        let r=Reset::parse(&serde_json::to_vec(&json!({"schema":"rewind_guest_reset/v0.2","op":"reseed","boot_token":"a".repeat(64),"session_id":"session-a","authority_epoch":2,"command_generation":2,"workload_id":"workload-a","owner_id":"actor-a","reservation_id":"reservation-a","challenge":"b".repeat(64),"entropy":"cd".repeat(64)})).unwrap()).unwrap();
        let nonce="f".repeat(64);
        let b=Binding{nonce:nonce.clone(),epoch:2,hello:r.hello(&nonce).unwrap()};
        b.matches_hello(&r.hello(&nonce).unwrap()).unwrap();
        for (key,bad) in [("nonce",json!("a".repeat(64))),("generation",json!(1)),("owner_id",json!("actor-b")),("workload_id",json!("workload-b")),("reservation_id",json!("reservation-b"))] {
            let mut v:serde_json::Value=serde_json::from_slice(&b.hello.canonical().unwrap()).unwrap();v[key]=bad;
            assert!(b.matches_hello(&Metadata::parse(&serde_json::to_vec(&v).unwrap()).unwrap()).is_err(),"{key}");
        }
    }
}
