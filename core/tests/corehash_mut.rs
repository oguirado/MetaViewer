mod support;

use metaviewer_core::admission::{
    AdmissionRequest, Authority, CoreState, Frame, Input, LifecycleUpdate, Surface,
};
use metaviewer_core::journal::{
    sha256_hex, Journal, JournalError, VerifiedPixels, MAX_SURFACE_WITNESS_BYTES,
};
use metaviewer_core::serve::{self, Config, Registration, Server};
use metaviewer_core::*;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::UnixStream;

static REGISTRY_SERIAL: Mutex<()> = Mutex::new(());

fn lock_registry() -> std::sync::MutexGuard<'static, ()> {
    REGISTRY_SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn private_temp() -> support::Temp {
    let temp = support::Temp::new();
    fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o700)).unwrap();
    temp
}

fn agent_endpoint() -> Endpoint {
    serde_json::from_value(json!({"component": "agent", "instance": "agent-test"})).unwrap()
}

fn sample_surface(display: &str) -> Surface {
    Surface {
        display: display.into(),
        owner: agent_endpoint(),
        agent_controlled: true,
        live: true,
        frame: None,
        refresh_after: None,
        allowed_verbs: vec!["noop".into(), "click".into()],
    }
}

fn create_private_dir(path: &Path) {
    let _ = fs::remove_dir_all(path);
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .unwrap();
}

fn write_private_file(path: &Path, bytes: &[u8]) {
    let mut f = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    f.write_all(bytes).unwrap();
    f.sync_all().unwrap();
}

fn evict_root_via_recover(session_dir: &Path) {
    let journal_path = session_dir.join("journal.jsonl");
    if journal_path.exists() {
        let _ = Journal::recover(&journal_path, session_dir);
    }
}

// Brief 1 (Advocate note): Same surface non-advancing generation refuses fast path on production read.
// Killing mutation: weaken `generation > entry.generation` to `generation >= entry.generation`
// in `lookup_committed_surface_witness`.
#[test]
fn same_surface_non_advancing_generation_refuses_fast_path_on_production_read() {
    let _guard = lock_registry();
    let temp = private_temp();
    let state_dir = temp.0.join("state");
    create_private_dir(&state_dir);

    let mut state = CoreState::session("session-non-adv").unwrap();
    let mut journal = Journal::create(&state_dir, &state).unwrap();
    let session_dir = state_dir.join("sessions/session-non-adv");

    let out_c = state.apply(&Input::Connect).unwrap();
    journal
        .append(&Input::Connect, &out_c, &state, vec![])
        .unwrap();

    let srf_in = Input::Surface {
        id: "srf-gen".into(),
        surface: sample_surface(":10"),
    };
    let sw = journal.retain_witness(b"srf-gen").unwrap();
    let out_s = state.apply(&srf_in).unwrap();
    journal.append(&srf_in, &out_s, &state, vec![sw]).unwrap();

    let payload = vec![0x42_u8; 65_536];
    let sha = sha256_hex(&payload);

    // Prime surface at generation 1 and advance to generation 2 so both equal (2)
    // and regressed (1) generations are valid positive generation numbers.
    for gen in [1_u64, 2_u64] {
        let started = Instant::now();
        let verified = VerifiedPixels::read_verified_for_surface(
            &session_dir,
            "srf-gen",
            state.epoch,
            gen,
            256,
            256,
            &payload[..],
            payload.len(),
            &sha,
        )
        .unwrap();
        let elapsed = started.elapsed().as_nanos();
        if gen == 1 {
            assert!(!verified.hash_skipped());
            assert!(verified.hash_ns() > 0);
            assert_eq!(verified.skipped_hash_ns(), 0);
            assert!(verified.shm_read_ns() + verified.hash_ns() <= elapsed);
        } else {
            assert!(verified.hash_skipped());
            assert_eq!(verified.hash_ns(), 0);
            assert!(verified.skipped_hash_ns() > 0);
            assert!(verified.shm_read_ns() + verified.skipped_hash_ns() <= elapsed);
        }
        let fw = journal.retain_verified_pixels(&verified).unwrap();
        let f_in = Input::Frame {
            surface_id: "srf-gen".into(),
            frame: Frame {
                sha256: sha.clone(),
                generation: gen,
                width: 256,
                height: 256,
            },
        };
        let out_f = state.apply(&f_in).unwrap();
        journal.append(&f_in, &out_f, &state, vec![fw]).unwrap();
    }
    assert!(journal.has_committed_surface_witness("srf-gen", &sha));

    // Equal generation (2 == 2) and regressed generation (1 < 2, 0 < 2) via production read
    // must refuse the fast path and compute full streaming SHA-256.
    for non_adv_gen in [2_u64, 1_u64, 0_u64] {
        let started = Instant::now();
        let verified = VerifiedPixels::read_verified_for_surface(
            &session_dir,
            "srf-gen",
            state.epoch,
            non_adv_gen,
            256,
            256,
            &payload[..],
            payload.len(),
            &sha,
        )
        .unwrap();
        let elapsed = started.elapsed().as_nanos();
        assert!(
            !verified.hash_skipped(),
            "production read must refuse fast path for non-advancing generation {non_adv_gen}"
        );
        assert!(
            verified.hash_ns() > 0,
            "non-advancing generation {non_adv_gen} must record positive hash_ns"
        );
        assert_eq!(verified.skipped_hash_ns(), 0);
        assert!(
            verified.shm_read_ns() + verified.hash_ns() <= elapsed,
            "shm_read_ns ({}) + hash_ns ({}) must not exceed total elapsed ({elapsed})",
            verified.shm_read_ns(),
            verified.hash_ns()
        );
        assert_eq!(verified.sha256(), sha);
    }

    // Advancing generation (3 > 2) still hits the fast path.
    let started = Instant::now();
    let advancing = VerifiedPixels::read_verified_for_surface(
        &session_dir,
        "srf-gen",
        state.epoch,
        3,
        256,
        256,
        &payload[..],
        payload.len(),
        &sha,
    )
    .unwrap();
    let elapsed = started.elapsed().as_nanos();
    assert!(advancing.hash_skipped());
    assert_eq!(advancing.hash_ns(), 0);
    assert!(advancing.skipped_hash_ns() > 0);
    assert!(advancing.shm_read_ns() + advancing.skipped_hash_ns() <= elapsed);

    journal.close().unwrap();
    drop(journal);
    evict_root_via_recover(&session_dir);
}

