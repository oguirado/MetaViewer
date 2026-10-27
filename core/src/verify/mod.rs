//! Core-owned verification over frame-bound evidence, independent of inference.
//! [TARGET, unit decision] Call only after admission's epoch/lease receipt gate.
//! Element state and lane predecessor are internal capture-owner witnesses;
//! the frozen observation wire has no slots for them. Missing evidence refuses.
//! [TARGET, unit decision] Published frames belong to the core effective UID
//! and expose no group/other permissions throughout the read.
#![forbid(unsafe_code)]

use crate::journal::canonical_bytes;
use crate::wire::payload::*;
use crate::wire::Optional;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

#[cfg(test)]
mod ownership_tests;

/// [TARGET, unit decision] Bound allocation before reading untrusted frame paths.
pub const MAX_RGB_BYTES: u64 = 256 * 1024 * 1024;
const MAX_STATE_BYTES: usize = 1_048_576;

#[derive(Clone, Copy, Debug)]
pub struct ElementWitness<'a> {
    pub role: &'a str,
    pub name: &'a str,
    pub state: &'a str,
}

/// Facts obtained from the capture owner, never from the executor's success bit.
#[derive(Clone, Copy, Debug, Default)]
pub struct Evidence<'a> {
    pub before_rgb: Option<&'a [u8]>,
    pub after_rgb: Option<&'a [u8]>,
    pub before_state: Option<&'a [u8]>,
    pub after_state: Option<&'a [u8]>,
    /// Capture-owner binding for lane, element and OCR evidence.
    pub semantic_frame_sha256: Option<&'a str>,
    pub previous_state_sha256: Option<&'a str>,
    pub elements: &'a [ElementWitness<'a>],
    pub text: &'a [&'a str],
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn byte_len(frame: &FrameRef) -> Option<u64> {
    if frame.width == 0 || frame.height == 0 || frame.generation == 0 {
        return None;
    }
    let length = frame.width.checked_mul(frame.height)?.checked_mul(3)?;
    (length <= MAX_RGB_BYTES).then_some(length)
}

fn valid_rgb(frame: &FrameRef, bytes: Option<&[u8]>) -> bool {
    let Some(bytes) = bytes else { return false };
    byte_len(frame).is_some_and(|n| n == bytes.len() as u64)
        && !bytes.is_empty()
        && digest(bytes) == frame.sha256
}

/// Read only an immutable regular RAM file; size/hash are checked on read bytes.
/// The caller retains its generation lease until verification finishes.
pub fn read_published_frame(frame: &FrameRef) -> io::Result<Vec<u8>> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "invalid frame witness");
    let uid = crate::serve::effective_uid().map_err(|_| invalid())?;
    let private_file = |metadata: &fs::Metadata| {
        metadata.is_file() && metadata.uid() == uid && metadata.mode() & 0o077 == 0
    };
    let length = byte_len(frame).ok_or_else(invalid)?;
    let path = Path::new(&frame.ramws_path);
    let canonical = fs::canonicalize(path)?;
    if !canonical.starts_with("/dev/shm") || canonical != path {
        return Err(invalid());
    }
    let metadata = fs::symlink_metadata(path)?;
    if !private_file(&metadata) || metadata.file_type().is_symlink() || metadata.len() != length {
        return Err(invalid());
    }
    let file = File::open(path)?;
    let opened = file.metadata()?;
    if !private_file(&opened) || opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(length + 1).read_to_end(&mut bytes)?;
    let final_meta = fs::symlink_metadata(path)?;
    if !private_file(&final_meta)
        || final_meta.dev() != opened.dev()
        || final_meta.ino() != opened.ino()
        || !valid_rgb(frame, Some(&bytes))
    {
        return Err(invalid());
    }
    Ok(bytes)
}

fn canonical_state(bytes: Option<&[u8]>, expected: &str) -> bool {
    let Some(bytes) = bytes else { return false };
    if bytes.is_empty() || bytes.len() > MAX_STATE_BYTES {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return false;
    };
    value.is_object()
        && canonical_bytes(&value)
            .is_ok_and(|canonical| canonical == bytes && digest(bytes) == expected)
}

