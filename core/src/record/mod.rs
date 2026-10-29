#![forbid(unsafe_code)]
//! [TARGET, unit decision] Recording authority is an explicit, offline seam.
//! The caller supplies admitted surface identities and a durable journal sink;
//! sink failure commits neither recording state nor the local chain cursor.
//! Screenshots use their supplied capture ID as the wire recording ID. Disk
//! stop seals a bounded RAM capture; the adapter exports a PNG tar archive.
//! Counts describe retained frames, including after ring eviction.
//! [TARGET, unit decision] Every unreleased capture holds its RAM reservation,
//! including sealed screenshots and exported recordings. Callers release only
//! after delivery and RAM reclamation. Budget refusals name held reservations.
//! `release` is local metadata reclamation for terminal
//! recordings, retaining session-lifetime ID tombstones. It emits no wire event
//! (v0.2 has no release event) and leaves the journal chain unchanged. The adapter
//! owns RAM files and must reclaim its copies separately; observed paths confer
//! no filesystem deletion authority on this coordinator.
use crate::journal::{canonical_bytes, sha256_hex};
use crate::wire::payload::*;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Component, Path};

const CAP: u64 = 1 << 30;
/// Maximum archive size, shared by the exporter and receipt admission.
pub const EXPORT_BYTE_LIMIT: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Configuration,
    Journal,
    Overflow,
    Event,
    UnknownRecording,
    ActiveRecording,
}