// Brief 2: Lifecycle and control events each evict primed surface witness.
// Killing mutation: drop `Input::ReleaseControl { surface_id }` arm from eviction dispatch
// in `update_committed_surface_witnesses_after_append`.
#[test]
fn lifecycle_and_control_events_each_evict_primed_surface_witness() {
    let _guard = lock_registry();
    let temp = private_temp();
    let state_dir = temp.0.join("state");
    create_private_dir(&state_dir);

    let mut state = CoreState::session("session-evict").unwrap();
    let mut journal = Journal::create(&state_dir, &state).unwrap();
    let session_dir = state_dir.join("sessions/session-evict");

    let out_c = state.apply(&Input::Connect).unwrap();
    journal
        .append(&Input::Connect, &out_c, &state, vec![])
        .unwrap();

    for (sid, disp) in [
        ("srf-main", ":20"),
        ("srf-lost", ":21"),
        ("srf-destroy", ":22"),
    ] {
        let create_in = Input::Lifecycle {
            surface_id: sid.into(),
            update: LifecycleUpdate::Created(sample_surface(disp)),
        };
        let out = state.apply(&create_in).unwrap();
        journal.append(&create_in, &out, &state, vec![]).unwrap();
    }

    let payload = vec![0x3c_u8; 32_768];
    let sha = sha256_hex(&payload);

    let prime_surface = |journal: &mut Journal, state: &mut CoreState, sid: &str, gen: u64| {
        let fw = journal.retain_frame_witness(&sha, &payload).unwrap();
        let f_in = Input::Frame {
            surface_id: sid.into(),
            frame: Frame {
                sha256: sha.clone(),
                generation: gen,
                width: 128,
                height: 256,
            },
        };
        let out_f = state.apply(&f_in).unwrap();
        journal.append(&f_in, &out_f, state, vec![fw]).unwrap();
        assert!(journal.has_committed_surface_witness(sid, &sha));
    };

    let assert_evicted_and_hashes =
        |journal: &Journal, state: &CoreState, sid: &str, next_gen: u64, label: &str| {
            assert!(
                !journal.has_committed_surface_witness(sid, &sha),
                "{label} must evict committed surface witness for {sid}"
            );
            let started = Instant::now();
            let v = VerifiedPixels::read_verified_for_surface(
                &session_dir,
                sid,
                state.epoch,
                next_gen,
                128,
                256,
                &payload[..],
                payload.len(),
                &sha,
            )
            .unwrap();
            let elapsed = started.elapsed().as_nanos();
            assert!(
                !v.hash_skipped(),
                "{label} must force full hash on production read"
            );
            assert!(v.hash_ns() > 0, "{label} must record positive hash_ns");
            assert_eq!(v.skipped_hash_ns(), 0);
            assert!(v.shm_read_ns() + v.hash_ns() <= elapsed);
        };

    // 1. Created on an already-primed surface (policy-refused duplicate create, refresh_after remains None).
    prime_surface(&mut journal, &mut state, "srf-main", 1);
    let created_again = Input::Lifecycle {
        surface_id: "srf-main".into(),
        update: LifecycleUpdate::Created(sample_surface(":20")),
    };
    let out_created = state.apply(&created_again).unwrap();
    assert_eq!(out_created.reason, Some(Refusal::Policy));
    journal
        .append(&created_again, &out_created, &state, vec![])
        .unwrap();
    assert_evicted_and_hashes(&journal, &state, "srf-main", 2, "LifecycleUpdate::Created");

    // 2. Updated on a primed surface.
    prime_surface(&mut journal, &mut state, "srf-main", 2);
    let updated_in = Input::Lifecycle {
        surface_id: "srf-main".into(),
        update: LifecycleUpdate::Updated(sample_surface(":20-upd")),
    };
    let out_updated = state.apply(&updated_in).unwrap();
    journal
        .append(&updated_in, &out_updated, &state, vec![])
        .unwrap();
    assert_evicted_and_hashes(&journal, &state, "srf-main", 3, "LifecycleUpdate::Updated");

    // 3. TakeControl on a primed surface.
    prime_surface(&mut journal, &mut state, "srf-main", 3);
    let tc_in = Input::TakeControl {
        surface_id: "srf-main".into(),
    };
    let out_tc = state.apply(&tc_in).unwrap();
    journal.append(&tc_in, &out_tc, &state, vec![]).unwrap();
    assert_evicted_and_hashes(&journal, &state, "srf-main", 4, "Input::TakeControl");

    // 4a. Accepted ReleaseControl on a primed surface (re-prime while human-controlled, then ReleaseControl).
    prime_surface(&mut journal, &mut state, "srf-main", 4);
    let rc_ok = Input::ReleaseControl {
        surface_id: "srf-main".into(),
    };
    let out_rc_ok = state.apply(&rc_ok).unwrap();
    assert_eq!(out_rc_ok.reason, None);
    journal.append(&rc_ok, &out_rc_ok, &state, vec![]).unwrap();
    assert_evicted_and_hashes(
        &journal,
        &state,
        "srf-main",
        5,
        "accepted Input::ReleaseControl",
    );

    // 4b. ReleaseControl while a cancelled proposal is draining and a fresh frame has already
    // cleared `refresh_after` to None. Here `stale_surfaces` sees `refresh_after == None`, so ONLY
    // the explicit `Input::ReleaseControl` arm in eviction dispatch evicts the primed witness.
    prime_surface(&mut journal, &mut state, "srf-main", 5);
    let proposal_env = json!({
        "schema": "envelope/v0.2",
        "msg_id": "agent-prop-1",
        "ts_ns": 100,
        "from": agent_endpoint(),
        "to": {"component": "core", "instance": "core-test"},
        "session_id": "session-evict",
        "seq": 1,
        "nonce": "nonce-prop-1",
        "body": {
            "schema": "action_proposal/v0.2",
            "proposal_id": "prop-drain-1",
            "surface_id": "srf-main",
            "based_on_frame": {
                "sha256": sha,
                "generation": 5
            },
            "action": {
                "type": "click",
                "x": 10,
                "y": 10,
                "button": "left"
            },
            "expectation": {
                "type": "changed_region", "bbox": {"x": 0, "y": 0, "w": 1, "h": 1}
            },
            "budget": {
                "max_ms": 1000,
                "max_retries": 0
            }
        }
    });
    let req = AdmissionRequest::decode(
        &proposal_env.to_string(),
        &agent_endpoint(),
        "session-evict",
        state.epoch,
        100,
    )
    .unwrap();
    let prop_fw = journal.retain_frame_witness(&sha, &payload).unwrap();
    let prop_in = Input::Propose(req);
    let out_prop = state.apply(&prop_in).unwrap();
    assert_eq!(out_prop.reason, None);
    journal
        .append(&prop_in, &out_prop, &state, vec![prop_fw])
        .unwrap();

    let disp_in = Input::Dispatch {
        proposal_id: "prop-drain-1".into(),
        now_ns: 200,
    };
    let out_disp = state.apply(&disp_in).unwrap();
    assert!(out_disp.dispatch);
    journal.append(&disp_in, &out_disp, &state, vec![]).unwrap();

    // TakeControl cancels the dispatched proposal into `draining`.
    let tc_drain = Input::TakeControl {
        surface_id: "srf-main".into(),
    };
    let out_tc_drain = state.apply(&tc_drain).unwrap();
    assert_eq!(out_tc_drain.cancelled, vec!["prop-drain-1".to_string()]);
    journal
        .append(&tc_drain, &out_tc_drain, &state, vec![])
        .unwrap();

    // Commit frame generation 6: clears `refresh_after` to None and primes `srf-main` while draining.
    prime_surface(&mut journal, &mut state, "srf-main", 6);
    assert!(state.surfaces["srf-main"].refresh_after.is_none());
    assert!(state.draining.contains_key("prop-drain-1"));

    // ReleaseControl is refused with Policy because `prop-drain-1` is still draining,
    // leaving `refresh_after == None`. The dispatch arm must still evict `srf-main`.
    let rc_draining = Input::ReleaseControl {
        surface_id: "srf-main".into(),
    };
    let out_rc_draining = state.apply(&rc_draining).unwrap();
    assert_eq!(out_rc_draining.reason, Some(Refusal::Policy));
    assert!(state.surfaces["srf-main"].refresh_after.is_none());
    journal
        .append(&rc_draining, &out_rc_draining, &state, vec![])
        .unwrap();
    assert_evicted_and_hashes(
        &journal,
        &state,
        "srf-main",
        7,
        "draining Input::ReleaseControl",
    );

    // 5. Lost on a primed surface.
    prime_surface(&mut journal, &mut state, "srf-lost", 1);
    let lost_in = Input::Lifecycle {
        surface_id: "srf-lost".into(),
        update: LifecycleUpdate::Lost,
    };
    let out_lost = state.apply(&lost_in).unwrap();
    journal.append(&lost_in, &out_lost, &state, vec![]).unwrap();
    assert_evicted_and_hashes(&journal, &state, "srf-lost", 2, "LifecycleUpdate::Lost");

    // 6. Destroyed on a primed surface.
    prime_surface(&mut journal, &mut state, "srf-destroy", 1);
    let destroy_in = Input::Lifecycle {
        surface_id: "srf-destroy".into(),
        update: LifecycleUpdate::Destroyed,
    };
    let out_destroy = state.apply(&destroy_in).unwrap();
    journal
        .append(&destroy_in, &out_destroy, &state, vec![])
        .unwrap();
    assert_evicted_and_hashes(
        &journal,
        &state,
        "srf-destroy",
        2,
        "LifecycleUpdate::Destroyed",
    );

    // 7. Surface announce (`Input::Surface`) with an embedded initial frame never blesses the fast
    // path cache without a live `Input::Frame`, and re-announcing an existing surface is rejected.
    prime_surface(&mut journal, &mut state, "srf-main", 7);
    let reannounce = Input::Surface {
        id: "srf-main".into(),
        surface: sample_surface(":20"),
    };
    // [TARGET, unit decision] A primed re-announcement cannot reach eviction
    // through the public API: admission rejects duplicate surface identities.
    assert!(state.apply(&reannounce).is_err());
    assert_eq!(
        journal.append(&reannounce, &out_rc_draining, &state, vec![]),
        Err(JournalError::Invalid)
    );
    let mut initial_with_frame = sample_surface(":23");
    initial_with_frame.frame = Some(Frame {
        sha256: sha.clone(),
        generation: 1,
        width: 128,
        height: 256,
    });
    let srf_announce = Input::Surface {
        id: "srf-announced".into(),
        surface: initial_with_frame,
    };
    let announce_fw = journal.retain_frame_witness(&sha, &payload).unwrap();
    let out_ann = state.apply(&srf_announce).unwrap();
    journal
        .append(&srf_announce, &out_ann, &state, vec![announce_fw])
        .unwrap();
    assert_evicted_and_hashes(&journal, &state, "srf-announced", 2, "Input::Surface");

    journal.close().unwrap();
    drop(journal);
    evict_root_via_recover(&session_dir);
}

