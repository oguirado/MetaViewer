#![forbid(unsafe_code)]
//! [TARGET, unit decision] Private archive v1: canonical event sidecars retain
//! replay inputs/outcomes and complete boundary bytes; a durable checkpoint binds
//! header, count, record tail and archive chain. Unsealed crash tails fail closed.
//! [TARGET, unit decision] Recovery may promote checkpoint.next only after
//! replay proves its complete closure; stale pending files are replaced under
//! the exclusive writer lock. State/archive directories require effective uid/0700.
//! The archive read budget is 64 MiB [TARGET, unit decision], including
//! retained boundary snapshots. Artifacts are opaque authorized state witnesses; callers must authorize any
//! disk export. Raw pixel retention is never implied by a frame reference.
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
pub use sha256::sha256_hex;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RECORDS: u64 = 100_000;
const MAX_LINE: usize = crate::MAX_FRAME_BYTES;
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
crate::wire::error_type!(JournalError {
    Invalid,
    Io,
    Corrupt,
    Duplicate,
    Witness,
    Unsealed,
    Policy,
    Locked,
    Poisoned
});
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
}
pub struct Journal {
    root: PathBuf,
    file: WriterFile,
    count: u64,
    bytes: u64,
    tail: String,
    archive: String,
    genesis: String,
    archive_bytes: u64,
    poisoned: bool,
    // Last durably committed reduction boundary; supplied transitions are untrusted.
    state: CoreState,
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
fn private_directory(path: &Path) -> Result<(), JournalError> {
    confined(path)?;
    // Linux host effective uid, without unsafe FFI or process-wide state changes.
    let status = fs::read_to_string("/proc/self/status").map_err(|_| JournalError::Io)?;
    let uid: u32 = status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or(JournalError::Invalid)?
        .parse()
        .map_err(|_| JournalError::Invalid)?;
    private_directory_for_uid(path, uid)
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
fn sync_dir(path: &Path) -> Result<(), JournalError> {
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|_| JournalError::Io)
}
fn publish(path: &Path, bytes: &[u8]) -> Result<(), JournalError> {
    let parent = path.parent().ok_or(JournalError::Invalid)?;
    private_directory(parent)?;
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| JournalError::Io)?;
    f.write_all(bytes)
        .and_then(|_| f.sync_all())
        .map_err(|_| JournalError::Io)?;
    sync_dir(parent)
}
fn checkpoint(root: &Path, c: &Checkpoint) -> Result<(), JournalError> {
    let tmp = root.join("checkpoint.next");
    // Only called by a new journal or the exclusive, replay-verified writer.
    private_directory(root)?;
    match fs::symlink_metadata(&tmp) {
        Ok(meta) if meta.is_file() => fs::remove_file(&tmp).map_err(|_| JournalError::Io)?,
        Ok(_) => return Err(JournalError::Invalid),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(JournalError::Io),
    }
    publish(&tmp, &json(c)?)?;
    fs::rename(tmp, root.join("checkpoint.json")).map_err(|_| JournalError::Io)?;
    sync_dir(root)
}
fn event_kind(input: &Input, out: &Outcome) -> SessionRecordKind {
    if out.reason.is_some() {
        return SessionRecordKind::Refused;
    }
    match input {
        Input::Propose(_) => SessionRecordKind::Admitted,
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
    let bytes = read_file(&root.join("artifacts").join(&w.sha256), MAX_BYTES)
        .map_err(|_| JournalError::Witness)?;
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
        if !state_dir.exists() {
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
        let journal = Self {
            root,
            file,
            count: 0,
            bytes: header.len() as u64 + 1,
            tail: ZERO.into(),
            archive: ZERO.into(),
            genesis: sha256_hex(&genesis),
            archive_bytes: genesis.len() as u64,
            poisoned: false,
            state: state.clone(),
        };
        checkpoint(&journal.root, &journal.closure())?;
        sync_dir(&sessions)?;
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
        let replay = scan(path, root)?;
        let c = replay.checkpoint.clone();
        let bytes = file.metadata().map_err(|_| JournalError::Io)?.len();
        // scan has validated every tail before any recovery mutation. Keep a
        // matching published checkpoint byte/inode-stable; only promote if needed.
        let current_matches = read_file(&root.join("checkpoint.json"), MAX_LINE as u64)
            .is_ok_and(|bytes| json(&c).is_ok_and(|expected| bytes == expected));
        let pending = root.join("checkpoint.next");
        match fs::symlink_metadata(&pending) {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return Err(JournalError::Invalid),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(JournalError::Io),
        }
        if current_matches {
            match fs::remove_file(&pending) {
                Ok(()) => sync_dir(root)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(JournalError::Io),
            }
        } else {
            checkpoint(root, &c)?;
        }
        Ok((
            Self {
                root: root.into(),
                file,
                count: c.count,
                bytes,
                tail: c.tail,
                archive: c.archive,
                genesis: c.genesis,
                archive_bytes: replay.archive_bytes,
                poisoned: false,
                state: replay.state.clone(),
            },
            replay.state,
        ))
    }
    pub fn retain_witness(&mut self, bytes: &[u8]) -> Result<Witness, JournalError> {
        if self.poisoned {
            return Err(JournalError::Poisoned);
        }
        if bytes.is_empty() || bytes.len() as u64 > MAX_BYTES {
            return Err(JournalError::Witness);
        }
        let w = Witness {
            sha256: sha256_hex(bytes),
            byte_len: bytes.len() as u64,
        };
        let path = self.root.join("artifacts").join(&w.sha256);
        if path.exists() {
            verify_witness(&self.root, &w)?;
        } else {
            publish(&path, bytes)?;
        }
        Ok(w)
    }
    pub fn append(
        &mut self,
        input: &Input,
        outcome: &Outcome,
        state: &CoreState,
        witnesses: Vec<Witness>,
    ) -> Result<(), JournalError> {
        if self.poisoned {
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
            verify_witness(&self.root, w)?;
        }
        if required_witness(input, outcome)
            .is_some_and(|hash| !witnesses.iter().any(|w| w.sha256 == hash))
        {
            return Err(JournalError::Witness);
        }
        // From the first durable mutation, errors poison the handle until recovery.
        self.poisoned = true;
        publish(
            &self.root.join("events").join(format!("{next}.json")),
            &event,
        )?;
        self.file
            .write_all(&raw)
            .and_then(|_| self.file.write_all(b"\n"))
            .and_then(|_| self.file.sync_all())
            .map_err(|_| JournalError::Io)?;
        self.count = next;
        self.bytes += raw.len() as u64 + 1;
        self.tail = sha256_hex(&raw);
        self.archive = archive_next(&self.archive, &event);
        checkpoint(&self.root, &self.closure())?;
        self.archive_bytes = archive_bytes;
        self.state = reduced;
        self.poisoned = false;
        Ok(())
    }
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
    if bytes.len() > MAX_LINE || bytes.pop() != Some(b'\n') {
        return Err(JournalError::Corrupt);
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
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err(JournalError::Corrupt);
    }
    let mut reader = BufReader::new(File::open(path).map_err(|_| JournalError::Io)?);
    let header_bytes = line(&mut reader)?.ok_or(JournalError::Corrupt)?;
    let header: Header = parse(&header_bytes)?;
    if header.schema != "metaviewer.journal/v1"
        || !safe_component(&header.session_id)
        || header.core_version != env!("CARGO_PKG_VERSION")
    {
        return Err(JournalError::Corrupt);
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
    let uncommitted = root.join("events").join(format!(
        "{}.json",
        count.checked_add(1).ok_or(JournalError::Policy)?
    ));
    match fs::symlink_metadata(uncommitted) {
        Ok(_) => return Err(JournalError::Unsealed),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(JournalError::Io),
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
}