/// The sink must durably append the entire entry or return an error.
/// Entries contain metadata only; raw pixels never cross this boundary.
pub trait JournalSink {
    fn append(&mut self, record: &SessionRecord, events: &[RecordEvent]) -> Result<(), Error>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    Recording,
    Sealed,
    Exported,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recording {
    pub surface_id: String,
    pub phase: Phase,
    pub mode: String,
    pub frame_count: u64,
    pub byte_count: u64,
    ring_bytes: u64,
    frames: VecDeque<u64>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coordinator {
    surfaces: BTreeSet<String>,
    recordings: BTreeMap<String, Recording>,
    released: BTreeSet<String>,
    limits: SettingsLimits,
    destination: Option<SettingsRecordingDestinationCase0>,
    seq: u64,
    tail: String,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn absolute(path: &str) -> bool {
    path.len() <= 4096
        && path.starts_with('/')
        && !path.bytes().any(|b| b == 0 || b == b'\r' || b == b'\n')
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        && !path.split('/').any(|c| c == "." || c == "..")
}
fn event(base: &Value, fields: Value) -> Result<RecordEvent, Error> {
    let mut value = base.clone();
    let target = value.as_object_mut().ok_or(Error::Event)?;
    target.extend(fields.as_object().ok_or(Error::Event)?.clone());
    serde_json::from_value(value).map_err(|_| Error::Event)
}

impl Coordinator {
    pub fn new(settings: &Settings, surfaces: BTreeSet<String>) -> Result<Self, Error> {
        let l = &settings.limits;
        if l.ring_bytes == 0
            || l.ring_bytes > CAP
            || l.ring_bytes > l.memory_bytes
            || l.max_fps == 0
            || l.max_fps > 120
            || surfaces.iter().any(|id| !valid_id(id))
        {
            return Err(Error::Configuration);
        }
        let destination = match &settings.recording_destination {
            SettingsRecordingDestination::Case0(d) => {
                if !valid_id(&d.capability_id) || !absolute(&d.path) {
                    return Err(Error::Configuration);
                }
                Some((**d).clone())
            }
            SettingsRecordingDestination::Case1(()) => None,
        };
        Ok(Self {
            surfaces,
            recordings: BTreeMap::new(),
            released: BTreeSet::new(),
            limits: l.clone(),
            destination,
            seq: 0,
            tail: "0".repeat(64),
        })
    }

    pub fn recording(&self, id: &str) -> Option<&Recording> {
        self.recordings.get(id)
    }

    /// Release a sealed/exported capture's reservation and retained metadata.
    /// The caller must first finish delivery and reclaim the adapter-owned RAM.
    /// Unknown (including already released) and active IDs leave state unchanged.
    pub fn release(&mut self, id: &str) -> Result<(), Error> {
        let recording = self.recordings.get(id).ok_or(Error::UnknownRecording)?;
        if recording.phase == Phase::Recording {
            return Err(Error::ActiveRecording);
        }
        self.released.insert(id.to_owned());
        self.recordings.remove(id);
        Ok(())
    }

    fn commit(
        &mut self,
        mut next: Self,
        request_id: &str,
        events: Vec<RecordEvent>,
        sink: &mut impl JournalSink,
    ) -> Result<Vec<RecordEvent>, Error> {
        let record = SessionRecord {
            schema: SessionRecordSchema::Value,
            core_seq: self.seq.checked_add(1).ok_or(Error::Overflow)?,
            kind: if events.iter().any(|e| matches!(e, RecordEvent::Case5(_))) {
                SessionRecordKind::Refused
            } else {
                SessionRecordKind::Admitted
            },
            msg_id: request_id.to_owned(),
            prev_sha256: self.tail.clone(),
        };
        let bytes = canonical_bytes(&serde_json::to_value(&record).map_err(|_| Error::Journal)?)
            .map_err(|_| Error::Journal)?;
        next.seq = record.core_seq;
        next.tail = sha256_hex(&bytes);
        sink.append(&record, &events)?;
        *self = next;
        Ok(events)
    }

    pub fn handle(
        &mut self,
        request: &RecordRequest,
        mono_ns: u64,
        sink: &mut impl JournalSink,
    ) -> Result<Vec<RecordEvent>, Error> {
        let (req, surface, id, mode, ring, fps, destination, stop) = match request {
            RecordRequest::Case0(r) => (
                &r.request_id,
                &r.params.surface_id,
                &r.params.recording_id,
                "ram",
                r.params.ring_bytes,
                r.params.max_fps,
                None,
                false,
            ),
            RecordRequest::Case1(r) => (
                &r.request_id,
                &r.params.surface_id,
                &r.params.recording_id,
                "ram",
                0,
                0,
                None,
                true,
            ),
            RecordRequest::Case2(r) => (
                &r.request_id,
                &r.params.surface_id,
                &r.params.recording_id,
                "disk",
                self.limits.ring_bytes,
                r.params.max_fps,
                Some((
                    &r.params.destination_capability_id,
                    &r.params.destination_path,
                )),
                false,
            ),
            RecordRequest::Case3(r) => (
                &r.request_id,
                &r.params.surface_id,
                &r.params.recording_id,
                "disk",
                0,
                0,
                None,
                true,
            ),
            RecordRequest::Case4(r) => (
                &r.request_id,
                &r.params.surface_id,
                &r.params.capture_id,
                "screenshot",
                self.limits.ring_bytes,
                1,
                None,
                false,
            ),
        };
        let base = json!({"schema":"record_event/v0.2", "request_id":req, "surface_id":surface, "recording_id":id, "mono_ns":mono_ns});
        // Missing identities cannot produce a contract-valid refusal event.
        if !valid_id(req) || !valid_id(surface) || !valid_id(id) {
            return Err(Error::Event);
        }
        let mut next = self.clone();
        let held_detail;
        let mut reason = None;
        if !self.surfaces.contains(surface) {
            reason = Some(("POLICY", "surface is not admitted"));
        }
        if stop && reason.is_none() {
            match next.recordings.get_mut(id) {
                Some(r)
                    if r.phase == Phase::Recording
                        && r.surface_id == *surface
                        && r.mode == mode =>
                {
                    r.phase = Phase::Sealed;
                }
                _ => reason = Some(("POLICY", "recording is not active in this mode and surface")),
            }
        } else if !stop && reason.is_none() {
            if fps == 0 || fps > 120 || ring == 0 || ring > CAP {
                reason = Some(("POLICY", "recording bounds are invalid"));
            } else if fps > self.limits.max_fps || ring > self.limits.ring_bytes {
                reason = Some(("BUDGET_EXCEEDED", "recording exceeds configured limits"));
            }
            // Every unreleased capture reserves session memory. Preserve the first
            // refusal and validate bounds before doing arithmetic on the request.
            if reason.is_none() {
                let reserved = self
                    .recordings
                    .values()
                    .try_fold(0_u64, |sum, r| sum.checked_add(r.ring_bytes))
                    .ok_or(Error::Overflow)?;
                if reserved.checked_add(ring).ok_or(Error::Overflow)? > self.limits.memory_bytes {
                    // Keep the wire detail bounded even with many tiny captures.
                    let mut held = String::new();
                    let mut named = 0;
                    for (id, recording) in &self.recordings {
                        let entry = format!("{id}={}", recording.ring_bytes);
                        if held.len() + entry.len() + 2 > 3500 {
                            break;
                        }
                        if !held.is_empty() {
                            held.push_str(", ");
                        }
                        held.push_str(&entry);
                        named += 1;
                    }
                    held_detail = format!(
                        "recording exceeds session memory; held reservations (bytes): [{held}]; additional held reservations: {}",
                        self.recordings.len() - named
                    );
                    reason = Some(("BUDGET_EXCEEDED", held_detail.as_str()));
                }
            }
            if reason.is_none() && (self.recordings.contains_key(id) || self.released.contains(id))
            {
                reason = Some(("POLICY", "recording identity was already used"));
            }
            if reason.is_none()
                && mode == "disk"
                && !destination.is_some_and(|(cap, path)| {
                    self.destination
                        .as_ref()
                        .is_some_and(|d| d.capability_id == *cap && d.path == *path)
                })
            {
                reason = Some(("POLICY", "host destination is not authorized"));
            }
            if reason.is_none() {
                next.recordings.insert(
                    id.clone(),
                    Recording {
                        surface_id: surface.clone(),
                        phase: Phase::Recording,
                        mode: mode.to_owned(),
                        frame_count: 0,
                        byte_count: 0,
                        ring_bytes: ring,
                        frames: VecDeque::new(),
                    },
                );
            }
        }
        if let Some((code, detail)) = reason {
            return self.commit(
                self.clone(),
                req,
                vec![event(
                    &base,
                    json!({"event":"refused", "reason_code":code, "detail":detail}),
                )?],
                sink,
            );
        }
        let fields = if stop {
            let r = next.recordings.get(id).ok_or(Error::Event)?;
            json!({"event":"stopped", "frame_count":r.frame_count,"byte_count":r.byte_count})
        } else {
            json!({"event":"started", "mode":mode})
        };
        let e = event(&base, fields)?;
        self.commit(next, req, vec![e], sink)
    }

    /// Accept metadata from the authenticated recorder; derive evictions locally.
    /// Export receipts are accepted only for sealed disk recordings and the exact grant.
    pub fn observe(
        &mut self,
        e: RecordEvent,
        sink: &mut impl JournalSink,
    ) -> Result<Vec<RecordEvent>, Error> {
        let mut next = self.clone();
        let (req, mut events) = match &e {
            RecordEvent::Case2(f) => {
                let r = next
                    .recordings
                    .get_mut(&f.recording_id)
                    .ok_or(Error::Event)?;
                if r.phase != Phase::Recording
                    || r.surface_id != f.surface_id
                    || f.byte_count == 0
                    || f.byte_count > r.ring_bytes
                    || !absolute(&f.ram_path)
                    || !f.ram_path.starts_with("/dev/shm/")
                    || f.ram_path.ends_with('/')
                    || f.sha256.len() != 64
                    || !f
                        .sha256
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    || !valid_id(&f.request_id)
                {
                    return Err(Error::Event);
                }
                let mut dropped = 0_u64;
                while r
                    .byte_count
                    .checked_add(f.byte_count)
                    .ok_or(Error::Overflow)?
                    > r.ring_bytes
                {
                    let old = r.frames.pop_front().ok_or(Error::Event)?;
                    r.byte_count = r.byte_count.checked_sub(old).ok_or(Error::Overflow)?;
                    r.frame_count = r.frame_count.checked_sub(1).ok_or(Error::Overflow)?;
                    dropped = dropped.checked_add(1).ok_or(Error::Overflow)?;
                }
                r.frames.push_back(f.byte_count);
                r.byte_count = r
                    .byte_count
                    .checked_add(f.byte_count)
                    .ok_or(Error::Overflow)?;
                r.frame_count = r.frame_count.checked_add(1).ok_or(Error::Overflow)?;
                let base = json!({"schema":"record_event/v0.2", "request_id":f.request_id,"surface_id":f.surface_id,"recording_id":f.recording_id,"mono_ns":f.mono_ns});
                let mut events = Vec::new();
                if dropped > 0 {
                    events.push(event(&base,json!({"event":"dropped","dropped_frames":dropped,"policy":"ram_ring_oldest"}))?);
                }
                events.push(e.clone());
                if r.mode == "screenshot" {
                    r.phase = Phase::Sealed;
                    events.push(event(&base, json!({"event":"stopped","frame_count":r.frame_count,"byte_count":r.byte_count}))?);
                }
                (f.request_id.clone(), events)
            }
            RecordEvent::Case3(f) => {
                let r = self.recordings.get(&f.recording_id).ok_or(Error::Event)?;
                if r.phase != Phase::Sealed
                    || r.mode != "disk"
                    || r.surface_id != f.surface_id
                    || f.byte_count == 0
                    || f.byte_count > EXPORT_BYTE_LIMIT
                    || f.sha256.len() != 64
                    || !f
                        .sha256
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    || !valid_id(&f.request_id)
                    || !self.destination.as_ref().is_some_and(|d| {
                        d.path == f.destination_path
                            && d.capability_id == f.destination_capability_id
                    })
                {
                    return Err(Error::Event);
                }
                next.recordings
                    .get_mut(&f.recording_id)
                    .ok_or(Error::Event)?
                    .phase = Phase::Exported;
                (f.request_id.clone(), vec![e.clone()])
            }
            _ => return Err(Error::Event),
        };
        self.commit(next, &req, std::mem::take(&mut events), sink)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod guard_tests;

pub mod capture;