// Brief 3: Per root byte cap and count cap evict oldest at boundary.
// Killing mutation: loosen byte cap comparison to allow one byte over cap
// (`MAX_SURFACE_WITNESS_BYTES + 1`).
#[test]
fn per_root_byte_cap_and_count_cap_evict_oldest_at_boundary() {
    let _guard = lock_registry();
    let temp = private_temp();

    // Part A: Exact 64 MiB byte cap boundary (4 * 16 MiB = 64 MiB) + 1 byte overflow evicts oldest.
    let state_bytes_dir = temp.0.join("state-bytes");
    create_private_dir(&state_bytes_dir);
    let mut state_b = CoreState::session("session-byte-cap").unwrap();
    let mut journal_b = Journal::create(&state_bytes_dir, &state_b).unwrap();
    let session_b = state_bytes_dir.join("sessions/session-byte-cap");
    let out_c = state_b.apply(&Input::Connect).unwrap();
    journal_b
        .append(&Input::Connect, &out_c, &state_b, vec![])
        .unwrap();

    // Single witness over cap (64 MiB + 1 byte) is rejected at the production read boundary.
    let over_cap_err = VerifiedPixels::read_verified_for_surface(
        &session_b,
        "srf-over",
        state_b.epoch,
        1,
        1024,
        1024,
        std::io::empty(),
        MAX_SURFACE_WITNESS_BYTES + 1,
        &"a".repeat(64),
    )
    .unwrap_err();
    assert_eq!(over_cap_err.kind(), std::io::ErrorKind::InvalidData);

    let chunk_len = 16 * 1024 * 1024; // 16 MiB; 4 chunks = 64 MiB == MAX_SURFACE_WITNESS_BYTES
    assert_eq!(4 * chunk_len, MAX_SURFACE_WITNESS_BYTES);
    let mut chunks: Vec<(String, Vec<u8>, String)> = Vec::new();

    for idx in 0..4_u8 {
        let sid = format!("srf-byte-{idx}");
        let s_in = Input::Lifecycle {
            surface_id: sid.clone(),
            update: LifecycleUpdate::Created(sample_surface(&format!(":3{idx}"))),
        };
        let out_s = state_b.apply(&s_in).unwrap();
        journal_b.append(&s_in, &out_s, &state_b, vec![]).unwrap();

        let mut payload = vec![idx.wrapping_add(0x10); chunk_len];
        payload[0] = idx;
        payload[chunk_len - 1] = idx ^ 0x55;
        let sha = sha256_hex(&payload);
        let fw = journal_b.retain_frame_witness(&sha, &payload).unwrap();
        let f_in = Input::Frame {
            surface_id: sid.clone(),
            frame: Frame {
                sha256: sha.clone(),
                generation: 1,
                width: 4096,
                height: 4096,
            },
        };
        let out_f = state_b.apply(&f_in).unwrap();
        journal_b.append(&f_in, &out_f, &state_b, vec![fw]).unwrap();
        chunks.push((sid, payload, sha));
    }

    // At exact 64 MiB boundary, all 4 witnesses (including oldest `srf-byte-0`) remain cached.
    assert_eq!(journal_b.committed_surface_witness_count(), 4);
    assert_eq!(
        journal_b.committed_surface_witness_bytes(),
        MAX_SURFACE_WITNESS_BYTES
    );
    assert!(journal_b.has_committed_surface_witness(&chunks[0].0, &chunks[0].2));
    let v_at_cap = VerifiedPixels::read_verified_for_surface(
        &session_b,
        &chunks[0].0,
        state_b.epoch,
        2,
        4096,
        4096,
        &chunks[0].1[..],
        chunks[0].1.len(),
        &chunks[0].2,
    )
    .unwrap();
    assert!(
        v_at_cap.hash_skipped(),
        "oldest surface must remain cached at exact MAX_SURFACE_WITNESS_BYTES boundary"
    );

    // Adding a 1-byte witness crosses MAX_SURFACE_WITNESS_BYTES by 1 byte (`64 MiB + 1`),
    // which must evict `srf-byte-0` and keep total bytes within cap.
    let sid_one = "srf-byte-overflow-1b".to_string();
    let s_in = Input::Lifecycle {
        surface_id: sid_one.clone(),
        update: LifecycleUpdate::Created(sample_surface(":39")),
    };
    let out_s = state_b.apply(&s_in).unwrap();
    journal_b.append(&s_in, &out_s, &state_b, vec![]).unwrap();
    let one_byte = vec![0xee_u8; 1];
    let sha_one = sha256_hex(&one_byte);
    let fw_one = journal_b.retain_frame_witness(&sha_one, &one_byte).unwrap();
    let f_one = Input::Frame {
        surface_id: sid_one.clone(),
        frame: Frame {
            sha256: sha_one.clone(),
            generation: 1,
            width: 1,
            height: 1,
        },
    };
    let out_f_one = state_b.apply(&f_one).unwrap();
    journal_b
        .append(&f_one, &out_f_one, &state_b, vec![fw_one])
        .unwrap();

    assert_eq!(journal_b.committed_surface_witness_count(), 4);
    assert_eq!(
        journal_b.committed_surface_witness_bytes(),
        3 * chunk_len + 1
    );
    assert!(journal_b.committed_surface_witness_bytes() <= MAX_SURFACE_WITNESS_BYTES);
    assert!(
        !journal_b.has_committed_surface_witness(&chunks[0].0, &chunks[0].2),
        "crossing MAX_SURFACE_WITNESS_BYTES by 1 byte must evict oldest surface"
    );
    let started = Instant::now();
    let v_evicted = VerifiedPixels::read_verified_for_surface(
        &session_b,
        &chunks[0].0,
        state_b.epoch,
        2,
        4096,
        4096,
        &chunks[0].1[..],
        chunks[0].1.len(),
        &chunks[0].2,
    )
    .unwrap();
    let elapsed = started.elapsed().as_nanos();
    assert!(!v_evicted.hash_skipped());
    assert!(v_evicted.hash_ns() > 0);
    assert_eq!(v_evicted.skipped_hash_ns(), 0);
    assert!(v_evicted.shm_read_ns() + v_evicted.hash_ns() <= elapsed);

    let v_retained = VerifiedPixels::read_verified_for_surface(
        &session_b,
        &chunks[1].0,
        state_b.epoch,
        2,
        4096,
        4096,
        &chunks[1].1[..],
        chunks[1].1.len(),
        &chunks[1].2,
    )
    .unwrap();
    assert!(v_retained.hash_skipped());

    journal_b.close().unwrap();
    drop(journal_b);
    drop(chunks);
    evict_root_via_recover(&session_b);

    // Part B: Per-root count cap boundary (32 surfaces retained; 33rd evicts oldest).
    let state_cnt_dir = temp.0.join("state-count");
    create_private_dir(&state_cnt_dir);
    let mut state_c = CoreState::session("session-count-cap").unwrap();
    let mut journal_c = Journal::create(&state_cnt_dir, &state_c).unwrap();
    let session_c = state_cnt_dir.join("sessions/session-count-cap");
    let out_c = state_c.apply(&Input::Connect).unwrap();
    journal_c
        .append(&Input::Connect, &out_c, &state_c, vec![])
        .unwrap();

    let mut tiny_surfaces: Vec<(String, Vec<u8>, String)> = Vec::new();
    for idx in 0..33_u8 {
        let sid = format!("srf-cnt-{idx:02}");
        let s_in = Input::Lifecycle {
            surface_id: sid.clone(),
            update: LifecycleUpdate::Created(sample_surface(&format!(":4{idx:02}"))),
        };
        let out_s = state_c.apply(&s_in).unwrap();
        journal_c.append(&s_in, &out_s, &state_c, vec![]).unwrap();

        let payload = vec![idx.wrapping_add(1); 64];
        let sha = sha256_hex(&payload);
        let fw = journal_c.retain_frame_witness(&sha, &payload).unwrap();
        let f_in = Input::Frame {
            surface_id: sid.clone(),
            frame: Frame {
                sha256: sha.clone(),
                generation: 1,
                width: 8,
                height: 8,
            },
        };
        let out_f = state_c.apply(&f_in).unwrap();
        journal_c.append(&f_in, &out_f, &state_c, vec![fw]).unwrap();
        tiny_surfaces.push((sid, payload, sha));

        if idx == 31 {
            assert_eq!(journal_c.committed_surface_witness_count(), 32);
            let v_oldest_at_32 = VerifiedPixels::read_verified_for_surface(
                &session_c,
                &tiny_surfaces[0].0,
                state_c.epoch,
                2,
                8,
                8,
                &tiny_surfaces[0].1[..],
                tiny_surfaces[0].1.len(),
                &tiny_surfaces[0].2,
            )
            .unwrap();
            assert!(v_oldest_at_32.hash_skipped());
        }
    }

    assert_eq!(journal_c.committed_surface_witness_count(), 32);
    assert!(!journal_c.has_committed_surface_witness(&tiny_surfaces[0].0, &tiny_surfaces[0].2));
    let v_cnt_evicted = VerifiedPixels::read_verified_for_surface(
        &session_c,
        &tiny_surfaces[0].0,
        state_c.epoch,
        2,
        8,
        8,
        &tiny_surfaces[0].1[..],
        tiny_surfaces[0].1.len(),
        &tiny_surfaces[0].2,
    )
    .unwrap();
    assert!(!v_cnt_evicted.hash_skipped());
    assert!(v_cnt_evicted.hash_ns() > 0);
    assert_eq!(v_cnt_evicted.skipped_hash_ns(), 0);

    for retained_idx in [1_usize, 32_usize] {
        let (sid, payload, sha) = &tiny_surfaces[retained_idx];
        assert!(journal_c.has_committed_surface_witness(sid, sha));
        let v_ret = VerifiedPixels::read_verified_for_surface(
            &session_c,
            sid,
            state_c.epoch,
            2,
            8,
            8,
            &payload[..],
            payload.len(),
            sha,
        )
        .unwrap();
        assert!(v_ret.hash_skipped());
        assert_eq!(v_ret.hash_ns(), 0);
        assert!(v_ret.skipped_hash_ns() > 0);
    }

    journal_c.close().unwrap();
    drop(journal_c);
    evict_root_via_recover(&session_c);
}

