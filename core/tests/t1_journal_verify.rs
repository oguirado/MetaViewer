#![forbid(unsafe_code)]
use metaviewer_core::admission::{CoreState, Input};
use metaviewer_core::journal::{scan, Journal, JournalError};
use std::fs;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    dir: PathBuf,
    root: PathBuf,
    path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "mv-t1-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let root = dir.join("sessions/session-1");
        Self {
            path: root.join("journal.jsonl"),
            root,
            dir,
        }
    }
    fn populated(&self) {
        let mut state = CoreState::session("session-1").unwrap();
        let mut j = Journal::create(&self.dir, &state).unwrap();
        let out = state.apply(&Input::Connect).unwrap();
        j.append(&Input::Connect, &out, &state, vec![]).unwrap();
    }
    fn checkpoint(&self) -> (Vec<u8>, u64) {
        let p = self.root.join("checkpoint.json");
        (fs::read(&p).unwrap(), fs::metadata(p).unwrap().ino())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.dir).unwrap();
    }
}
#[test]
fn orphan_is_unsealed_in_scan_recover_and_cli() {
    let f = Fixture::new();
    f.populated();
    assert!(scan(&f.path, &f.root).is_ok());
    fs::write(f.root.join("events/2.json"), b"orphan").unwrap();
    assert!(matches!(
        scan(&f.path, &f.root),
        Err(JournalError::Unsealed)
    ));
    assert!(matches!(
        Journal::recover(&f.path, &f.root),
        Err(JournalError::Unsealed)
    ));
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
        .arg("--journal")
        .arg(&f.path)
        .arg("--witness-root")
        .arg(&f.root)
        .arg("--verify-only")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
}
#[test]
fn invalid_transition_is_refused_before_write_without_poison() {
    let f = Fixture::new();
    let mut state = CoreState::session("session-1").unwrap();
    let mut j = Journal::create(&f.dir, &state).unwrap();
    let before = (fs::read(&f.path).unwrap(), f.checkpoint());
    let good = state.apply(&Input::Connect).unwrap();
    let mut bad = good.clone();
    bad.dispatch = !bad.dispatch;
    assert_eq!(
        j.append(&Input::Connect, &bad, &state, vec![]),
        Err(JournalError::Invalid)
    );
    assert_eq!((fs::read(&f.path).unwrap(), f.checkpoint()), before);
    assert!(!f.root.join("events/1.json").exists());
    let mut bad_state = state.clone();
    bad_state.remaining_budget -= 1;
    assert_eq!(
        j.append(&Input::Connect, &good, &bad_state, vec![]),
        Err(JournalError::Invalid)
    );
    assert_eq!((fs::read(&f.path).unwrap(), f.checkpoint()), before);
    j.append(&Input::Connect, &good, &state, vec![]).unwrap();
    assert_eq!(scan(&f.path, &f.root).unwrap().state, state);
}
#[test]
fn clean_double_recover_preserves_checkpoint_identity() {
    let f = Fixture::new();
    f.populated();
    let before = f.checkpoint();
    let mut snapshots = Vec::new();
    for _ in 0..2 {
        let (j, s) = Journal::recover(&f.path, &f.root).unwrap();
        snapshots.push(s.snapshot().unwrap());
        drop(j);
        assert_eq!(f.checkpoint(), before);
    }
    assert_eq!(snapshots[0], snapshots[1]);
}
#[test]
fn refused_recover_preserves_checkpoint_identity() {
    let f = Fixture::new();
    f.populated();
    let before = f.checkpoint();
    fs::write(f.root.join("events/2.json"), b"orphan").unwrap();
    assert!(matches!(
        Journal::recover(&f.path, &f.root),
        Err(JournalError::Unsealed)
    ));
    assert_eq!(f.checkpoint(), before);
}
#[test]
fn stale_next_cleanup_preserves_current_and_promotion_requires_proof() {
    let f = Fixture::new();
    f.populated();
    let before = f.checkpoint();
    fs::write(f.root.join("checkpoint.next"), b"stale").unwrap();
    drop(Journal::recover(&f.path, &f.root).unwrap());
    assert!(!f.root.join("checkpoint.next").exists());
    assert_eq!(f.checkpoint(), before);
    fs::rename(
        f.root.join("checkpoint.json"),
        f.root.join("checkpoint.next"),
    )
    .unwrap();
    drop(Journal::recover(&f.path, &f.root).unwrap());
    assert!(scan(&f.path, &f.root).is_ok());
    fs::remove_file(f.root.join("checkpoint.json")).unwrap();
    fs::write(f.root.join("checkpoint.next"), b"{}").unwrap();
    assert!(Journal::recover(&f.path, &f.root).is_err());
    assert!(!f.root.join("checkpoint.json").exists());
}

