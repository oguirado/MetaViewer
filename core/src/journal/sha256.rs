//! Approved SHA-256 implementation; the public digest format stays lowercase hex.
use sha2::{Digest, Sha256};
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