// Brief 4: Global root registry cap evicts oldest root at boundary.
// Killing mutation: remove oldest root eviction when registry is full
// (`MAX_SURFACE_WITNESS_ROOTS = 64`).
#[test]
fn global_root_registry_cap_evicts_oldest_root_at_boundary() {
    let _guard = lock_registry();
    let temp = private_temp();

    let payload = vec![0x91_u8; 4096];
    let sha = sha256_hex(&payload);
    let mut roots: Vec<(PathBuf, u64)> = Vec::new();
    let mut journals = Vec::new();

    for idx in 0..65_usize {
        let state_dir = temp.0.join(format!("root-{idx:02}"));
        create_private_dir(&state_dir);
        let session_name = format!("sess-{idx:02}");
        let mut state = CoreState::session(&session_name).unwrap();
        let mut journal = Journal::create(&state_dir, &state).unwrap();
        let session_dir = state_dir.join("sessions").join(&session_name);

        let out_c = state.apply(&Input::Connect).unwrap();
        journal
            .append(&Input::Connect, &out_c, &state, vec![])
            .unwrap();

        let s_in = Input::Lifecycle {
            surface_id: "srf-root".into(),
            update: LifecycleUpdate::Created(sample_surface(":50")),
        };
        let out_s = state.apply(&s_in).unwrap();
        journal.append(&s_in, &out_s, &state, vec![]).unwrap();

        let fw = journal.retain_frame_witness(&sha, &payload).unwrap();
        let f_in = Input::Frame {
            surface_id: "srf-root".into(),
            frame: Frame {
                sha256: sha.clone(),
                generation: 1,
                width: 64,
                height: 64,
            },
        };
        let out_f = state.apply(&f_in).unwrap();
        journal.append(&f_in, &out_f, &state, vec![fw]).unwrap();
        journal.close().unwrap();
        roots.push((session_dir, state.epoch));
        journals.push(journal);

        if idx == 63 {
            // At exactly 64 roots, the oldest root (`root-00`) is still present in the registry.
            let v_oldest_at_cap = VerifiedPixels::read_verified_for_surface(
                &roots[0].0,
                "srf-root",
                roots[0].1,
                2,
                64,
                64,
                &payload[..],
                payload.len(),
                &sha,
            )
            .unwrap();
            assert!(
                v_oldest_at_cap.hash_skipped(),
                "oldest root must remain cached at exact 64-root cap"
            );
        }
    }

    // Publishing the 65th root (`root-64`) must evict the oldest root (`root-00`).
    let started = Instant::now();
    let v_evicted = VerifiedPixels::read_verified_for_surface(
        &roots[0].0,
        "srf-root",
        roots[0].1,
        2,
        64,
        64,
        &payload[..],
        payload.len(),
        &sha,
    )
    .unwrap();
    let elapsed = started.elapsed().as_nanos();
    assert!(
        !v_evicted.hash_skipped(),
        "evicted oldest root must compute full hash on production read"
    );
    assert!(v_evicted.hash_ns() > 0);
    assert_eq!(v_evicted.skipped_hash_ns(), 0);
    assert!(v_evicted.shm_read_ns() + v_evicted.hash_ns() <= elapsed);

    for retained_idx in [1_usize, 64_usize] {
        let (ref root_dir, epoch) = roots[retained_idx];
        let v_retained = VerifiedPixels::read_verified_for_surface(
            root_dir,
            "srf-root",
            epoch,
            2,
            64,
            64,
            &payload[..],
            payload.len(),
            &sha,
        )
        .unwrap();
        assert!(
            v_retained.hash_skipped(),
            "retained root {retained_idx} must skip hash on production read"
        );
        assert_eq!(v_retained.hash_ns(), 0);
        assert!(v_retained.skipped_hash_ns() > 0);
    }

    drop(journals);
    for (root_dir, _) in &roots {
        evict_root_via_recover(root_dir);
    }
}

