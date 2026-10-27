use super::publish_frame;
use crate::admission::{Authority, CoreState, Frame, Input, Surface};
use crate::{Component, Endpoint, Refusal};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct TempRoot(PathBuf);

impl Drop for TempRoot {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn publish_first_frame(generation: u64, expected_reason: Option<Refusal>) {
    let root = TempRoot(std::env::temp_dir().join(format!(
        "frame-genesis-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&root.0)
        .unwrap();
    let mut authority =
        Authority::create(&root.0, CoreState::session("frame-genesis").unwrap()).unwrap();
    authority.apply(Input::Connect).unwrap();
    authority
        .apply(Input::Surface {
            id: "surface".into(),
            surface: Surface {
                display: "display".into(),
                owner: Endpoint {
                    component: Component::Agent,
                    instance: "agent".into(),
                },
                live: true,
                agent_controlled: true,
                frame: None,
                refresh_after: None,
                allowed_verbs: vec![],
            },
        })
        .unwrap();
    let witness = authority.retain_witness(b"frame").unwrap();
    let frame = Frame {
        generation,
        sha256: witness.sha256.clone(),
        width: 10,
        height: 10,
    };
    let before = authority.state().clone();
    let outcome = publish_frame(&mut authority, "surface", frame.clone(), vec![witness]).unwrap();
    assert_eq!(outcome.reason, expected_reason);
    // A refusal is journalled, but must not commit a frame or other state changes.
    let mut expected = before;
    expected.core_seq += 1;
    if expected_reason.is_none() {
        expected.surfaces.get_mut("surface").unwrap().frame = Some(frame);
    }
    assert_eq!(authority.state(), &expected);

    let journal = root.0.join("sessions/frame-genesis/journal.jsonl");
    drop(authority);
    let recovered = Authority::recover(&journal, journal.parent().unwrap()).unwrap();
    assert_eq!(recovered.state(), &expected);
}

#[test]
fn first_frame_generation_zero_is_stale_without_commit() {
    publish_first_frame(0, Some(Refusal::StaleFrame));
}

#[test]
fn first_frame_generation_one_is_admitted_and_committed() {
    publish_first_frame(1, None);
}
