#![forbid(unsafe_code)]
//! [TARGET, unit decision] Private archive v1: canonical event sidecars retain
//! replay inputs/outcomes and complete boundary bytes; a durable checkpoint binds
//! header, count, record tail and archive chain. Read-only scan fails closed on
//! unsealed tails; recovery rolls back any torn or unsealed tail to the durable
//! committed prefix, cleaning sidecars (events, orphan artifacts) before truncating
//! the journal.
//! [TARGET, unit decision] Recovery may promote checkpoint.next only after
//! replay proves its complete closure; stale pending files are replaced under
//! the exclusive writer lock. State/archive directories require effective uid/0700.
//! The archive read budget is 64 MiB [TARGET, unit decision], including
//! retained boundary snapshots. Artifacts are opaque authorized state witnesses; callers must authorize any
//! disk export. Raw pixel retention is never implied by a frame reference.
//! [TARGET, unit decision] A recognized journal header from another core version
//! requires an explicit fresh-session upgrade; it is never replayed or migrated.
//! [TARGET, unit decision] Durability and witness bounds: retained witnesses verify
//! caller-supplied digests before disk write or cache insertion; frame appends stage
//! checkpoint.next and publish checkpoint.json only after the sync batch flushes
//! artifacts, events, and journal.jsonl; any inline or background fsync error
//! poisons the journal handle so the next commit or flush_sync fails closed with
//! JournalError::Poisoned; uncommitted retains and verified-witness cache entries
//! are bounded (MAX_UNCOMMITTED_ARTIFACTS = 32, MAX_DIRTY_FILES = 32,
//! MAX_VERIFIED_WITNESS_CACHE = 256).
//! [TARGET, unit decision] Journal close/shutdown and Drop flush any pending
//! group-commit batch, close the worker channel, and join the background sync
//! worker (bounded wait SYNC_WORKER_JOIN_TIMEOUT = 5 s, logging errors) so no
//! file is written or renamed after close/drop returns.
//! [TARGET, unit decision] Unchanged-frame fast path in journal verify: when a
//! frame's advertised digest equals the last committed digest for the same
//! surface in the same session root and epoch with strictly advancing generation
//! and matching width, height, and byte length, verification compares the
//! anchored bytes against the in-memory verified witness bytes (memcmp of the
//! full buffer) and reuses the witness without recomputing SHA-256, falling
//! back to full streaming SHA-256 verification on any length, geometry,
//! generation, epoch, surface, root, mode, ownership, or byte difference. Disk
//! bytes are never inserted into the witness cache or marked verified without
//! computing SHA-256; surface changes, Lost/Destroyed, restart, or epoch changes
//! evict the cache entry, and per-surface witness memory is bounded by
//! MAX_SURFACE_WITNESS_BYTES (64 MiB; 16 surfaces at 1280x900 RGB24 = 55,296,000 B).
use crate::admission::{CoreState, Input, Outcome};
use crate::wire::payload::{SessionRecord, SessionRecordKind, SessionRecordSchema};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
/// Verification against a separately protected, externally supplied journal head.
pub mod anchor;
mod sha256;
pub use sha256::{sha256_hex, StreamingSha256};

// [TARGET, unit decision] Group-commit window for frame witness/record fsyncs.
// Non-frame transitions and Journal drop flush synchronously before proceeding.
const FRAME_SYNC_WINDOW: std::time::Duration = std::time::Duration::from_millis(50);
const FRAME_SYNC_MAX_BATCH: u64 = 8;
const MAX_PENDING_SYNC_BATCHES: usize = 4;
const SYNC_WORKER_JOIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const MAX_UNCOMMITTED_ARTIFACTS: usize = 32;
const MAX_DIRTY_FILES: usize = 32;
const MAX_VERIFIED_WITNESS_CACHE: usize = 256;
const MAX_SURFACE_WITNESS_ROOTS: usize = 64;
const MAX_SURFACE_WITNESSES_PER_ROOT: usize = 32;
/// [TARGET, unit decision] Per-session byte cap on committed surface witnesses (64 MiB).
/// 16 surfaces at 1280x900 RGB24 (3,456,000 B each) occupy at most 55,296,000 B (~52.73 MiB).
pub const MAX_SURFACE_WITNESS_BYTES: usize = 64 * 1024 * 1024;
const MAX_RETAINED_WITNESS_BYTES: usize = 64 * 1024 * 1024;

#[cfg(test)]
static HOOKS_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RecoveryCrashStep {
    FirstEventSidecarRemoved,
    EventsCleanedBeforeEventsDirSync,
    FirstOrphanArtifactRemoved,
    SidecarsSyncedBeforeJournalTruncate,
    JournalTruncateBeforeJournalSync,
    JournalSyncBeforePendingRemove,
    PendingRemoveBeforeRootDirSync,
}

#[cfg(test)]
#[derive(Default)]
struct RootHooks {
    trace_enabled: bool,
    trace: Vec<String>,
    fail_next_witness_sync: bool,
    fail_next_append_torn_event_sidecar: bool,
    fail_next_append_torn_journal: bool,
    fail_next_append_torn_checkpoint_next: bool,
    fail_next_checkpoint_before_rename: bool,
    fail_next_after_journal_sync: bool,
    fail_next_worker_batch: bool,
    fail_next_recovery_step: Option<RecoveryCrashStep>,
    block_next_flush: bool,
    worker_entered_block: bool,
    join_timeout: Option<std::time::Duration>,
}

#[cfg(test)]
struct HookRegistry {
    map: std::sync::Mutex<std::collections::BTreeMap<PathBuf, RootHooks>>,
    cv: std::sync::Condvar,
}

#[cfg(test)]
fn hook_registry() -> &'static HookRegistry {
    static REGISTRY: std::sync::OnceLock<HookRegistry> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| HookRegistry {
        map: std::sync::Mutex::new(std::collections::BTreeMap::new()),
        cv: std::sync::Condvar::new(),
    })
}

#[cfg(test)]
pub(crate) fn clear_root_hooks(root: &Path) {
    let reg = hook_registry();
    let mut map = reg.map.lock().unwrap_or_else(|e| e.into_inner());
    map.remove(root);
    if map.is_empty() {
        HOOKS_ACTIVE.store(false, std::sync::atomic::Ordering::Release);
    }
    reg.cv.notify_all();
}

/// Enables per-root fsync ordering trace collection for recovery and durability tests.
#[cfg(test)]
pub(crate) fn enable_sync_trace(root: &Path) {
    HOOKS_ACTIVE.store(true, std::sync::atomic::Ordering::Release);
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let entry = map.entry(root.to_path_buf()).or_default();
    entry.trace_enabled = true;
    entry.trace.clear();
}

/// Drains and disables the per-root fsync ordering trace.
#[cfg(test)]
pub(crate) fn take_sync_trace(root: &Path) -> Vec<String> {
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(entry) = map.get_mut(root) else {
        return Vec::new();
    };
    entry.trace_enabled = false;
    std::mem::take(&mut entry.trace)
}

/// Injects a single fsync failure on the next witness sync under `root`.
#[cfg(test)]
pub(crate) fn fail_next_witness_sync(root: &Path) {
    HOOKS_ACTIVE.store(true, std::sync::atomic::Ordering::Release);
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(root.to_path_buf())
        .or_default()
        .fail_next_witness_sync = true;
}

/// Injects a crash during `append` after writing a torn event sidecar before writing `journal.jsonl`.
#[cfg(test)]
pub(crate) fn fail_next_append_with_torn_event_sidecar(root: &Path) {
    HOOKS_ACTIVE.store(true, std::sync::atomic::Ordering::Release);
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(root.to_path_buf())
        .or_default()
        .fail_next_append_torn_event_sidecar = true;
}

/// Injects a crash during `append` after writing a torn journal line without trailing LF.
#[cfg(test)]
pub(crate) fn fail_next_append_with_torn_journal(root: &Path) {
    HOOKS_ACTIVE.store(true, std::sync::atomic::Ordering::Release);
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(root.to_path_buf())
        .or_default()
        .fail_next_append_torn_journal = true;
}

/// Injects a crash during `append` after writing a truncated genuine `checkpoint.next`.
#[cfg(test)]
pub(crate) fn fail_next_append_with_torn_checkpoint_next(root: &Path) {
    HOOKS_ACTIVE.store(true, std::sync::atomic::Ordering::Release);
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(root.to_path_buf())
        .or_default()
        .fail_next_append_torn_checkpoint_next = true;
}

/// Injects a single crash at the specified step of `try_rollback_uncommitted_tail`.
#[cfg(test)]
pub(crate) fn fail_next_recovery_at_step(root: &Path, step: RecoveryCrashStep) {
    HOOKS_ACTIVE.store(true, std::sync::atomic::Ordering::Release);
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(root.to_path_buf())
        .or_default()
        .fail_next_recovery_step = Some(step);
}

/// Injects a crash inside `checkpoint` right before renaming `checkpoint.next` to `checkpoint.json`.
#[cfg(test)]
pub(crate) fn fail_next_checkpoint_before_rename(root: &Path) {
    HOOKS_ACTIVE.store(true, std::sync::atomic::Ordering::Release);
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(root.to_path_buf())
        .or_default()
        .fail_next_checkpoint_before_rename = true;
}

/// Injects a crash in non-frame `append` right after syncing `journal.jsonl` before checkpoint promotion.
#[cfg(test)]
pub(crate) fn fail_next_after_journal_sync(root: &Path) {
    HOOKS_ACTIVE.store(true, std::sync::atomic::Ordering::Release);
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(root.to_path_buf())
        .or_default()
        .fail_next_after_journal_sync = true;
}

/// Injects a single batch sync failure in the background worker after any block hook releases.
#[cfg(test)]
pub(crate) fn fail_next_worker_batch(root: &Path) {
    HOOKS_ACTIVE.store(true, std::sync::atomic::Ordering::Release);
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(root.to_path_buf())
        .or_default()
        .fail_next_worker_batch = true;
}

/// Holds the background sync worker on its next flush batch for `root` and sets a custom join timeout.
#[cfg(test)]
pub(crate) fn block_worker_on_next_flush(root: &Path, join_timeout: std::time::Duration) {
    HOOKS_ACTIVE.store(true, std::sync::atomic::Ordering::Release);
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let entry = map.entry(root.to_path_buf()).or_default();
    entry.block_next_flush = true;
    entry.worker_entered_block = false;
    entry.join_timeout = Some(join_timeout);
}

#[cfg(test)]
pub(crate) fn set_worker_join_timeout_for_test(root: &Path, join_timeout: std::time::Duration) {
    HOOKS_ACTIVE.store(true, std::sync::atomic::Ordering::Release);
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(root.to_path_buf()).or_default().join_timeout = Some(join_timeout);
}

#[cfg(test)]
pub(crate) fn wait_until_worker_blocked(root: &Path, timeout: std::time::Duration) -> bool {
    let reg = hook_registry();
    let deadline = std::time::Instant::now() + timeout;
    let mut map = reg.map.lock().unwrap_or_else(|e| e.into_inner());
    while !map.get(root).is_some_and(|e| e.worker_entered_block) {
        let now = std::time::Instant::now();
        if now >= deadline {
            return false;
        }
        let (new_map, _) = reg
            .cv
            .wait_timeout(map, deadline.saturating_duration_since(now))
            .unwrap_or_else(|e| e.into_inner());
        map = new_map;
    }
    true
}

/// Releases a worker blocked via `block_worker_on_next_flush`.
#[cfg(test)]
pub(crate) fn release_blocked_worker(root: &Path) {
    if !HOOKS_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    let reg = hook_registry();
    let mut map = reg.map.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = map.get_mut(root) {
        entry.block_next_flush = false;
        entry.worker_entered_block = false;
        reg.cv.notify_all();
    }
}

#[cfg(test)]
fn record_sync_trace(root: &Path, rel: &str) {
    if !HOOKS_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = map.get_mut(root) {
        if entry.trace_enabled {
            entry.trace.push(rel.to_owned());
        }
    }
}

#[cfg(test)]
fn take_injected_witness_sync_failure(root: &Path) -> bool {
    if !HOOKS_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        return false;
    }
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = map.get_mut(root) {
        if entry.fail_next_witness_sync {
            entry.fail_next_witness_sync = false;
            return true;
        }
    }
    false
}

#[cfg(test)]
fn take_injected_append_torn_event_sidecar(root: &Path) -> bool {
    if !HOOKS_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        return false;
    }
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = map.get_mut(root) {
        if entry.fail_next_append_torn_event_sidecar {
            entry.fail_next_append_torn_event_sidecar = false;
            return true;
        }
    }
    false
}

#[cfg(test)]
fn take_injected_append_torn_journal(root: &Path) -> bool {
    if !HOOKS_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        return false;
    }
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = map.get_mut(root) {
        if entry.fail_next_append_torn_journal {
            entry.fail_next_append_torn_journal = false;
            return true;
        }
    }
    false
}

#[cfg(test)]
fn take_injected_append_torn_checkpoint_next(root: &Path) -> bool {
    if !HOOKS_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        return false;
    }
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = map.get_mut(root) {
        if entry.fail_next_append_torn_checkpoint_next {
            entry.fail_next_append_torn_checkpoint_next = false;
            return true;
        }
    }
    false
}

#[cfg(test)]
fn take_injected_recovery_step(root: &Path, step: RecoveryCrashStep) -> bool {
    if !HOOKS_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        return false;
    }
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = map.get_mut(root) {
        if entry.fail_next_recovery_step == Some(step) {
            entry.fail_next_recovery_step = None;
            return true;
        }
    }
    false
}

#[cfg(test)]
fn take_injected_checkpoint_before_rename(root: &Path) -> bool {
    if !HOOKS_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        return false;
    }
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = map.get_mut(root) {
        if entry.fail_next_checkpoint_before_rename {
            entry.fail_next_checkpoint_before_rename = false;
            return true;
        }
    }
    false
}

#[cfg(test)]
fn take_injected_after_journal_sync(root: &Path) -> bool {
    if !HOOKS_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        return false;
    }
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = map.get_mut(root) {
        if entry.fail_next_after_journal_sync {
            entry.fail_next_after_journal_sync = false;
            return true;
        }
    }
    false
}

#[cfg(test)]
fn take_injected_worker_batch_failure(root: &Path) -> bool {
    if !HOOKS_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        return false;
    }
    let mut map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = map.get_mut(root) {
        if entry.fail_next_worker_batch {
            entry.fail_next_worker_batch = false;
            return true;
        }
    }
    false
}

#[cfg(test)]
fn join_timeout_for(root: &Path) -> std::time::Duration {
    if !HOOKS_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        return SYNC_WORKER_JOIN_TIMEOUT;
    }
    let map = hook_registry()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.get(root)
        .and_then(|e| e.join_timeout)
        .unwrap_or(SYNC_WORKER_JOIN_TIMEOUT)
}

#[cfg(not(test))]
fn join_timeout_for(_root: &Path) -> std::time::Duration {
    SYNC_WORKER_JOIN_TIMEOUT
}

#[cfg(test)]
fn wait_while_hook_blocked(root: &Path) {
    if !HOOKS_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    let reg = hook_registry();
    let mut map = reg.map.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = map.get_mut(root) {
        if entry.block_next_flush {
            entry.worker_entered_block = true;
            reg.cv.notify_all();
        }
    }
    while map.get(root).is_some_and(|e| e.block_next_flush) {
        map = reg.cv.wait(map).unwrap_or_else(|e| e.into_inner());
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub struct FrameStageTimings {
    pub test_prep_ns: u128,
    pub shm_read_ns: u128,
    pub hash_ns: u128,
    pub hash_calls_3mb: u64,
    pub skipped_hash_ns: u128,
    pub skipped_hash_frames: u64,
    pub witness_copy_ns: u128,
    pub witness_verify_read_ns: u128,
    pub journal_write_ns: u128,
    pub fsync_ns: u128,
    pub fsync_calls: u64,
    pub capture_ns: u128,
    pub fanout_ns: u128,
}

#[cfg(test)]
std::thread_local! {
    pub static STAGE_TIMINGS: std::cell::Cell<FrameStageTimings> = const { std::cell::Cell::new(FrameStageTimings {
        test_prep_ns: 0,
        shm_read_ns: 0,
        hash_ns: 0,
        hash_calls_3mb: 0,
        skipped_hash_ns: 0,
        skipped_hash_frames: 0,
        witness_copy_ns: 0,
        witness_verify_read_ns: 0,
        journal_write_ns: 0,
        fsync_ns: 0,
        fsync_calls: 0,
        capture_ns: 0,
        fanout_ns: 0,
    }) };
}

#[cfg(test)]
struct TestSyncHold {
    held: std::sync::Mutex<bool>,
    cv: std::sync::Condvar,
}

#[cfg(test)]
fn test_sync_holds(
) -> &'static std::sync::Mutex<std::collections::BTreeMap<PathBuf, std::sync::Arc<TestSyncHold>>> {
    static HOLDS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::BTreeMap<PathBuf, std::sync::Arc<TestSyncHold>>>,
    > = std::sync::OnceLock::new();
    HOLDS.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeMap::new()))
}

#[cfg(test)]
pub(crate) fn hold_sync_worker_for_test(root: &Path) {
    let mut holds = test_sync_holds().lock().unwrap_or_else(|e| e.into_inner());
    let hold = holds
        .entry(root.to_path_buf())
        .or_insert_with(|| {
            std::sync::Arc::new(TestSyncHold {
                held: std::sync::Mutex::new(true),
                cv: std::sync::Condvar::new(),
            })
        })
        .clone();
    *hold.held.lock().unwrap_or_else(|e| e.into_inner()) = true;
}

#[cfg(test)]
fn is_test_sync_held(root: &Path) -> bool {
    let hold = test_sync_holds()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(root)
        .cloned();
    hold.is_some_and(|h| *h.held.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(test)]
fn wait_while_test_sync_held(root: &Path) {
    let hold = test_sync_holds()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(root)
        .cloned();
    if let Some(hold) = hold {
        let mut held = hold.held.lock().unwrap_or_else(|e| e.into_inner());
        while *held {
            held = hold.cv.wait(held).unwrap_or_else(|e| e.into_inner());
        }
    }
}

#[cfg(test)]
pub(crate) fn release_test_sync_hold(root: &Path) {
    let hold = test_sync_holds()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(root);
    if let Some(hold) = hold {
        let mut held = hold.held.lock().unwrap_or_else(|e| e.into_inner());
        *held = false;
        hold.cv.notify_all();
    }
}

#[cfg(test)]
fn unsynced_eviction_counts() -> &'static std::sync::Mutex<std::collections::BTreeMap<PathBuf, u64>>
{
    static COUNTS: std::sync::OnceLock<std::sync::Mutex<std::collections::BTreeMap<PathBuf, u64>>> =
        std::sync::OnceLock::new();
    COUNTS.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeMap::new()))
}

#[cfg(test)]
fn record_unsynced_dirty_eviction(root: &Path) {
    let mut map = unsynced_eviction_counts()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *map.entry(root.to_path_buf()).or_insert(0) += 1;
}

#[cfg(test)]
pub(crate) fn unsynced_dirty_evictions(root: &Path) -> u64 {
    unsynced_eviction_counts()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(root)
        .copied()
        .unwrap_or(0)
}

const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RECORDS: u64 = 100_000;
const MAX_LINE: usize = crate::MAX_FRAME_BYTES;
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JournalError {
    Invalid,
    Io,
    Corrupt,
    Empty,
    Blank,
    Utf8Bom,
    MissingLf,
    Oversize,
    Duplicate,
    Witness,
    Unsealed,
    Policy,
    Locked,
    Poisoned,
    UpgradeRequired { expected: String, found: String },
}
impl JournalError {
    pub fn corruption_cause(&self) -> Option<&'static str> {
        match self {
            Self::Empty => Some("empty"),
            Self::Blank => Some("blank"),
            Self::Utf8Bom => Some("utf8_bom"),
            Self::MissingLf => Some("missing_lf"),
            Self::Oversize => Some("oversize"),
            Self::Corrupt => Some("corrupt"),
            _ => None,
        }
    }
}
impl std::fmt::Display for JournalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => write!(f, "Corrupt(empty): journal file is empty"),
            Self::Blank => write!(f, "Corrupt(blank): journal line is empty or whitespace-only"),
            Self::Utf8Bom => write!(f, "Corrupt(utf8_bom): journal line starts with a UTF-8 BOM"),
            Self::MissingLf => write!(
                f,
                "Corrupt(missing_lf): journal line is torn or missing trailing LF"
            ),
            Self::Oversize => write!(
                f,
                "Corrupt(oversize): journal or record line exceeds byte ceiling"
            ),
            Self::UpgradeRequired { expected, found } => write!(
                f,
                "UPGRADE-REQUIRED: expected core version {expected}, found {found}; stop peers, archive the complete session directory unchanged, and start a fresh session with a new session_id"
            ),
            _ => write!(f, "{self:?}"),
        }
    }
}
impl std::error::Error for JournalError {}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    schema: String,
    session_id: String,
    core_version: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Genesis {
    schema: String,
    header_sha256: String,
    state: CoreState,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Witness {
    pub sha256: String,
    pub byte_len: u64,
}
#[derive(Clone, Debug)]
struct SurfaceWitnessEntry {
    sha256: String,
    epoch: u64,
    generation: u64,
    width: u64,
    height: u64,
    byte_len: usize,
    uid: u32,
    mode: u32,
    bytes: std::sync::Arc<[u8]>,
}
type SurfaceWitnessMap = std::collections::BTreeMap<String, SurfaceWitnessEntry>;
type RootWitnessTable = std::collections::BTreeMap<PathBuf, SurfaceWitnessMap>;

fn committed_surface_witnesses() -> &'static std::sync::Mutex<RootWitnessTable> {
    static REGISTRY: std::sync::OnceLock<std::sync::Mutex<RootWitnessTable>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeMap::new()))
}

fn publish_committed_surface_witnesses(root: &Path, map: &SurfaceWitnessMap) {
    let mut reg = committed_surface_witnesses()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if map.is_empty() {
        reg.remove(root);
        return;
    }
    if !reg.contains_key(root) && reg.len() >= MAX_SURFACE_WITNESS_ROOTS {
        if let Some(oldest) = reg.keys().next().cloned() {
            reg.remove(&oldest);
        }
    }
    reg.insert(root.to_path_buf(), map.clone());
}

fn remove_committed_surface_witnesses(root: &Path) {
    let mut reg = committed_surface_witnesses()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    reg.remove(root);
}

#[allow(clippy::too_many_arguments)]
fn lookup_committed_surface_witness(
    root: &Path,
    surface_id: &str,
    epoch: u64,
    generation: u64,
    width: u64,
    height: u64,
    expected_sha256: &str,
    expected_len: usize,
) -> Option<std::sync::Arc<[u8]>> {
    if surface_id.is_empty()
        || width == 0
        || height == 0
        || expected_len == 0
        || (expected_len as u64) > MAX_BYTES
        || !hex(expected_sha256)
    {
        return None;
    }
    let uid = current_uid().ok()?;
    let reg = committed_surface_witnesses()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let surfaces = reg.get(root)?;
    let entry = surfaces.get(surface_id)?;
    if entry.sha256 == expected_sha256
        && entry.epoch == epoch
        && entry.generation > 0
        && generation > entry.generation
        && entry.width == width
        && entry.height == height
        && entry.byte_len == expected_len
        && entry.bytes.len() == expected_len
        && entry.uid == uid
        && (entry.mode & 0o077) == 0
    {
        Some(entry.bytes.clone())
    } else {
        None
    }
}

struct PoisonWitnessGuard {
    root: PathBuf,
    disarmed: bool,
}
impl Drop for PoisonWitnessGuard {
    fn drop(&mut self) {
        if !self.disarmed {
            remove_committed_surface_witnesses(&self.root);
        }
    }
}

