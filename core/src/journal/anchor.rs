#![forbid(unsafe_code)]
//! [TARGET, unit decision] An anchor is an externally protected, canonical
//! metaviewer.checkpoint/v1 head captured by a trusted operator after validation.
//! Provision it outside the session archive, under storage/permissions the archive
//! writer cannot rewrite. This module only reads it: it never creates, refreshes,
//! or falls back from a required anchor. Path separation is checked, but cannot
//! establish independent administrative protection; that is a caller precondition.
//! An anchor pins the exact head, so legitimate later appends need a new trusted
//! anchor. Unanchored scan intentionally proves local consistency only.
use super::{json, parse, read_file, scan, Checkpoint, JournalError, Replay, MAX_LINE};
use std::fs;
use std::path::Path;

/// Verify the conventional journal in `root` against a required protected head.
pub fn verify_with_anchor(root: &Path, anchor_path: &Path) -> Result<Replay, JournalError> {
    scan_with_anchor(&root.join("journal.jsonl"), root, anchor_path)
}

/// Verify an explicitly selected journal and its archive against a protected head.
pub fn scan_with_anchor(
    path: &Path,
    root: &Path,
    anchor_path: &Path,
) -> Result<Replay, JournalError> {
    // Reject missing, unreadable, noncanonical or archive-local anchors. read_file
    // rejects symlink components; canonical paths also handle relative spellings.
    let bytes = read_file(anchor_path, MAX_LINE as u64).map_err(|_| JournalError::Corrupt)?;
    let anchor = fs::canonicalize(anchor_path).map_err(|_| JournalError::Corrupt)?;
    let archive = fs::canonicalize(root).map_err(|_| JournalError::Corrupt)?;
    if anchor.starts_with(archive) {
        return Err(JournalError::Corrupt);
    }
    let expected: Checkpoint = parse(&bytes).map_err(|_| JournalError::Corrupt)?;
    let replay = scan(path, root)?;
    if json(&expected)? != json(&replay.checkpoint)? {
        return Err(JournalError::Corrupt);
    }
    Ok(replay)
}
