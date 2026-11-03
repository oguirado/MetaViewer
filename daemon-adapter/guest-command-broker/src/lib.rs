//! Guest-only OS foundations. No transport or startup effects are exposed by main.
pub mod guard;
pub mod output;
pub mod sandbox;
pub mod seccomp;
pub mod spawn;
pub mod supervision;

use std::io;
pub type Result<T> = io::Result<T>;
fn refused(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

pub mod bootstrap;
pub mod dispatch;
pub mod transport;
pub mod wire;