#[derive(Debug)]
pub struct VerifiedPixels {
    bytes: Vec<u8>,
    sha256: String,
    pub(crate) read_started: Option<std::time::Instant>,
    pub(crate) shm_read_ns: u128,
    pub(crate) hash_ns: u128,
    pub(crate) skipped_hash_ns: u128,
    pub(crate) hash_skipped: bool,
}
std::thread_local! {
    static VERIFIED_PIXEL_GRANT: std::cell::Cell<Option<(usize, usize, [u8; 64])>> = const {
        std::cell::Cell::new(None)
    };
}
struct VerifiedGrantGuard;
impl Drop for VerifiedGrantGuard {
    fn drop(&mut self) {
        VERIFIED_PIXEL_GRANT.with(|c| c.set(None));
    }
}
fn take_verified_grant(sha256: &str, bytes: &[u8]) -> bool {
    VERIFIED_PIXEL_GRANT.with(|c| {
        let Some((ptr, len, grant_sha)) = c.take() else {
            return false;
        };
        ptr == bytes.as_ptr() as usize && len == bytes.len() && sha256.as_bytes() == grant_sha
    })
}
impl VerifiedPixels {
    fn new(bytes: Vec<u8>, sha256: String) -> Self {
        Self {
            bytes,
            sha256,
            read_started: None,
            shm_read_ns: 0,
            hash_ns: 0,
            skipped_hash_ns: 0,
            hash_skipped: false,
        }
    }
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, JournalError> {
        if bytes.is_empty() || bytes.len() as u64 > MAX_BYTES {
            return Err(JournalError::Witness);
        }
        let sha256 = sha256_hex(&bytes);
        Ok(Self::new(bytes, sha256))
    }
    pub fn verify(sha256: &str, bytes: Vec<u8>) -> Result<Self, JournalError> {
        if !hex(sha256)
            || bytes.is_empty()
            || bytes.len() as u64 > MAX_BYTES
            || sha256_hex(&bytes) != sha256
        {
            return Err(JournalError::Witness);
        }
        Ok(Self::new(bytes, sha256.to_owned()))
    }
    pub(crate) fn read_verified(
        reader: impl Read,
        expected_len: usize,
        expected_sha256: &str,
    ) -> std::io::Result<Self> {
        Self::read_verified_inner(reader, None, expected_len, expected_sha256)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn read_verified_for_surface(
        root: &Path,
        surface_id: &str,
        epoch: u64,
        generation: u64,
        width: u64,
        height: u64,
        reader: impl Read,
        expected_len: usize,
        expected_sha256: &str,
    ) -> std::io::Result<Self> {
        let candidate = lookup_committed_surface_witness(
            root,
            surface_id,
            epoch,
            generation,
            width,
            height,
            expected_sha256,
            expected_len,
        );
        Self::read_verified_inner(reader, candidate, expected_len, expected_sha256)
    }
    fn read_verified_inner(
        mut reader: impl Read,
        candidate: Option<std::sync::Arc<[u8]>>,
        expected_len: usize,
        expected_sha256: &str,
    ) -> std::io::Result<Self> {
        if expected_len == 0 || (expected_len as u64) > MAX_BYTES || !hex(expected_sha256) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "frame digest mismatch",
            ));
        }
        let started = std::time::Instant::now();
        if let Some(cached_bytes) = candidate {
            let mut bytes = vec![0u8; expected_len];
            let mut pos = 0usize;
            while pos < expected_len {
                let end = (pos + 65536).min(expected_len);
                let n = reader.read(&mut bytes[pos..end])?;
                if n == 0 {
                    break;
                }
                pos += n;
            }
            let mut extra = [0u8; 1];
            let trailing = reader.read(&mut extra)?;
            if pos != expected_len || trailing != 0 || bytes.len() != cached_bytes.len() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "frame digest mismatch",
                ));
            }
            let cmp_started = std::time::Instant::now();
            let unchanged = bytes.as_slice() == cached_bytes.as_ref();
            let cmp_ns = cmp_started.elapsed().as_nanos();
            if unchanged {
                #[cfg(test)]
                STAGE_TIMINGS.with(|cell| {
                    let mut s = cell.get();
                    s.skipped_hash_ns += cmp_ns;
                    s.skipped_hash_frames += 1;
                    cell.set(s);
                });
                let mut verified = Self::new(bytes, expected_sha256.to_owned());
                verified.read_started = Some(started);
                verified.hash_ns = 0;
                verified.skipped_hash_ns = cmp_ns;
                verified.hash_skipped = true;
                verified.shm_read_ns = started.elapsed().as_nanos().saturating_sub(cmp_ns);
                return Ok(verified);
            }
            let hash_started = std::time::Instant::now();
            let mut hasher = StreamingSha256::new();
            for chunk in bytes.chunks(65536) {
                hasher.update(chunk);
            }
            let digest = hasher.finalize_hex();
            let hash_ns = hash_started.elapsed().as_nanos();
            if digest != expected_sha256 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "frame digest mismatch",
                ));
            }
            let mut verified = Self::new(bytes, digest);
            verified.read_started = Some(started);
            verified.hash_ns = hash_ns;
            verified.shm_read_ns = started
                .elapsed()
                .as_nanos()
                .saturating_sub(hash_ns.saturating_add(cmp_ns));
            return Ok(verified);
        }
        let mut hash_ns = 0;
        let mut bytes = vec![0u8; expected_len];
        let mut hasher = StreamingSha256::new();
        let mut pos = 0usize;
        while pos < expected_len {
            let end = (pos + 65536).min(expected_len);
            let n = reader.read(&mut bytes[pos..end])?;
            if n == 0 {
                break;
            }
            let hash_started = std::time::Instant::now();
            hasher.update(&bytes[pos..pos + n]);
            hash_ns += hash_started.elapsed().as_nanos();
            pos += n;
        }
        let mut extra = [0u8; 1];
        let trailing = reader.read(&mut extra)?;
        let hash_started = std::time::Instant::now();
        let digest = hasher.finalize_hex();
        hash_ns += hash_started.elapsed().as_nanos();
        if pos != expected_len || trailing != 0 || digest != expected_sha256 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "frame digest mismatch",
            ));
        }
        let mut verified = Self::new(bytes, digest);
        verified.read_started = Some(started);
        verified.hash_ns = hash_ns;
        verified.shm_read_ns = started.elapsed().as_nanos().saturating_sub(hash_ns);
        Ok(verified)
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
    pub fn hash_skipped(&self) -> bool {
        self.hash_skipped
    }
    pub fn skipped_hash_ns(&self) -> u128 {
        self.skipped_hash_ns
    }
    pub fn hash_ns(&self) -> u128 {
        self.hash_ns
    }
    pub fn shm_read_ns(&self) -> u128 {
        self.shm_read_ns
    }
    pub fn retain_in_authority(
        &self,
        authority: &mut crate::admission::Authority,
    ) -> Result<Witness, JournalError> {
        let Ok(grant_sha) = <[u8; 64]>::try_from(self.sha256.as_bytes()) else {
            return Err(JournalError::Witness);
        };
        VERIFIED_PIXEL_GRANT.with(|c| {
            c.set(Some((
                self.bytes.as_ptr() as usize,
                self.bytes.len(),
                grant_sha,
            )));
        });
        let _guard = VerifiedGrantGuard;
        authority.retain_frame_witness(&self.sha256, &self.bytes)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Event {
    schema: String,
    record: SessionRecord,
    envelope: crate::Envelope,
    input: Input,
    outcome: Outcome,
    state: Value,
    witnesses: Vec<Witness>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    schema: String,
    count: u64,
    tail: String,
    archive: String,
    genesis: String,
}
#[derive(Debug)]
pub struct Replay {
    pub state: CoreState,
    pub boundaries: Vec<Vec<u8>>,
    archive_bytes: u64,
    checkpoint: Checkpoint,
    committed_witnesses: BTreeSet<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct VerifiedArtifact {
    byte_len: u64,
    dev: u64,
    ino: u64,
    uid: u32,
    mode: u32,
    mtime_nsec: i64,
    ctime_nsec: i64,
}
struct SyncBatch {
    files: Vec<(File, String)>,
    journal_file: File,
    checkpoint_file: Option<File>,
    checkpoint_count: u64,
    checkpoint_lock: std::sync::Arc<std::sync::Mutex<u64>>,
    aborted: std::sync::Arc<std::sync::atomic::AtomicBool>,
    root: PathBuf,
}
enum SyncCmd {
    Flush(SyncBatch),
    Barrier(std::sync::mpsc::SyncSender<Result<(), JournalError>>),
}
struct StagedBatch {
    batch: SyncBatch,
    deadline: std::time::Instant,
}
struct WorkerState {
    queue: std::collections::VecDeque<SyncCmd>,
    staged: Option<StagedBatch>,
    in_flight: bool,
    closed: bool,
    finished: bool,
    sticky_err: Option<JournalError>,
    completed_checkpoint_count: u64,
    completed_batches: u64,
    last_completed_sync: std::time::Instant,
}
struct WorkerShared {
    state: std::sync::Mutex<WorkerState>,
    cv: std::sync::Condvar,
    aborted: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
struct SyncWorker {
    shared: std::sync::Arc<WorkerShared>,
    handle: Option<std::thread::JoinHandle<()>>,
}
pub struct Journal {
    root: PathBuf,
    file: std::sync::Arc<WriterFile>,
    count: u64,
    bytes: u64,
    tail: String,
    archive: String,
    genesis: String,
    archive_bytes: u64,
    poisoned: bool,
    // Last durably committed reduction boundary; supplied transitions are untrusted.
    state: CoreState,
    verified_witnesses: std::collections::BTreeMap<String, VerifiedArtifact>,
    verified_witness_order: std::collections::VecDeque<String>,
    last_surface_witnesses: SurfaceWitnessMap,
    surface_witness_order: std::collections::VecDeque<String>,
    surface_witness_total_bytes: usize,
    retained_witness_bytes: std::collections::BTreeMap<String, (std::sync::Arc<[u8]>, u32, u32)>,
    retained_witness_order: std::collections::VecDeque<String>,
    retained_witness_total_bytes: usize,
    committed_witnesses: BTreeSet<String>,
    unsynced_witnesses: BTreeSet<String>,
    uncommitted_artifacts: std::collections::VecDeque<String>,
    dirty_files: Vec<(File, String)>,
    staged_dirty_len: usize,
    staged_checkpoint_count: u64,
    pending_checkpoint: Option<File>,
    checkpoint_lock: std::sync::Arc<std::sync::Mutex<u64>>,
    unsynced_frames: u64,
    first_unsynced_at: Option<std::time::Instant>,
    last_sync: std::time::Instant,
    last_dispatch: std::time::Instant,
    completed_sync_count: u64,
    completed_sync_batches: u64,
    sync_failed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    sync_worker: Option<SyncWorker>,
}
impl Drop for Journal {
    fn drop(&mut self) {
        remove_committed_surface_witnesses(&self.root);
        self.last_surface_witnesses.clear();
        self.surface_witness_order.clear();
        self.surface_witness_total_bytes = 0;
        self.retained_witness_bytes.clear();
        self.retained_witness_order.clear();
        self.retained_witness_total_bytes = 0;
        if !self.poisoned {
            if let Err(err) = self.close() {
                eprintln!("journal drop close failed: {err}");
            }
        }
        if self.sync_worker.is_some() {
            self.dirty_files.clear();
            self.staged_dirty_len = 0;
            self.staged_checkpoint_count = 0;
            self.pending_checkpoint = None;
            self.unsynced_frames = 0;
            self.first_unsynced_at = None;
            if let Err(err) = self.join_sync_worker_inner(true, true) {
                eprintln!("journal drop worker join failed: {err}");
            }
        }
    }
}
// [TARGET, unit decision] Release the writer's lock explicitly, including on
// error paths. Closing alone leaves flock held by a concurrent fork's inherited
// open file description until that child execs or exits.
struct WriterFile(File);
impl WriterFile {
    fn lock(file: File) -> Result<Self, JournalError> {
        file.try_lock().map_err(|_| JournalError::Locked)?;
        Ok(Self(file))
    }
}
impl std::ops::Deref for WriterFile {
    type Target = File;
    fn deref(&self) -> &File {
        &self.0
    }
}
impl std::ops::DerefMut for WriterFile {
    fn deref_mut(&mut self) -> &mut File {
        &mut self.0
    }
}
impl Drop for WriterFile {
    fn drop(&mut self) {
        // If unlock fails, closing still preserves the fail-closed kernel lock.
        let _ = self.0.unlock();
    }
}
fn json<T: Serialize>(value: &T) -> Result<Vec<u8>, JournalError> {
    canonical_bytes(&serde_json::to_value(value).map_err(|_| JournalError::Invalid)?)
}
pub fn canonical_bytes(v: &Value) -> Result<Vec<u8>, JournalError> {
    fn sorted(v: &Value) -> Result<Value, JournalError> {
        match v {
            Value::Number(n) if !n.is_u64() && !n.is_i64() => Err(JournalError::Invalid),
            Value::Array(a) => Ok(Value::Array(
                a.iter().map(sorted).collect::<Result<_, _>>()?,
            )),
            Value::Object(m) => {
                let pairs: std::collections::BTreeMap<_, _> = m.iter().collect();
                let mut out = serde_json::Map::new();
                for (k, v) in pairs {
                    out.insert(k.clone(), sorted(v)?);
                }
                Ok(Value::Object(out))
            }
            _ => Ok(v.clone()),
        }
    }
    serde_json::to_vec(&sorted(v)?).map_err(|_| JournalError::Invalid)
}
fn safe_component(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn confined(path: &Path) -> Result<(), JournalError> {
    let mut current = PathBuf::new();
    for c in path.components() {
        if matches!(c, Component::ParentDir) {
            return Err(JournalError::Invalid);
        }
        current.push(c);
        let m = fs::symlink_metadata(&current).map_err(|_| JournalError::Io)?;
        if m.file_type().is_symlink() {
            return Err(JournalError::Invalid);
        }
    }
    Ok(())
}
fn current_uid() -> Result<u32, JournalError> {
    static UID: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    if let Some(&uid) = UID.get() {
        return Ok(uid);
    }
    // Linux host effective uid, without unsafe FFI or process-wide state changes.
    let status = fs::read_to_string("/proc/self/status").map_err(|_| JournalError::Io)?;
    let uid: u32 = status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or(JournalError::Invalid)?
        .parse()
        .map_err(|_| JournalError::Invalid)?;
    let _ = UID.set(uid);
    Ok(uid)
}
fn private_directory(path: &Path) -> Result<(), JournalError> {
    confined(path)?;
    private_directory_for_uid(path, current_uid()?)
}
fn private_directory_for_uid(path: &Path, uid: u32) -> Result<(), JournalError> {
    confined(path)?;
    let meta = fs::symlink_metadata(path).map_err(|_| JournalError::Io)?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o7777 != 0o700 {
        return Err(JournalError::Invalid);
    }
    Ok(())
}
fn private_archive(root: &Path) -> Result<(), JournalError> {
    let sessions = root.parent().ok_or(JournalError::Invalid)?;
    let state = sessions.parent().ok_or(JournalError::Invalid)?;
    for dir in [
        state.to_path_buf(),
        sessions.to_path_buf(),
        root.to_path_buf(),
        root.join("events"),
        root.join("artifacts"),
    ] {
        private_directory(&dir)?;
    }
    Ok(())
}
// [TARGET, unit decision] Pending checkpoints are evidence only when their full
// closure matches a replay from genesis. A valid current checkpoint wins over a
// stale next file; recovery holds the journal lock before cleaning or promoting.
fn matching_checkpoint(root: &Path, expected: &Checkpoint) -> Result<Checkpoint, JournalError> {
    for name in ["checkpoint.json", "checkpoint.next"] {
        if let Ok(bytes) = read_file(&root.join(name), MAX_LINE as u64) {
            if let Ok(c) = parse::<Checkpoint>(&bytes) {
                if c.schema == expected.schema
                    && c.count == expected.count
                    && c.tail == expected.tail
                    && c.archive == expected.archive
                    && c.genesis == expected.genesis
                {
                    return Ok(c);
                }
            }
        }
    }
    Err(JournalError::Corrupt)
}
fn read_file(path: &Path, cap: u64) -> Result<Vec<u8>, JournalError> {
    confined(path)?;
    let before = fs::symlink_metadata(path).map_err(|_| JournalError::Io)?;
    if !before.is_file() || before.len() == 0 || before.len() > cap {
        return Err(JournalError::Invalid);
    }
    let f = File::open(path).map_err(|_| JournalError::Io)?;
    let after = f.metadata().map_err(|_| JournalError::Io)?;
    if before.ino() != after.ino() || before.dev() != after.dev() {
        return Err(JournalError::Invalid);
    }
    let mut bytes = Vec::new();
    f.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| JournalError::Io)?;
    if bytes.len() as u64 != before.len() {
        return Err(JournalError::Invalid);
    }
    Ok(bytes)
}
fn parse<T: for<'de> Deserialize<'de> + Serialize>(bytes: &[u8]) -> Result<T, JournalError> {
    let v: T = serde_json::from_slice(bytes).map_err(|_| JournalError::Corrupt)?;
    // Canonical identity rejects duplicate keys and alternate numeric spellings.
    if json(&v)? != bytes {
        return Err(JournalError::Corrupt);
    }
    Ok(v)
}
fn sync_file_traced(file: &File, _root: &Path, _rel: &str) -> Result<(), JournalError> {
    #[cfg(test)]
    let t0 = std::time::Instant::now();
    let res = file.sync_all().map_err(|_| JournalError::Io);
    #[cfg(test)]
    STAGE_TIMINGS.with(|cell| {
        let mut s = cell.get();
        s.fsync_ns += t0.elapsed().as_nanos();
        s.fsync_calls += 1;
        cell.set(s);
    });
    #[cfg(test)]
    if res.is_ok() {
        record_sync_trace(_root, _rel);
    }
    res
}
fn sync_path_traced(path: &Path, root: &Path, rel: &str) -> Result<(), JournalError> {
    let f = File::open(path).map_err(|_| JournalError::Io)?;
    sync_file_traced(&f, root, rel)
}
fn sync_dir_traced(path: &Path, _root: &Path, _rel: &str) -> Result<(), JournalError> {
    #[cfg(test)]
    let t0 = std::time::Instant::now();
    let res = File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|_| JournalError::Io);
    #[cfg(test)]
    STAGE_TIMINGS.with(|cell| {
        let mut s = cell.get();
        s.fsync_ns += t0.elapsed().as_nanos();
        s.fsync_calls += 1;
        cell.set(s);
    });
    #[cfg(test)]
    if res.is_ok() {
        record_sync_trace(_root, _rel);
    }
    res
}
fn sync_dir(path: &Path) -> Result<(), JournalError> {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if matches!(name, "artifacts" | "events") {
            if let Some(root) = path.parent() {
                return sync_dir_traced(path, root, name);
            }
        }
    }
    sync_dir_traced(path, path, ".")
}
fn publish_unsynced(path: &Path, bytes: &[u8]) -> Result<File, JournalError> {
    let parent = path.parent().ok_or(JournalError::Invalid)?;
    #[cfg(test)]
    let t_write = std::time::Instant::now();
    private_directory(parent)?;
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| JournalError::Io)?;
    f.write_all(bytes).map_err(|_| JournalError::Io)?;
    #[cfg(test)]
    STAGE_TIMINGS.with(|cell| {
        let mut s = cell.get();
        if parent.file_name().is_some_and(|n| n == "artifacts") {
            s.witness_copy_ns += t_write.elapsed().as_nanos();
        } else {
            s.journal_write_ns += t_write.elapsed().as_nanos();
        }
        cell.set(s);
    });
    Ok(f)
}
fn publish(path: &Path, bytes: &[u8]) -> Result<(), JournalError> {
    let parent = path.parent().ok_or(JournalError::Invalid)?;
    let f = publish_unsynced(path, bytes)?;
    let is_artifact = parent.file_name().is_some_and(|n| n == "artifacts");
    let root = if is_artifact {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };
    #[cfg(test)]
    if is_artifact && take_injected_witness_sync_failure(root) {
        return Err(JournalError::Io);
    }
    let rel = path
        .strip_prefix(root)
        .ok()
        .and_then(|p| p.to_str())
        .unwrap_or("");
    sync_file_traced(&f, root, rel)?;
    sync_dir(parent)
}
fn checkpoint_unsynced(root: &Path, c: &Checkpoint) -> Result<File, JournalError> {
    let tmp = root.join("checkpoint.next");
    #[cfg(test)]
    let t_prep = std::time::Instant::now();
    private_directory(root)?;
    match fs::symlink_metadata(&tmp) {
        Ok(meta) if meta.is_file() => fs::remove_file(&tmp).map_err(|_| JournalError::Io)?,
        Ok(_) => return Err(JournalError::Invalid),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(JournalError::Io),
    }
    let c_bytes = json(c)?;
    #[cfg(test)]
    if take_injected_append_torn_checkpoint_next(root) {
        let half = (c_bytes.len() / 2).max(1);
        let _ = publish_unsynced(&tmp, &c_bytes[..half]);
        return Err(JournalError::Io);
    }
    #[cfg(test)]
    STAGE_TIMINGS.with(|cell| {
        let mut s = cell.get();
        s.journal_write_ns += t_prep.elapsed().as_nanos();
        cell.set(s);
    });
    let f = publish_unsynced(&tmp, &c_bytes)?;
    Ok(f)
}
fn checkpoint(root: &Path, c: &Checkpoint) -> Result<(), JournalError> {
    let tmp = root.join("checkpoint.next");
    // Only called by a new journal or the exclusive, replay-verified writer.
    #[cfg(test)]
    let t_prep = std::time::Instant::now();
    private_directory(root)?;
    let c_bytes = json(c)?;
    let next_matches = match fs::symlink_metadata(&tmp) {
        Ok(meta) if meta.is_file() => {
            read_file(&tmp, MAX_LINE as u64).is_ok_and(|bytes| bytes == c_bytes)
        }
        Ok(_) => return Err(JournalError::Invalid),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err(JournalError::Io),
    };
    if next_matches {
        // Crash-safety rule (D2): never delete a proven checkpoint.next before its replacement is durable.
        sync_path_traced(&tmp, root, "checkpoint.next")?;
        sync_dir(root)?;
    } else {
        if fs::symlink_metadata(&tmp).is_ok() {
            fs::remove_file(&tmp).map_err(|_| JournalError::Io)?;
        }
        #[cfg(test)]
        STAGE_TIMINGS.with(|cell| {
            let mut s = cell.get();
            s.journal_write_ns += t_prep.elapsed().as_nanos();
            cell.set(s);
        });
        publish(&tmp, &c_bytes)?;
    }
    #[cfg(test)]
    if take_injected_checkpoint_before_rename(root) {
        return Err(JournalError::Io);
    }
    #[cfg(test)]
    let t_ren = std::time::Instant::now();
    fs::rename(tmp, root.join("checkpoint.json")).map_err(|_| JournalError::Io)?;
    #[cfg(test)]
    STAGE_TIMINGS.with(|cell| {
        let mut s = cell.get();
        s.journal_write_ns += t_ren.elapsed().as_nanos();
        cell.set(s);
    });
    sync_dir(root)
}
fn execute_sync_batch(batch: SyncBatch) -> Result<(), JournalError> {
    if batch.aborted.load(std::sync::atomic::Ordering::Acquire) {
        return Err(JournalError::Io);
    }
    #[cfg(test)]
    if take_injected_worker_batch_failure(&batch.root) {
        return Err(JournalError::Io);
    }
    for (f, rel) in batch.files {
        sync_file_traced(&f, &batch.root, &rel)?;
    }
    sync_dir(&batch.root.join("artifacts"))?;
    sync_dir(&batch.root.join("events"))?;
    sync_file_traced(&batch.journal_file, &batch.root, "journal.jsonl")?;
    if let Some(cp_file) = batch.checkpoint_file {
        sync_file_traced(&cp_file, &batch.root, "checkpoint.next")?;
        let staged = batch.checkpoint_lock.lock().map_err(|_| JournalError::Io)?;
        if batch.aborted.load(std::sync::atomic::Ordering::Acquire) {
            return Err(JournalError::Io);
        }
        if *staged == batch.checkpoint_count {
            match fs::rename(
                batch.root.join("checkpoint.next"),
                batch.root.join("checkpoint.json"),
            ) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    let bytes = read_file(&batch.root.join("checkpoint.json"), MAX_LINE as u64)?;
                    let cp: Checkpoint = parse(&bytes)?;
                    if cp.schema != "metaviewer.checkpoint/v1" || cp.count < batch.checkpoint_count
                    {
                        return Err(JournalError::Io);
                    }
                }
                Err(_) => return Err(JournalError::Io),
            }
        } else {
            let meta = fs::symlink_metadata(batch.root.join("checkpoint.json"))
                .map_err(|_| JournalError::Io)?;
            if !meta.is_file() {
                return Err(JournalError::Io);
            }
        }
    }
    sync_dir(&batch.root)
}
fn event_kind(input: &Input, out: &Outcome) -> SessionRecordKind {
    if out.reason.is_some() {
        return SessionRecordKind::Refused;
    }
    match input {
        Input::Propose(_) | Input::HumanInput { .. } => SessionRecordKind::Admitted,
        Input::Dispatch { .. } | Input::Receipt { .. } => SessionRecordKind::Executed,
        _ => SessionRecordKind::SurfaceChanged,
    }
}
// [TARGET, unit decision] Each event sidecar retains its referenced closed
// audit envelope plus the exact originating proposal bytes, when present.
fn audit_envelope(record: &SessionRecord, session: &str) -> crate::Envelope {
    crate::Envelope {
        schema: "envelope/v0.2".into(),
        msg_id: record.msg_id.clone(),
        ts_ns: crate::Clock::new(0),
        from: crate::Endpoint {
            component: crate::Component::Core,
            instance: "authority".into(),
        },
        to: crate::Endpoint {
            component: crate::Component::Core,
            instance: "journal".into(),
        },
        session_id: session.into(),
        seq: record.core_seq,
        nonce: record.msg_id.clone(),
        body: crate::Command::SessionRecord(Box::new(record.clone())),
    }
}
fn archive_next(prev: &str, bytes: &[u8]) -> String {
    let mut preimage = prev.as_bytes().to_vec();
    preimage.extend_from_slice(bytes);
    sha256_hex(&preimage)
}
fn required_witness<'a>(input: &'a Input, outcome: &Outcome) -> Option<&'a str> {
    match input {
        Input::Surface { surface, .. } => surface.frame.as_ref().map(|f| f.sha256.as_str()),
        Input::Frame { frame, .. } => Some(&frame.sha256),
        Input::Propose(r) if outcome.reason.is_none() => {
            r.proposal().ok().map(|p| p.based_on_frame.sha256.as_str())
        }
        _ => None,
    }
}
fn verify_witness(root: &Path, w: &Witness) -> Result<(), JournalError> {
    if !hex(&w.sha256) || w.byte_len == 0 || w.byte_len > MAX_BYTES {
        return Err(JournalError::Witness);
    }
    #[cfg(test)]
    let t_read = std::time::Instant::now();
    let bytes = read_file(&root.join("artifacts").join(&w.sha256), MAX_BYTES)
        .map_err(|_| JournalError::Witness)?;
    #[cfg(test)]
    STAGE_TIMINGS.with(|cell| {
        let mut s = cell.get();
        s.witness_verify_read_ns += t_read.elapsed().as_nanos();
        cell.set(s);
    });
    if bytes.len() as u64 != w.byte_len || sha256_hex(&bytes) != w.sha256 {
        return Err(JournalError::Witness);
    }
    Ok(())
}
impl Journal {
    pub fn create(state_dir: &Path, state: &CoreState) -> Result<Self, JournalError> {
        if !safe_component(&state.session_id) || state.core_seq != 0 {
            return Err(JournalError::Invalid);
        }
        let mut created_state_parents = Vec::new();
        if !state_dir.exists() {
            let mut created = state_dir;
            while !created.exists() {
                let parent = created.parent().ok_or(JournalError::Invalid)?;
                created_state_parents.push(parent.to_path_buf());
                created = parent;
            }
            let ancestor = state_dir
                .ancestors()
                .find(|p| p.exists())
                .ok_or(JournalError::Invalid)?;
            confined(ancestor)?;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(state_dir)
                .map_err(|_| JournalError::Io)?;
        }
        private_directory(state_dir)?;
        let sessions = state_dir.join("sessions");
        if !sessions.exists() {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&sessions)
                .map_err(|_| JournalError::Io)?;
        }
        private_directory(&sessions)?;
        let root = sessions.join(&state.session_id);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .map_err(|_| JournalError::Io)?;
        for name in ["events", "artifacts"] {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(root.join(name))
                .map_err(|_| JournalError::Io)?;
        }
        private_archive(&root)?;
        let header = json(&Header {
            schema: "metaviewer.journal/v1".into(),
            session_id: state.session_id.clone(),
            core_version: env!("CARGO_PKG_VERSION").into(),
        })?;
        let genesis = json(&Genesis {
            schema: "metaviewer.archive/v1".into(),
            header_sha256: sha256_hex(&header),
            state: state.clone(),
        })?;
        publish(&root.join("genesis.json"), &genesis)?;
        let file = OpenOptions::new()
            .read(true)
            .append(true)
            .create_new(true)
            .mode(0o600)
            .open(root.join("journal.jsonl"))
            .map_err(|_| JournalError::Io)?;
        let mut file = WriterFile::lock(file)?;
        file.write_all(&header)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|_| JournalError::Io)?;
        let now = std::time::Instant::now();
        let journal = Self {
            root,
            file: std::sync::Arc::new(file),
            count: 0,
            bytes: header.len() as u64 + 1,
            tail: ZERO.into(),
            archive: ZERO.into(),
            genesis: sha256_hex(&genesis),
            archive_bytes: genesis.len() as u64,
            poisoned: false,
            state: state.clone(),
            verified_witnesses: std::collections::BTreeMap::new(),
            verified_witness_order: std::collections::VecDeque::new(),
            last_surface_witnesses: std::collections::BTreeMap::new(),
            surface_witness_order: std::collections::VecDeque::new(),
            surface_witness_total_bytes: 0,
            retained_witness_bytes: std::collections::BTreeMap::new(),
            retained_witness_order: std::collections::VecDeque::new(),
            retained_witness_total_bytes: 0,
            committed_witnesses: BTreeSet::new(),
            unsynced_witnesses: BTreeSet::new(),
            uncommitted_artifacts: std::collections::VecDeque::new(),
            dirty_files: Vec::new(),
            staged_dirty_len: 0,
            staged_checkpoint_count: 0,
            pending_checkpoint: None,
            checkpoint_lock: std::sync::Arc::new(std::sync::Mutex::new(0)),
            unsynced_frames: 0,
            first_unsynced_at: None,
            last_sync: now,
            last_dispatch: now,
            completed_sync_count: 0,
            completed_sync_batches: 0,
            sync_failed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            sync_worker: None,
        };
        remove_committed_surface_witnesses(&journal.root);
        checkpoint(&journal.root, &journal.closure())?;
        // Persist the directory entries all the way through the first existing
        // ancestor, including sessions in state_dir on first-ever creation.
        sync_dir_traced(&sessions, &journal.root, "..")?;
        sync_dir_traced(state_dir, &journal.root, "../..")?;
        for parent in created_state_parents {
            sync_dir_traced(&parent, &journal.root, "state-parent")?;
        }
        Ok(journal)
    }
    fn closure(&self) -> Checkpoint {
        Checkpoint {
            schema: "metaviewer.checkpoint/v1".into(),
            count: self.count,
            tail: self.tail.clone(),
            archive: self.archive.clone(),
            genesis: self.genesis.clone(),
        }
    }
    pub fn recover(path: &Path, root: &Path) -> Result<(Self, CoreState), JournalError> {
        confined(path)?;
        let file = OpenOptions::new()
            .read(true)
            .append(true)
            .open(path)
            .map_err(|_| JournalError::Io)?;
        let file = WriterFile::lock(file)?;
        let pending = root.join("checkpoint.next");
        match fs::symlink_metadata(&pending) {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return Err(JournalError::Invalid),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(JournalError::Io),
        }
        let (replay, rolled_back) = match scan(path, root) {
            Ok(r) => (r, false),
            Err(scan_err) => {
                try_rollback_uncommitted_tail(&file, path, root, scan_err)?;
                (scan(path, root)?, true)
            }
        };
        let c = replay.checkpoint.clone();
        let bytes = file.metadata().map_err(|_| JournalError::Io)?.len();
        if !rolled_back {
            cleanup_uncommitted_artifacts(root, &replay.committed_witnesses, false)?;
        }
        // Keep a matching published checkpoint byte/inode-stable on clean steady-state
        // archives; only force dependencies and promote when repairing or promoting checkpoint.next.
        let current_matches = read_file(&root.join("checkpoint.json"), MAX_LINE as u64)
            .is_ok_and(|b| json(&c).is_ok_and(|expected| b == expected));
        if current_matches && !rolled_back {
            match fs::remove_file(&pending) {
                Ok(()) => {
                    sync_file_traced(&file, root, "journal.jsonl")?;
                    sync_dir_traced(root, root, ".")?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(JournalError::Io),
            }
        } else if !current_matches {
            force_recovered_dependencies(root, &file, c.count, &replay.committed_witnesses)?;
            checkpoint(root, &c)?;
        }
        let now = std::time::Instant::now();
        // Restart / recovery evicts any prior in-memory surface witness cache for this
        // root and never inserts disk artifact bytes into `last_surface_witnesses` or
        // `verified_witnesses` without computing SHA-256 over them on a live frame.
        remove_committed_surface_witnesses(root);
        let journal = Self {
            root: root.into(),
            file: std::sync::Arc::new(file),
            count: c.count,
            bytes,
            tail: c.tail,
            archive: c.archive,
            genesis: c.genesis,
            archive_bytes: replay.archive_bytes,
            poisoned: false,
            state: replay.state.clone(),
            verified_witnesses: std::collections::BTreeMap::new(),
            verified_witness_order: std::collections::VecDeque::new(),
            last_surface_witnesses: std::collections::BTreeMap::new(),
            surface_witness_order: std::collections::VecDeque::new(),
            surface_witness_total_bytes: 0,
            retained_witness_bytes: std::collections::BTreeMap::new(),
            retained_witness_order: std::collections::VecDeque::new(),
            retained_witness_total_bytes: 0,
            committed_witnesses: replay.committed_witnesses,
            unsynced_witnesses: BTreeSet::new(),
            uncommitted_artifacts: std::collections::VecDeque::new(),
            dirty_files: Vec::new(),
            staged_dirty_len: 0,
            staged_checkpoint_count: 0,
            pending_checkpoint: None,
            checkpoint_lock: std::sync::Arc::new(std::sync::Mutex::new(c.count)),
            unsynced_frames: 0,
            first_unsynced_at: None,
            last_sync: now,
            last_dispatch: now,
            completed_sync_count: c.count,
            completed_sync_batches: 0,
            sync_failed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            sync_worker: None,
        };
        Ok((journal, replay.state))
    }
    fn record_verified_artifact(
        &mut self,
        sha256: &str,
        path: &Path,
        byte_len: u64,
    ) -> Result<(), JournalError> {
        let meta = fs::symlink_metadata(path).map_err(|_| JournalError::Io)?;
        if !meta.is_file() || meta.len() != byte_len {
            return Err(JournalError::Witness);
        }
        self.verified_witness_order.retain(|k| k != sha256);
        while !self.verified_witnesses.contains_key(sha256)
            && self.verified_witnesses.len() >= MAX_VERIFIED_WITNESS_CACHE
        {
            let Some(oldest) = self.verified_witness_order.pop_front() else {
                break;
            };
            self.verified_witnesses.remove(&oldest);
        }
        self.verified_witness_order.push_back(sha256.to_owned());
        self.verified_witnesses.insert(
            sha256.to_owned(),
            VerifiedArtifact {
                byte_len,
                dev: meta.dev(),
                ino: meta.ino(),
                uid: meta.uid(),
                mode: meta.mode() & 0o7777,
                mtime_nsec: meta.mtime_nsec(),
                ctime_nsec: meta.ctime_nsec(),
            },
        );
        Ok(())
    }
    fn is_verified_artifact(&self, path: &Path, w: &Witness) -> bool {
        if !hex(&w.sha256) || w.byte_len == 0 || w.byte_len > MAX_BYTES {
            return false;
        }
        let Some(&recorded) = self.verified_witnesses.get(&w.sha256) else {
            return false;
        };
        if recorded.byte_len != w.byte_len {
            return false;
        }
        let Ok(uid) = current_uid() else {
            return false;
        };
        let Ok(meta) = fs::symlink_metadata(path) else {
            return false;
        };
        meta.is_file()
            && meta.len() == w.byte_len
            && meta.dev() == recorded.dev
            && meta.ino() == recorded.ino
            && meta.uid() == recorded.uid
            && meta.uid() == uid
            && (meta.mode() & 0o7777) == recorded.mode
            && (meta.mode() & 0o077) == 0
            && meta.mtime_nsec() == recorded.mtime_nsec
            && meta.ctime_nsec() == recorded.ctime_nsec
    }
    fn cache_retained_witness_bytes(&mut self, sha256: &str, bytes: &[u8], uid: u32, mode: u32) {
        if bytes.is_empty() || bytes.len() > MAX_RETAINED_WITNESS_BYTES || (mode & 0o077) != 0 {
            return;
        }
        if let Some((prev, _, _)) = self.retained_witness_bytes.remove(sha256) {
            self.retained_witness_total_bytes =
                self.retained_witness_total_bytes.saturating_sub(prev.len());
            self.retained_witness_order.retain(|k| k != sha256);
        }
        while (self.retained_witness_bytes.len() >= MAX_UNCOMMITTED_ARTIFACTS
            || self
                .retained_witness_total_bytes
                .saturating_add(bytes.len())
                > MAX_RETAINED_WITNESS_BYTES)
            && !self.retained_witness_order.is_empty()
        {
            let Some(oldest) = self.retained_witness_order.pop_front() else {
                break;
            };
            if let Some((evicted, _, _)) = self.retained_witness_bytes.remove(&oldest) {
                self.retained_witness_total_bytes = self
                    .retained_witness_total_bytes
                    .saturating_sub(evicted.len());
            }
        }
        let shared = self
            .last_surface_witnesses
            .values()
            .find(|e| e.sha256 == sha256 && e.bytes.len() == bytes.len())
            .map(|e| e.bytes.clone())
            .unwrap_or_else(|| std::sync::Arc::<[u8]>::from(bytes));
        self.retained_witness_total_bytes = self
            .retained_witness_total_bytes
            .saturating_add(shared.len());
        self.retained_witness_order.push_back(sha256.to_owned());
        self.retained_witness_bytes
            .insert(sha256.to_owned(), (shared, uid, mode & 0o7777));
    }
    fn evict_retained_witness_bytes(&mut self, sha256: &str) {
        self.retained_witness_order.retain(|k| k != sha256);
        if let Some((evicted, _, _)) = self.retained_witness_bytes.remove(sha256) {
            self.retained_witness_total_bytes = self
                .retained_witness_total_bytes
                .saturating_sub(evicted.len());
        }
    }
    fn clear_surface_witness_cache(&mut self) {
        self.last_surface_witnesses.clear();
        self.surface_witness_order.clear();
        self.surface_witness_total_bytes = 0;
        remove_committed_surface_witnesses(&self.root);
    }
    fn evict_surface_witness_entry(&mut self, surface_id: &str) {
        self.surface_witness_order.retain(|k| k != surface_id);
        if let Some(evicted) = self.last_surface_witnesses.remove(surface_id) {
            self.surface_witness_total_bytes = self
                .surface_witness_total_bytes
                .saturating_sub(evicted.bytes.len());
        }
    }
    fn update_committed_surface_witnesses_after_append(
        &mut self,
        input: &Input,
        outcome: &Outcome,
    ) {
        if self.poisoned || self.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            self.clear_surface_witness_cache();
            return;
        }
        let Ok(uid) = current_uid() else {
            self.clear_surface_witness_cache();
            return;
        };
        if matches!(input, Input::Connect) && outcome.reason.is_none() {
            self.clear_surface_witness_cache();
            return;
        }
        match input {
            Input::Lifecycle { surface_id, .. }
            | Input::Surface { id: surface_id, .. }
            | Input::TakeControl { surface_id }
            | Input::ReleaseControl { surface_id } => {
                self.evict_surface_witness_entry(surface_id);
            }
            _ => {}
        }
        let current_epoch = self.state.epoch;
        let stale_surfaces: Vec<String> = self
            .last_surface_witnesses
            .iter()
            .filter_map(|(sid, entry)| {
                let Some(surface) = self.state.surfaces.get(sid) else {
                    return Some(sid.clone());
                };
                if !surface.live
                    || self.state.is_destroyed(sid)
                    || surface.refresh_after.is_some()
                    || entry.epoch != current_epoch
                    || entry.uid != uid
                    || (entry.mode & 0o077) != 0
                    || entry.byte_len != entry.bytes.len()
                    || entry.byte_len == 0
                {
                    return Some(sid.clone());
                }
                let Some(ref committed_frame) = surface.frame else {
                    return Some(sid.clone());
                };
                if committed_frame.sha256 != entry.sha256
                    || committed_frame.generation != entry.generation
                    || committed_frame.width != entry.width
                    || committed_frame.height != entry.height
                {
                    if matches!(
                        input,
                        Input::Frame {
                            surface_id,
                            ..
                        } if surface_id == sid && outcome.reason.is_none()
                    ) {
                        return None;
                    }
                    return Some(sid.clone());
                }
                None
            })
            .collect();
        for sid in stale_surfaces {
            self.evict_surface_witness_entry(&sid);
        }
        if outcome.reason.is_none() {
            if let Input::Frame { surface_id, frame } = input {
                if frame.generation > 0 && frame.width > 0 && frame.height > 0 && hex(&frame.sha256)
                {
                    let verified_in_memory = if let Some((bytes, r_uid, r_mode)) =
                        self.retained_witness_bytes.get(&frame.sha256)
                    {
                        if *r_uid == uid
                            && (*r_mode & 0o077) == 0
                            && !bytes.is_empty()
                            && bytes.len() <= MAX_SURFACE_WITNESS_BYTES
                        {
                            Some((bytes.clone(), *r_uid, *r_mode, true))
                        } else {
                            None
                        }
                    } else if let Some(existing) = self.last_surface_witnesses.get(surface_id) {
                        if existing.sha256 == frame.sha256
                            && existing.epoch == current_epoch
                            && existing.uid == uid
                            && (existing.mode & 0o077) == 0
                            && existing.byte_len == existing.bytes.len()
                            && existing.byte_len > 0
                            && existing.byte_len <= MAX_SURFACE_WITNESS_BYTES
                        {
                            Some((existing.bytes.clone(), existing.uid, existing.mode, false))
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    self.evict_surface_witness_entry(surface_id);
                    if let Some((arc_bytes, entry_uid, entry_mode, from_retained)) =
                        verified_in_memory
                    {
                        if from_retained {
                            self.evict_retained_witness_bytes(&frame.sha256);
                        }
                        while (self.last_surface_witnesses.len() >= MAX_SURFACE_WITNESSES_PER_ROOT
                            || self
                                .surface_witness_total_bytes
                                .saturating_add(arc_bytes.len())
                                > MAX_SURFACE_WITNESS_BYTES)
                            && !self.surface_witness_order.is_empty()
                        {
                            let Some(oldest) = self.surface_witness_order.pop_front() else {
                                break;
                            };
                            self.evict_surface_witness_entry(&oldest);
                        }
                        if self.last_surface_witnesses.len() < MAX_SURFACE_WITNESSES_PER_ROOT
                            && self
                                .surface_witness_total_bytes
                                .saturating_add(arc_bytes.len())
                                <= MAX_SURFACE_WITNESS_BYTES
                        {
                            let byte_len = arc_bytes.len();
                            self.surface_witness_total_bytes =
                                self.surface_witness_total_bytes.saturating_add(byte_len);
                            self.surface_witness_order.push_back(surface_id.clone());
                            self.last_surface_witnesses.insert(
                                surface_id.clone(),
                                SurfaceWitnessEntry {
                                    sha256: frame.sha256.clone(),
                                    epoch: current_epoch,
                                    generation: frame.generation,
                                    width: frame.width,
                                    height: frame.height,
                                    byte_len,
                                    uid: entry_uid,
                                    mode: entry_mode,
                                    bytes: arc_bytes,
                                },
                            );
                        }
                    }
                } else {
                    self.evict_surface_witness_entry(surface_id);
                }
            }
        }
        publish_committed_surface_witnesses(&self.root, &self.last_surface_witnesses);
    }
    /// Returns true if `surface_id` currently holds a committed witness for `sha256`.
    pub fn has_committed_surface_witness(&self, surface_id: &str, sha256: &str) -> bool {
        if self.poisoned || self.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            return false;
        }
        self.last_surface_witnesses
            .get(surface_id)
            .is_some_and(|e| e.sha256 == sha256 && e.epoch == self.state.epoch)
    }
    /// Returns the total byte footprint of in-memory committed surface witnesses for this journal.
    pub fn committed_surface_witness_bytes(&self) -> usize {
        if self.poisoned || self.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            return 0;
        }
        self.surface_witness_total_bytes
    }
    /// Returns the number of surfaces currently holding an in-memory committed witness for this journal.
    pub fn committed_surface_witness_count(&self) -> usize {
        if self.poisoned || self.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            return 0;
        }
        self.last_surface_witnesses.len()
    }
    /// Verifies an anchored frame file against the surface's last committed
    /// witness when the advertised digest and committed geometry match, comparing
    /// full payload bytes (`memcmp`) and falling back to full streaming SHA-256
    /// verification on any length, geometry, generation, epoch, mode, ownership,
    /// or byte difference.
    pub fn verify_surface_frame(
        &self,
        surface_id: &str,
        generation: u64,
        file: &File,
        expected_len: usize,
        expected_sha256: &str,
    ) -> Result<VerifiedPixels, JournalError> {
        let (width, height) = self
            .state
            .surfaces
            .get(surface_id)
            .and_then(|s| s.frame.as_ref())
            .map(|f| (f.width, f.height))
            .unwrap_or((0, 0));
        self.verify_surface_frame_with_geometry(
            surface_id,
            generation,
            width,
            height,
            file,
            expected_len,
            expected_sha256,
        )
    }
    /// Verifies an anchored frame file against the surface's last committed
    /// witness with explicit `(width, height)` geometry check.
    #[allow(clippy::too_many_arguments)]
    pub fn verify_surface_frame_with_geometry(
        &self,
        surface_id: &str,
        generation: u64,
        width: u64,
        height: u64,
        file: &File,
        expected_len: usize,
        expected_sha256: &str,
    ) -> Result<VerifiedPixels, JournalError> {
        if self.poisoned || self.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(JournalError::Poisoned);
        }
        if expected_len == 0 || (expected_len as u64) > MAX_BYTES || !hex(expected_sha256) {
            return Err(JournalError::Witness);
        }
        let meta = file.metadata().map_err(|_| JournalError::Io)?;
        if !meta.is_file() || meta.len() != expected_len as u64 {
            return Err(JournalError::Witness);
        }
        let uid = current_uid()?;
        let file_uid = meta.uid();
        let file_mode = meta.mode() & 0o7777;
        let candidate = self
            .state
            .surfaces
            .get(surface_id)
            .zip(self.last_surface_witnesses.get(surface_id))
            .and_then(|(surface, entry)| {
                let prev_frame = surface.frame.as_ref()?;
                if surface.live
                    && !self.state.is_destroyed(surface_id)
                    && surface.refresh_after.is_none()
                    && entry.epoch == self.state.epoch
                    && prev_frame.sha256 == expected_sha256
                    && entry.sha256 == expected_sha256
                    && generation > prev_frame.generation
                    && entry.generation == prev_frame.generation
                    && entry.generation > 0
                    && width > 0
                    && height > 0
                    && prev_frame.width == width
                    && prev_frame.height == height
                    && entry.width == width
                    && entry.height == height
                    && entry.byte_len == expected_len
                    && entry.bytes.len() == expected_len
                    && file_uid == uid
                    && entry.uid == file_uid
                    && (file_mode & 0o077) == 0
                    && (entry.mode & 0o077) == 0
                {
                    Some(entry.bytes.clone())
                } else {
                    None
                }
            });
        let mut reader = file.try_clone().map_err(|_| JournalError::Io)?;
        use std::io::{Seek, SeekFrom};
        reader
            .seek(SeekFrom::Start(0))
            .map_err(|_| JournalError::Io)?;
        let started = std::time::Instant::now();
        if let Some(cached_bytes) = candidate {
            let mut bytes = vec![0u8; expected_len];
            let mut pos = 0usize;
            while pos < expected_len {
                let end = (pos + 65536).min(expected_len);
                let n = reader
                    .read(&mut bytes[pos..end])
                    .map_err(|_| JournalError::Io)?;
                if n == 0 {
                    break;
                }
                pos += n;
            }
            let mut extra = [0u8; 1];
            let trailing = reader.read(&mut extra).map_err(|_| JournalError::Io)?;
            if pos != expected_len || trailing != 0 {
                return Err(JournalError::Witness);
            }
            let cmp_started = std::time::Instant::now();
            let unchanged = bytes.as_slice() == cached_bytes.as_ref();
            let cmp_ns = cmp_started.elapsed().as_nanos();
            if unchanged {
                #[cfg(test)]
                STAGE_TIMINGS.with(|cell| {
                    let mut s = cell.get();
                    s.skipped_hash_ns += cmp_ns;
                    s.skipped_hash_frames += 1;
                    cell.set(s);
                });
                let mut verified = VerifiedPixels::new(bytes, expected_sha256.to_owned());
                verified.read_started = Some(started);
                verified.hash_ns = 0;
                verified.skipped_hash_ns = cmp_ns;
                verified.hash_skipped = true;
                verified.shm_read_ns = started.elapsed().as_nanos().saturating_sub(cmp_ns);
                return Ok(verified);
            }
            let hash_started = std::time::Instant::now();
            let mut hasher = StreamingSha256::new();
            for chunk in bytes.chunks(65536) {
                hasher.update(chunk);
            }
            let digest = hasher.finalize_hex();
            let hash_ns = hash_started.elapsed().as_nanos();
            if digest != expected_sha256 {
                return Err(JournalError::Witness);
            }
            let mut verified = VerifiedPixels::new(bytes, digest);
            verified.read_started = Some(started);
            verified.hash_ns = hash_ns;
            verified.shm_read_ns = started.elapsed().as_nanos().saturating_sub(hash_ns);
            return Ok(verified);
        }
        let mut hash_ns = 0u128;
        let mut bytes = vec![0u8; expected_len];
        let mut hasher = StreamingSha256::new();
        let mut pos = 0usize;
        while pos < expected_len {
            let end = (pos + 65536).min(expected_len);
            let n = reader
                .read(&mut bytes[pos..end])
                .map_err(|_| JournalError::Io)?;
            if n == 0 {
                break;
            }
            let hash_started = std::time::Instant::now();
            hasher.update(&bytes[pos..pos + n]);
            hash_ns += hash_started.elapsed().as_nanos();
            pos += n;
        }
        let mut extra = [0u8; 1];
        let trailing = reader.read(&mut extra).map_err(|_| JournalError::Io)?;
        let hash_started = std::time::Instant::now();
        let digest = hasher.finalize_hex();
        hash_ns += hash_started.elapsed().as_nanos();
        if pos != expected_len || trailing != 0 || digest != expected_sha256 {
            return Err(JournalError::Witness);
        }
        if file_uid != uid || (file_mode & 0o077) != 0 {
            return Err(JournalError::Invalid);
        }
        let mut verified = VerifiedPixels::new(bytes, digest);
        verified.read_started = Some(started);
        verified.hash_ns = hash_ns;
        verified.shm_read_ns = started.elapsed().as_nanos().saturating_sub(hash_ns);
        Ok(verified)
    }
    pub fn completed_sync_count(&self) -> u64 {
        if let Some(ref worker) = self.sync_worker {
            let st = worker
                .shared
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            self.completed_sync_count.max(st.completed_checkpoint_count)
        } else {
            self.completed_sync_count
        }
    }
    pub fn completed_sync_batches(&self) -> u64 {
        if let Some(ref worker) = self.sync_worker {
            let st = worker
                .shared
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            self.completed_sync_batches + st.completed_batches
        } else {
            self.completed_sync_batches
        }
    }
    fn reconcile_worker_progress(&mut self) {
        let Some(ref worker) = self.sync_worker else {
            return;
        };
        let st = worker
            .shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if st.completed_checkpoint_count > self.completed_sync_count {
            self.completed_sync_count = st.completed_checkpoint_count;
        }
        if st.last_completed_sync > self.last_sync {
            self.last_sync = st.last_completed_sync;
            self.last_dispatch = self.last_dispatch.max(st.last_completed_sync);
        }
        if self.unsynced_frames > 0
            && st.staged.is_none()
            && !st.in_flight
            && self.staged_checkpoint_count > 0
            && st.completed_checkpoint_count >= self.staged_checkpoint_count
        {
            let drain_n = self.staged_dirty_len.min(self.dirty_files.len());
            self.dirty_files.drain(..drain_n);
            self.staged_dirty_len = 0;
            self.staged_checkpoint_count = 0;
            self.unsynced_witnesses.clear();
            self.pending_checkpoint = None;
            self.unsynced_frames = 0;
            self.first_unsynced_at = None;
        }
    }
    fn ensure_sync_worker(&mut self) -> Result<std::sync::Arc<WorkerShared>, JournalError> {
        if self.sync_worker.is_none() {
            let sync_failed = self.sync_failed.clone();
            let writer_lock = self.file.clone();
            let shared = std::sync::Arc::new(WorkerShared {
                state: std::sync::Mutex::new(WorkerState {
                    queue: std::collections::VecDeque::with_capacity(MAX_PENDING_SYNC_BATCHES),
                    staged: None,
                    in_flight: false,
                    closed: false,
                    finished: false,
                    sticky_err: None,
                    completed_checkpoint_count: self.completed_sync_count,
                    completed_batches: 0,
                    last_completed_sync: self.last_sync,
                }),
                cv: std::sync::Condvar::new(),
                aborted: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });
            let worker_shared = shared.clone();
            let handle = std::thread::Builder::new()
                .name("mv-journal-sync".into())
                .spawn(move || {
                    let _writer_guard = writer_lock;
                    loop {
                        let next_cmd = {
                            let mut st = worker_shared
                                .state
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            loop {
                                if worker_shared
                                    .aborted
                                    .load(std::sync::atomic::Ordering::Acquire)
                                {
                                    st.queue.clear();
                                    st.staged = None;
                                    if st.sticky_err.is_none() {
                                        st.sticky_err = Some(JournalError::Io);
                                    }
                                }
                                if let Some(cmd) = st.queue.pop_front() {
                                    st.in_flight = true;
                                    worker_shared.cv.notify_all();
                                    break Some(cmd);
                                }
                                if let Some(ref staged) = st.staged {
                                    #[cfg(test)]
                                    let held = is_test_sync_held(&staged.batch.root);
                                    #[cfg(not(test))]
                                    let held = false;
                                    if !held {
                                        let now = std::time::Instant::now();
                                        if now >= staged.deadline || st.closed {
                                            let sb = st.staged.take().unwrap();
                                            st.in_flight = true;
                                            worker_shared.cv.notify_all();
                                            break Some(SyncCmd::Flush(sb.batch));
                                        }
                                        let wait_dur =
                                            staged.deadline.saturating_duration_since(now);
                                        let (new_st, _) = worker_shared
                                            .cv
                                            .wait_timeout(st, wait_dur)
                                            .unwrap_or_else(|e| e.into_inner());
                                        st = new_st;
                                        continue;
                                    }
                                }
                                if st.closed {
                                    st.finished = true;
                                    worker_shared.cv.notify_all();
                                    break None;
                                }
                                st = worker_shared.cv.wait(st).unwrap_or_else(|e| e.into_inner());
                            }
                        };
                        let Some(cmd) = next_cmd else {
                            break;
                        };
                        match cmd {
                            SyncCmd::Flush(batch) => {
                                #[cfg(test)]
                                wait_while_test_sync_held(&batch.root);
                                #[cfg(test)]
                                wait_while_hook_blocked(&batch.root);
                                let already_err = {
                                    let st = worker_shared
                                        .state
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner());
                                    st.sticky_err.is_some()
                                        || worker_shared
                                            .aborted
                                            .load(std::sync::atomic::Ordering::Acquire)
                                };
                                if !already_err {
                                    let cp_count = batch.checkpoint_count;
                                    let err_root = batch.root.clone();
                                    match execute_sync_batch(batch) {
                                        Ok(()) => {
                                            let mut st = worker_shared
                                                .state
                                                .lock()
                                                .unwrap_or_else(|e| e.into_inner());
                                            st.completed_checkpoint_count =
                                                st.completed_checkpoint_count.max(cp_count);
                                            st.completed_batches += 1;
                                            st.last_completed_sync = std::time::Instant::now();
                                            st.in_flight = false;
                                            worker_shared.cv.notify_all();
                                        }
                                        Err(e) => {
                                            sync_failed
                                                .store(true, std::sync::atomic::Ordering::Release);
                                            remove_committed_surface_witnesses(&err_root);
                                            let mut st = worker_shared
                                                .state
                                                .lock()
                                                .unwrap_or_else(|e| e.into_inner());
                                            if st.sticky_err.is_none() {
                                                st.sticky_err = Some(e);
                                            }
                                            st.in_flight = false;
                                            worker_shared.cv.notify_all();
                                        }
                                    }
                                } else {
                                    let mut st = worker_shared
                                        .state
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner());
                                    if st.sticky_err.is_none() {
                                        st.sticky_err = Some(JournalError::Io);
                                    }
                                    st.in_flight = false;
                                    worker_shared.cv.notify_all();
                                }
                            }
                            SyncCmd::Barrier(reply) => {
                                let mut st = worker_shared
                                    .state
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner());
                                let res = st.sticky_err.clone().map_or(Ok(()), Err);
                                st.in_flight = false;
                                worker_shared.cv.notify_all();
                                let _ = reply.send(res);
                            }
                        }
                    }
                })
                .map_err(|_| JournalError::Io)?;
            self.sync_worker = Some(SyncWorker {
                shared,
                handle: Some(handle),
            });
        }
        self.sync_worker
            .as_ref()
            .map(|w| w.shared.clone())
            .ok_or(JournalError::Io)
    }
    fn join_sync_worker(&mut self) -> Result<(), JournalError> {
        self.join_sync_worker_inner(false, false)
    }
    fn join_sync_worker_inner(
        &mut self,
        abort_pending: bool,
        from_drop: bool,
    ) -> Result<(), JournalError> {
        let Some(mut worker) = self.sync_worker.take() else {
            return Ok(());
        };
        let timeout = join_timeout_for(&self.root);
        let deadline = std::time::Instant::now() + timeout;
        {
            let mut st = worker
                .shared
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if abort_pending {
                worker
                    .shared
                    .aborted
                    .store(true, std::sync::atomic::Ordering::Release);
                st.queue.clear();
                st.staged = None;
            }
            st.closed = true;
            worker.shared.cv.notify_all();
            while !st.finished {
                let now = std::time::Instant::now();
                if now >= deadline {
                    worker
                        .shared
                        .aborted
                        .store(true, std::sync::atomic::Ordering::Release);
                    st.queue.clear();
                    st.staged = None;
                    worker.shared.cv.notify_all();
                    self.poisoned = true;
                    eprintln!("journal sync worker join timed out after {:?}", timeout);
                    if !from_drop {
                        // Never detach a running worker thread: keep ownership for Drop/later join.
                        drop(st);
                        self.sync_worker = Some(worker);
                        return Err(JournalError::Io);
                    }
                    break;
                }
                let rem = deadline.saturating_duration_since(now);
                let (new_st, _) = worker
                    .shared
                    .cv
                    .wait_timeout(st, rem)
                    .unwrap_or_else(|e| e.into_inner());
                st = new_st;
            }
        }
        #[cfg(test)]
        if from_drop {
            release_test_sync_hold(&self.root);
            release_blocked_worker(&self.root);
        }
        if let Some(handle) = worker.handle.take() {
            if handle.join().is_err() {
                self.poisoned = true;
                eprintln!("journal sync worker thread panicked");
                return Err(JournalError::Io);
            }
        }
        let st = worker
            .shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if st.completed_checkpoint_count > self.completed_sync_count {
            self.completed_sync_count = st.completed_checkpoint_count;
        }
        self.completed_sync_batches += st.completed_batches;
        if st.last_completed_sync > self.last_sync {
            self.last_sync = st.last_completed_sync;
            self.last_dispatch = self.last_dispatch.max(st.last_completed_sync);
        }
        let worker_res = st.sticky_err.clone().map_or(Ok(()), Err);
        if let Err(ref err) = worker_res {
            self.poisoned = true;
            eprintln!("journal background sync failed: {err}");
        }
        worker_res
    }
    fn stage_frame_sync_batch(&mut self) -> Result<(), JournalError> {
        let shared = self.ensure_sync_worker()?;
        let mut cloned_files = Vec::with_capacity(self.dirty_files.len());
        for (f, rel) in &self.dirty_files {
            cloned_files.push((f.try_clone().map_err(|_| JournalError::Io)?, rel.clone()));
        }
        let cp_clone = match &self.pending_checkpoint {
            Some(cp) => Some(cp.try_clone().map_err(|_| JournalError::Io)?),
            None => None,
        };
        let batch = SyncBatch {
            files: cloned_files,
            journal_file: self.file.try_clone().map_err(|_| JournalError::Io)?,
            checkpoint_file: cp_clone,
            checkpoint_count: self.count,
            checkpoint_lock: self.checkpoint_lock.clone(),
            aborted: shared.aborted.clone(),
            root: self.root.clone(),
        };
        let first_at = *self
            .first_unsynced_at
            .get_or_insert_with(std::time::Instant::now);
        let deadline = first_at + FRAME_SYNC_WINDOW;
        self.staged_dirty_len = self.dirty_files.len();
        self.staged_checkpoint_count = self.count;
        let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if st.closed || shared.aborted.load(std::sync::atomic::Ordering::Acquire) {
            return Err(JournalError::Io);
        }
        st.staged = Some(StagedBatch { batch, deadline });
        shared.cv.notify_all();
        Ok(())
    }
    fn dispatch_frame_sync_batch(&mut self) -> Result<(), JournalError> {
        self.reconcile_worker_progress();
        if self.dirty_files.is_empty()
            && self.pending_checkpoint.is_none()
            && self.unsynced_frames == 0
        {
            return Ok(());
        }
        let shared = self.ensure_sync_worker()?;
        let was_fully_staged = self.staged_checkpoint_count == self.count
            && self.staged_dirty_len == self.dirty_files.len();
        let batch = SyncBatch {
            files: std::mem::take(&mut self.dirty_files),
            journal_file: self.file.try_clone().map_err(|_| JournalError::Io)?,
            checkpoint_file: self.pending_checkpoint.take(),
            checkpoint_count: self.count,
            checkpoint_lock: self.checkpoint_lock.clone(),
            aborted: shared.aborted.clone(),
            root: self.root.clone(),
        };
        self.staged_dirty_len = 0;
        self.staged_checkpoint_count = 0;
        self.unsynced_witnesses.clear();
        self.unsynced_frames = 0;
        self.first_unsynced_at = None;
        self.last_dispatch = std::time::Instant::now();
        let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if st.closed || shared.aborted.load(std::sync::atomic::Ordering::Acquire) {
            return Err(JournalError::Io);
        }
        if was_fully_staged
            && st.staged.is_none()
            && (st.in_flight || st.completed_checkpoint_count >= self.count)
        {
            shared.cv.notify_all();
            return Ok(());
        }
        st.staged = None;
        #[cfg(test)]
        let held = is_test_sync_held(&self.root);
        #[cfg(not(test))]
        let held = false;
        if st.queue.len() >= MAX_PENDING_SYNC_BATCHES && !held {
            let (new_st, _) = shared
                .cv
                .wait_timeout(st, FRAME_SYNC_WINDOW)
                .unwrap_or_else(|e| e.into_inner());
            st = new_st;
        }
        if st.queue.len() >= MAX_PENDING_SYNC_BATCHES {
            if let Some(SyncCmd::Flush(prev)) = st.queue.back_mut() {
                for (f, rel) in batch.files {
                    if let Some(pos) = prev.files.iter().position(|(_, r)| r == &rel) {
                        prev.files[pos] = (f, rel);
                    } else {
                        prev.files.push((f, rel));
                    }
                }
                prev.checkpoint_file = batch.checkpoint_file;
                prev.checkpoint_count = batch.checkpoint_count;
                shared.cv.notify_all();
                return Ok(());
            }
        }
        st.queue.push_back(SyncCmd::Flush(batch));
        shared.cv.notify_all();
        Ok(())
    }
    pub fn flush_sync(&mut self) -> Result<(), JournalError> {
        self.reconcile_worker_progress();
        if self.poisoned || self.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            self.poisoned = true;
            self.clear_surface_witness_cache();
            self.dirty_files.clear();
            self.staged_dirty_len = 0;
            self.staged_checkpoint_count = 0;
            self.unsynced_witnesses.clear();
            self.pending_checkpoint = None;
            self.unsynced_frames = 0;
            self.first_unsynced_at = None;
            let _ = self.join_sync_worker_inner(true, false);
            return Err(JournalError::Poisoned);
        }
        self.poisoned = true;
        let mut poison_guard = PoisonWitnessGuard {
            root: self.root.clone(),
            disarmed: false,
        };
        if !self.dirty_files.is_empty()
            || self.pending_checkpoint.is_some()
            || self.unsynced_frames > 0
        {
            if self.sync_worker.is_some() {
                if let Err(err) = self.dispatch_frame_sync_batch() {
                    let _ = self.join_sync_worker_inner(true, false);
                    return Err(err);
                }
            } else {
                #[cfg(test)]
                let t_sync = std::time::Instant::now();
                let cp_count = self.count;
                let batch = SyncBatch {
                    files: std::mem::take(&mut self.dirty_files),
                    journal_file: self.file.try_clone().map_err(|_| JournalError::Io)?,
                    checkpoint_file: self.pending_checkpoint.take(),
                    checkpoint_count: cp_count,
                    checkpoint_lock: self.checkpoint_lock.clone(),
                    aborted: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    root: self.root.clone(),
                };
                self.staged_dirty_len = 0;
                self.staged_checkpoint_count = 0;
                self.unsynced_witnesses.clear();
                self.unsynced_frames = 0;
                self.first_unsynced_at = None;
                execute_sync_batch(batch)?;
                let now = std::time::Instant::now();
                self.last_sync = now;
                self.last_dispatch = now;
                self.completed_sync_count = self.completed_sync_count.max(cp_count);
                self.completed_sync_batches += 1;
                #[cfg(test)]
                STAGE_TIMINGS.with(|cell| {
                    let mut s = cell.get();
                    s.fsync_ns += t_sync.elapsed().as_nanos();
                    s.fsync_calls += 1;
                    cell.set(s);
                });
            }
        }
        if let Some(worker) = &self.sync_worker {
            let (b_tx, b_rx) = std::sync::mpsc::sync_channel(1);
            {
                let mut st = worker
                    .shared
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                if st.closed
                    || worker
                        .shared
                        .aborted
                        .load(std::sync::atomic::Ordering::Acquire)
                {
                    return Err(JournalError::Io);
                }
                st.staged = None;
                st.queue.push_back(SyncCmd::Barrier(b_tx));
                worker.shared.cv.notify_all();
            }
            let timeout = join_timeout_for(&self.root);
            match b_rx.recv_timeout(timeout) {
                Ok(Ok(())) => {}
                Ok(Err(e)) => return Err(e),
                Err(_) => {
                    worker
                        .shared
                        .aborted
                        .store(true, std::sync::atomic::Ordering::Release);
                    worker.shared.cv.notify_all();
                    return Err(JournalError::Io);
                }
            }
        }
        self.reconcile_worker_progress();
        self.poisoned = false;
        poison_guard.disarmed = true;
        Ok(())
    }
    pub fn close(&mut self) -> Result<(), JournalError> {
        let res = self.flush_sync().and_then(|()| self.join_sync_worker());
        if let Err(ref err) = res {
            eprintln!("journal close failed: {err}");
        }
        res
    }
    pub fn shutdown(&mut self) -> Result<(), JournalError> {
        self.close()
    }
    pub fn retain_witness(&mut self, bytes: &[u8]) -> Result<Witness, JournalError> {
        self.reconcile_worker_progress();
        if self.poisoned || self.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            self.poisoned = true;
            self.clear_surface_witness_cache();
            return Err(JournalError::Poisoned);
        }
        if bytes.is_empty() || bytes.len() as u64 > MAX_BYTES {
            return Err(JournalError::Witness);
        }
        let digest = sha256_hex(bytes);
        self.retain_witness_inner(&digest, bytes, true, true)
            .inspect_err(|_| {
                if self.poisoned {
                    self.clear_surface_witness_cache();
                }
            })
    }
    pub fn retain_verified_pixels(
        &mut self,
        pixels: &VerifiedPixels,
    ) -> Result<Witness, JournalError> {
        self.reconcile_worker_progress();
        if self.poisoned || self.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            self.poisoned = true;
            self.clear_surface_witness_cache();
            return Err(JournalError::Poisoned);
        }
        self.retain_witness_inner(&pixels.sha256, &pixels.bytes, false, true)
            .inspect_err(|_| {
                if self.poisoned {
                    self.clear_surface_witness_cache();
                }
            })
    }
    pub fn retain_verified_witness(
        &mut self,
        sha256: &str,
        bytes: &[u8],
    ) -> Result<Witness, JournalError> {
        self.reconcile_worker_progress();
        if self.poisoned || self.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            self.poisoned = true;
            self.clear_surface_witness_cache();
            return Err(JournalError::Poisoned);
        }
        let verified = take_verified_grant(sha256, bytes);
        if !hex(sha256)
            || bytes.is_empty()
            || bytes.len() as u64 > MAX_BYTES
            || (!verified && sha256_hex(bytes) != sha256)
        {
            return Err(JournalError::Witness);
        }
        self.retain_witness_inner(sha256, bytes, true, true)
            .inspect_err(|_| {
                if self.poisoned {
                    self.clear_surface_witness_cache();
                }
            })
    }
    pub fn retain_frame_witness(
        &mut self,
        sha256: &str,
        bytes: &[u8],
    ) -> Result<Witness, JournalError> {
        self.reconcile_worker_progress();
        if self.poisoned || self.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            self.poisoned = true;
            self.clear_surface_witness_cache();
            return Err(JournalError::Poisoned);
        }
        let verified = take_verified_grant(sha256, bytes);
        if !hex(sha256)
            || bytes.is_empty()
            || bytes.len() as u64 > MAX_BYTES
            || (!verified && sha256_hex(bytes) != sha256)
        {
            return Err(JournalError::Witness);
        }
        self.retain_witness_inner(sha256, bytes, false, true)
            .inspect_err(|_| {
                if self.poisoned {
                    self.clear_surface_witness_cache();
                }
            })
    }
    fn retain_witness_inner(
        &mut self,
        sha256: &str,
        bytes: &[u8],
        sync_now: bool,
        digest_verified: bool,
    ) -> Result<Witness, JournalError> {
        self.reconcile_worker_progress();
        if self.poisoned || self.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            self.poisoned = true;
            self.clear_surface_witness_cache();
            return Err(JournalError::Poisoned);
        }
        // Latch poisoned on any error inside retain_witness_inner (R3-T1-09).
        self.poisoned = true;
        let mut poison_guard = PoisonWitnessGuard {
            root: self.root.clone(),
            disarmed: false,
        };
        if !hex(sha256)
            || bytes.is_empty()
            || bytes.len() as u64 > MAX_BYTES
            || (!digest_verified && sha256_hex(bytes) != sha256)
        {
            return Err(JournalError::Witness);
        }
        let w = Witness {
            sha256: sha256.to_owned(),
            byte_len: bytes.len() as u64,
        };
        let artifacts_dir = self.root.join("artifacts");
        let path = artifacts_dir.join(&w.sha256);
        let rel = format!("artifacts/{}", w.sha256);
        if path.exists() {
            if !self.is_verified_artifact(&path, &w) {
                verify_witness(&self.root, &w)?;
                self.record_verified_artifact(&w.sha256, &path, w.byte_len)?;
            }
            let needs_sync = !self.committed_witnesses.contains(&w.sha256)
                || self.unsynced_witnesses.contains(&w.sha256);
            if sync_now && needs_sync {
                #[cfg(test)]
                if take_injected_witness_sync_failure(&self.root) {
                    return Err(JournalError::Io);
                }
                sync_path_traced(&path, &self.root, &rel)?;
                sync_dir_traced(&artifacts_dir, &self.root, "artifacts")?;
                self.unsynced_witnesses.remove(&w.sha256);
                self.dirty_files.retain(|(_, r)| r != &rel);
                self.staged_dirty_len = self.staged_dirty_len.min(self.dirty_files.len());
            } else if !sync_now && needs_sync && !self.dirty_files.iter().any(|(_, r)| r == &rel) {
                if self.dirty_files.len() >= MAX_DIRTY_FILES {
                    if self.unsynced_frames > 0 {
                        self.dispatch_frame_sync_batch()?;
                    } else {
                        let (ref old_f, ref old_rel) = self.dirty_files[0];
                        if self.root.join(old_rel).exists() {
                            sync_file_traced(old_f, &self.root, old_rel)?;
                        } else {
                            #[cfg(test)]
                            record_unsynced_dirty_eviction(&self.root);
                        }
                        let (_, old_rel) = self.dirty_files.remove(0);
                        self.staged_dirty_len = self.staged_dirty_len.saturating_sub(1);
                        if let Some(sha) = old_rel.strip_prefix("artifacts/") {
                            self.unsynced_witnesses.remove(sha);
                        }
                    }
                }
                let f = File::open(&path).map_err(|_| JournalError::Io)?;
                self.dirty_files.push((f, rel));
                self.unsynced_witnesses.insert(w.sha256.clone());
            }
        } else {
            while self.uncommitted_artifacts.len() >= MAX_UNCOMMITTED_ARTIFACTS {
                let Some(evicted) = self.uncommitted_artifacts.pop_front() else {
                    break;
                };
                if !self.committed_witnesses.contains(&evicted) {
                    self.verified_witnesses.remove(&evicted);
                    self.verified_witness_order.retain(|k| k != &evicted);
                    self.evict_retained_witness_bytes(&evicted);
                    self.unsynced_witnesses.remove(&evicted);
                    let evicted_rel = format!("artifacts/{evicted}");
                    self.dirty_files.retain(|(_, r)| r != &evicted_rel);
                    self.staged_dirty_len = self.staged_dirty_len.min(self.dirty_files.len());
                    let _ = fs::remove_file(artifacts_dir.join(&evicted));
                }
            }
            if sync_now {
                publish(&path, bytes)?;
                self.unsynced_witnesses.remove(&w.sha256);
                self.record_verified_artifact(&w.sha256, &path, w.byte_len)?;
            } else {
                if self.dirty_files.len() >= MAX_DIRTY_FILES {
                    if self.unsynced_frames > 0 {
                        self.dispatch_frame_sync_batch()?;
                    } else {
                        let (ref old_f, ref old_rel) = self.dirty_files[0];
                        if self.root.join(old_rel).exists() {
                            sync_file_traced(old_f, &self.root, old_rel)?;
                        } else {
                            #[cfg(test)]
                            record_unsynced_dirty_eviction(&self.root);
                        }
                        let (_, old_rel) = self.dirty_files.remove(0);
                        self.staged_dirty_len = self.staged_dirty_len.saturating_sub(1);
                        if let Some(sha) = old_rel.strip_prefix("artifacts/") {
                            self.unsynced_witnesses.remove(sha);
                        }
                    }
                }
                let f = publish_unsynced(&path, bytes)?;
                self.dirty_files.push((f, rel));
                self.unsynced_witnesses.insert(w.sha256.clone());
                self.record_verified_artifact(&w.sha256, &path, w.byte_len)?;
            }
            if !self.committed_witnesses.contains(&w.sha256)
                && !self.uncommitted_artifacts.iter().any(|s| s == &w.sha256)
            {
                self.uncommitted_artifacts.push_back(w.sha256.clone());
            }
        }
        if let Ok(uid) = current_uid() {
            let mode = fs::symlink_metadata(&path)
                .map(|m| m.mode() & 0o7777)
                .unwrap_or(0o600);
            self.cache_retained_witness_bytes(&w.sha256, bytes, uid, mode);
        }
        self.poisoned = false;
        poison_guard.disarmed = true;
        Ok(w)
    }
    pub fn append(
        &mut self,
        input: &Input,
        outcome: &Outcome,
        state: &CoreState,
        witnesses: Vec<Witness>,
    ) -> Result<(), JournalError> {
        self.reconcile_worker_progress();
        if self.poisoned || self.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            self.poisoned = true;
            self.clear_surface_witness_cache();
            return Err(JournalError::Poisoned);
        }
        if self.count >= MAX_RECORDS {
            return Err(JournalError::Policy);
        }
        let next = self.count.checked_add(1).ok_or(JournalError::Policy)?;
        if outcome.core_seq != next || state.core_seq != next {
            return Err(JournalError::Invalid);
        }
        let mut reduced = self.state.clone();
        let expected = reduced.apply(input).map_err(|_| JournalError::Invalid)?;
        if expected != *outcome
            || reduced.snapshot().map_err(|_| JournalError::Invalid)?
                != state.snapshot().map_err(|_| JournalError::Invalid)?
        {
            return Err(JournalError::Invalid);
        }
        let record = SessionRecord {
            schema: SessionRecordSchema::Value,
            core_seq: next,
            kind: event_kind(input, outcome),
            msg_id: format!("event-{next}"),
            prev_sha256: self.tail.clone(),
        };
        let raw = json(&record)?;
        if self
            .bytes
            .checked_add(raw.len() as u64 + 1)
            .is_none_or(|b| b > MAX_BYTES)
        {
            return Err(JournalError::Policy);
        }
        let event = json(&Event {
            schema: "metaviewer.event/v1".into(),
            envelope: audit_envelope(&record, &state.session_id),
            record,
            input: input.clone(),
            outcome: outcome.clone(),
            state: serde_json::to_value(state).map_err(|_| JournalError::Invalid)?,
            witnesses: witnesses.clone(),
        })?;
        let archive_bytes = self
            .archive_bytes
            .checked_add(event.len() as u64)
            .and_then(|n| {
                state
                    .snapshot()
                    .ok()
                    .and_then(|s| n.checked_add(s.len() as u64))
            })
            .ok_or(JournalError::Policy)?;
        if archive_bytes > MAX_BYTES {
            return Err(JournalError::Policy);
        }
        for w in &witnesses {
            let path = self.root.join("artifacts").join(&w.sha256);
            if !self.is_verified_artifact(&path, w) {
                verify_witness(&self.root, w)?;
                self.record_verified_artifact(&w.sha256, &path, w.byte_len)?;
            }
        }
        if required_witness(input, outcome)
            .is_some_and(|hash| !witnesses.iter().any(|w| w.sha256 == hash))
        {
            return Err(JournalError::Witness);
        }
        for w in &witnesses {
            self.committed_witnesses.insert(w.sha256.clone());
            self.uncommitted_artifacts.retain(|s| s != &w.sha256);
            if self.unsynced_witnesses.contains(&w.sha256) {
                let rel = format!("artifacts/{}", w.sha256);
                if !self.dirty_files.iter().any(|(_, r)| r == &rel) {
                    let f = File::open(self.root.join(&rel)).map_err(|_| JournalError::Io)?;
                    self.dirty_files.push((f, rel));
                }
            }
        }
        // From the first durable mutation, errors poison the handle until recovery.
        self.poisoned = true;
        let mut poison_guard = PoisonWitnessGuard {
            root: self.root.clone(),
            disarmed: false,
        };
        let is_frame = matches!(input, Input::Frame { .. });
        if !is_frame {
            if let Some(worker) = &self.sync_worker {
                let (b_tx, b_rx) = std::sync::mpsc::sync_channel(1);
                {
                    let mut st = worker
                        .shared
                        .state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if st.closed
                        || worker
                            .shared
                            .aborted
                            .load(std::sync::atomic::Ordering::Acquire)
                    {
                        return Err(JournalError::Io);
                    }
                    st.staged = None;
                    st.queue.push_back(SyncCmd::Barrier(b_tx));
                    worker.shared.cv.notify_all();
                }
                let timeout = join_timeout_for(&self.root);
                match b_rx.recv_timeout(timeout) {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => return Err(e),
                    Err(_) => {
                        worker
                            .shared
                            .aborted
                            .store(true, std::sync::atomic::Ordering::Release);
                        worker.shared.cv.notify_all();
                        return Err(JournalError::Io);
                    }
                }
            }
            let event_rel = format!("events/{next}.json");
            #[cfg(test)]
            if take_injected_append_torn_event_sidecar(&self.root) {
                let half = (event.len() / 2).max(1);
                let _ = publish_unsynced(&self.root.join(&event_rel), &event[..half]);
                return Err(JournalError::Io);
            }
            let event_file = publish_unsynced(&self.root.join(&event_rel), &event)?;
            #[cfg(test)]
            if take_injected_append_torn_journal(&self.root) {
                let half = (raw.len() / 2).max(1);
                let _ = (&self.file.0).write_all(&raw[..half]);
                return Err(JournalError::Io);
            }
            #[cfg(test)]
            let t_jw = std::time::Instant::now();
            (&self.file.0)
                .write_all(&raw)
                .and_then(|_| (&self.file.0).write_all(b"\n"))
                .map_err(|_| JournalError::Io)?;
            #[cfg(test)]
            STAGE_TIMINGS.with(|cell| {
                let mut s = cell.get();
                s.journal_write_ns += t_jw.elapsed().as_nanos();
                cell.set(s);
            });
            self.count = next;
            self.bytes += raw.len() as u64 + 1;
            self.tail = sha256_hex(&raw);
            self.archive = archive_next(&self.archive, &event);
            self.pending_checkpoint = None;
            #[cfg(test)]
            let t_js = std::time::Instant::now();
            let had_dirty = !self.dirty_files.is_empty() || !self.unsynced_witnesses.is_empty();
            for (f, rel) in self.dirty_files.drain(..) {
                sync_file_traced(&f, &self.root, &rel)?;
            }
            self.staged_dirty_len = 0;
            self.staged_checkpoint_count = 0;
            self.unsynced_witnesses.clear();
            self.unsynced_frames = 0;
            self.first_unsynced_at = None;
            sync_file_traced(&event_file, &self.root, &event_rel)?;
            // Persist directory entries for artifacts and events before syncing journal.jsonl
            // and promoting checkpoint.next (SW-0011, SW-0201).
            if had_dirty || !witnesses.is_empty() {
                sync_dir_traced(&self.root.join("artifacts"), &self.root, "artifacts")?;
            }
            sync_dir_traced(&self.root.join("events"), &self.root, "events")?;
            sync_file_traced(&self.file, &self.root, "journal.jsonl")?;
            #[cfg(test)]
            if take_injected_after_journal_sync(&self.root) {
                return Err(JournalError::Io);
            }
            let mut staged = self.checkpoint_lock.lock().map_err(|_| JournalError::Io)?;
            let tmp = self.root.join("checkpoint.next");
            private_directory(&self.root)?;
            match fs::symlink_metadata(&tmp) {
                Ok(meta) if meta.is_file() => {
                    fs::remove_file(&tmp).map_err(|_| JournalError::Io)?
                }
                Ok(_) => return Err(JournalError::Invalid),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(JournalError::Io),
            }
            let c_bytes = json(&self.closure())?;
            #[cfg(test)]
            if take_injected_append_torn_checkpoint_next(&self.root) {
                let half = (c_bytes.len() / 2).max(1);
                let _ = publish_unsynced(&tmp, &c_bytes[..half]);
                return Err(JournalError::Io);
            }
            let cp_file = publish_unsynced(&tmp, &c_bytes)?;
            sync_file_traced(&cp_file, &self.root, "checkpoint.next")?;
            *staged = next;
            fs::rename(&tmp, self.root.join("checkpoint.json")).map_err(|_| JournalError::Io)?;
            drop(staged);
            sync_dir_traced(&self.root, &self.root, ".")?;
            #[cfg(test)]
            STAGE_TIMINGS.with(|cell| {
                let mut s = cell.get();
                s.fsync_ns += t_js.elapsed().as_nanos();
                s.fsync_calls += 1;
                cell.set(s);
            });
            let now = std::time::Instant::now();
            self.last_sync = now;
            self.last_dispatch = now;
            self.completed_sync_count = next;
            self.completed_sync_batches += 1;
        } else {
            let event_rel = format!("events/{next}.json");
            #[cfg(test)]
            if take_injected_append_torn_event_sidecar(&self.root) {
                let half = (event.len() / 2).max(1);
                let _ = publish_unsynced(&self.root.join(&event_rel), &event[..half]);
                return Err(JournalError::Io);
            }
            let event_file = publish_unsynced(&self.root.join(&event_rel), &event)?;
            self.dirty_files.push((event_file, event_rel));
            #[cfg(test)]
            if take_injected_append_torn_journal(&self.root) {
                let half = (raw.len() / 2).max(1);
                let _ = (&self.file.0).write_all(&raw[..half]);
                return Err(JournalError::Io);
            }
            #[cfg(test)]
            let t_jw = std::time::Instant::now();
            (&self.file.0)
                .write_all(&raw)
                .and_then(|_| (&self.file.0).write_all(b"\n"))
                .map_err(|_| JournalError::Io)?;
            #[cfg(test)]
            STAGE_TIMINGS.with(|cell| {
                let mut s = cell.get();
                s.journal_write_ns += t_jw.elapsed().as_nanos();
                cell.set(s);
            });
            self.count = next;
            self.bytes += raw.len() as u64 + 1;
            self.tail = sha256_hex(&raw);
            self.archive = archive_next(&self.archive, &event);
            let cp_file = {
                let mut staged = self.checkpoint_lock.lock().map_err(|_| JournalError::Io)?;
                let cp = checkpoint_unsynced(&self.root, &self.closure())?;
                *staged = next;
                cp
            };
            self.pending_checkpoint = Some(cp_file);
            if self.unsynced_frames == 0 {
                self.first_unsynced_at = Some(std::time::Instant::now());
            }
            self.unsynced_frames += 1;
            #[cfg(test)]
            let window_elapsed =
                !is_test_sync_held(&self.root) && self.last_dispatch.elapsed() >= FRAME_SYNC_WINDOW;
            #[cfg(not(test))]
            let window_elapsed = self.last_dispatch.elapsed() >= FRAME_SYNC_WINDOW;
            if window_elapsed || self.unsynced_frames >= FRAME_SYNC_MAX_BATCH {
                self.dispatch_frame_sync_batch()?;
            } else {
                self.stage_frame_sync_batch()?;
            }
        }
        self.archive_bytes = archive_bytes;
        self.state = reduced;
        self.poisoned = false;
        poison_guard.disarmed = true;
        self.update_committed_surface_witnesses_after_append(input, outcome);
        Ok(())
    }
}
fn force_recovered_dependencies(
    root: &Path,
    file: &File,
    count: u64,
    committed_witnesses: &BTreeSet<String>,
) -> Result<(), JournalError> {
    for sha in committed_witnesses {
        sync_path_traced(
            &root.join("artifacts").join(sha),
            root,
            &format!("artifacts/{sha}"),
        )?;
    }
    sync_dir_traced(&root.join("artifacts"), root, "artifacts")?;
    sync_path_traced(&root.join("genesis.json"), root, "genesis.json")?;
    for seq in 1..=count {
        sync_path_traced(
            &root.join("events").join(format!("{seq}.json")),
            root,
            &format!("events/{seq}.json"),
        )?;
    }
    sync_dir_traced(&root.join("events"), root, "events")?;
    sync_file_traced(file, root, "journal.jsonl")
}
fn line_counted(
    reader: &mut impl BufRead,
    offset: &mut u64,
) -> Result<Option<Vec<u8>>, JournalError> {
    let mut bytes = Vec::new();
    let n = reader
        .take(MAX_LINE as u64 + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| JournalError::Io)?;
    *offset = offset.saturating_add(n as u64);
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() > MAX_LINE {
        return Err(JournalError::Oversize);
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(JournalError::Utf8Bom);
    }
    if bytes.pop() != Some(b'\n') {
        return Err(JournalError::MissingLf);
    }
    if bytes.is_empty() || bytes.iter().all(u8::is_ascii_whitespace) {
        return Err(JournalError::Blank);
    }
    Ok(Some(bytes))
}
fn verify_prefix_and_classify_tail(
    path: &Path,
    root: &Path,
    cp: &Checkpoint,
) -> Option<(u64, BTreeSet<String>)> {
    if cp.schema != "metaviewer.checkpoint/v1" {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BYTES {
        return None;
    }
    let file_len = metadata.len();
    let mut reader = BufReader::new(File::open(path).ok()?);
    let mut offset = 0u64;
    let header_bytes = line_counted(&mut reader, &mut offset).ok()??;
    let header: Header = parse(&header_bytes).ok()?;
    if header.schema != "metaviewer.journal/v1"
        || !safe_component(&header.session_id)
        || header.core_version != env!("CARGO_PKG_VERSION")
    {
        return None;
    }
    let genesis_bytes = read_file(&root.join("genesis.json"), MAX_BYTES).ok()?;
    let genesis: Genesis = parse(&genesis_bytes).ok()?;
    if genesis.schema != "metaviewer.archive/v1"
        || genesis.header_sha256 != sha256_hex(&header_bytes)
        || genesis.state.session_id != header.session_id
        || genesis.state.core_seq != 0
        || sha256_hex(&genesis_bytes) != cp.genesis
    {
        return None;
    }
    let mut state = genesis.state;
    let mut tail = ZERO.to_owned();
    let mut archive = ZERO.to_owned();
    let mut ids = BTreeSet::new();
    let mut committed_witnesses = BTreeSet::new();
    let mut archive_budget = genesis_bytes.len() as u64;
    for seq in 1..=cp.count {
        let bytes = line_counted(&mut reader, &mut offset).ok()??;
        let record: SessionRecord = parse(&bytes).ok()?;
        if !ids.insert(record.msg_id.clone())
            || record.core_seq != seq
            || record.msg_id != format!("event-{seq}")
            || record.prev_sha256 != tail
        {
            return None;
        }
        let event_bytes =
            read_file(&root.join("events").join(format!("{seq}.json")), MAX_BYTES).ok()?;
        archive_budget = archive_budget.checked_add(event_bytes.len() as u64)?;
        if archive_budget > MAX_BYTES {
            return None;
        }
        let event: Event = parse(&event_bytes).ok()?;
        let envelope_raw = json(&event.envelope).ok()?;
        let envelope_text = std::str::from_utf8(&envelope_raw).ok()?;
        let decoded = crate::decode_envelope(envelope_text).ok()?;
        if event.schema != "metaviewer.event/v1"
            || event.record != record
            || decoded != audit_envelope(&record, &header.session_id)
        {
            return None;
        }
        for w in &event.witnesses {
            verify_witness(root, w).ok()?;
            committed_witnesses.insert(w.sha256.clone());
        }
        if required_witness(&event.input, &event.outcome)
            .is_some_and(|hash| !event.witnesses.iter().any(|w| w.sha256 == hash))
        {
            return None;
        }
        let outcome = state.apply(&event.input).ok()?;
        if outcome != event.outcome || record.kind != event_kind(&event.input, &outcome) {
            return None;
        }
        let snapshot = state.snapshot().ok()?;
        if snapshot != canonical_bytes(&event.state).ok()? {
            return None;
        }
        archive_budget = archive_budget.checked_add(snapshot.len() as u64)?;
        if archive_budget > MAX_BYTES {
            return None;
        }
        tail = sha256_hex(&bytes);
        archive = archive_next(&archive, &event_bytes);
    }
    if tail != cp.tail || archive != cp.archive {
        return None;
    }
    let prefix_end_offset = offset;
    let next_seq = cp.count.checked_add(1)?;
    if file_len == prefix_end_offset {
        return Some((prefix_end_offset, committed_witnesses));
    }
    let mut saw_torn = false;
    let mut non_frame_tail_records = 0u64;
    let mut expected_seq = next_seq;
    let mut expected_tail = cp.tail.clone();
    loop {
        match line_counted(&mut reader, &mut offset) {
            Ok(None) => break,
            Err(_) => {
                saw_torn = true;
                break;
            }
            Ok(Some(bytes)) => {
                let Ok(rec) = parse::<SessionRecord>(&bytes) else {
                    saw_torn = true;
                    break;
                };
                if rec.core_seq != expected_seq
                    || rec.msg_id != format!("event-{expected_seq}")
                    || rec.prev_sha256 != expected_tail
                {
                    return None;
                }
                let ev_path = root.join("events").join(format!("{expected_seq}.json"));
                let Ok(ev_bytes) = read_file(&ev_path, MAX_BYTES) else {
                    saw_torn = true;
                    break;
                };
                let Ok(ev) = parse::<Event>(&ev_bytes) else {
                    saw_torn = true;
                    break;
                };
                if ev.schema != "metaviewer.event/v1" || ev.record != rec {
                    saw_torn = true;
                    break;
                }
                for w in &ev.witnesses {
                    if verify_witness(root, w).is_err() {
                        saw_torn = true;
                        break;
                    }
                }
                if saw_torn {
                    break;
                }
                // Tail records are uncommitted, but must satisfy the same state
                // and witness checks before they can veto rollback as valid data.
                let valid_tail = (|| -> Option<()> {
                    let envelope_raw = json(&ev.envelope).ok()?;
                    let decoded =
                        crate::decode_envelope(std::str::from_utf8(&envelope_raw).ok()?).ok()?;
                    if decoded != audit_envelope(&rec, &header.session_id)
                        || required_witness(&ev.input, &ev.outcome)
                            .is_some_and(|hash| !ev.witnesses.iter().any(|w| w.sha256 == hash))
                    {
                        return None;
                    }
                    archive_budget = archive_budget.checked_add(ev_bytes.len() as u64)?;
                    if archive_budget > MAX_BYTES {
                        return None;
                    }
                    let outcome = state.apply(&ev.input).ok()?;
                    if outcome != ev.outcome || rec.kind != event_kind(&ev.input, &outcome) {
                        return None;
                    }
                    let snapshot = state.snapshot().ok()?;
                    if snapshot != canonical_bytes(&ev.state).ok()? {
                        return None;
                    }
                    archive_budget = archive_budget.checked_add(snapshot.len() as u64)?;
                    (archive_budget <= MAX_BYTES).then_some(())
                })();
                if valid_tail.is_none() {
                    saw_torn = true;
                    break;
                }
                if matches!(ev.input, Input::Frame { .. }) {
                    if non_frame_tail_records > 0 {
                        return None;
                    }
                } else {
                    non_frame_tail_records += 1;
                }
                expected_tail = sha256_hex(&bytes);
                expected_seq = expected_seq.checked_add(1)?;
            }
        }
    }
    if !saw_torn && non_frame_tail_records > 1 {
        return None;
    }
    Some((prefix_end_offset, committed_witnesses))
}
fn cleanup_uncommitted_events(root: &Path, committed_count: u64) -> Result<(), JournalError> {
    let events_dir = root.join("events");
    let mut to_remove = Vec::new();
    for entry in fs::read_dir(&events_dir).map_err(|_| JournalError::Io)? {
        let entry = entry.map_err(|_| JournalError::Io)?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|_| JournalError::Io)?;
        if !meta.is_file() {
            return Err(JournalError::Invalid);
        }
        let fname = entry.file_name();
        let keep = fname
            .to_str()
            .and_then(|s| s.strip_suffix(".json"))
            .and_then(|stem| stem.parse::<u64>().ok())
            .is_some_and(|seq| {
                (1..=committed_count).contains(&seq) && fname == format!("{seq}.json").as_str()
            });
        if !keep {
            let seq_key = fname
                .to_str()
                .and_then(|s| s.strip_suffix(".json"))
                .and_then(|stem| stem.parse::<u64>().ok())
                .unwrap_or(u64::MAX);
            to_remove.push((seq_key, path));
        }
    }
    to_remove.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    for (_, path) in to_remove {
        fs::remove_file(&path).map_err(|_| JournalError::Io)?;
        #[cfg(test)]
        if take_injected_recovery_step(root, RecoveryCrashStep::FirstEventSidecarRemoved) {
            return Err(JournalError::Io);
        }
    }
    #[cfg(test)]
    if take_injected_recovery_step(root, RecoveryCrashStep::EventsCleanedBeforeEventsDirSync) {
        return Err(JournalError::Io);
    }
    sync_dir_traced(&events_dir, root, "events")
}
fn cleanup_uncommitted_artifacts(
    root: &Path,
    committed_witnesses: &BTreeSet<String>,
    always_sync_dir: bool,
) -> Result<(), JournalError> {
    let artifacts_dir = root.join("artifacts");
    let mut to_remove = Vec::new();
    for entry in fs::read_dir(&artifacts_dir).map_err(|_| JournalError::Io)? {
        let entry = entry.map_err(|_| JournalError::Io)?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|_| JournalError::Io)?;
        if !meta.is_file() {
            return Err(JournalError::Invalid);
        }
        let fname = entry.file_name();
        let keep = fname
            .to_str()
            .is_some_and(|name| committed_witnesses.contains(name));
        if !keep {
            to_remove.push(path);
        }
    }
    to_remove.sort();
    let mut removed_any = false;
    for path in to_remove {
        fs::remove_file(&path).map_err(|_| JournalError::Io)?;
        removed_any = true;
        #[cfg(test)]
        if take_injected_recovery_step(root, RecoveryCrashStep::FirstOrphanArtifactRemoved) {
            return Err(JournalError::Io);
        }
    }
    if removed_any || always_sync_dir {
        sync_dir_traced(&artifacts_dir, root, "artifacts")?;
    }
    Ok(())
}
fn try_rollback_uncommitted_tail(
    file: &File,
    path: &Path,
    root: &Path,
    scan_err: JournalError,
) -> Result<(), JournalError> {
    if matches!(
        scan_err,
        JournalError::UpgradeRequired { .. }
            | JournalError::Invalid
            | JournalError::Locked
            | JournalError::Poisoned
    ) {
        return Err(scan_err);
    }
    let mut candidates: Vec<Checkpoint> = Vec::new();
    for name in ["checkpoint.json", "checkpoint.next"] {
        let p = root.join(name);
        if let Ok(bytes) = read_file(&p, MAX_LINE as u64) {
            if let Ok(cp) = parse::<Checkpoint>(&bytes) {
                if cp.schema == "metaviewer.checkpoint/v1"
                    && !candidates
                        .iter()
                        .any(|c| c.count == cp.count && c.tail == cp.tail)
                {
                    candidates.push(cp);
                }
            }
        }
    }
    candidates.sort_by_key(|a| std::cmp::Reverse(a.count));
    for cp in candidates {
        if let Some((prefix_end_offset, committed_witnesses)) =
            verify_prefix_and_classify_tail(path, root, &cp)
        {
            // Crash-safe rollback order:
            // 1. Force committed prefix files and ensure checkpoint.json durably holds cp.
            // 2. Clean sidecars first (events beyond cp.count, orphan artifacts not referenced
            //    by the committed prefix) and fsync their directories.
            // 3. Truncate journal.jsonl to prefix_end_offset and fsync journal.jsonl.
            // 4. Remove stale checkpoint.next (if any) and fsync root dir.
            for sha in &committed_witnesses {
                sync_path_traced(
                    &root.join("artifacts").join(sha),
                    root,
                    &format!("artifacts/{sha}"),
                )?;
            }
            sync_path_traced(&root.join("genesis.json"), root, "genesis.json")?;
            for seq in 1..=cp.count {
                sync_path_traced(
                    &root.join("events").join(format!("{seq}.json")),
                    root,
                    &format!("events/{seq}.json"),
                )?;
            }
            let current_matches = read_file(&root.join("checkpoint.json"), MAX_LINE as u64)
                .is_ok_and(|b| json(&cp).is_ok_and(|expected| b == expected));
            if !current_matches {
                sync_dir_traced(&root.join("artifacts"), root, "artifacts")?;
                sync_dir_traced(&root.join("events"), root, "events")?;
                sync_file_traced(file, root, "journal.jsonl")?;
                checkpoint(root, &cp)?;
            }
            cleanup_uncommitted_events(root, cp.count)?;
            cleanup_uncommitted_artifacts(root, &committed_witnesses, true)?;
            #[cfg(test)]
            if take_injected_recovery_step(
                root,
                RecoveryCrashStep::SidecarsSyncedBeforeJournalTruncate,
            ) {
                return Err(JournalError::Io);
            }
            file.set_len(prefix_end_offset)
                .map_err(|_| JournalError::Io)?;
            #[cfg(test)]
            if take_injected_recovery_step(
                root,
                RecoveryCrashStep::JournalTruncateBeforeJournalSync,
            ) {
                return Err(JournalError::Io);
            }
            sync_file_traced(file, root, "journal.jsonl")?;
            #[cfg(test)]
            if take_injected_recovery_step(root, RecoveryCrashStep::JournalSyncBeforePendingRemove)
            {
                return Err(JournalError::Io);
            }
            let pending = root.join("checkpoint.next");
            match fs::remove_file(&pending) {
                Ok(()) => {
                    #[cfg(test)]
                    if take_injected_recovery_step(
                        root,
                        RecoveryCrashStep::PendingRemoveBeforeRootDirSync,
                    ) {
                        return Err(JournalError::Io);
                    }
                    sync_dir_traced(root, root, ".")?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(JournalError::Io),
            }
            return Ok(());
        }
    }
    Err(scan_err)
}
fn line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, JournalError> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_LINE as u64 + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| JournalError::Io)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() > MAX_LINE {
        return Err(JournalError::Oversize);
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(JournalError::Utf8Bom);
    }
    if bytes.pop() != Some(b'\n') {
        return Err(JournalError::MissingLf);
    }
    if bytes.is_empty() || bytes.iter().all(u8::is_ascii_whitespace) {
        return Err(JournalError::Blank);
    }
    Ok(Some(bytes))
}
pub fn verify_chain(path: &Path, root: &Path) -> Result<(), JournalError> {
    scan(path, root).map(|_| ())
}
pub fn scan(path: &Path, root: &Path) -> Result<Replay, JournalError> {
    confined(path)?;
    private_archive(root)?;
    let metadata = fs::metadata(path).map_err(|_| JournalError::Io)?;
    if !metadata.is_file() {
        return Err(JournalError::Corrupt);
    }
    if metadata.len() == 0 {
        return Err(JournalError::Empty);
    }
    if metadata.len() > MAX_BYTES {
        return Err(JournalError::Oversize);
    }
    let mut reader = BufReader::new(File::open(path).map_err(|_| JournalError::Io)?);
    let header_bytes = line(&mut reader)?.ok_or(JournalError::Empty)?;
    let header: Header = parse(&header_bytes)?;
    if header.schema != "metaviewer.journal/v1" || !safe_component(&header.session_id) {
        return Err(JournalError::Corrupt);
    }
    if header.core_version != env!("CARGO_PKG_VERSION") {
        return Err(JournalError::UpgradeRequired {
            expected: env!("CARGO_PKG_VERSION").into(),
            found: header.core_version,
        });
    }
    let genesis_bytes = read_file(&root.join("genesis.json"), MAX_BYTES)?;
    let genesis: Genesis = parse(&genesis_bytes)?;
    if genesis.schema != "metaviewer.archive/v1"
        || genesis.header_sha256 != sha256_hex(&header_bytes)
        || genesis.state.session_id != header.session_id
        || genesis.state.core_seq != 0
    {
        return Err(JournalError::Corrupt);
    }
    let mut state = genesis.state;
    let mut tail = ZERO.to_owned();
    let mut archive = ZERO.to_owned();
    let mut count = 0u64;
    let mut ids = BTreeSet::new();
    let mut committed_witnesses = BTreeSet::new();
    let mut boundaries = Vec::new();
    let mut archive_budget = genesis_bytes.len() as u64;
    while let Some(bytes) = line(&mut reader)? {
        if count >= MAX_RECORDS {
            return Err(JournalError::Policy);
        }
        let record: SessionRecord = parse(&bytes)?;
        if !ids.insert(record.msg_id.clone()) {
            return Err(JournalError::Duplicate);
        }
        count = count.checked_add(1).ok_or(JournalError::Corrupt)?;
        if record.core_seq != count {
            return Err(JournalError::Duplicate);
        }
        if record.msg_id != format!("event-{count}") || record.prev_sha256 != tail {
            return Err(JournalError::Corrupt);
        }
        let event_bytes = read_file(
            &root.join("events").join(format!("{count}.json")),
            MAX_BYTES,
        )?;
        archive_budget = archive_budget
            .checked_add(event_bytes.len() as u64)
            .ok_or(JournalError::Policy)?;
        if archive_budget > MAX_BYTES {
            return Err(JournalError::Policy);
        }
        let event: Event = parse(&event_bytes)?;
        let envelope_raw = json(&event.envelope)?;
        let envelope_text =
            std::str::from_utf8(&envelope_raw).map_err(|_| JournalError::Corrupt)?;
        let decoded = crate::decode_envelope(envelope_text).map_err(|_| JournalError::Corrupt)?;
        if event.schema != "metaviewer.event/v1"
            || event.record != record
            || decoded != audit_envelope(&record, &header.session_id)
        {
            return Err(JournalError::Corrupt);
        }
        for w in &event.witnesses {
            verify_witness(root, w)?;
            committed_witnesses.insert(w.sha256.clone());
        }
        if required_witness(&event.input, &event.outcome)
            .is_some_and(|hash| !event.witnesses.iter().any(|w| w.sha256 == hash))
        {
            return Err(JournalError::Witness);
        }
        let outcome = state
            .apply(&event.input)
            .map_err(|_| JournalError::Corrupt)?;
        if outcome != event.outcome || record.kind != event_kind(&event.input, &outcome) {
            return Err(JournalError::Corrupt);
        }
        let snapshot = state.snapshot().map_err(|_| JournalError::Corrupt)?;
        if snapshot != canonical_bytes(&event.state)? {
            return Err(JournalError::Corrupt);
        }
        archive_budget = archive_budget
            .checked_add(snapshot.len() as u64)
            .ok_or(JournalError::Policy)?;
        if archive_budget > MAX_BYTES {
            return Err(JournalError::Policy);
        }
        boundaries.push(snapshot);
        tail = sha256_hex(&bytes);
        archive = archive_next(&archive, &event_bytes);
    }
    let _ = count.checked_add(1).ok_or(JournalError::Policy)?;
    for entry in fs::read_dir(root.join("events")).map_err(|_| JournalError::Io)? {
        let entry = entry.map_err(|_| JournalError::Io)?;
        let fname = entry.file_name();
        let valid_committed = fname
            .to_str()
            .and_then(|s| s.strip_suffix(".json"))
            .and_then(|stem| stem.parse::<u64>().ok())
            .is_some_and(|seq| {
                (1..=count).contains(&seq) && fname == format!("{seq}.json").as_str()
            });
        if !valid_committed {
            return Err(JournalError::Unsealed);
        }
    }
    let checkpoint = matching_checkpoint(
        root,
        &Checkpoint {
            schema: "metaviewer.checkpoint/v1".into(),
            count,
            tail,
            archive,
            genesis: sha256_hex(&genesis_bytes),
        },
    )?;
    Ok(Replay {
        state,
        boundaries,
        archive_bytes: archive_budget,
        checkpoint,
        committed_witnesses,
    })
}
/// Resolves the conductor's default state destination without creating it.
pub fn default_state_dir() -> Result<PathBuf, JournalError> {
    if let Some(p) = std::env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()) {
        let p = PathBuf::from(p);
        if !p.is_absolute() {
            return Err(JournalError::Invalid);
        }
        return Ok(p.join("metaviewer"));
    }
    let home = std::env::var_os("HOME")
        .filter(|s| !s.is_empty())
        .ok_or(JournalError::Invalid)?;
    let p = PathBuf::from(home);
    if !p.is_absolute() {
        return Err(JournalError::Invalid);
    }
    Ok(p.join(".local/state/metaviewer"))
}