fn pixel_changed(
    region: &ActionProposalExpectationCase0Bbox,
    before: &FrameRef,
    after: &FrameRef,
    evidence: &Evidence<'_>,
) -> bool {
    if (before.width, before.height) != (after.width, after.height)
        || region.w == 0
        || region.h == 0
        || !region
            .x
            .checked_add(region.w)
            .is_some_and(|x| x <= after.width)
        || !region
            .y
            .checked_add(region.h)
            .is_some_and(|y| y <= after.height)
    {
        return false;
    }
    let (Some(b), Some(a)) = (evidence.before_rgb, evidence.after_rgb) else {
        return false;
    };
    // Frame byte lengths were capped and checked before indexing.
    for y in region.y..region.y + region.h {
        let start = ((y * after.width + region.x) * 3) as usize;
        let end = start + (region.w * 3) as usize;
        if a[start..end] != b[start..end] {
            return true;
        }
    }
    false
}

/// Recompute the terminal receipt; the incoming verified/method/detail are ignored.
/// Epoch, replay, ownership and dispatch custody remain admission preconditions.
pub fn verify_receipt(
    proposal: &ActionProposal,
    before: &Observation,
    after: &Observation,
    receipt: &ActionReceipt,
    evidence: &Evidence<'_>,
) -> ActionReceipt {
    let mut result = receipt.clone();
    result.verified = false;
    let (method, predicate) = match &proposal.expectation {
        ActionProposalExpectation::Case0(want) => (
            ActionReceiptVerificationMethod::Pixel,
            valid_rgb(&before.frame_ref, evidence.before_rgb)
                && valid_rgb(&after.frame_ref, evidence.after_rgb)
                && pixel_changed(&want.bbox, &before.frame_ref, &after.frame_ref, evidence),
        ),
        ActionProposalExpectation::Case1(want) => (
            ActionReceiptVerificationMethod::Element,
            evidence.semantic_frame_sha256 == Some(after.frame_ref.sha256.as_str())
                && evidence
                    .elements
                    .iter()
                    .any(|e| e.role == want.role && e.name == want.name && e.state == want.state),
        ),
        ActionProposalExpectation::Case2(want) => {
            let matches = match (&before.ground_truth, &after.ground_truth) {
                (Optional::Present(b), Optional::Present(a)) => {
                    evidence.semantic_frame_sha256 == Some(after.frame_ref.sha256.as_str())
                        && want.min_tick <= want.max_tick
                        && (want.min_tick..=want.max_tick).contains(&a.tick)
                        && a.tick > b.tick
                        && a.tick == after.frame_ref.tick
                        && b.tick == before.frame_ref.tick
                        && b.state_sha256 == want.before
                        && a.state_sha256 != b.state_sha256
                        && evidence.previous_state_sha256 == Some(b.state_sha256.as_str())
                        && canonical_state(evidence.before_state, &b.state_sha256)
                        && canonical_state(evidence.after_state, &a.state_sha256)
                }
                _ => false,
            };
            (ActionReceiptVerificationMethod::StateSha256, matches)
        }
        ActionProposalExpectation::Case3(want) => (
            ActionReceiptVerificationMethod::Element,
            evidence.semantic_frame_sha256 == Some(after.frame_ref.sha256.as_str())
                && !want.text.is_empty()
                && evidence.text.iter().any(|text| text.contains(&want.text)),
        ),
    };
    let b = &before.frame_ref;
    let a = &after.frame_ref;
    let bindings = proposal.proposal_id == receipt.proposal_id
        && proposal.surface_id == b.surface_id
        && proposal.surface_id == a.surface_id
        && proposal.based_on_frame.sha256 == b.sha256
        && proposal.based_on_frame.generation == b.generation
        && a.generation > b.generation
        && receipt.after_frame == *a
        && b.ts_ns <= receipt.executed_at_ns
        && receipt.executed_at_ns <= a.ts_ns
        && proposal
            .budget
            .max_ms
            .checked_mul(1_000_000)
            .is_some_and(|limit| {
                a.ts_ns
                    .checked_sub(b.ts_ns)
                    .is_some_and(|elapsed| elapsed <= limit)
            })
        && receipt.error.is_empty();
    result.verified = bindings
        && valid_rgb(b, evidence.before_rgb)
        && valid_rgb(a, evidence.after_rgb)
        && predicate;
    result.verification = ActionReceiptVerification {
        method,
        detail: if result.verified {
            "frame-bound witness matched"
        } else {
            "missing, invalid or unmatched witness"
        }
        .into(),
    };
    result
}
