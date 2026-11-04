//! Combined bounded stdout/stderr storage; excess output is still accounted for.
use crate::{refused, Result};

#[derive(Debug, Default)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exceeded: bool,
    limit: usize,
}
impl Output {
    pub fn new(limit: usize) -> Result<Self> {
        if limit == 0 || limit > 65536 {
            return Err(refused("explicit combined output bound required"));
        }
        Ok(Self {
            limit,
            ..Self::default()
        })
    }
    pub fn push(&mut self, stderr: bool, bytes: &[u8]) {
        let left = self
            .limit
            .saturating_sub(self.stdout.len() + self.stderr.len());
        let n = left.min(bytes.len());
        if stderr {
            self.stderr.extend_from_slice(&bytes[..n]);
        } else {
            self.stdout.extend_from_slice(&bytes[..n]);
        }
        self.exceeded |= n != bytes.len();
    }
    pub fn success_admissible(&self) -> bool {
        !self.exceeded
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn combined_budget_and_overflow_are_not_success() {
        let mut out = Output::new(4).unwrap();
        out.push(false, b"abc");
        out.push(true, b"de");
        assert_eq!(out.stdout, b"abc");
        assert_eq!(out.stderr, b"d");
        assert!(!out.success_admissible());
        out.push(false, &[0; 64]);
        assert_eq!(out.stdout.len() + out.stderr.len(), 4);
    }
    #[test]
    fn empty_and_binary_output_preserve_bytes() {
        let mut out = Output::new(4).unwrap();
        out.push(true, &[0, 255]);
        assert!(out.success_admissible());
        assert_eq!(out.stderr, [0, 255]);
        assert!(Output::new(0).is_err());
        assert!(Output::new(65537).is_err());
    }
}