#[test]
fn mv_replay_verifies_recorded_pre_change_and_post_change_frame_journals() {
    use metaviewer_core::admission::{Frame, Surface};
    use metaviewer_core::journal::sha256_hex;
    use metaviewer_core::{Component, Endpoint};

    let f = Fixture::new();
    let mut state = CoreState::session("session-1").unwrap();
    let mut j = Journal::create(&f.dir, &state).unwrap();
    let out1 = state.apply(&Input::Connect).unwrap();
    j.append(&Input::Connect, &out1, &state, vec![]).unwrap();

    let surface_id = "srf-replay".to_string();
    let surface_witness = j.retain_witness(b"surface-seed").unwrap();
    let surface_input = Input::Surface {
        id: surface_id.clone(),
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
    let out2 = state.apply(&surface_input).unwrap();
    j.append(&surface_input, &out2, &state, vec![surface_witness])
        .unwrap();

    // 1. Pre-change style frame record (retained with immediate fsync via retain_witness).
    let raw_pre = b"pre-change-frame-pixels-v1";
    let sha_pre = sha256_hex(raw_pre);
    let wit_pre = j.retain_witness(raw_pre).unwrap();
    let frame_pre = Input::Frame {
        surface_id: surface_id.clone(),
        frame: Frame {
            sha256: sha_pre,
            generation: 1,
            width: 1280,
            height: 900,
        },
    };
    let out3 = state.apply(&frame_pre).unwrap();
    j.append(&frame_pre, &out3, &state, vec![wit_pre]).unwrap();
    drop(j);

    let out_pre = std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
        .arg("--journal")
        .arg(&f.path)
        .arg("--witness-root")
        .arg(&f.root)
        .arg("--verify-only")
        .output()
        .unwrap();
    assert_eq!(out_pre.status.code(), Some(0));

    // 2. Recover and append post-change frame records using retain_frame_witness + group-commit.
    let (mut j, mut state) = Journal::recover(&f.path, &f.root).unwrap();
    let raw_post = vec![0x7b_u8; 64 * 1024];
    let sha_post = sha256_hex(&raw_post);
    let wit_post = j.retain_frame_witness(&sha_post, &raw_post).unwrap();
    let frame_post = Input::Frame {
        surface_id,
        frame: Frame {
            sha256: sha_post.clone(),
            generation: 2,
            width: 1280,
            height: 900,
        },
    };
    let out4 = state.apply(&frame_post).unwrap();
    j.append(&frame_post, &out4, &state, vec![wit_post])
        .unwrap();
    drop(j);

    let out_post = std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
        .arg("--journal")
        .arg(&f.path)
        .arg("--witness-root")
        .arg(&f.root)
        .arg("--verify-only")
        .output()
        .unwrap();
    assert_eq!(out_post.status.code(), Some(0));

    // Negative control: corrupting a frame witness byte causes mv-replay to fail closed with rc=4 (Witness).
    let artifact_path = f.root.join("artifacts").join(&sha_post);
    let mut corrupted = fs::read(&artifact_path).unwrap();
    corrupted[0] ^= 0xff;
    fs::write(&artifact_path, &corrupted).unwrap();
    let out_bad = std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
        .arg("--journal")
        .arg(&f.path)
        .arg("--witness-root")
        .arg(&f.root)
        .arg("--verify-only")
        .output()
        .unwrap();
    assert_eq!(out_bad.status.code(), Some(4));
}

#[test]
fn retain_frame_witness_rejects_mismatched_digest_before_commit() {
    use metaviewer_core::journal::{sha256_hex, VerifiedPixels};

    let f = Fixture::new();
    let state = CoreState::session("session-1").unwrap();
    let mut j = Journal::create(&f.dir, &state).unwrap();
    let bogus = "0".repeat(64);
    assert_eq!(
        j.retain_frame_witness(&bogus, b"corrupt"),
        Err(JournalError::Witness)
    );
    assert_eq!(
        VerifiedPixels::verify(&bogus, b"corrupt".to_vec()).unwrap_err(),
        JournalError::Witness
    );
    assert!(!f.root.join("artifacts").join(&bogus).exists());

    let valid_bytes = b"verified-frame-pixels".to_vec();
    let valid_sha = sha256_hex(&valid_bytes);
    let verified = VerifiedPixels::verify(&valid_sha, valid_bytes.clone()).unwrap();
    let w = j.retain_verified_pixels(&verified).unwrap();
    assert_eq!(w.sha256, valid_sha);
    assert_eq!(w.byte_len, valid_bytes.len() as u64);
}

#[test]
fn frame_append_does_not_publish_checkpoint_before_sync() {
    use metaviewer_core::admission::{Frame, Surface};
    use metaviewer_core::journal::sha256_hex;
    use metaviewer_core::{Component, Endpoint};

    let f = Fixture::new();
    let mut state = CoreState::session("session-1").unwrap();
    let mut j = Journal::create(&f.dir, &state).unwrap();
    let out1 = state.apply(&Input::Connect).unwrap();
    j.append(&Input::Connect, &out1, &state, vec![]).unwrap();
    let sw = j.retain_witness(b"surface-seed").unwrap();
    let s_in = Input::Surface {
        id: "srf-cp".into(),
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

    let cp_before: serde_json::Value =
        serde_json::from_slice(&fs::read(f.root.join("checkpoint.json")).unwrap()).unwrap();
    assert_eq!(cp_before["count"], 2);

    let pixels = b"frame-1-unflushed";
    let sha = sha256_hex(pixels);
    let fw = j.retain_frame_witness(&sha, pixels).unwrap();
    let f_in = Input::Frame {
        surface_id: "srf-cp".into(),
        frame: Frame {
            sha256: sha,
            generation: 1,
            width: 64,
            height: 64,
        },
    };
    let out3 = state.apply(&f_in).unwrap();
    j.append(&f_in, &out3, &state, vec![fw]).unwrap();

    let cp_unflushed: serde_json::Value =
        serde_json::from_slice(&fs::read(f.root.join("checkpoint.json")).unwrap()).unwrap();
    assert_eq!(
        cp_unflushed["count"], 2,
        "checkpoint.json must not claim an unflushed frame before sync"
    );

    j.flush_sync().unwrap();
    let cp_flushed: serde_json::Value =
        serde_json::from_slice(&fs::read(f.root.join("checkpoint.json")).unwrap()).unwrap();
    assert_eq!(cp_flushed["count"], 3);
}

#[test]
fn failed_flush_sync_poisons_journal() {
    use metaviewer_core::admission::{Frame, Surface};
    use metaviewer_core::journal::sha256_hex;
    use metaviewer_core::{Component, Endpoint};

    let f = Fixture::new();
    let mut state = CoreState::session("session-1").unwrap();
    let mut j = Journal::create(&f.dir, &state).unwrap();
    let payload = b"dirty-frame-witness";
    let sha = sha256_hex(payload);
    j.retain_frame_witness(&sha, payload).unwrap();
    fs::remove_dir_all(f.root.join("artifacts")).unwrap();
    assert!(j.flush_sync().is_err());
    let out = state.apply(&Input::Connect).unwrap();
    assert_eq!(
        j.append(&Input::Connect, &out, &state, vec![]),
        Err(JournalError::Poisoned)
    );

    // Also verify background sync failure poisons the next commit without explicit flush_sync.
    let f2 = Fixture::new();
    let mut state2 = CoreState::session("session-1").unwrap();
    let mut j2 = Journal::create(&f2.dir, &state2).unwrap();
    let out2 = state2.apply(&Input::Connect).unwrap();
    j2.append(&Input::Connect, &out2, &state2, vec![]).unwrap();
    let sw2 = j2.retain_witness(b"surface-bg-seed").unwrap();
    let s_in2 = Input::Surface {
        id: "surface-bg".into(),
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
    let out_s2 = state2.apply(&s_in2).unwrap();
    j2.append(&s_in2, &out_s2, &state2, vec![sw2]).unwrap();
    // Wait past FRAME_SYNC_WINDOW (50 ms) so the next Frame append immediately dispatches a background SyncTask.
    std::thread::sleep(std::time::Duration::from_millis(60));
    let bytes2 = b"bg-sync-frame-pixels";
    let sha2 = sha256_hex(bytes2);
    let w2 = j2.retain_frame_witness(&sha2, bytes2).unwrap();
    let f_in2 = Input::Frame {
        surface_id: "surface-bg".into(),
        frame: Frame {
            sha256: sha2,
            generation: 1,
            width: 64,
            height: 64,
        },
    };
    let out_f2 = state2.apply(&f_in2).unwrap();
    fs::remove_file(f2.root.join("checkpoint.json")).unwrap();
    fs::create_dir(f2.root.join("checkpoint.json")).unwrap();
    std::os::unix::fs::PermissionsExt::set_mode(
        &mut fs::metadata(f2.root.join("checkpoint.json"))
            .unwrap()
            .permissions(),
        0o700,
    );
    fs::set_permissions(
        f2.root.join("checkpoint.json"),
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    fs::write(f2.root.join("checkpoint.json").join("keep"), b"x").unwrap();
    j2.append(&f_in2, &out_f2, &state2, vec![w2]).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    let out_next = state2.apply(&Input::Connect).unwrap();
    assert_eq!(
        j2.append(&Input::Connect, &out_next, &state2, vec![]),
        Err(JournalError::Poisoned)
    );
    assert_eq!(j2.flush_sync(), Err(JournalError::Poisoned));
}

#[test]
fn repeated_uncommitted_retains_do_not_hold_unbounded_fds() {
    use metaviewer_core::journal::sha256_hex;

    let f = Fixture::new();
    let state = CoreState::session("session-1").unwrap();
    let mut j = Journal::create(&f.dir, &state).unwrap();
    let fd_count = || fs::read_dir("/proc/self/fd").unwrap().count();
    let before = fd_count();
    for i in 0..2048u32 {
        let bytes = format!("uncommitted-fd-payload-{i}").into_bytes();
        let sha = sha256_hex(&bytes);
        j.retain_frame_witness(&sha, &bytes).unwrap();
    }
    let after = fd_count();
    assert!(
        after.saturating_sub(before) < 64,
        "uncommitted retains grew open fds by {} (>= 64)",
        after.saturating_sub(before)
    );
}

#[test]
fn uncommitted_retains_do_not_leave_unbounded_artifacts() {
    use metaviewer_core::journal::sha256_hex;

    let f = Fixture::new();
    let state = CoreState::session("session-1").unwrap();
    let mut j = Journal::create(&f.dir, &state).unwrap();
    for i in 0..256u32 {
        let bytes = format!("uncommitted-artifact-payload-{i}").into_bytes();
        let sha = sha256_hex(&bytes);
        j.retain_frame_witness(&sha, &bytes).unwrap();
    }
    let count = fs::read_dir(f.root.join("artifacts")).unwrap().count();
    assert!(
        count <= 32,
        "uncommitted retains left {count} orphaned artifacts (> 32)"
    );
}

#[test]
fn flush_sync_on_poisoned_journal_returns_poisoned() {
    let f = Fixture::new();
    let mut state = CoreState::session("session-1").unwrap();
    let mut j = Journal::create(&f.dir, &state).unwrap();
    fs::remove_dir_all(f.root.join("events")).unwrap();
    let out = state.apply(&Input::Connect).unwrap();
    assert!(j.append(&Input::Connect, &out, &state, vec![]).is_err());
    assert_eq!(j.flush_sync(), Err(JournalError::Poisoned));
}