// Brief 5: Recovery forces full hash on first production read.
// Killing mutation: skip `remove_committed_surface_witnesses(root)` in `Journal::recover`.
#[test]
fn recovery_forces_full_hash_on_first_production_read() {
    let _guard = lock_registry();
    let temp = private_temp();
    let state_dir = temp.0.join("state");
    create_private_dir(&state_dir);

    let payload = vec![0x6b_u8; 65_536];
    let sha = sha256_hex(&payload);
    let session_dir = state_dir.join("sessions/session-recover-prod");

    let mut authority = Authority::create(
        &state_dir,
        CoreState::session("session-recover-prod").unwrap(),
    )
    .unwrap();
    authority.apply(Input::Connect).unwrap();
    authority
        .apply(Input::Lifecycle {
            surface_id: "srf-rec".into(),
            update: LifecycleUpdate::Created(sample_surface(":60")),
        })
        .unwrap();
    let fw1 = authority.retain_frame_witness(&sha, &payload).unwrap();
    authority
        .apply_with_witnesses(
            Input::Frame {
                surface_id: "srf-rec".into(),
                frame: Frame {
                    sha256: sha.clone(),
                    generation: 1,
                    width: 256,
                    height: 256,
                },
            },
            vec![fw1],
        )
        .unwrap();
    authority.flush_sync().unwrap();

    // Confirm the global registry is primed before recovery.
    let v_pre = VerifiedPixels::read_verified_for_surface(
        &session_dir,
        "srf-rec",
        authority.state().epoch,
        2,
        256,
        256,
        &payload[..],
        payload.len(),
        &sha,
    )
    .unwrap();
    assert!(v_pre.hash_skipped());

    // Recover the journal: must clear the global committed-witness registry for `session_dir`.
    // [TARGET, unit decision] Keep the original witness alive while recovering a
    // byte-identical journal snapshot on another inode: dropping the original
    // authority would itself clear the registry and mask the recovery mutant.
    let recovery_path = session_dir.join("recovery.jsonl");
    fs::copy(session_dir.join("journal.jsonl"), &recovery_path).unwrap();
    let (mut journal, mut state) = Journal::recover(&recovery_path, &session_dir).unwrap();
    assert!(!journal.has_committed_surface_witness("srf-rec", &sha));

    // First production read (`read_verified_for_surface`) after recovery with advancing generation (2 > 1)
    // must NOT skip the hash.
    let started = Instant::now();
    let v_first = VerifiedPixels::read_verified_for_surface(
        &session_dir,
        "srf-rec",
        state.epoch,
        2,
        256,
        256,
        &payload[..],
        payload.len(),
        &sha,
    )
    .unwrap();
    let elapsed = started.elapsed().as_nanos();
    assert!(
        !v_first.hash_skipped(),
        "first production read after Journal::recover must compute full SHA-256"
    );
    assert!(v_first.hash_ns() > 0);
    assert_eq!(v_first.skipped_hash_ns(), 0);
    assert!(v_first.shm_read_ns() + v_first.hash_ns() <= elapsed);

    // Commit generation 2 live, then verify the next advancing production read (generation 3) skips.
    let fw2 = journal.retain_verified_pixels(&v_first).unwrap();
    let f2_in = Input::Frame {
        surface_id: "srf-rec".into(),
        frame: Frame {
            sha256: sha.clone(),
            generation: 2,
            width: 256,
            height: 256,
        },
    };
    let out_f2 = state.apply(&f2_in).unwrap();
    journal.append(&f2_in, &out_f2, &state, vec![fw2]).unwrap();
    assert!(journal.has_committed_surface_witness("srf-rec", &sha));

    let started_next = Instant::now();
    let v_next = VerifiedPixels::read_verified_for_surface(
        &session_dir,
        "srf-rec",
        state.epoch,
        3,
        256,
        256,
        &payload[..],
        payload.len(),
        &sha,
    )
    .unwrap();
    let elapsed_next = started_next.elapsed().as_nanos();
    assert!(
        v_next.hash_skipped(),
        "advancing production read after post-recovery commit must skip SHA-256"
    );
    assert_eq!(v_next.hash_ns(), 0);
    assert!(v_next.skipped_hash_ns() > 0);
    assert!(v_next.shm_read_ns() + v_next.skipped_hash_ns() <= elapsed_next);

    journal.close().unwrap();
    drop(journal);
    evict_root_via_recover(&session_dir);
}