#[cfg(test)]
mod directory_tests {
    use super::*;
    #[test]
    fn writer_drop_releases_lock_with_a_retained_file_description() {
        let root = std::env::temp_dir().join(format!("mv-journal-lock-{}", std::process::id()));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let state = CoreState::session("session-1").unwrap();
        let journal = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let path = session.join("journal.jsonl");
        // A duplicate models the same open file description retained across a
        // concurrent fork before exec closes the child's inherited descriptor.
        let inherited = journal.file.try_clone().unwrap();
        assert!(matches!(
            Journal::recover(&path, &session),
            Err(JournalError::Locked)
        ));
        drop(journal);
        let (recovered, _) = Journal::recover(&path, &session).unwrap();
        assert!(matches!(
            Journal::recover(&path, &session),
            Err(JournalError::Locked)
        ));
        drop(inherited);
        // Closing the old descriptor must not release the new writer's lock.
        assert!(matches!(
            Journal::recover(&path, &session),
            Err(JournalError::Locked)
        ));
        drop(recovered);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn foreign_owner_is_refused_even_with_private_mode() {
        let root = std::env::temp_dir().join(format!("mv-journal-owner-{}", std::process::id()));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let uid = fs::metadata(&root).unwrap().uid();
        assert_eq!(private_directory_for_uid(&root, uid), Ok(()));
        assert_eq!(
            private_directory_for_uid(&root, uid.checked_add(1).unwrap()),
            Err(JournalError::Invalid)
        );
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn verified_witness_cache_is_bounded() {
        let root = std::env::temp_dir().join(format!("mv-journal-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let state = CoreState::session("session-1").unwrap();
        let mut journal = Journal::create(&root, &state).unwrap();
        for i in 0..300u32 {
            let bytes = format!("witness-cache-entry-{i}").into_bytes();
            let sha = sha256_hex(&bytes);
            let path = journal.root.join("artifacts").join(&sha);
            fs::write(&path, &bytes).unwrap();
            journal
                .record_verified_artifact(&sha, &path, bytes.len() as u64)
                .unwrap();
        }
        assert!(
            journal.verified_witnesses.len() <= 256,
            "verified_witnesses grew to {} (> 256)",
            journal.verified_witnesses.len()
        );
        drop(journal);
        fs::remove_dir_all(root).unwrap();
    }
    fn snapshot_tree(session: &Path) -> Vec<(String, u64, u64, i64)> {
        let mut entries = Vec::new();
        for rel in ["", "events", "artifacts"] {
            let dir = if rel.is_empty() {
                session.to_path_buf()
            } else {
                session.join(rel)
            };
            let mut dir_entries: Vec<_> = fs::read_dir(&dir)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            dir_entries.sort();
            for p in dir_entries {
                let m = fs::symlink_metadata(&p).unwrap();
                if m.is_file() {
                    let name = p
                        .strip_prefix(session)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned();
                    entries.push((name, m.len(), m.ino(), m.mtime_nsec()));
                }
            }
        }
        entries
    }
    #[test]
    fn drop_and_close_flush_and_join_leaving_directory_quiescent() {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};

        let root = std::env::temp_dir().join(format!("mv-journal-jdrop-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();

        let seed_surface = |state: &mut CoreState, journal: &mut Journal| {
            let out = state.apply(&Input::Connect).unwrap();
            journal
                .append(&Input::Connect, &out, state, vec![])
                .unwrap();
            let sw = journal.retain_witness(b"surface-seed").unwrap();
            let s_in = Input::Surface {
                id: "surface-1".into(),
                surface: Surface {
                    display: ":1".into(),
                    owner: Endpoint {
                        component: Component::Agent,
                        instance: "agent-1".into(),
                    },
                    agent_controlled: true,
                    live: true,
                    frame: None,
                    refresh_after: None,
                    allowed_verbs: vec![],
                },
            };
            let out_s = state.apply(&s_in).unwrap();
            journal.append(&s_in, &out_s, state, vec![sw]).unwrap();
        };

        // 1. Positive control (Drop): active background worker + pending group commit.
        let mut state = CoreState::session("session-drop").unwrap();
        let mut journal = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-drop");
        seed_surface(&mut state, &mut journal);
        hold_sync_worker_for_test(&session);
        for gen in 1..=9u64 {
            let bytes = format!("drop-frame-{gen}").into_bytes();
            let sha = sha256_hex(&bytes);
            let w = journal.retain_frame_witness(&sha, &bytes).unwrap();
            let f_in = Input::Frame {
                surface_id: "surface-1".into(),
                frame: Frame {
                    sha256: sha,
                    generation: gen,
                    width: 64,
                    height: 64,
                },
            };
            let out = state.apply(&f_in).unwrap();
            journal.append(&f_in, &out, &state, vec![w]).unwrap();
        }
        // Generation 1..=8 dispatched a background sync batch; generation 9 is a pending group commit.
        assert!(
            journal.sync_worker.is_some(),
            "background worker must be active"
        );
        assert!(
            journal.pending_checkpoint.is_some() && journal.unsynced_frames == 1,
            "generation 9 must remain pending before drop"
        );
        assert!(session.join("checkpoint.next").exists());
        let cp_before_drop: Checkpoint =
            serde_json::from_slice(&fs::read(session.join("checkpoint.json")).unwrap()).unwrap();
        assert_eq!(cp_before_drop.count, 2);

        release_test_sync_hold(&session);
        drop(journal);

        // Immediately after drop returns, checkpoint.next must be promoted and directory quiescent.
        assert!(
            !session.join("checkpoint.next").exists(),
            "checkpoint.next must not exist after Journal::drop returns"
        );
        let snap_immediately = snapshot_tree(&session);
        let cp: Checkpoint =
            serde_json::from_slice(&fs::read(session.join("checkpoint.json")).unwrap()).unwrap();
        assert_eq!(cp.count, 11);
        let replayed = scan(&session.join("journal.jsonl"), &session).unwrap();
        assert_eq!(replayed.state, state);
        std::thread::sleep(std::time::Duration::from_millis(30));
        assert_eq!(
            snapshot_tree(&session),
            snap_immediately,
            "directory must be quiescent right after drop"
        );

        // 2. Positive control (explicit close/shutdown): flushes, joins, and makes Drop a no-op.
        let mut state_close = CoreState::session("session-close").unwrap();
        let mut journal_close = Journal::create(&root, &state_close).unwrap();
        let session_close = root.join("sessions/session-close");
        seed_surface(&mut state_close, &mut journal_close);
        hold_sync_worker_for_test(&session_close);
        for gen in 1..=9u64 {
            let bytes = format!("close-frame-{gen}").into_bytes();
            let sha = sha256_hex(&bytes);
            let w = journal_close.retain_frame_witness(&sha, &bytes).unwrap();
            let f_in = Input::Frame {
                surface_id: "surface-1".into(),
                frame: Frame {
                    sha256: sha,
                    generation: gen,
                    width: 64,
                    height: 64,
                },
            };
            let out = state_close.apply(&f_in).unwrap();
            journal_close
                .append(&f_in, &out, &state_close, vec![w])
                .unwrap();
        }
        assert!(journal_close.sync_worker.is_some());
        assert!(
            journal_close.pending_checkpoint.is_some() && journal_close.unsynced_frames == 1,
            "generation 9 must remain pending before close"
        );
        assert!(session_close.join("checkpoint.next").exists());
        let cp_before_close: Checkpoint =
            serde_json::from_slice(&fs::read(session_close.join("checkpoint.json")).unwrap())
                .unwrap();
        assert_eq!(cp_before_close.count, 2);
        release_test_sync_hold(&session_close);
        journal_close.close().unwrap();
        assert!(journal_close.sync_worker.is_none());
        assert!(!session_close.join("checkpoint.next").exists());
        let cp_after_close: Checkpoint =
            serde_json::from_slice(&fs::read(session_close.join("checkpoint.json")).unwrap())
                .unwrap();
        assert_eq!(cp_after_close.count, 11);
        let snap_after_close = snapshot_tree(&session_close);
        drop(journal_close);
        assert_eq!(snapshot_tree(&session_close), snap_after_close);

        // 3. Negative control (without joining the background worker): directory is still
        // being mutated after an unjoined teardown returns.
        let mut state_neg = CoreState::session("session-unjoined").unwrap();
        let mut journal_neg = Journal::create(&root, &state_neg).unwrap();
        let session_neg = root.join("sessions/session-unjoined");
        seed_surface(&mut state_neg, &mut journal_neg);
        hold_sync_worker_for_test(&session_neg);
        let bytes = b"unjoined-frame-1";
        let sha = sha256_hex(bytes);
        let w = journal_neg.retain_frame_witness(&sha, bytes).unwrap();
        let f_in = Input::Frame {
            surface_id: "surface-1".into(),
            frame: Frame {
                sha256: sha,
                generation: 1,
                width: 64,
                height: 64,
            },
        };
        let out = state_neg.apply(&f_in).unwrap();
        journal_neg
            .append(&f_in, &out, &state_neg, vec![w])
            .unwrap();
        let batch = SyncBatch {
            files: std::mem::take(&mut journal_neg.dirty_files),
            journal_file: journal_neg.file.try_clone().unwrap(),
            checkpoint_file: journal_neg.pending_checkpoint.take(),
            checkpoint_count: journal_neg.count,
            checkpoint_lock: journal_neg.checkpoint_lock.clone(),
            aborted: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            root: journal_neg.root.clone(),
        };
        journal_neg.staged_dirty_len = 0;
        if let Some(ref w) = journal_neg.sync_worker {
            w.shared
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .staged = None;
        }
        journal_neg.unsynced_frames = 0;
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let unjoined_handle = std::thread::spawn(move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            execute_sync_batch(batch).unwrap();
        });
        entered_rx.recv().unwrap();
        // Drop journal_neg without joining the detached worker; checkpoint.next is still present
        // and the worker mutates the directory after drop returns.
        release_test_sync_hold(&session_neg);
        drop(journal_neg);
        let snap_before_worker_finishes = snapshot_tree(&session_neg);
        assert!(
            session_neg.join("checkpoint.next").exists(),
            "negative control: without join, checkpoint.next is still unpromoted after drop"
        );
        release_tx.send(()).unwrap();
        unjoined_handle.join().unwrap();
        let snap_after_worker_finishes = snapshot_tree(&session_neg);
        assert_ne!(
            snap_before_worker_finishes, snap_after_worker_finishes,
            "negative control: unjoined worker mutates session directory after drop"
        );
        assert!(!session_neg.join("checkpoint.next").exists());

        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retain_witness_inner_latches_poison_on_any_error() {
        let root = std::env::temp_dir().join(format!("mv-journal-rpoison-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let state = CoreState::session("session-1").unwrap();
        let mut journal = Journal::create(&root, &state).unwrap();
        assert_eq!(
            journal.retain_witness_inner("not-hex", b"payload", true, false),
            Err(JournalError::Witness)
        );
        assert!(journal.poisoned);
        assert_eq!(
            journal.retain_witness(b"after-poison"),
            Err(JournalError::Poisoned)
        );
        drop(journal);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn injected_witness_sync_failure_latches_poison_and_blocks_retry() {
        let root = std::env::temp_dir().join(format!("mv-journal-wsync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");

        let payload = b"witness-sync-failure-bytes";
        let sha = sha256_hex(payload);
        fail_next_witness_sync(&session);
        assert_eq!(j.retain_witness(payload), Err(JournalError::Io));

        assert!(session.join("artifacts").join(&sha).exists());
        assert_eq!(j.retain_witness(payload), Err(JournalError::Poisoned));
        assert_eq!(
            j.retain_verified_witness(&sha, payload),
            Err(JournalError::Poisoned)
        );
        assert_eq!(
            j.retain_frame_witness(&sha, payload),
            Err(JournalError::Poisoned)
        );
        let out = state.apply(&Input::Connect).unwrap();
        assert_eq!(
            j.append(&Input::Connect, &out, &state, vec![]),
            Err(JournalError::Poisoned)
        );
        assert_eq!(j.flush_sync(), Err(JournalError::Poisoned));
        drop(j);
        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recover_forces_witnesses_events_and_journal_before_checkpoint_promotion_and_skips_when_clean(
    ) {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};

        let root = std::env::temp_dir().join(format!("mv-journal-recf-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let path = session.join("journal.jsonl");
        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();

        let sw = j.retain_witness(b"surface-recover-order").unwrap();
        let s_in = Input::Surface {
            id: "srf-rec".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![sw.clone()]).unwrap();
        let old_cp = fs::read(session.join("checkpoint.json")).unwrap();

        let f_bytes = b"frame-recover-order";
        let f_sha = sha256_hex(f_bytes);
        let fw = j.retain_frame_witness(&f_sha, f_bytes).unwrap();
        let f_in = Input::Frame {
            surface_id: "srf-rec".into(),
            frame: Frame {
                sha256: f_sha.clone(),
                generation: 1,
                width: 64,
                height: 64,
            },
        };
        let out3 = state.apply(&f_in).unwrap();
        j.append(&f_in, &out3, &state, vec![fw]).unwrap();
        drop(j);

        // 1. Clean steady-state recover (current_matches == true): must NOT fsync all historical files.
        enable_sync_trace(&session);
        let (clean_rec, clean_state) = Journal::recover(&path, &session).unwrap();
        let clean_trace = take_sync_trace(&session);
        assert_eq!(clean_state, state);
        assert!(
            clean_trace.is_empty(),
            "steady-state recover with matching checkpoint.json must not fsync historical files: {clean_trace:?}"
        );
        drop(clean_rec);

        // 2. Simulate crash with proven checkpoint.next and older checkpoint.json.
        fs::rename(
            session.join("checkpoint.json"),
            session.join("checkpoint.next"),
        )
        .unwrap();
        fs::write(session.join("checkpoint.json"), &old_cp).unwrap();

        enable_sync_trace(&session);
        let (recovered, recovered_state) = Journal::recover(&path, &session).unwrap();
        let trace = take_sync_trace(&session);
        assert_eq!(recovered_state, state);
        drop(recovered);

        let pos = |entry: &str| {
            trace
                .iter()
                .position(|e| e == entry)
                .unwrap_or_else(|| panic!("missing {entry:?} in recovery fsync trace: {trace:?}"))
        };
        let cp_next_pos = pos("checkpoint.next");
        for dep in [
            format!("artifacts/{}", sw.sha256),
            format!("artifacts/{f_sha}"),
            "artifacts".to_string(),
            "genesis.json".to_string(),
            "events/1.json".to_string(),
            "events/2.json".to_string(),
            "events/3.json".to_string(),
            "events".to_string(),
            "journal.jsonl".to_string(),
        ] {
            let dep_pos = pos(&dep);
            assert!(
                dep_pos < cp_next_pos,
                "dependency {dep:?} synced at {dep_pos} after checkpoint.next at {cp_next_pos}: {trace:?}"
            );
        }
        assert_eq!(trace.last().map(String::as_str), Some("."));
        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn blocked_worker_timeout_retains_lock_prevents_epoch_crossing_and_joins_on_drop() {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};
        use std::time::Duration;

        let root = std::env::temp_dir().join(format!("mv-journal-wblk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let path = session.join("journal.jsonl");
        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let sw = j.retain_witness(b"surface-block-seed").unwrap();
        let s_in = Input::Surface {
            id: "srf-block".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![sw]).unwrap();

        block_worker_on_next_flush(&session, Duration::from_millis(30));

        let pixels = b"blocked-worker-frame";
        let sha = sha256_hex(pixels);
        let fw = j.retain_frame_witness(&sha, pixels).unwrap();
        let f_in = Input::Frame {
            surface_id: "srf-block".into(),
            frame: Frame {
                sha256: sha,
                generation: 1,
                width: 64,
                height: 64,
            },
        };
        let out3 = state.apply(&f_in).unwrap();
        j.append(&f_in, &out3, &state, vec![fw]).unwrap();

        assert_eq!(j.flush_sync(), Err(JournalError::Io));
        assert_eq!(j.flush_sync(), Err(JournalError::Poisoned));

        assert!(matches!(
            Journal::recover(&path, &session),
            Err(JournalError::Locked)
        ));

        block_worker_on_next_flush(&session, Duration::from_millis(500));
        let path_clone = path.clone();
        let root_clone = session.clone();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            assert!(matches!(
                Journal::recover(&path_clone, &root_clone),
                Err(JournalError::Locked)
            ));
            release_blocked_worker(&root_clone);
        });

        drop(j);
        releaser.join().unwrap();

        let cp_after_drop: serde_json::Value =
            serde_json::from_slice(&fs::read(session.join("checkpoint.json")).unwrap()).unwrap();
        assert_eq!(cp_after_drop["count"], 2);
        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crash_point_torn_journal_on_append_recovers_committed_prefix() {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};

        let root = std::env::temp_dir().join(format!("mv-journal-ctorn-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let path = session.join("journal.jsonl");

        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let sw = j.retain_witness(b"surface-torn-seed").unwrap();
        let s_in = Input::Surface {
            id: "srf-torn".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![sw]).unwrap();
        let committed_state = state.clone();

        // Fault-injection kills the write mid-record on the next append, leaving events/3.json
        // and a torn non-LF-terminated line in journal.jsonl.
        fail_next_append_with_torn_journal(&session);
        let pixels = b"torn-frame-payload";
        let sha = sha256_hex(pixels);
        let fw = j.retain_frame_witness(&sha, pixels).unwrap();
        let f_in = Input::Frame {
            surface_id: "srf-torn".into(),
            frame: Frame {
                sha256: sha,
                generation: 1,
                width: 64,
                height: 64,
            },
        };
        let out3 = state.apply(&f_in).unwrap();
        assert_eq!(
            j.append(&f_in, &out3, &state, vec![fw]),
            Err(JournalError::Io)
        );
        drop(j);

        // Read-only scan detects MissingLf before recovery.
        assert_eq!(scan(&path, &session).unwrap_err(), JournalError::MissingLf);
        assert!(session.join("events/3.json").exists());

        // Journal::recover rolls back the torn tail and uncommitted sidecar, preserving prefix 1..=2.
        let (mut recovered, rec_state) = Journal::recover(&path, &session).unwrap();
        assert_eq!(rec_state, committed_state);
        assert_eq!(recovered.count, 2);
        assert!(!session.join("events/3.json").exists());
        assert_eq!(scan(&path, &session).unwrap().state, committed_state);

        // Subsequent append after recovery succeeds cleanly.
        let mut next_state = rec_state;
        let out_next = next_state.apply(&Input::Connect).unwrap();
        recovered
            .append(&Input::Connect, &out_next, &next_state, vec![])
            .unwrap();
        drop(recovered);
        assert_eq!(scan(&path, &session).unwrap().state, next_state);

        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crash_point_recover_preserves_proven_checkpoint_next_before_rename() {
        let root = std::env::temp_dir().join(format!("mv-journal-cnext-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let path = session.join("journal.jsonl");

        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let cp1 = fs::read(session.join("checkpoint.json")).unwrap();
        let out2 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out2, &state, vec![]).unwrap();
        drop(j);

        // Crash state: checkpoint.next has the proven count=2 checkpoint; checkpoint.json is missing/stale.
        fs::rename(
            session.join("checkpoint.json"),
            session.join("checkpoint.next"),
        )
        .unwrap();
        fs::write(session.join("checkpoint.json"), &cp1).unwrap();
        let next_ino_before = fs::metadata(session.join("checkpoint.next")).unwrap().ino();
        let next_bytes_before = fs::read(session.join("checkpoint.next")).unwrap();

        // Inject crash inside checkpoint() during recover before rename(checkpoint.next, checkpoint.json).
        fail_next_checkpoint_before_rename(&session);
        assert_eq!(
            Journal::recover(&path, &session).err(),
            Some(JournalError::Io)
        );

        // checkpoint.next must NOT have been deleted or truncated before its replacement was durable.
        assert!(session.join("checkpoint.next").exists());
        assert_eq!(
            fs::metadata(session.join("checkpoint.next")).unwrap().ino(),
            next_ino_before
        );
        assert_eq!(
            fs::read(session.join("checkpoint.next")).unwrap(),
            next_bytes_before
        );

        // Second recover attempt succeeds with count=2 intact.
        let (recovered, rec_state) = Journal::recover(&path, &session).unwrap();
        assert_eq!(rec_state, state);
        assert_eq!(recovered.count, 2);
        drop(recovered);
        assert!(!session.join("checkpoint.next").exists());
        assert_eq!(scan(&path, &session).unwrap().state, state);

        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crash_point_non_frame_append_syncs_dirs_before_journal_and_recovers() {
        use crate::admission::Surface;
        use crate::{Component, Endpoint};

        let root = std::env::temp_dir().join(format!("mv-journal-cdir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let path = session.join("journal.jsonl");

        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let committed_state = state.clone();

        // Retain witness unsynced, then commit a non-frame Surface record that references it,
        // injecting a crash right after journal.jsonl is synced (before checkpoint.next is written).
        let sw_bytes = b"surface-dir-order-witness";
        let sw_sha = sha256_hex(sw_bytes);
        let sw = j.retain_frame_witness(&sw_sha, sw_bytes).unwrap();
        let s_in = Input::Surface {
            id: "srf-dir".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        enable_sync_trace(&session);
        fail_next_after_journal_sync(&session);
        assert_eq!(
            j.append(&s_in, &out2, &state, vec![sw]),
            Err(JournalError::Io)
        );
        let trace = take_sync_trace(&session);
        drop(j);

        let pos = |entry: &str| {
            trace
                .iter()
                .position(|e| e == entry)
                .unwrap_or_else(|| panic!("missing {entry:?} in append trace: {trace:?}"))
        };
        let art_file_pos = pos(&format!("artifacts/{sw_sha}"));
        let ev_file_pos = pos("events/2.json");
        let art_dir_pos = pos("artifacts");
        let ev_dir_pos = pos("events");
        let journal_pos = pos("journal.jsonl");
        assert!(art_file_pos < art_dir_pos, "trace: {trace:?}");
        assert!(ev_file_pos < ev_dir_pos, "trace: {trace:?}");
        assert!(
            art_dir_pos < journal_pos && ev_dir_pos < journal_pos,
            "artifacts and events directories must be synced before journal.jsonl: {trace:?}"
        );

        // Recover rolls back the uncommitted record 2 and restores committed prefix count=1.
        let (recovered, rec_state) = Journal::recover(&path, &session).unwrap();
        assert_eq!(rec_state, committed_state);
        assert_eq!(recovered.count, 1);
        assert!(!session.join("events/2.json").exists());
        drop(recovered);

        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn dirty_file_eviction_and_worker_coalescing_never_drop_unsynced_files() {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};

        let root = std::env::temp_dir().join(format!("mv-journal-coal-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let sw = j.retain_witness(b"surface-coal-seed").unwrap();
        let s_in = Input::Surface {
            id: "srf-coal".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![sw]).unwrap();

        // Hold worker and dispatch > MAX_PENDING_SYNC_BATCHES (4) frame batches (40 frames total)
        // so batches coalesce in the worker queue without dropping any dirty witness or event file.
        hold_sync_worker_for_test(&session);
        enable_sync_trace(&session);
        let mut expected_files = Vec::new();
        for gen in 1..=40u64 {
            let bytes = format!("coalesced-frame-payload-{gen}").into_bytes();
            let sha = sha256_hex(&bytes);
            let fw = j.retain_frame_witness(&sha, &bytes).unwrap();
            let f_in = Input::Frame {
                surface_id: "srf-coal".into(),
                frame: Frame {
                    sha256: sha.clone(),
                    generation: gen,
                    width: 64,
                    height: 64,
                },
            };
            let out = state.apply(&f_in).unwrap();
            j.append(&f_in, &out, &state, vec![fw]).unwrap();
            expected_files.push(format!("artifacts/{sha}"));
            expected_files.push(format!("events/{}.json", gen + 2));
        }
        release_test_sync_hold(&session);
        j.flush_sync().unwrap();
        let trace = take_sync_trace(&session);
        let last_cp_pos = trace
            .iter()
            .rposition(|e| e == "checkpoint.next")
            .expect("checkpoint.next must be synced");
        for req in &expected_files {
            let p = trace.iter().position(|e| e == req).unwrap_or_else(|| {
                panic!("unsynced file {req:?} was dropped from fsync trace: {trace:?}")
            });
            assert!(
                p < last_cp_pos,
                "{req:?} synced at {p} after final checkpoint.next at {last_cp_pos}"
            );
        }
        drop(j);
        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn reconcile_worker_progress_keeps_in_flight_batch_tracked_until_durable() {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};
        use std::time::Duration;

        let root = std::env::temp_dir().join(format!("mv-journal-infl-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let sw = j.retain_witness(b"surface-infl-seed").unwrap();
        let s_in = Input::Surface {
            id: "srf-infl".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![sw]).unwrap();

        // Block the worker as soon as the idle timer pops st.staged into in_flight = true.
        block_worker_on_next_flush(&session, Duration::from_millis(500));
        let pixels = b"in-flight-frame-1";
        let sha = sha256_hex(pixels);
        let fw = j.retain_frame_witness(&sha, pixels).unwrap();
        let f_in = Input::Frame {
            surface_id: "srf-infl".into(),
            frame: Frame {
                sha256: sha,
                generation: 1,
                width: 64,
                height: 64,
            },
        };
        let out3 = state.apply(&f_in).unwrap();
        j.append(&f_in, &out3, &state, vec![fw]).unwrap();

        assert!(
            wait_until_worker_blocked(&session, Duration::from_millis(500)),
            "worker must enter blocked flush state after idle timer expires"
        );

        // Trigger reconcile_worker_progress while st.staged is None and st.in_flight is true.
        j.reconcile_worker_progress();
        assert_eq!(
            j.unsynced_frames, 1,
            "unsynced_frames must remain tracked while worker batch is in flight"
        );
        assert!(
            !j.dirty_files.is_empty() && j.pending_checkpoint.is_some(),
            "dirty_files and pending_checkpoint must not be drained before batch completion"
        );

        release_blocked_worker(&session);
        j.flush_sync().unwrap();
        assert_eq!(j.unsynced_frames, 0);
        assert!(j.dirty_files.is_empty());
        assert!(j.pending_checkpoint.is_none());
        assert_eq!(j.completed_sync_count(), 3);

        // Now inject a worker batch failure and verify reconcile_worker_progress does not
        // clear unsynced_frames/dirty_files when completed_checkpoint_count did not advance.
        fail_next_worker_batch(&session);
        let pixels2 = b"in-flight-frame-2-fail";
        let sha2 = sha256_hex(pixels2);
        let fw2 = j.retain_frame_witness(&sha2, pixels2).unwrap();
        let f_in2 = Input::Frame {
            surface_id: "srf-infl".into(),
            frame: Frame {
                sha256: sha2,
                generation: 2,
                width: 64,
                height: 64,
            },
        };
        let out4 = state.apply(&f_in2).unwrap();
        j.append(&f_in2, &out4, &state, vec![fw2]).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while !j.sync_failed.load(std::sync::atomic::Ordering::Acquire) {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        j.reconcile_worker_progress();
        assert_eq!(j.unsynced_frames, 1);
        assert!(!j.dirty_files.is_empty());
        assert_eq!(j.flush_sync(), Err(JournalError::Poisoned));

        drop(j);
        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crash_point_torn_checkpoint_next_does_not_veto_rollback() {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};

        let root = std::env::temp_dir().join(format!("mv-journal-n1-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let path = session.join("journal.jsonl");

        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let sw = j.retain_witness(b"surface-n1-seed").unwrap();
        let s_in = Input::Surface {
            id: "srf-n1".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![sw]).unwrap();
        let committed_state = state.clone();

        // 1. Fault-inject a crash while writing checkpoint.next during append of record 3.
        // Canonical Checkpoint JSON starts with {"archive":..., so a truncated genuine
        // checkpoint.next must never veto rollback to committed prefix count=2.
        fail_next_append_with_torn_checkpoint_next(&session);
        let pixels = b"n1-frame-1";
        let sha = sha256_hex(pixels);
        let fw = j.retain_frame_witness(&sha, pixels).unwrap();
        let f_in = Input::Frame {
            surface_id: "srf-n1".into(),
            frame: Frame {
                sha256: sha,
                generation: 1,
                width: 64,
                height: 64,
            },
        };
        let mut state3 = state.clone();
        let out3 = state3.apply(&f_in).unwrap();
        assert_eq!(
            j.append(&f_in, &out3, &state3, vec![fw]),
            Err(JournalError::Io)
        );
        drop(j);

        let torn_next = fs::read(session.join("checkpoint.next")).unwrap();
        assert!(torn_next.starts_with(b"{\"archive\":\""));
        assert!(parse::<Checkpoint>(&torn_next).is_err());

        let (mut recovered, rec_state) = Journal::recover(&path, &session).unwrap();
        assert_eq!(rec_state, committed_state);
        assert_eq!(recovered.count, 2);
        assert!(!session.join("checkpoint.next").exists());
        assert!(!session.join("events/3.json").exists());

        // 2. Also test torn journal.jsonl tail combined with a truncated genuine checkpoint.next.
        let canonical_cp = fs::read(session.join("checkpoint.json")).unwrap();
        fail_next_append_with_torn_journal(&session);
        let pixels2 = b"n1-frame-2";
        let sha2 = sha256_hex(pixels2);
        let fw2 = recovered.retain_frame_witness(&sha2, pixels2).unwrap();
        let f_in2 = Input::Frame {
            surface_id: "srf-n1".into(),
            frame: Frame {
                sha256: sha2,
                generation: 1,
                width: 64,
                height: 64,
            },
        };
        let mut state3b = rec_state.clone();
        let out3b = state3b.apply(&f_in2).unwrap();
        assert_eq!(
            recovered.append(&f_in2, &out3b, &state3b, vec![fw2]),
            Err(JournalError::Io)
        );
        drop(recovered);
        fs::write(
            session.join("checkpoint.next"),
            &canonical_cp[..canonical_cp.len() / 2],
        )
        .unwrap();

        let (recovered2, rec_state2) = Journal::recover(&path, &session).unwrap();
        assert_eq!(rec_state2, committed_state);
        assert_eq!(recovered2.count, 2);
        drop(recovered2);

        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crash_point_rollback_cleans_sidecars_before_truncate_and_survives_mid_cleanup_crash() {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};

        let root = std::env::temp_dir().join(format!("mv-journal-n2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let path = session.join("journal.jsonl");

        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let sw = j.retain_witness(b"surface-n2-seed").unwrap();
        let s_in = Input::Surface {
            id: "srf-n2".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![sw]).unwrap();
        let committed_state = state.clone();

        // Multi-frame uncommitted tail: Frame 3 is staged unsynced, Frame 4 tears journal.jsonl.
        hold_sync_worker_for_test(&session);
        let p3 = b"n2-frame-3";
        let sha3 = sha256_hex(p3);
        let fw3 = j.retain_frame_witness(&sha3, p3).unwrap();
        let f_in3 = Input::Frame {
            surface_id: "srf-n2".into(),
            frame: Frame {
                sha256: sha3,
                generation: 1,
                width: 64,
                height: 64,
            },
        };
        let out3 = state.apply(&f_in3).unwrap();
        j.append(&f_in3, &out3, &state, vec![fw3]).unwrap();

        fail_next_append_with_torn_journal(&session);
        let p4 = b"n2-frame-4";
        let sha4 = sha256_hex(p4);
        let fw4 = j.retain_frame_witness(&sha4, p4).unwrap();
        let f_in4 = Input::Frame {
            surface_id: "srf-n2".into(),
            frame: Frame {
                sha256: sha4,
                generation: 2,
                width: 64,
                height: 64,
            },
        };
        let out4 = state.apply(&f_in4).unwrap();
        assert_eq!(
            j.append(&f_in4, &out4, &state, vec![fw4]),
            Err(JournalError::Io)
        );
        release_test_sync_hold(&session);
        drop(j);

        assert!(session.join("events/3.json").exists());
        assert!(session.join("events/4.json").exists());

        // Simulate a mid-cleanup crash where events/3.json (+1) was removed after journal
        // truncation on the buggy ordering, leaving stale events/4.json (+2) behind.
        fs::remove_file(session.join("events/3.json")).unwrap();

        enable_sync_trace(&session);
        let (mut recovered, rec_state) = Journal::recover(&path, &session).unwrap();
        let trace = take_sync_trace(&session);
        assert_eq!(rec_state, committed_state);
        assert_eq!(recovered.count, 2);
        assert!(!session.join("events/3.json").exists());
        assert!(
            !session.join("events/4.json").exists(),
            "stale events/4.json (+2) must be removed during rollback"
        );

        let events_dir_pos = trace
            .iter()
            .rposition(|e| e == "events")
            .expect("events dir must be synced after sidecar cleanup");
        let artifacts_dir_pos = trace
            .iter()
            .rposition(|e| e == "artifacts")
            .expect("artifacts dir must be synced after sidecar cleanup");
        let journal_sync_pos = trace
            .iter()
            .rposition(|e| e == "journal.jsonl")
            .expect("journal.jsonl must be synced after truncation");
        assert!(
            events_dir_pos < journal_sync_pos && artifacts_dir_pos < journal_sync_pos,
            "sidecar directories must be synced after cleanup and before journal.jsonl truncation sync: {trace:?}"
        );

        // Appending at seq=3 (+1) and seq=4 (+2) must succeed without colliding with stale events/4.json.
        let mut next_state = rec_state;
        let out_a = next_state.apply(&Input::Connect).unwrap();
        recovered
            .append(&Input::Connect, &out_a, &next_state, vec![])
            .unwrap();
        let out_b = next_state.apply(&Input::Connect).unwrap();
        recovered
            .append(&Input::Connect, &out_b, &next_state, vec![])
            .unwrap();
        assert_eq!(recovered.count, 4);
        drop(recovered);
        assert_eq!(scan(&path, &session).unwrap().state, next_state);

        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crash_point_torn_event_sidecar_alone_recovers_committed_prefix() {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};

        let root = std::env::temp_dir().join(format!("mv-journal-n3-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let path = session.join("journal.jsonl");

        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let sw = j.retain_witness(b"surface-n3-seed").unwrap();
        let s_in = Input::Surface {
            id: "srf-n3".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![sw]).unwrap();
        let committed_state = state.clone();

        // Inject a crash between publishing events/3.json (leaving a torn sidecar) and writing journal.jsonl.
        fail_next_append_with_torn_event_sidecar(&session);
        let pixels = b"n3-frame-payload";
        let sha = sha256_hex(pixels);
        let fw = j.retain_frame_witness(&sha, pixels).unwrap();
        let f_in = Input::Frame {
            surface_id: "srf-n3".into(),
            frame: Frame {
                sha256: sha,
                generation: 1,
                width: 64,
                height: 64,
            },
        };
        let mut state3 = state.clone();
        let out3 = state3.apply(&f_in).unwrap();
        assert_eq!(
            j.append(&f_in, &out3, &state3, vec![fw]),
            Err(JournalError::Io)
        );
        drop(j);

        // Read-only scan reports Unsealed because events/3.json exists beyond count=2.
        assert_eq!(scan(&path, &session).unwrap_err(), JournalError::Unsealed);
        assert!(session.join("events/3.json").exists());

        // Recovery must roll back the torn sidecar and recover the intact committed prefix count=2.
        let (mut recovered, rec_state) = Journal::recover(&path, &session).unwrap();
        assert_eq!(rec_state, committed_state);
        assert_eq!(recovered.count, 2);
        assert!(!session.join("events/3.json").exists());

        let mut next_state = rec_state;
        let out_next = next_state.apply(&Input::Connect).unwrap();
        recovered
            .append(&Input::Connect, &out_next, &next_state, vec![])
            .unwrap();
        drop(recovered);
        assert_eq!(scan(&path, &session).unwrap().state, next_state);

        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crash_point_rollback_and_recover_reclaim_orphan_uncommitted_artifacts() {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};

        let root = std::env::temp_dir().join(format!("mv-journal-n4-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let path = session.join("journal.jsonl");

        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let sw = j.retain_witness(b"surface-n4-committed").unwrap();
        let s_in = Input::Surface {
            id: "srf-n4".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![sw.clone()]).unwrap();
        let committed_state = state.clone();

        // Retain several uncommitted frame artifacts and crash during append of frame 3.
        let mut orphan_shas = Vec::new();
        for i in 0..4u32 {
            let b = format!("orphan-artifact-batch1-{i}").into_bytes();
            let s = sha256_hex(&b);
            j.retain_frame_witness(&s, &b).unwrap();
            orphan_shas.push(s);
        }
        fail_next_append_with_torn_journal(&session);
        let p_crash = b"orphan-artifact-torn-frame";
        let sha_crash = sha256_hex(p_crash);
        let fw_crash = j.retain_frame_witness(&sha_crash, p_crash).unwrap();
        orphan_shas.push(sha_crash.clone());
        let f_in = Input::Frame {
            surface_id: "srf-n4".into(),
            frame: Frame {
                sha256: sha_crash,
                generation: 1,
                width: 64,
                height: 64,
            },
        };
        let mut state3 = state.clone();
        let out3 = state3.apply(&f_in).unwrap();
        assert_eq!(
            j.append(&f_in, &out3, &state3, vec![fw_crash]),
            Err(JournalError::Io)
        );
        drop(j);

        for s in &orphan_shas {
            assert!(session.join("artifacts").join(s).exists());
        }

        let (mut recovered, rec_state) = Journal::recover(&path, &session).unwrap();
        assert_eq!(rec_state, committed_state);
        for s in &orphan_shas {
            assert!(
                !session.join("artifacts").join(s).exists(),
                "orphan artifact {s} must be removed on rollback"
            );
        }
        assert!(session.join("artifacts").join(&sw.sha256).exists());

        // Also test crashing after retain_frame_witness alone (before any append writes events/journal).
        let mut standalone_orphans = Vec::new();
        for i in 0..3u32 {
            let b = format!("orphan-artifact-standalone-{i}").into_bytes();
            let s = sha256_hex(&b);
            recovered.retain_frame_witness(&s, &b).unwrap();
            standalone_orphans.push(s);
        }
        drop(recovered);

        let (recovered2, rec_state2) = Journal::recover(&path, &session).unwrap();
        assert_eq!(rec_state2, committed_state);
        for s in &standalone_orphans {
            assert!(
                !session.join("artifacts").join(s).exists(),
                "standalone orphan artifact {s} must be removed on recover"
            );
        }
        assert!(session.join("artifacts").join(&sw.sha256).exists());
        drop(recovered2);

        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crash_point_recover_twice_after_crash_at_each_recovery_step_is_idempotent() {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};

        let steps = [
            RecoveryCrashStep::FirstEventSidecarRemoved,
            RecoveryCrashStep::EventsCleanedBeforeEventsDirSync,
            RecoveryCrashStep::FirstOrphanArtifactRemoved,
            RecoveryCrashStep::SidecarsSyncedBeforeJournalTruncate,
            RecoveryCrashStep::JournalTruncateBeforeJournalSync,
            RecoveryCrashStep::JournalSyncBeforePendingRemove,
            RecoveryCrashStep::PendingRemoveBeforeRootDirSync,
        ];

        let tree_digest = |session: &Path| -> Vec<(String, String)> {
            let mut out = Vec::new();
            for rel in ["", "events", "artifacts"] {
                let dir = if rel.is_empty() {
                    session.to_path_buf()
                } else {
                    session.join(rel)
                };
                let mut paths: Vec<_> = fs::read_dir(&dir)
                    .unwrap()
                    .map(|e| e.unwrap().path())
                    .collect();
                paths.sort();
                for p in paths {
                    if fs::symlink_metadata(&p).unwrap().is_file() {
                        let name = p
                            .strip_prefix(session)
                            .unwrap()
                            .to_string_lossy()
                            .into_owned();
                        let sha = sha256_hex(&fs::read(&p).unwrap());
                        out.push((name, sha));
                    }
                }
            }
            out
        };

        let mut expected_tree: Option<Vec<(String, String)>> = None;
        let mut expected_snapshot: Option<Vec<u8>> = None;

        for (idx, step) in steps.into_iter().enumerate() {
            let root =
                std::env::temp_dir().join(format!("mv-journal-idem-{}-{idx}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
            let mut state = CoreState::session("session-1").unwrap();
            let mut j = Journal::create(&root, &state).unwrap();
            let session = root.join("sessions/session-1");
            let path = session.join("journal.jsonl");

            let out1 = state.apply(&Input::Connect).unwrap();
            j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
            let sw = j.retain_witness(b"surface-idem-committed").unwrap();
            let s_in = Input::Surface {
                id: "srf-idem".into(),
                surface: Surface {
                    display: ":42".into(),
                    owner: Endpoint {
                        component: Component::Agent,
                        instance: "agent-1".into(),
                    },
                    agent_controlled: true,
                    live: true,
                    frame: None,
                    refresh_after: None,
                    allowed_verbs: vec![],
                },
            };
            let out2 = state.apply(&s_in).unwrap();
            j.append(&s_in, &out2, &state, vec![sw.clone()]).unwrap();
            let committed_state = state.clone();

            // Create a multi-frame torn tail + extra orphan artifact + torn checkpoint.next.
            hold_sync_worker_for_test(&session);
            let orphan_extra = b"idem-extra-orphan";
            j.retain_frame_witness(&sha256_hex(orphan_extra), orphan_extra)
                .unwrap();

            let p3 = b"idem-frame-3";
            let sha3 = sha256_hex(p3);
            let fw3 = j.retain_frame_witness(&sha3, p3).unwrap();
            let f_in3 = Input::Frame {
                surface_id: "srf-idem".into(),
                frame: Frame {
                    sha256: sha3,
                    generation: 1,
                    width: 64,
                    height: 64,
                },
            };
            let out3 = state.apply(&f_in3).unwrap();
            j.append(&f_in3, &out3, &state, vec![fw3]).unwrap();

            fail_next_append_with_torn_journal(&session);
            let p4 = b"idem-frame-4";
            let sha4 = sha256_hex(p4);
            let fw4 = j.retain_frame_witness(&sha4, p4).unwrap();
            let f_in4 = Input::Frame {
                surface_id: "srf-idem".into(),
                frame: Frame {
                    sha256: sha4,
                    generation: 2,
                    width: 64,
                    height: 64,
                },
            };
            let out4 = state.apply(&f_in4).unwrap();
            assert_eq!(
                j.append(&f_in4, &out4, &state, vec![fw4]),
                Err(JournalError::Io)
            );
            release_test_sync_hold(&session);
            drop(j);

            // [TARGET, unit decision] Make the torn-next fixture explicit: a
            // valid newer checkpoint must now win over the older committed one.
            let next_path = session.join("checkpoint.next");
            let next = fs::read(&next_path).unwrap();
            fs::write(&next_path, &next[..next.len() / 2]).unwrap();

            // First recover crashes at `step`.
            fail_next_recovery_at_step(&session, step);
            assert_eq!(
                Journal::recover(&path, &session).err(),
                Some(JournalError::Io),
                "step {step:?} must trigger injected recovery failure"
            );

            // Second recover must succeed and reach the exact same clean state at count=2.
            let (recovered, rec_state) = Journal::recover(&path, &session)
                .unwrap_or_else(|e| panic!("second recover failed after {step:?}: {e:?}"));
            assert_eq!(rec_state, committed_state, "state mismatch after {step:?}");
            assert_eq!(recovered.count, 2, "count mismatch after {step:?}");
            drop(recovered);

            assert!(!session.join("checkpoint.next").exists());
            assert!(!session.join("events/3.json").exists());
            assert!(!session.join("events/4.json").exists());
            let cur_tree = tree_digest(&session);
            let cur_snap = rec_state.snapshot().unwrap();
            if let Some(ref exp) = expected_tree {
                assert_eq!(&cur_tree, exp, "tree digest diverged after {step:?}");
            } else {
                expected_tree = Some(cur_tree);
            }
            if let Some(ref exp_s) = expected_snapshot {
                assert_eq!(&cur_snap, exp_s, "snapshot diverged after {step:?}");
            } else {
                expected_snapshot = Some(cur_snap);
            }

            // Verify a subsequent recover and appends at seq=3,4 succeed.
            let (mut recovered2, mut next_state) = Journal::recover(&path, &session).unwrap();
            let out_a = next_state.apply(&Input::Connect).unwrap();
            recovered2
                .append(&Input::Connect, &out_a, &next_state, vec![])
                .unwrap();
            let out_b = next_state.apply(&Input::Connect).unwrap();
            recovered2
                .append(&Input::Connect, &out_b, &next_state, vec![])
                .unwrap();
            drop(recovered2);
            assert_eq!(scan(&path, &session).unwrap().state, next_state);

            clear_root_hooks(&session);
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn rv11_01_dirty_handle_eviction_syncs_before_remove_and_preserves_durability() {
        use crate::admission::Surface;
        use crate::{Component, Endpoint};

        let root = std::env::temp_dir().join(format!("mv-journal-rv11-01-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");
        let path = session.join("journal.jsonl");

        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let w0_bytes = b"rv11-01-committed-w0";
        let w0_sha = sha256_hex(w0_bytes);
        let w0 = j.retain_witness(w0_bytes).unwrap();
        let s_in = Input::Surface {
            id: "srf-rv11-01".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![w0.clone()]).unwrap();

        // External deletion of committed W0, then re-retain W0 unsynced followed by 32 fresh retains.
        fs::remove_file(session.join("artifacts").join(&w0_sha)).unwrap();
        enable_sync_trace(&session);
        j.retain_frame_witness(&w0_sha, w0_bytes).unwrap();
        for i in 0..32u32 {
            let b = format!("rv11-01-retain-{i}").into_bytes();
            let s = sha256_hex(&b);
            j.retain_frame_witness(&s, &b).unwrap();
        }
        assert_eq!(unsynced_dirty_evictions(&session), 0);
        let trace = take_sync_trace(&session);
        assert!(
            trace.contains(&format!("artifacts/{w0_sha}")),
            "evicted committed witness W0 must be fsynced before removal from dirty_files: {trace:?}"
        );

        // Negative control: 40 fresh retains keep <= 32 uncommitted files in artifacts/ (+1 committed W0),
        // delete the oldest uncommitted, verify cleanly, and keep unsynced_dirty_evictions at 0.
        let mut fresh_witnesses = Vec::new();
        for i in 0..40u32 {
            let b = format!("rv11-01-neg-fresh-{i}").into_bytes();
            let s = sha256_hex(&b);
            let fw = j.retain_frame_witness(&s, &b).unwrap();
            fresh_witnesses.push((i, fw));
        }
        assert_eq!(unsynced_dirty_evictions(&session), 0);
        let uncommitted_on_disk: Vec<_> = fs::read_dir(session.join("artifacts"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy() != w0_sha)
            .collect();
        assert!(
            uncommitted_on_disk.len() <= MAX_UNCOMMITTED_ARTIFACTS,
            "expected <= {MAX_UNCOMMITTED_ARTIFACTS} uncommitted artifacts, got {}",
            uncommitted_on_disk.len()
        );
        assert!(
            !session
                .join("artifacts")
                .join(&fresh_witnesses[0].1.sha256)
                .exists(),
            "oldest uncommitted artifact must be evicted"
        );
        for (_, fw) in fresh_witnesses.iter().skip(8) {
            verify_witness(&session, fw).unwrap();
        }
        j.close().unwrap();
        assert_eq!(scan(&path, &session).unwrap().state, state);
        clear_root_hooks(&session);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rv11_02_staged_checkpoint_count_updates_only_after_checkpoint_unsynced_succeeds() {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};

        let root = std::env::temp_dir().join(format!("mv-journal-rv11-02-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");

        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let sw = j.retain_witness(b"rv11-02-surface").unwrap();
        let s_in = Input::Surface {
            id: "srf-rv11-02".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![sw]).unwrap();

        hold_sync_worker_for_test(&session);
        for gen in 1..=8u64 {
            let b = format!("rv11-02-frame-{gen}").into_bytes();
            let sha = sha256_hex(&b);
            let fw = j.retain_frame_witness(&sha, &b).unwrap();
            let f_in = Input::Frame {
                surface_id: "srf-rv11-02".into(),
                frame: Frame {
                    sha256: sha,
                    generation: gen,
                    width: 64,
                    height: 64,
                },
            };
            let out = state.apply(&f_in).unwrap();
            j.append(&f_in, &out, &state, vec![fw]).unwrap();
        }
        assert_eq!(*j.checkpoint_lock.lock().unwrap(), 10);

        // Swap checkpoint.next for an empty directory so the 9th frame's checkpoint_unsynced fails.
        let cp_next = session.join("checkpoint.next");
        let saved_next = fs::read(&cp_next).unwrap();
        fs::remove_file(&cp_next).unwrap();
        fs::DirBuilder::new().mode(0o700).create(&cp_next).unwrap();

        let b9 = b"rv11-02-frame-9";
        let sha9 = sha256_hex(b9);
        let fw9 = j.retain_frame_witness(&sha9, b9).unwrap();
        let f_in9 = Input::Frame {
            surface_id: "srf-rv11-02".into(),
            frame: Frame {
                sha256: sha9,
                generation: 9,
                width: 64,
                height: 64,
            },
        };
        let mut state9 = state.clone();
        let out9 = state9.apply(&f_in9).unwrap();
        assert!(j.append(&f_in9, &out9, &state9, vec![fw9]).is_err());
        assert_eq!(
            *j.checkpoint_lock.lock().unwrap(),
            10,
            "staged checkpoint count must remain at 10 when 9th frame checkpoint staging fails"
        );

        // Restore checkpoint.next, unpoison for worker drain verification, release hold, and close.
        fs::remove_dir(&cp_next).unwrap();
        fs::write(&cp_next, &saved_next).unwrap();
        release_test_sync_hold(&session);
        drop(j);

        // Negative control: 9 frames without sabotage advance checkpoint.json to the final count after flush.
        let root_ok =
            std::env::temp_dir().join(format!("mv-journal-rv11-02-ok-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root_ok);
        fs::DirBuilder::new().mode(0o700).create(&root_ok).unwrap();
        let mut state_ok = CoreState::session("session-ok").unwrap();
        let mut j_ok = Journal::create(&root_ok, &state_ok).unwrap();
        let session_ok = root_ok.join("sessions/session-ok");
        let out1_ok = state_ok.apply(&Input::Connect).unwrap();
        j_ok.append(&Input::Connect, &out1_ok, &state_ok, vec![])
            .unwrap();
        let sw_ok = j_ok.retain_witness(b"rv11-02-surface-ok").unwrap();
        let out2_ok = state_ok.apply(&s_in).unwrap();
        j_ok.append(&s_in, &out2_ok, &state_ok, vec![sw_ok])
            .unwrap();
        hold_sync_worker_for_test(&session_ok);
        for gen in 1..=9u64 {
            let b = format!("rv11-02-ok-frame-{gen}").into_bytes();
            let sha = sha256_hex(&b);
            let fw = j_ok.retain_frame_witness(&sha, &b).unwrap();
            let f_in = Input::Frame {
                surface_id: "srf-rv11-02".into(),
                frame: Frame {
                    sha256: sha,
                    generation: gen,
                    width: 64,
                    height: 64,
                },
            };
            let out = state_ok.apply(&f_in).unwrap();
            j_ok.append(&f_in, &out, &state_ok, vec![fw]).unwrap();
        }
        release_test_sync_hold(&session_ok);
        j_ok.close().unwrap();
        let cp_ok: Checkpoint =
            serde_json::from_slice(&fs::read(session_ok.join("checkpoint.json")).unwrap()).unwrap();
        assert_eq!(cp_ok.count, 11);

        clear_root_hooks(&session);
        clear_root_hooks(&session_ok);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(root_ok).unwrap();
    }
    #[test]
    fn rv11_03_and_04_barrier_flush_keeps_worker_alive_and_held_close_times_out() {
        use crate::admission::{Frame, Surface};
        use crate::{Component, Endpoint};
        use std::time::Duration;

        let root =
            std::env::temp_dir().join(format!("mv-journal-rv11-03-04-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session = root.join("sessions/session-1");

        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
        let sw = j.retain_witness(b"rv11-03-04-surface").unwrap();
        let s_in = Input::Surface {
            id: "srf-rv11-03".into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        };
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![sw]).unwrap();

        // RV11-04: 8 frames spawn worker; back-to-back flush_sync() calls keep worker Some.
        for gen in 1..=8u64 {
            let b = format!("rv11-04-frame-{gen}").into_bytes();
            let sha = sha256_hex(&b);
            let fw = j.retain_frame_witness(&sha, &b).unwrap();
            let f_in = Input::Frame {
                surface_id: "srf-rv11-03".into(),
                frame: Frame {
                    sha256: sha,
                    generation: gen,
                    width: 64,
                    height: 64,
                },
            };
            let out = state.apply(&f_in).unwrap();
            j.append(&f_in, &out, &state, vec![fw]).unwrap();
        }
        assert!(j.sync_worker.is_some());
        j.flush_sync().unwrap();
        assert!(
            j.sync_worker.is_some(),
            "flush_sync must synchronize via Barrier without destroying the worker thread"
        );
        j.flush_sync().unwrap();
        assert!(
            j.sync_worker.is_some(),
            "back-to-back flush_sync calls must keep worker Some"
        );

        // RV11-03 negative control: helper thread releasing the hold after 100ms allows close() to succeed.
        hold_sync_worker_for_test(&session);
        for gen in 9..=16u64 {
            let b = format!("rv11-03-release-frame-{gen}").into_bytes();
            let sha = sha256_hex(&b);
            let fw = j.retain_frame_witness(&sha, &b).unwrap();
            let f_in = Input::Frame {
                surface_id: "srf-rv11-03".into(),
                frame: Frame {
                    sha256: sha,
                    generation: gen,
                    width: 64,
                    height: 64,
                },
            };
            let out = state.apply(&f_in).unwrap();
            j.append(&f_in, &out, &state, vec![fw]).unwrap();
        }
        let session_clone = session.clone();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            release_test_sync_hold(&session_clone);
        });
        j.close().unwrap();
        releaser.join().unwrap();
        assert!(
            j.sync_worker.is_none(),
            "close() must join the sync worker thread after barrier flush"
        );
        let cp_promoted: Checkpoint =
            serde_json::from_slice(&fs::read(session.join("checkpoint.json")).unwrap()).unwrap();
        assert_eq!(cp_promoted.count, 18);
        drop(j);

        // RV11-03 positive: held worker without release causes close() to return Err(Io) and poison journal.
        let root_to =
            std::env::temp_dir().join(format!("mv-journal-rv11-03-to-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root_to);
        fs::DirBuilder::new().mode(0o700).create(&root_to).unwrap();
        let mut state_to = CoreState::session("session-to").unwrap();
        let mut j_to = Journal::create(&root_to, &state_to).unwrap();
        let session_to = root_to.join("sessions/session-to");
        let out1_to = state_to.apply(&Input::Connect).unwrap();
        j_to.append(&Input::Connect, &out1_to, &state_to, vec![])
            .unwrap();
        let sw_to = j_to.retain_witness(b"rv11-03-surface-to").unwrap();
        let out2_to = state_to.apply(&s_in).unwrap();
        j_to.append(&s_in, &out2_to, &state_to, vec![sw_to])
            .unwrap();
        set_worker_join_timeout_for_test(&session_to, Duration::from_millis(150));
        hold_sync_worker_for_test(&session_to);
        for gen in 1..=8u64 {
            let b = format!("rv11-03-to-frame-{gen}").into_bytes();
            let sha = sha256_hex(&b);
            let fw = j_to.retain_frame_witness(&sha, &b).unwrap();
            let f_in = Input::Frame {
                surface_id: "srf-rv11-03".into(),
                frame: Frame {
                    sha256: sha,
                    generation: gen,
                    width: 64,
                    height: 64,
                },
            };
            let out = state_to.apply(&f_in).unwrap();
            j_to.append(&f_in, &out, &state_to, vec![fw]).unwrap();
        }
        assert_eq!(j_to.close(), Err(JournalError::Io));
        assert!(j_to.poisoned);
        release_test_sync_hold(&session_to);
        drop(j_to);

        clear_root_hooks(&session);
        clear_root_hooks(&session_to);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(root_to).unwrap();
    }

    fn make_surface_input(id: &str) -> Input {
        use crate::admission::Surface;
        use crate::{Component, Endpoint};
        Input::Surface {
            id: id.into(),
            surface: Surface {
                display: ":42".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent-1".into(),
                },
                agent_controlled: true,
                live: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        }
    }

    #[test]
    fn unchanged_frame_fast_path_preserves_digest_grant_poison_and_linkage() {
        use crate::admission::Frame;
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("mv-journal-fastpath-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let session_dir = root.join("sessions/session-fast");

        let mut authority =
            crate::admission::Authority::create(&root, CoreState::session("session-fast").unwrap())
                .unwrap();
        let o1 = authority.apply(Input::Connect).unwrap();
        assert_eq!(o1.reason, None);
        let epoch = authority.state().epoch;
        let s_in = make_surface_input("srf-fast");
        let sw = authority.retain_witness(b"srf-fast-init").unwrap();
        let o2 = authority.apply_with_witnesses(s_in, vec![sw]).unwrap();
        assert_eq!(o2.reason, None);

        let payload_a = vec![0x42_u8; 65536 + 1024];
        let sha_a = sha256_hex(&payload_a);
        let shm_path = root.join("frame-a.shm");
        {
            let mut f = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&shm_path)
                .unwrap();
            f.write_all(&payload_a).unwrap();
            f.sync_all().unwrap();
        }
        let shm_file = File::open(&shm_path).unwrap();

        // First frame for srf-fast has no prior committed witness: must run full SHA-256.
        let v1 = VerifiedPixels::read_verified_for_surface(
            &session_dir,
            "srf-fast",
            epoch,
            1,
            1280,
            900,
            &shm_file,
            payload_a.len(),
            &sha_a,
        )
        .unwrap();
        assert!(!v1.hash_skipped(), "first frame must not skip SHA-256");
        assert!(v1.hash_ns() > 0, "first frame must record hash_ns > 0");
        assert_eq!(v1.skipped_hash_ns(), 0);
        assert_eq!(v1.sha256(), sha_a);
        let fw1 = v1.retain_in_authority(&mut authority).unwrap();
        let o3 = authority
            .apply_with_witnesses(
                Input::Frame {
                    surface_id: "srf-fast".into(),
                    frame: Frame {
                        sha256: sha_a.clone(),
                        generation: 1,
                        width: 1280,
                        height: 900,
                    },
                },
                vec![fw1],
            )
            .unwrap();
        assert_eq!(o3.reason, None);

        // Unscoped read_verified never uses the fast path.
        let mut shm_unscoped = File::open(&shm_path).unwrap();
        let v_unscoped =
            VerifiedPixels::read_verified(&mut shm_unscoped, payload_a.len(), &sha_a).unwrap();
        assert!(
            !v_unscoped.hash_skipped(),
            "unscoped read_verified must always run full streaming SHA-256"
        );

        // Second frame with identical root, surface_id, epoch, advancing generation, geometry,
        // advertised digest, and identical bytes reuses witness via full-buffer memcmp.
        STAGE_TIMINGS.with(|c| c.set(FrameStageTimings::default()));
        let mut shm_reopen = File::open(&shm_path).unwrap();
        let t_read_start = std::time::Instant::now();
        let v2 = VerifiedPixels::read_verified_for_surface(
            &session_dir,
            "srf-fast",
            epoch,
            2,
            1280,
            900,
            &mut shm_reopen,
            payload_a.len(),
            &sha_a,
        )
        .unwrap();
        let total_read_elapsed = t_read_start.elapsed().as_nanos();
        assert!(
            v2.hash_skipped(),
            "unchanged frame must skip SHA-256 after full-buffer memcmp"
        );
        assert_eq!(v2.hash_ns(), 0, "unchanged frame must have hash_ns == 0");
        assert!(
            v2.skipped_hash_ns() > 0,
            "unchanged frame must record memcmp duration in skipped_hash_ns"
        );
        assert!(
            v2.shm_read_ns() + v2.skipped_hash_ns() <= total_read_elapsed,
            "shm_read_ns ({}) and skipped_hash_ns ({}) must be disjoint within total read ({})",
            v2.shm_read_ns(),
            v2.skipped_hash_ns(),
            total_read_elapsed
        );
        assert_eq!(v2.sha256(), sha_a);
        let st = STAGE_TIMINGS.with(|c| c.get());
        assert_eq!(st.skipped_hash_frames, 1);
        assert!(st.skipped_hash_ns > 0);

        let fw2 = v2.retain_in_authority(&mut authority).unwrap();
        let o4 = authority
            .apply_with_witnesses(
                Input::Frame {
                    surface_id: "srf-fast".into(),
                    frame: Frame {
                        sha256: sha_a.clone(),
                        generation: 2,
                        width: 1280,
                        height: 900,
                    },
                },
                vec![fw2],
            )
            .unwrap();
        assert_eq!(o4.reason, None);
        drop(authority);

        // Restart / recovery evicts the surface witness cache and never loads disk bytes
        // into the verified witness cache without computing SHA-256 over them.
        let (mut j, mut state) =
            Journal::recover(&session_dir.join("journal.jsonl"), &session_dir).unwrap();
        assert!(
            !j.has_committed_surface_witness("srf-fast", &sha_a),
            "journal recovery must start with an empty surface witness cache"
        );
        assert_eq!(j.committed_surface_witness_bytes(), 0);
        let vf_after_recover = j
            .verify_surface_frame("srf-fast", 3, &shm_file, payload_a.len(), &sha_a)
            .unwrap();
        assert!(
            !vf_after_recover.hash_skipped(),
            "first frame after journal recovery must compute full SHA-256"
        );
        assert!(vf_after_recover.hash_ns() > 0);

        // Commit generation 3 live so the in-memory witness cache is populated from verified bytes.
        let fw3 = j.retain_verified_pixels(&vf_after_recover).unwrap();
        let f3_in = Input::Frame {
            surface_id: "srf-fast".into(),
            frame: Frame {
                sha256: sha_a.clone(),
                generation: 3,
                width: 1280,
                height: 900,
            },
        };
        let out_f3 = state.apply(&f3_in).unwrap();
        j.append(&f3_in, &out_f3, &state, vec![fw3]).unwrap();
        assert!(j.has_committed_surface_witness("srf-fast", &sha_a));
        assert_eq!(j.committed_surface_witness_bytes(), payload_a.len());

        let t_vf_start = std::time::Instant::now();
        let vf_fast = j
            .verify_surface_frame("srf-fast", 4, &shm_file, payload_a.len(), &sha_a)
            .unwrap();
        let vf_elapsed = t_vf_start.elapsed().as_nanos();
        assert!(vf_fast.hash_skipped());
        assert_eq!(vf_fast.hash_ns(), 0);
        assert!(vf_fast.skipped_hash_ns() > 0);
        assert!(
            vf_fast.shm_read_ns() + vf_fast.skipped_hash_ns() <= vf_elapsed,
            "verify_surface_frame shm_read_ns and skipped_hash_ns must be disjoint"
        );
        assert_eq!(vf_fast.sha256(), sha_a);

        // Non-advancing generation (generation <= committed generation 3) must fall back to full verify.
        let vf_stale_gen = j
            .verify_surface_frame("srf-fast", 3, &shm_file, payload_a.len(), &sha_a)
            .unwrap();
        assert!(
            !vf_stale_gen.hash_skipped(),
            "non-advancing generation must fall back to full streaming SHA-256"
        );
        assert!(vf_stale_gen.hash_ns() > 0);

        // Geometry mismatch (different width or height) must fall back to full streaming SHA-256.
        let vf_geom_mismatch = j
            .verify_surface_frame_with_geometry(
                "srf-fast",
                4,
                640,
                1800,
                &shm_file,
                payload_a.len(),
                &sha_a,
            )
            .unwrap();
        assert!(
            !vf_geom_mismatch.hash_skipped(),
            "geometry change must fall back to full streaming SHA-256"
        );
        assert!(vf_geom_mismatch.hash_ns() > 0);

        // Permissive file mode (0o644) must be rejected after falling back.
        let bad_mode_path = root.join("frame-bad-mode.shm");
        fs::copy(&shm_path, &bad_mode_path).unwrap();
        fs::set_permissions(&bad_mode_path, fs::Permissions::from_mode(0o644)).unwrap();
        let bad_mode_file = File::open(&bad_mode_path).unwrap();
        assert_eq!(
            j.verify_surface_frame("srf-fast", 4, &bad_mode_file, payload_a.len(), &sha_a)
                .unwrap_err(),
            JournalError::Invalid
        );

        // Poison latch clears committed surface witnesses so fast path is disabled when poisoned.
        fail_next_witness_sync(&session_dir);
        let new_bytes = b"poison-trigger-witness-bytes";
        assert_eq!(j.retain_witness(new_bytes), Err(JournalError::Io));
        assert!(j.poisoned);
        assert_eq!(j.committed_surface_witness_bytes(), 0);
        assert_eq!(
            j.verify_surface_frame("srf-fast", 4, &shm_file, payload_a.len(), &sha_a)
                .unwrap_err(),
            JournalError::Poisoned
        );
        let mut shm_after_poison = File::open(&shm_path).unwrap();
        let v_after_poison = VerifiedPixels::read_verified_for_surface(
            &session_dir,
            "srf-fast",
            state.epoch,
            4,
            1280,
            900,
            &mut shm_after_poison,
            payload_a.len(),
            &sha_a,
        )
        .unwrap();
        assert!(
            !v_after_poison.hash_skipped(),
            "poisoned journal must evict its surface witnesses from the fast-path registry"
        );
        drop(j);
        clear_root_hooks(&session_dir);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unchanged_frame_mb_spoof_same_digest_changed_byte_forces_full_hash_and_refuses() {
        use crate::admission::Frame;
        let root = std::env::temp_dir().join(format!("mv-journal-mb-spoof-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();

        let mut state = CoreState::session("session-mb").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session_dir = root.join("sessions/session-mb");

        let out1 = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out1, &state, vec![]).unwrap();

        let s_in = make_surface_input("srf-mb");
        let sw = j.retain_witness(b"srf-mb-surface").unwrap();
        let out2 = state.apply(&s_in).unwrap();
        j.append(&s_in, &out2, &state, vec![sw]).unwrap();

        let payload_a = vec![0x7e_u8; 131_072];
        let sha_a = sha256_hex(&payload_a);
        let fw1 = j.retain_frame_witness(&sha_a, &payload_a).unwrap();
        let f1_in = Input::Frame {
            surface_id: "srf-mb".into(),
            frame: Frame {
                sha256: sha_a.clone(),
                generation: 1,
                width: 512,
                height: 256,
            },
        };
        let out3 = state.apply(&f1_in).unwrap();
        j.append(&f1_in, &out3, &state, vec![fw1]).unwrap();
        j.flush_sync().unwrap();

        let count_before = j.count;
        let lines_before = fs::read_to_string(session_dir.join("journal.jsonl"))
            .unwrap()
            .lines()
            .count();

        // M-B SPOOF-SAME-DIGEST: test middle byte, first byte (index 0), and last byte (len - 1).
        for flip_idx in [payload_a.len() / 2, 0, payload_a.len() - 1] {
            let mut spoofed = payload_a.clone();
            spoofed[flip_idx] ^= 0x01;
            let spoof_path = root.join(format!("spoof-{flip_idx}.shm"));
            {
                let mut f = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&spoof_path)
                    .unwrap();
                f.write_all(&spoofed).unwrap();
                f.sync_all().unwrap();
            }
            let spoof_file = File::open(&spoof_path).unwrap();

            let read_err = VerifiedPixels::read_verified_for_surface(
                &session_dir,
                "srf-mb",
                state.epoch,
                2,
                512,
                256,
                &spoof_file,
                spoofed.len(),
                &sha_a,
            )
            .unwrap_err();
            assert_eq!(
                read_err.kind(),
                std::io::ErrorKind::InvalidData,
                "spoofed byte at index {flip_idx} must fail read_verified_for_surface"
            );
            assert_eq!(
                j.verify_surface_frame("srf-mb", 2, &spoof_file, spoofed.len(), &sha_a)
                    .unwrap_err(),
                JournalError::Witness,
                "spoofed byte at index {flip_idx} must fail verify_surface_frame"
            );
            assert_eq!(
                j.retain_frame_witness(&sha_a, &spoofed),
                Err(JournalError::Witness)
            );
            assert_eq!(
                j.retain_verified_witness(&sha_a, &spoofed),
                Err(JournalError::Witness)
            );
        }

        // Length-mismatch attacks against a primed witness cache:
        // (a) Truncated by 1 byte (`len - 1`) advertising original `sha_a`.
        // (b) Extended by 1 byte (`len + 1`) advertising original `sha_a`.
        let trunc_bytes = &payload_a[..payload_a.len() - 1];
        let trunc_path = root.join("spoof-trunc.shm");
        {
            let mut f = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&trunc_path)
                .unwrap();
            f.write_all(trunc_bytes).unwrap();
            f.sync_all().unwrap();
        }
        let trunc_file = File::open(&trunc_path).unwrap();
        assert_eq!(
            VerifiedPixels::read_verified_for_surface(
                &session_dir,
                "srf-mb",
                state.epoch,
                2,
                512,
                256,
                &trunc_file,
                payload_a.len(),
                &sha_a,
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::InvalidData
        );
        assert_eq!(
            VerifiedPixels::read_verified_for_surface(
                &session_dir,
                "srf-mb",
                state.epoch,
                2,
                512,
                256,
                &trunc_file,
                trunc_bytes.len(),
                &sha_a,
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::InvalidData
        );
        assert_eq!(
            j.verify_surface_frame("srf-mb", 2, &trunc_file, payload_a.len(), &sha_a)
                .unwrap_err(),
            JournalError::Witness
        );
        assert_eq!(
            j.verify_surface_frame("srf-mb", 2, &trunc_file, trunc_bytes.len(), &sha_a)
                .unwrap_err(),
            JournalError::Witness
        );

        let mut ext_bytes = payload_a.clone();
        ext_bytes.push(0x7e);
        let ext_path = root.join("spoof-ext.shm");
        {
            let mut f = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&ext_path)
                .unwrap();
            f.write_all(&ext_bytes).unwrap();
            f.sync_all().unwrap();
        }
        let ext_file = File::open(&ext_path).unwrap();
        assert_eq!(
            VerifiedPixels::read_verified_for_surface(
                &session_dir,
                "srf-mb",
                state.epoch,
                2,
                512,
                256,
                &ext_file,
                payload_a.len(),
                &sha_a,
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::InvalidData
        );
        assert_eq!(
            VerifiedPixels::read_verified_for_surface(
                &session_dir,
                "srf-mb",
                state.epoch,
                2,
                512,
                256,
                &ext_file,
                ext_bytes.len(),
                &sha_a,
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::InvalidData
        );
        assert_eq!(
            j.verify_surface_frame("srf-mb", 2, &ext_file, payload_a.len(), &sha_a)
                .unwrap_err(),
            JournalError::Witness
        );
        assert_eq!(
            j.verify_surface_frame("srf-mb", 2, &ext_file, ext_bytes.len(), &sha_a)
                .unwrap_err(),
            JournalError::Witness
        );

        // No journal record may be appended on any spoofed or length-mismatched frame.
        assert_eq!(j.count, count_before);
        let lines_after = fs::read_to_string(session_dir.join("journal.jsonl"))
            .unwrap()
            .lines()
            .count();
        assert_eq!(lines_after, lines_before);

        // When the changed last byte is advertised with its true digest, full SHA-256 runs and succeeds.
        let last_idx = payload_a.len() - 1;
        let spoof_last_file = File::open(root.join(format!("spoof-{last_idx}.shm"))).unwrap();
        let mut spoof_last = payload_a.clone();
        spoof_last[last_idx] ^= 0x01;
        let sha_b = sha256_hex(&spoof_last);
        let verified_b = j
            .verify_surface_frame("srf-mb", 2, &spoof_last_file, spoof_last.len(), &sha_b)
            .unwrap();
        assert!(
            !verified_b.hash_skipped(),
            "changed payload byte must force full streaming SHA-256"
        );
        assert!(verified_b.hash_ns() > 0);
        assert_eq!(verified_b.sha256(), sha_b);

        drop(j);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unchanged_frame_scope_isolation_and_eviction_on_surface_lifecycle_and_epoch() {
        use crate::admission::{Frame, LifecycleUpdate};
        let root_a =
            std::env::temp_dir().join(format!("mv-journal-scope-a-{}", std::process::id()));
        let root_b =
            std::env::temp_dir().join(format!("mv-journal-scope-b-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root_a);
        let _ = fs::remove_dir_all(&root_b);
        fs::DirBuilder::new().mode(0o700).create(&root_a).unwrap();
        fs::DirBuilder::new().mode(0o700).create(&root_b).unwrap();

        let mut state_a = CoreState::session("session-scope").unwrap();
        let mut j_a = Journal::create(&root_a, &state_a).unwrap();
        let session_a = root_a.join("sessions/session-scope");
        let out_c = state_a.apply(&Input::Connect).unwrap();
        j_a.append(&Input::Connect, &out_c, &state_a, vec![])
            .unwrap();

        for sid in ["srf-a", "srf-b"] {
            let s_in = make_surface_input(sid);
            let sw = j_a.retain_witness(sid.as_bytes()).unwrap();
            let out_s = state_a.apply(&s_in).unwrap();
            j_a.append(&s_in, &out_s, &state_a, vec![sw]).unwrap();
        }

        let payload = vec![0x5a_u8; 32_768];
        let sha = sha256_hex(&payload);
        let fw1 = j_a.retain_frame_witness(&sha, &payload).unwrap();
        let f1_in = Input::Frame {
            surface_id: "srf-a".into(),
            frame: Frame {
                sha256: sha.clone(),
                generation: 1,
                width: 256,
                height: 128,
            },
        };
        let out_f1 = state_a.apply(&f1_in).unwrap();
        j_a.append(&f1_in, &out_f1, &state_a, vec![fw1]).unwrap();
        assert!(j_a.has_committed_surface_witness("srf-a", &sha));
        assert!(!j_a.has_committed_surface_witness("srf-b", &sha));

        // Same surface, same root, same epoch, advancing generation -> fast path hit.
        let v_same = VerifiedPixels::read_verified_for_surface(
            &session_a,
            "srf-a",
            state_a.epoch,
            2,
            256,
            128,
            &payload[..],
            payload.len(),
            &sha,
        )
        .unwrap();
        assert!(v_same.hash_skipped());

        // Different surface (`srf-b`) in the same session must NOT reuse `srf-a`'s witness.
        let v_other_surface = VerifiedPixels::read_verified_for_surface(
            &session_a,
            "srf-b",
            state_a.epoch,
            1,
            256,
            128,
            &payload[..],
            payload.len(),
            &sha,
        )
        .unwrap();
        assert!(
            !v_other_surface.hash_skipped(),
            "fast path must never reuse a witness across different surfaces"
        );

        // Different root (`session_b`) with identical surface_id and epoch must NOT reuse `session_a`.
        let session_b = root_b.join("sessions/session-scope");
        let v_other_root = VerifiedPixels::read_verified_for_surface(
            &session_b,
            "srf-a",
            state_a.epoch,
            2,
            256,
            128,
            &payload[..],
            payload.len(),
            &sha,
        )
        .unwrap();
        assert!(
            !v_other_root.hash_skipped(),
            "fast path must never reuse a witness across different session roots"
        );

        // Wrong epoch in read_verified_for_surface must NOT reuse the cached witness.
        let v_wrong_epoch = VerifiedPixels::read_verified_for_surface(
            &session_a,
            "srf-a",
            state_a.epoch + 1,
            2,
            256,
            128,
            &payload[..],
            payload.len(),
            &sha,
        )
        .unwrap();
        assert!(
            !v_wrong_epoch.hash_skipped(),
            "fast path must reject a mismatched epoch"
        );

        // Surface change (`LifecycleUpdate::Updated`) evicts the surface witness cache entry.
        let mut updated_surface = state_a.surfaces["srf-a"].clone();
        updated_surface.display = ":99".into();
        updated_surface.frame = None;
        let upd_in = Input::Lifecycle {
            surface_id: "srf-a".into(),
            update: LifecycleUpdate::Updated(updated_surface),
        };
        let out_upd = state_a.apply(&upd_in).unwrap();
        j_a.append(&upd_in, &out_upd, &state_a, vec![]).unwrap();
        assert!(
            !j_a.has_committed_surface_witness("srf-a", &sha),
            "LifecycleUpdate::Updated must evict the surface witness entry"
        );
        let v_after_upd = VerifiedPixels::read_verified_for_surface(
            &session_a,
            "srf-a",
            state_a.epoch,
            2,
            256,
            128,
            &payload[..],
            payload.len(),
            &sha,
        )
        .unwrap();
        assert!(!v_after_upd.hash_skipped());

        // Re-prime `srf-a` at generation 2, then verify `TakeControl` and `ReleaseControl` evict.
        let fw2 = j_a.retain_verified_pixels(&v_after_upd).unwrap();
        let f2_in = Input::Frame {
            surface_id: "srf-a".into(),
            frame: Frame {
                sha256: sha.clone(),
                generation: 2,
                width: 256,
                height: 128,
            },
        };
        let out_f2 = state_a.apply(&f2_in).unwrap();
        j_a.append(&f2_in, &out_f2, &state_a, vec![fw2]).unwrap();
        assert!(j_a.has_committed_surface_witness("srf-a", &sha));

        let tc_in = Input::TakeControl {
            surface_id: "srf-a".into(),
        };
        let out_tc = state_a.apply(&tc_in).unwrap();
        j_a.append(&tc_in, &out_tc, &state_a, vec![]).unwrap();
        assert!(
            !j_a.has_committed_surface_witness("srf-a", &sha),
            "TakeControl must evict the surface witness entry"
        );

        let rc_in = Input::ReleaseControl {
            surface_id: "srf-a".into(),
        };
        let out_rc = state_a.apply(&rc_in).unwrap();
        j_a.append(&rc_in, &out_rc, &state_a, vec![]).unwrap();

        // Re-prime `srf-a` at generation 3, then verify `LifecycleUpdate::Lost` evicts.
        let fw3 = j_a.retain_frame_witness(&sha, &payload).unwrap();
        let f3_in = Input::Frame {
            surface_id: "srf-a".into(),
            frame: Frame {
                sha256: sha.clone(),
                generation: 3,
                width: 256,
                height: 128,
            },
        };
        let out_f3 = state_a.apply(&f3_in).unwrap();
        j_a.append(&f3_in, &out_f3, &state_a, vec![fw3]).unwrap();
        assert!(j_a.has_committed_surface_witness("srf-a", &sha));

        let lost_in = Input::Lifecycle {
            surface_id: "srf-a".into(),
            update: LifecycleUpdate::Lost,
        };
        let out_lost = state_a.apply(&lost_in).unwrap();
        j_a.append(&lost_in, &out_lost, &state_a, vec![]).unwrap();
        assert!(
            !j_a.has_committed_surface_witness("srf-a", &sha),
            "LifecycleUpdate::Lost must evict the surface witness entry"
        );
        let v_after_lost = VerifiedPixels::read_verified_for_surface(
            &session_a,
            "srf-a",
            state_a.epoch,
            4,
            256,
            128,
            &payload[..],
            payload.len(),
            &sha,
        )
        .unwrap();
        assert!(!v_after_lost.hash_skipped());

        // Prime `srf-b` at generation 1, then verify `LifecycleUpdate::Destroyed` evicts.
        let fwb1 = j_a.retain_frame_witness(&sha, &payload).unwrap();
        let fb1_in = Input::Frame {
            surface_id: "srf-b".into(),
            frame: Frame {
                sha256: sha.clone(),
                generation: 1,
                width: 256,
                height: 128,
            },
        };
        let out_fb1 = state_a.apply(&fb1_in).unwrap();
        j_a.append(&fb1_in, &out_fb1, &state_a, vec![fwb1]).unwrap();
        assert!(j_a.has_committed_surface_witness("srf-b", &sha));

        let destroy_in = Input::Lifecycle {
            surface_id: "srf-b".into(),
            update: LifecycleUpdate::Destroyed,
        };
        let out_destroy = state_a.apply(&destroy_in).unwrap();
        j_a.append(&destroy_in, &out_destroy, &state_a, vec![])
            .unwrap();
        assert!(
            !j_a.has_committed_surface_witness("srf-b", &sha),
            "LifecycleUpdate::Destroyed must evict the surface witness entry"
        );
        let v_after_destroy = VerifiedPixels::read_verified_for_surface(
            &session_a,
            "srf-b",
            state_a.epoch,
            2,
            256,
            128,
            &payload[..],
            payload.len(),
            &sha,
        )
        .unwrap();
        assert!(!v_after_destroy.hash_skipped());

        // Re-create `srf-c`, prime it, then verify `Input::Connect` (epoch change) evicts all entries.
        let sc_in = make_surface_input("srf-c");
        let swc = j_a.retain_witness(b"srf-c").unwrap();
        let out_sc = state_a.apply(&sc_in).unwrap();
        j_a.append(&sc_in, &out_sc, &state_a, vec![swc]).unwrap();
        let fwc1 = j_a.retain_frame_witness(&sha, &payload).unwrap();
        let fc1_in = Input::Frame {
            surface_id: "srf-c".into(),
            frame: Frame {
                sha256: sha.clone(),
                generation: 1,
                width: 256,
                height: 128,
            },
        };
        let out_fc1 = state_a.apply(&fc1_in).unwrap();
        j_a.append(&fc1_in, &out_fc1, &state_a, vec![fwc1]).unwrap();
        assert!(j_a.has_committed_surface_witness("srf-c", &sha));

        let out_c2 = state_a.apply(&Input::Connect).unwrap();
        j_a.append(&Input::Connect, &out_c2, &state_a, vec![])
            .unwrap();
        assert!(
            !j_a.has_committed_surface_witness("srf-c", &sha),
            "Input::Connect (epoch change) must evict all surface witness entries"
        );
        assert_eq!(j_a.committed_surface_witness_bytes(), 0);

        // Disk artifact tamper check: if `artifacts/<sha>` is corrupted on disk before recover,
        // `Journal::recover` refuses with `JournalError::Witness` during `scan` and never blesses
        // unhashed disk bytes.
        j_a.close().unwrap();
        drop(j_a);
        let artifact_path = session_a.join("artifacts").join(&sha);
        let mut tampered_disk = payload.clone();
        tampered_disk[0] ^= 0xff;
        fs::write(&artifact_path, &tampered_disk).unwrap();
        assert_eq!(
            Journal::recover(&session_a.join("journal.jsonl"), &session_a)
                .err()
                .unwrap(),
            JournalError::Witness
        );

        fs::remove_dir_all(root_a).unwrap();
        fs::remove_dir_all(root_b).unwrap();
    }

    #[test]
    fn per_surface_witness_cache_is_bounded_by_64_mib_and_evicts_oldest() {
        use crate::admission::Frame;
        let root = std::env::temp_dir().join(format!("mv-journal-membound-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();

        let mut state = CoreState::session("session-membound").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let out_c = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out_c, &state, vec![]).unwrap();

        // 16 surfaces at 1280x900 RGB24 = 16 * 3,456,000 B = 55,296,000 B (52.734375 MiB),
        // which fits within MAX_SURFACE_WITNESS_BYTES (64 MiB = 67,108,864 B).
        // Attempting to populate 22 surfaces of 3,456,000 B each (76,032,000 B > 64 MiB)
        // must evict the oldest surfaces so total cached bytes never exceed 64 MiB (max 19 surfaces = 65,664,000 B).
        let frame_len = 1280 * 900 * 3;
        assert_eq!(frame_len, 3_456_000);
        assert_eq!(16 * frame_len, 55_296_000);
        assert!(16 * frame_len <= MAX_SURFACE_WITNESS_BYTES);

        for idx in 0..22_u8 {
            let sid = format!("srf-mem-{idx:02}");
            let s_in = make_surface_input(&sid);
            let sw = j.retain_witness(sid.as_bytes()).unwrap();
            let out_s = state.apply(&s_in).unwrap();
            j.append(&s_in, &out_s, &state, vec![sw]).unwrap();

            let mut bytes = vec![0u8; frame_len];
            bytes[0] = idx;
            bytes[frame_len - 1] = idx ^ 0xa5;
            let sha = sha256_hex(&bytes);
            let fw = j.retain_frame_witness(&sha, &bytes).unwrap();
            let f_in = Input::Frame {
                surface_id: sid.clone(),
                frame: Frame {
                    sha256: sha.clone(),
                    generation: 1,
                    width: 1280,
                    height: 900,
                },
            };
            let out_f = state.apply(&f_in).unwrap();
            j.append(&f_in, &out_f, &state, vec![fw]).unwrap();

            if idx == 15 {
                // At 16 surfaces (1280x900 RGB24), worst-case footprint is exactly 55,296,000 B.
                assert_eq!(j.committed_surface_witness_count(), 16);
                assert_eq!(j.committed_surface_witness_bytes(), 55_296_000);
            }
            assert!(
                j.committed_surface_witness_bytes() <= MAX_SURFACE_WITNESS_BYTES,
                "per-surface witness cache ({}) must never exceed MAX_SURFACE_WITNESS_BYTES ({})",
                j.committed_surface_witness_bytes(),
                MAX_SURFACE_WITNESS_BYTES
            );
        }

        // 67,108,864 / 3,456,000 = 19 surfaces (65,664,000 B); oldest 3 surfaces (00..=02) evicted.
        assert_eq!(j.committed_surface_witness_count(), 19);
        assert_eq!(j.committed_surface_witness_bytes(), 19 * frame_len);
        for evicted_idx in 0..3_u8 {
            let sid = format!("srf-mem-{evicted_idx:02}");
            let sha = state.surfaces[&sid].frame.as_ref().unwrap().sha256.clone();
            assert!(
                !j.has_committed_surface_witness(&sid, &sha),
                "oldest surface {sid} must be evicted when 64 MiB byte cap is reached"
            );
        }
        for retained_idx in 3..22_u8 {
            let sid = format!("srf-mem-{retained_idx:02}");
            let sha = state.surfaces[&sid].frame.as_ref().unwrap().sha256.clone();
            assert!(
                j.has_committed_surface_witness(&sid, &sha),
                "recent surface {sid} must remain cached within the 64 MiB byte cap"
            );
        }

        j.close().unwrap();
        drop(j);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unchanged_frame_replay_produces_identical_records_and_state() {
        use crate::admission::Frame;
        let root_fast =
            std::env::temp_dir().join(format!("mv-journal-replay-fast-{}", std::process::id()));
        let root_ref =
            std::env::temp_dir().join(format!("mv-journal-replay-ref-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root_fast);
        let _ = fs::remove_dir_all(&root_ref);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&root_fast)
            .unwrap();
        fs::DirBuilder::new().mode(0o700).create(&root_ref).unwrap();

        let run_session = |root: &Path, allow_fast_path: bool| {
            let mut state = CoreState::session("session-replay").unwrap();
            let mut j = Journal::create(root, &state).unwrap();
            let out_c = state.apply(&Input::Connect).unwrap();
            j.append(&Input::Connect, &out_c, &state, vec![]).unwrap();

            let capsules = ["srf-cap-1", "srf-cap-2", "srf-cap-3", "srf-cap-4"];
            for cap in capsules {
                let s_in = make_surface_input(cap);
                let sw = j.retain_witness(cap.as_bytes()).unwrap();
                let out_s = state.apply(&s_in).unwrap();
                j.append(&s_in, &out_s, &state, vec![sw]).unwrap();
            }

            for gen in 1..=6_u64 {
                for (idx, cap) in capsules.iter().enumerate() {
                    // Generations 1..=3 use static bytes per capsule; generation 4 changes; 5..=6 static again.
                    let payload_tag = if gen <= 3 { 1_u8 } else { 2_u8 };
                    let bytes = vec![((idx as u8) << 4) | payload_tag; 32_768];
                    let sha = sha256_hex(&bytes);
                    if !allow_fast_path {
                        j.clear_surface_witness_cache();
                    }
                    let verified = VerifiedPixels::read_verified_for_surface(
                        &j.root,
                        cap,
                        state.epoch,
                        gen,
                        128,
                        64,
                        &bytes[..],
                        bytes.len(),
                        &sha,
                    )
                    .unwrap();
                    if allow_fast_path && (gen == 2 || gen == 3 || gen == 5 || gen == 6) {
                        assert!(
                            verified.hash_skipped(),
                            "expected fast path on static frame gen={gen} cap={cap}"
                        );
                    } else {
                        assert!(
                            !verified.hash_skipped(),
                            "expected full hash on changed/initial frame gen={gen} cap={cap}"
                        );
                    }
                    let fw = j.retain_verified_pixels(&verified).unwrap();
                    let f_in = Input::Frame {
                        surface_id: (*cap).into(),
                        frame: Frame {
                            sha256: sha,
                            generation: gen,
                            width: 128,
                            height: 64,
                        },
                    };
                    let out_f = state.apply(&f_in).unwrap();
                    j.append(&f_in, &out_f, &state, vec![fw]).unwrap();
                }
            }
            j.close().unwrap();
        };

        run_session(&root_fast, true);
        run_session(&root_ref, false);

        let session_fast = root_fast.join("sessions/session-replay");
        let session_ref = root_ref.join("sessions/session-replay");
        assert_eq!(
            fs::read(session_fast.join("journal.jsonl")).unwrap(),
            fs::read(session_ref.join("journal.jsonl")).unwrap(),
            "journal.jsonl record sequence and parent linkage must be bit-identical"
        );
        assert_eq!(
            fs::read(session_fast.join("checkpoint.json")).unwrap(),
            fs::read(session_ref.join("checkpoint.json")).unwrap(),
            "checkpoint.json must be bit-identical"
        );
        let replay_fast = scan(&session_fast.join("journal.jsonl"), &session_fast).unwrap();
        let replay_ref = scan(&session_ref.join("journal.jsonl"), &session_ref).unwrap();
        assert_eq!(replay_fast.state, replay_ref.state);
        assert_eq!(replay_fast.boundaries, replay_ref.boundaries);
        assert_eq!(replay_fast.checkpoint.count, replay_ref.checkpoint.count);
        assert_eq!(replay_fast.checkpoint.tail, replay_ref.checkpoint.tail);
        assert_eq!(
            replay_fast.checkpoint.archive,
            replay_ref.checkpoint.archive
        );
        assert_eq!(
            replay_fast.checkpoint.genesis,
            replay_ref.checkpoint.genesis
        );

        fs::remove_dir_all(root_fast).unwrap();
        fs::remove_dir_all(root_ref).unwrap();
    }

    #[test]
    fn bench_1280x900_frame_verify_changed_vs_unchanged() {
        use crate::admission::Frame;
        // Opt-in benchmark: prints numbers without timing assertions inside unit tests.
        let run_bench = std::env::var_os("MV_RUN_HASH_BENCH").is_some()
            || std::env::args().any(|a| a.contains("bench_1280x900_frame_verify"));
        if !run_bench {
            return;
        }
        let root = std::env::temp_dir().join(format!("mv-journal-bench-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();

        let mut state = CoreState::session("session-bench").unwrap();
        let mut j = Journal::create(&root, &state).unwrap();
        let session_dir = root.join("sessions/session-bench");
        let out_c = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out_c, &state, vec![]).unwrap();

        for sid in ["srf-bench-changed", "srf-bench-unchanged"] {
            let s_in = make_surface_input(sid);
            let sw = j.retain_witness(sid.as_bytes()).unwrap();
            let out_s = state.apply(&s_in).unwrap();
            j.append(&s_in, &out_s, &state, vec![sw]).unwrap();
        }

        let frame_len = 1280 * 900 * 3;
        // Non-uniform synthetic RGB24 payload (position-dependent gradient + channel mix).
        let mut base_bytes = vec![0u8; frame_len];
        for (i, b) in base_bytes.iter_mut().enumerate() {
            *b = ((i.wrapping_mul(131) ^ (i >> 7).wrapping_mul(17)) & 0xff) as u8;
        }
        let base_sha = sha256_hex(&base_bytes);
        let shm_path = root.join("bench-1280x900.shm");
        {
            let mut f = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&shm_path)
                .unwrap();
            f.write_all(&base_bytes).unwrap();
            f.sync_all().unwrap();
        }

        // Commit generation 1 on `srf-bench-unchanged` (`srf-bench-changed` stays uncached).
        let fw1 = j.retain_frame_witness(&base_sha, &base_bytes).unwrap();
        let f1_in = Input::Frame {
            surface_id: "srf-bench-unchanged".into(),
            frame: Frame {
                sha256: base_sha.clone(),
                generation: 1,
                width: 1280,
                height: 900,
            },
        };
        let out_f1 = state.apply(&f1_in).unwrap();
        j.append(&f1_in, &out_f1, &state, vec![fw1]).unwrap();

        // Warmup both paths so file cache and instruction paths are warm before sampling.
        for _ in 0..3 {
            let mut f_c = File::open(&shm_path).unwrap();
            let vc = VerifiedPixels::read_verified_for_surface(
                &session_dir,
                "srf-bench-changed",
                state.epoch,
                1,
                1280,
                900,
                &mut f_c,
                frame_len,
                &base_sha,
            )
            .unwrap();
            assert!(!vc.hash_skipped());
            let mut f_u = File::open(&shm_path).unwrap();
            let vu = VerifiedPixels::read_verified_for_surface(
                &session_dir,
                "srf-bench-unchanged",
                state.epoch,
                2,
                1280,
                900,
                &mut f_u,
                frame_len,
                &base_sha,
            )
            .unwrap();
            assert!(vu.hash_skipped());
        }

        let samples = 21usize;
        let mut changed_total_ns = Vec::with_capacity(samples);
        let mut changed_hash_ns = Vec::with_capacity(samples);
        let mut unchanged_total_ns = Vec::with_capacity(samples);
        let mut unchanged_memcmp_ns = Vec::with_capacity(samples);
        for i in 0..samples {
            if i % 2 == 0 {
                let mut f_c = File::open(&shm_path).unwrap();
                let t0 = std::time::Instant::now();
                let vc = VerifiedPixels::read_verified_for_surface(
                    &session_dir,
                    "srf-bench-changed",
                    state.epoch,
                    1,
                    1280,
                    900,
                    &mut f_c,
                    frame_len,
                    &base_sha,
                )
                .unwrap();
                changed_total_ns.push(t0.elapsed().as_nanos());
                changed_hash_ns.push(vc.hash_ns());
                assert!(!vc.hash_skipped());

                let mut f_u = File::open(&shm_path).unwrap();
                let t1 = std::time::Instant::now();
                let vu = VerifiedPixels::read_verified_for_surface(
                    &session_dir,
                    "srf-bench-unchanged",
                    state.epoch,
                    2,
                    1280,
                    900,
                    &mut f_u,
                    frame_len,
                    &base_sha,
                )
                .unwrap();
                unchanged_total_ns.push(t1.elapsed().as_nanos());
                unchanged_memcmp_ns.push(vu.skipped_hash_ns());
                assert!(vu.hash_skipped());
            } else {
                let mut f_u = File::open(&shm_path).unwrap();
                let t1 = std::time::Instant::now();
                let vu = VerifiedPixels::read_verified_for_surface(
                    &session_dir,
                    "srf-bench-unchanged",
                    state.epoch,
                    2,
                    1280,
                    900,
                    &mut f_u,
                    frame_len,
                    &base_sha,
                )
                .unwrap();
                unchanged_total_ns.push(t1.elapsed().as_nanos());
                unchanged_memcmp_ns.push(vu.skipped_hash_ns());
                assert!(vu.hash_skipped());

                let mut f_c = File::open(&shm_path).unwrap();
                let t0 = std::time::Instant::now();
                let vc = VerifiedPixels::read_verified_for_surface(
                    &session_dir,
                    "srf-bench-changed",
                    state.epoch,
                    1,
                    1280,
                    900,
                    &mut f_c,
                    frame_len,
                    &base_sha,
                )
                .unwrap();
                changed_total_ns.push(t0.elapsed().as_nanos());
                changed_hash_ns.push(vc.hash_ns());
                assert!(!vc.hash_skipped());
            }
        }

        changed_total_ns.sort_unstable();
        changed_hash_ns.sort_unstable();
        unchanged_total_ns.sort_unstable();
        unchanged_memcmp_ns.sort_unstable();
        let p50 = samples / 2;
        let p95 = (samples * 95) / 100;
        eprintln!(
            "BENCH_1280x900_VERIFY samples={samples} changed_total_p50_ms={:.3} changed_total_p95_ms={:.3} changed_hash_p50_ms={:.3} unchanged_total_p50_ms={:.3} unchanged_total_p95_ms={:.3} unchanged_memcmp_p50_ms={:.3}",
            (changed_total_ns[p50] as f64) / 1_000_000.0,
            (changed_total_ns[p95] as f64) / 1_000_000.0,
            (changed_hash_ns[p50] as f64) / 1_000_000.0,
            (unchanged_total_ns[p50] as f64) / 1_000_000.0,
            (unchanged_total_ns[p95] as f64) / 1_000_000.0,
            (unchanged_memcmp_ns[p50] as f64) / 1_000_000.0,
        );

        j.close().unwrap();
        drop(j);
        fs::remove_dir_all(root).unwrap();
    }
}

// Keep regression fixtures beside integration tests while reusing private,
// test-only crash injection and sync tracing without exposing product APIs.
#[cfg(test)]
mod recovery_fix {
    use super::*;
    include!("../../tests/journal_recovery_fix.rs");
    journal_recovery_regressions!();
}
