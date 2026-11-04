use super::*;
use crate::admission::{Frame, Surface};
use crate::{Component as PeerComponent, Endpoint};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    base: PathBuf,
    root: PathBuf,
    state: CoreState,
    journal: Option<Journal>,
    snapshots: Vec<Vec<u8>>,
}
impl Fixture {
    fn new() -> Self {
        let base = Path::new("/dev/shm").join(format!(
            "mv-compact-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&base).unwrap();
        let state = CoreState::session("compact-test").unwrap();
        let journal = Journal::create(&base, &state).unwrap();
        let root = base.join("sessions/compact-test");
        let mut f = Self {
            base,
            root,
            state,
            journal: Some(journal),
            snapshots: vec![],
        };
        f.append(Input::Connect, vec![]);
        f.append(
            Input::Surface {
                id: "surface-one".into(),
                surface: Surface {
                    display: ":synthetic".into(),
                    owner: Endpoint {
                        component: PeerComponent::Agent,
                        instance: "agent-one".into(),
                    },
                    agent_controlled: true,
                    live: true,
                    frame: None,
                    refresh_after: None,
                    allowed_verbs: vec![],
                },
            },
            vec![],
        );
        f
    }
    fn append(&mut self, input: Input, witnesses: Vec<Witness>) {
        let mut next = self.state.clone();
        let out = next.apply(&input).unwrap();
        self.journal
            .as_mut()
            .unwrap()
            .append(&input, &out, &next, witnesses)
            .unwrap();
        self.snapshots.push(next.snapshot().unwrap());
        self.state = next;
    }
    fn frame(&mut self, generation: u64) {
        let bytes = [generation as u8, 2, 3];
        let sha = sha256_hex(&bytes);
        let w = self
            .journal
            .as_mut()
            .unwrap()
            .retain_frame_witness(&sha, &bytes)
            .unwrap();
        self.append(
            Input::Frame {
                surface_id: "surface-one".into(),
                frame: Frame {
                    sha256: sha,
                    generation,
                    width: 1,
                    height: 1,
                },
            },
            vec![w],
        );
    }
    fn close(&mut self) {
        self.journal.as_mut().unwrap().close().unwrap();
        self.journal.take();
    }
    fn event_path(&self, seq: u64) -> PathBuf {
        self.root.join(format!("events/{seq}.json"))
    }
    fn rechain_archive(&self) {
        let path = self.root.join("checkpoint.json");
        let mut cp: Checkpoint = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let mut archive = ZERO.to_string();
        for seq in 1..=cp.count {
            archive = archive_next(&archive, &fs::read(self.event_path(seq)).unwrap());
        }
        cp.archive = archive;
        fs::write(path, super::json(&cp).unwrap()).unwrap();
    }
    fn assert_replay(&self) {
        let replay = scan(&self.root.join("journal.jsonl"), &self.root).unwrap();
        assert_eq!(
            replay.state.snapshot().unwrap(),
            self.state.snapshot().unwrap()
        );
        assert_eq!(replay.boundaries, self.snapshots);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.journal.take();
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn compact_frames_keep_every_record_witness_and_reduced_boundary() {
    let mut f = Fixture::new();
    for generation in 1..=12 {
        f.frame(generation);
    }
    f.append(
        Input::Refuse {
            reason: crate::Refusal::Policy,
        },
        vec![],
    );
    f.close();
    f.assert_replay();
    for seq in 3..=14 {
        let raw = fs::read(f.event_path(seq)).unwrap();
        let value: Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(value["schema"], "metaviewer.event/v2");
        assert!(value.get("state").is_none());
        assert_eq!(
            value["state_sha256"],
            sha256_hex(&f.snapshots[(seq - 1) as usize])
        );
        assert_eq!(value["witnesses"].as_array().unwrap().len(), 1);
        let mut legacy = value;
        legacy["schema"] = "metaviewer.event/v1".into();
        legacy.as_object_mut().unwrap().remove("state_sha256");
        legacy["state"] = serde_json::from_slice(&f.snapshots[(seq - 1) as usize]).unwrap();
        assert!(raw.len() < canonical_bytes(&legacy).unwrap().len());
    }
    // Non-frame transitions remain full snapshots, a negative control on compaction scope.
    for seq in [1, 2, 15] {
        let value: Value = serde_json::from_slice(&fs::read(f.event_path(seq)).unwrap()).unwrap();
        assert_eq!(value["schema"], "metaviewer.event/v1");
        assert!(value.get("state").is_some());
        assert!(value.get("state_sha256").is_none());
    }
    let (mut journal, restored) = Journal::recover(&f.root.join("journal.jsonl"), &f.root).unwrap();
    assert_eq!(restored.snapshot().unwrap(), f.state.snapshot().unwrap());
    journal.close().unwrap();
}

#[test]
fn legacy_frame_bytes_survive_recovery_and_mixed_compact_append() {
    let mut f = Fixture::new();
    f.frame(1);
    f.close();
    let path = f.event_path(3);
    let mut old: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    old["schema"] = "metaviewer.event/v1".into();
    old.as_object_mut().unwrap().remove("state_sha256");
    old["state"] = serde_json::from_slice(&f.snapshots[2]).unwrap();
    let legacy_bytes = canonical_bytes(&old).unwrap();
    fs::write(&path, &legacy_bytes).unwrap();
    f.rechain_archive();
    f.assert_replay();
    let (journal, state) = Journal::recover(&f.root.join("journal.jsonl"), &f.root).unwrap();
    assert_eq!(fs::read(&path).unwrap(), legacy_bytes);
    f.journal = Some(journal);
    f.state = state;
    f.frame(2);
    f.close();
    f.assert_replay();
    assert_eq!(fs::read(path).unwrap(), legacy_bytes);
    let compact: Value = serde_json::from_slice(&fs::read(f.event_path(4)).unwrap()).unwrap();
    assert_eq!(compact["schema"], "metaviewer.event/v2");
}

#[test]
fn compact_corruption_fails_even_with_resealed_archive_hash() {
    let mut f = Fixture::new();
    f.frame(1);
    f.close();
    let path = f.event_path(3);
    let raw = fs::read(&path).unwrap();
    let original: Value = serde_json::from_slice(&raw).unwrap();
    let mut mutations = vec![];
    let mut v = original.clone();
    v["state_sha256"] = "0".repeat(64).into();
    mutations.push(v);
    let mut v = original.clone();
    v["state_sha256"] = "invalid".into();
    mutations.push(v);
    let mut v = original.clone();
    v.as_object_mut().unwrap().remove("state_sha256");
    mutations.push(v);
    let mut v = original.clone();
    v["schema"] = "metaviewer.event/v1".into();
    mutations.push(v);
    let mut v = original.clone();
    v["state"] = serde_json::from_slice(&f.snapshots[2]).unwrap();
    mutations.push(v);
    let mut v = original.clone();
    v["input"]["frame"]["generation"] = 0.into();
    mutations.push(v);
    let mut v = original.clone();
    v["outcome"]["core_seq"] = 99.into();
    mutations.push(v);
    let mut v = original.clone();
    v["input"] = json!({"event":"SurfaceNotice"});
    mutations.push(v);
    let mut v = original.clone();
    v["schema"] = "metaviewer.event/v999".into();
    mutations.push(v);
    for (index, mutation) in mutations.iter().enumerate() {
        fs::write(&path, canonical_bytes(mutation).unwrap()).unwrap();
        f.rechain_archive();
        assert!(
            scan(&f.root.join("journal.jsonl"), &f.root).is_err(),
            "mutation {index} was accepted"
        );
        assert!(
            Journal::recover(&f.root.join("journal.jsonl"), &f.root).is_err(),
            "mutation {index} recovered"
        );
    }
    fs::write(path, raw).unwrap();
    f.rechain_archive();
    f.assert_replay();
    let w: Witness = serde_json::from_value(original["witnesses"][0].clone()).unwrap();
    let artifact = f.root.join("artifacts").join(w.sha256);
    let bytes = fs::read(&artifact).unwrap();
    fs::write(&artifact, b"bad").unwrap();
    assert!(matches!(
        scan(&f.root.join("journal.jsonl"), &f.root),
        Err(JournalError::Witness)
    ));
    fs::write(artifact, bytes).unwrap();
    f.assert_replay();
}

#[test]
fn compact_append_still_rejects_a_fabricated_post_state() {
    let mut f = Fixture::new();
    let bytes = [1, 2, 3];
    let sha = sha256_hex(&bytes);
    let w = f
        .journal
        .as_mut()
        .unwrap()
        .retain_frame_witness(&sha, &bytes)
        .unwrap();
    let input = Input::Frame {
        surface_id: "surface-one".into(),
        frame: Frame {
            sha256: sha,
            generation: 1,
            width: 1,
            height: 1,
        },
    };
    let mut fabricated = f.state.clone();
    let out = fabricated.apply(&input).unwrap();
    fabricated.remaining_budget -= 1;
    assert_eq!(
        f.journal
            .as_mut()
            .unwrap()
            .append(&input, &out, &fabricated, vec![w]),
        Err(JournalError::Invalid)
    );
    assert!(!f.event_path(3).exists());
    f.close();
    f.assert_replay();
}

#[test]
fn refused_frames_retain_full_diagnostic_snapshots() {
    let mut f = Fixture::new();
    f.append(
        Input::Lifecycle {
            surface_id: "surface-one".into(),
            update: crate::admission::LifecycleUpdate::Destroyed,
        },
        vec![],
    );
    f.frame(1);
    f.close();
    f.assert_replay();
    let value: Value = serde_json::from_slice(&fs::read(f.event_path(4)).unwrap()).unwrap();
    assert_eq!(value["schema"], "metaviewer.event/v1");
    assert!(value["outcome"]["reason"].is_string());
    assert_eq!(canonical_bytes(&value["state"]).unwrap(), f.snapshots[3]);
    assert!(value.get("state_sha256").is_none());
}