fn registration(component: &str) -> Registration {
    serde_json::from_value(json!({
        "endpoint": {"component": component, "instance": format!("{component}-test")},
        "hello": {
            "schema": "hello/v0.2",
            "contract_version": "v0.2",
            "component": component,
            "component_version": "0.2.0",
            "component_commit": "0123456789abcdef0123456789abcdef01234567",
            "dependencies": []
        }
    }))
    .unwrap()
}

fn serve_config() -> Config {
    Config {
        session_id: "serve-corehash-mut".into(),
        core: registration("core"),
        peers: vec![
            registration("daemon"),
            registration("agent"),
            registration("ui"),
        ],
    }
}

struct Peer {
    socket: UnixStream,
    config: Config,
    registration: Registration,
    tag: String,
    seq: u64,
}

impl Peer {
    async fn connect(path: &Path, component: &str, tag: &str) -> Self {
        let mut p = Self {
            socket: UnixStream::connect(path).await.unwrap(),
            config: serve_config(),
            registration: registration(component),
            tag: tag.into(),
            seq: 0,
        };
        p.send(serde_json::to_value(&p.registration.hello).unwrap())
            .await;
        let hello = p.receive().await;
        assert!(matches!(hello.body, Command::Hello(_)));
        p
    }

    async fn send(&mut self, body: Value) {
        self.seq += 1;
        let env = self.envelope(body);
        write_frame(&mut self.socket, &env).await.unwrap();
    }

