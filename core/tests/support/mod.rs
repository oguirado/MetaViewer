#![allow(dead_code)]
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
pub fn run<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
pub fn fixture() -> metaviewer_core::Envelope {
    metaviewer_core::decode_envelope(include_str!(
        "../../../contracts/examples/v0.2/envelope.valid.json"
    ))
    .unwrap()
}
pub fn limits(bytes: usize) -> metaviewer_core::WireLimits {
    metaviewer_core::WireLimits::new(
        bytes,
        32,
        256,
        65536,
        std::time::Duration::from_millis(20),
        std::time::Duration::from_millis(20),
    )
    .unwrap()
}
static NEXT: AtomicUsize = AtomicUsize::new(0);
pub struct Temp(pub PathBuf);
impl Temp {
    pub fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "metaviewer-core-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
pub fn uid() -> u32 {
    tokio::net::UnixStream::pair()
        .unwrap()
        .0
        .peer_cred()
        .unwrap()
        .uid()
}