    fn envelope(&self, body: Value) -> Envelope {
        let id = format!(
            "{}-{}-{}",
            self.registration.endpoint.instance, self.tag, self.seq
        );
        decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": id,
                "ts_ns": 0,
                "from": self.registration.endpoint,
                "to": self.config.core.endpoint,
                "session_id": self.config.session_id,
                "seq": self.seq,
                "nonce": id,
                "body": body
            })
            .to_string(),
        )
        .unwrap()
    }

    async fn receive(&mut self) -> Envelope {
        tokio::time::timeout(Duration::from_secs(3), read_frame(&mut self.socket))
            .await
            .unwrap()
            .unwrap()
            .unwrap()
    }
}

struct ShmGuard(PathBuf);
impl Drop for ShmGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn read_timing_rows(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

// Brief 6: Timings rows carry skipped hash keys with disjoint totals (plus generation-regression
// refusal row absence, optional stage keys absent, and recover-then-first-frame via serve).
// Killing mutation: omit `hash_skipped` flag on hashed rows.
#[test]
fn timings_rows_carry_skipped_hash_keys_with_disjoint_totals() {
    let _guard = lock_registry();
    support::run(async {
        let temp = private_temp();
        let uid = support::uid();
        let state = temp.0.join("state");
        let shm_path = Path::new("/dev/shm").join(format!(
            "mv-corehash-mut-{}-{}",
            std::process::id(),
            temp.0.file_name().unwrap().to_str().unwrap()
        ));
        let shm = ShmGuard(shm_path);
        let bytes = vec![0x52_u8; 64 * 64 * 3];
        write_private_file(&shm.0, &bytes);

        let mut expected_keys = vec![
            "surface_id",
            "generation",
            "width",
            "height",
            "byte_len",
            "shm_read_ns",
            "hash_ns",
            "skipped_hash_ns",
            "hash_skipped",
            "witness_journal_ns",
            "capture_ns",
            "fanout_ns",
            "total_ns",
        ];
        expected_keys.sort_unstable();

        let mut frame: Value = serde_json::from_str(include_str!(
            "../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        frame["ramws_path"] = shm.0.to_str().unwrap().into();
        frame["sha256"] = sha256_hex(&bytes).into();
        frame["width"] = 64.into();
        frame["height"] = 64.into();

        // Phase 1: Initial server accepts generation 1 (hashed) and generation 2 (skipped),
        // then refuses a generation regression (generation 2 repeated) without writing a row.
        {
            let socket = temp.0.join("runtime/core-1.sock");
            let listener = serve::bind(&socket, uid).await.unwrap();
            let server = Arc::new(Mutex::new(
                Server::open(serve_config(), &state, uid).unwrap(),
            ));
            let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

            let mut daemon = Peer::connect(&socket, "daemon", "r1").await;
            let mut ui = Peer::connect(&socket, "ui", "r1").await;
            let surface: Value = serde_json::from_str(include_str!(
                "../../contracts/examples/v0.2/surface.valid.json"
            ))
            .unwrap();
            daemon
                .send(json!({
                    "schema": "surface_event/v0.2",
                    "event": "created",
                    "data": {"surface": surface}
                }))
                .await;
            ui.receive().await;

            for gen in [1_u64, 2_u64] {
                frame["generation"] = gen.into();
                daemon.send(frame.clone()).await;
                ui.receive().await;
            }

            // Send regressed generation (1 <= committed generation 2): must be refused with no timing row.
            frame["generation"] = 1.into();
            daemon.send(frame.clone()).await;
            let refused =
                tokio::time::timeout(Duration::from_secs(5), read_frame(&mut daemon.socket))
                    .await
                    .unwrap();
            assert!(!matches!(refused, Ok(Some(_))), "{refused:?}");

            server.lock().unwrap().shutdown().unwrap();
            task.abort();
            let _ = task.await;
            drop(daemon);
            drop(ui);
            tokio::time::timeout(Duration::from_secs(5), async {
                while Arc::strong_count(&server) != 1 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }

        let timings_path = state.join("sessions/serve-corehash-mut/artifacts/frame_timings.jsonl");
        let rows_phase1 = read_timing_rows(&timings_path);
        assert_eq!(
            rows_phase1.len(),
            2,
            "regressed generation refusal must not emit a row"
        );
        for (idx, row) in rows_phase1.iter().enumerate() {
            let obj = row.as_object().unwrap();
            assert_eq!(
                obj.keys().map(String::as_str).collect::<Vec<_>>(),
                expected_keys
            );
            assert!(!obj.contains_key("parallel_wait_ns"));
            assert!(!obj.contains_key("surface_queue_depth"));
            assert_eq!(row["surface_id"], "surface-demo");
            assert_eq!(row["generation"], (idx + 1) as u64);
            assert_eq!(row["width"], 64);
            assert_eq!(row["height"], 64);
            assert_eq!(row["byte_len"], bytes.len() as u64);
            if idx == 0 {
                assert_eq!(row["hash_skipped"], false, "{row}");
                assert_eq!(row["skipped_hash_ns"].as_u64().unwrap(), 0, "{row}");
                assert!(row["hash_ns"].as_u64().unwrap() > 0, "{row}");
            } else {
                assert_eq!(row["hash_skipped"], true, "{row}");
                assert!(row["skipped_hash_ns"].as_u64().unwrap() > 0, "{row}");
                assert_eq!(row["hash_ns"].as_u64().unwrap(), 0, "{row}");
            }
            let sum: u64 = [
                "shm_read_ns",
                "hash_ns",
                "skipped_hash_ns",
                "witness_journal_ns",
                "capture_ns",
                "fanout_ns",
            ]
            .iter()
            .map(|k| row[k].as_u64().unwrap())
            .sum();
            assert!(row["total_ns"].as_u64().unwrap() >= sum, "{row}");
        }

        // Phase 2: Reopen Server on the same state directory (recovery via serve).
        // First advancing frame (generation 3) must compute full SHA-256 (`hash_skipped: false`),
        // and the next unchanged advancing frame (generation 4) must skip (`hash_skipped: true`).
        {
            let socket = temp.0.join("runtime/core-2.sock");
            let listener = serve::bind(&socket, uid).await.unwrap();
            let server = Arc::new(Mutex::new(
                Server::open(serve_config(), &state, uid).unwrap(),
            ));
            let task = tokio::spawn(serve::serve(listener, server.clone(), uid));

            let mut daemon = Peer::connect(&socket, "daemon", "r2").await;
            let mut ui = Peer::connect(&socket, "ui", "r2").await;

            for gen in [3_u64, 4_u64] {
                frame["generation"] = gen.into();
                daemon.send(frame.clone()).await;
                ui.receive().await;
            }

            server.lock().unwrap().shutdown().unwrap();
            task.abort();
            let _ = task.await;
            drop(daemon);
            drop(ui);
            tokio::time::timeout(Duration::from_secs(5), async {
                while Arc::strong_count(&server) != 1 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }

        let rows_phase2 = read_timing_rows(&timings_path);
        assert_eq!(rows_phase2.len(), 2);
        for (idx, row) in rows_phase2.iter().enumerate() {
            let obj = row.as_object().unwrap();
            assert_eq!(
                obj.keys().map(String::as_str).collect::<Vec<_>>(),
                expected_keys
            );
            assert!(!obj.contains_key("parallel_wait_ns"));
            assert!(!obj.contains_key("surface_queue_depth"));
            assert_eq!(row["generation"], (idx + 3) as u64);
            if idx == 0 {
                assert_eq!(
                    row["hash_skipped"], false,
                    "first frame after Server::open recovery must hash: {row}"
                );
                assert_eq!(row["skipped_hash_ns"].as_u64().unwrap(), 0, "{row}");
                assert!(row["hash_ns"].as_u64().unwrap() > 0, "{row}");
            } else {
                assert_eq!(
                    row["hash_skipped"], true,
                    "second frame after Server::open recovery must skip hash: {row}"
                );
                assert!(row["skipped_hash_ns"].as_u64().unwrap() > 0, "{row}");
                assert_eq!(row["hash_ns"].as_u64().unwrap(), 0, "{row}");
            }
            let sum: u64 = [
                "shm_read_ns",
                "hash_ns",
                "skipped_hash_ns",
                "witness_journal_ns",
                "capture_ns",
                "fanout_ns",
            ]
            .iter()
            .map(|k| row[k].as_u64().unwrap())
            .sum();
            assert!(row["total_ns"].as_u64().unwrap() >= sum, "{row}");
        }

        evict_root_via_recover(&state.join("sessions/serve-corehash-mut"));
    });
}
