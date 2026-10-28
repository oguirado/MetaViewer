#![forbid(unsafe_code)]
use metaviewer_core::admission::{AdmissionRequest, Authority, CoreState, Frame, Input, Surface};
use metaviewer_core::control::publish_frame;
use metaviewer_core::{Component, Endpoint, Refusal};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

// Authority reduction tests; production control routing remains in serve.
#[derive(PartialEq)]
enum Action {
    Take,
    Release,
}
fn transition(
    authority: &mut Authority,
    id: &str,
    action: Action,
) -> Result<metaviewer_core::admission::Outcome, metaviewer_core::journal::JournalError> {
    let refusal = match authority.state().surfaces.get(id) {
        None => Some(Refusal::Policy),
        Some(s) if !s.live => Some(Refusal::SurfaceNotAgentControlled),
        _ => None,
    };
    authority.apply(match refusal {
        Some(reason) => Input::Refuse { reason },
        None if action == Action::Take => Input::TakeControl {
            surface_id: id.into(),
        },
        None => Input::ReleaseControl {
            surface_id: id.into(),
        },
    })
}

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    authority: Authority,
    root: TempRoot,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "human-input-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .unwrap();
        let state = CoreState::session("human-input").unwrap();
        let mut authority = Authority::create(&root, state).unwrap();
        authority.apply(Input::Connect).unwrap();
        authority
            .apply(Input::Surface {
                id: "surface".into(),
                surface: Surface {
                    display: "display".into(),
                    owner: sender(),
                    live: true,
                    agent_controlled: true,
                    frame: None,
                    refresh_after: None,
                    allowed_verbs: vec![],
                },
            })
            .unwrap();
        let witness = authority.retain_witness(b"frame").unwrap();
        publish_frame(&mut authority, "surface", frame(1), vec![witness]).unwrap();
        Self {
            authority,
            root: TempRoot(root),
        }
    }
}
struct TempRoot(PathBuf);
impl std::ops::Deref for TempRoot {
    type Target = std::path::Path;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn sender() -> Endpoint {
    Endpoint {
        component: Component::Agent,
        instance: "agent".into(),
    }
}
fn frame(generation: u64) -> Frame {
    Frame {
        generation,
        sha256: format!("{:x}", Sha256::digest(b"frame")),
        width: 10,
        height: 10,
    }
}
fn proposal(n: u64, generation: u64) -> AdmissionRequest {
    let raw = json!({"schema":"envelope/v0.2","msg_id":format!("msg-{n}"),"session_id":"human-input","ts_ns":0,"from":sender(),"to":{"component":"core","instance":"core"},"nonce":format!("nonce-{n}"),"seq":n,"body":{"schema":"action_proposal/v0.2","proposal_id":format!("proposal-{n}"),"surface_id":"surface","based_on_frame":{"generation":generation,"sha256":frame(generation).sha256},"action":{"type":"click","x":1,"y":1,"button":"left"},"expectation":{"type":"text_present","text":"ready"},"budget":{"max_ms":100,"max_retries":1}}});
    AdmissionRequest::decode(&raw.to_string(), &sender(), "human-input", 1, 0).unwrap()
}
#[test]
fn takeover_cancels_and_release_requires_new_generation() {
    let mut f = Fixture::new();
    let witness = f.authority.retain_witness(b"frame").unwrap();
    f.authority
        .apply_with_witnesses(Input::Propose(proposal(1, 1)), vec![witness])
        .unwrap();
    let out = transition(&mut f.authority, "surface", Action::Take).unwrap();
    assert_eq!(out.cancelled, vec!["proposal-1"]);
    assert_eq!(
        out.cancellation_reason,
        Some(Refusal::SurfaceNotAgentControlled)
    );
    assert_eq!(
        f.authority
            .apply(Input::Propose(proposal(2, 1)))
            .unwrap()
            .reason,
        Some(Refusal::SurfaceNotAgentControlled)
    );
    assert!(transition(&mut f.authority, "surface", Action::Release)
        .unwrap()
        .reason
        .is_none());
    assert_eq!(
        f.authority
            .apply(Input::Propose(proposal(3, 1)))
            .unwrap()
            .reason,
        Some(Refusal::StaleFrame)
    );
    assert_eq!(
        publish_frame(&mut f.authority, "surface", frame(1), vec![])
            .unwrap()
            .reason,
        Some(Refusal::StaleFrame)
    );
    assert!(f.authority.state().surfaces["surface"]
        .refresh_after
        .is_some());
    let witness = f.authority.retain_witness(b"frame").unwrap();
    assert!(
        publish_frame(&mut f.authority, "surface", frame(2), vec![witness])
            .unwrap()
            .reason
            .is_none()
    );
    let witness = f.authority.retain_witness(b"frame").unwrap();
    assert!(f
        .authority
        .apply_with_witnesses(Input::Propose(proposal(4, 2)), vec![witness])
        .unwrap()
        .reason
        .is_none());
    let path = f.root.join("sessions/human-input/journal.jsonl");
    let expected = f.authority.state().snapshot().unwrap();
    drop(f.authority);
    let recovered = Authority::recover(&path, path.parent().unwrap()).unwrap();
    assert_eq!(recovered.state().snapshot().unwrap(), expected);
}
#[test]
fn invalid_transitions_are_typed_and_journalled() {
    let mut f = Fixture::new();
    let before = f.authority.state().core_seq;
    assert_eq!(
        transition(&mut f.authority, "unknown", Action::Take)
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
    assert_eq!(f.authority.state().core_seq, before + 1);

    // Production admission and serve allow release_control when already agent_controlled:
    // it commits ReleaseControl, advances core_seq, and fences proposals behind refresh_after.
    assert!(f.authority.state().surfaces["surface"].agent_controlled);
    let before_release = f.authority.state().core_seq;
    let out = transition(&mut f.authority, "surface", Action::Release).unwrap();
    assert_eq!(out.reason, None);
    assert_eq!(f.authority.state().core_seq, before_release + 1);
    assert!(f.authority.state().surfaces["surface"].agent_controlled);
    assert_eq!(
        f.authority.state().surfaces["surface"].refresh_after,
        Some(before_release + 1)
    );

    transition(&mut f.authority, "surface", Action::Take).unwrap();
    assert!(transition(&mut f.authority, "surface", Action::Take)
        .unwrap()
        .reason
        .is_none());
    f.authority
        .apply(Input::Lifecycle {
            surface_id: "surface".into(),
            update: metaviewer_core::admission::LifecycleUpdate::Lost,
        })
        .unwrap();
    assert_eq!(
        transition(&mut f.authority, "surface", Action::Release)
            .unwrap()
            .reason,
        Some(Refusal::SurfaceNotAgentControlled)
    );
}
#[test]
fn dispatched_work_must_drain_before_release() {
    let mut f = Fixture::new();
    let witness = f.authority.retain_witness(b"frame").unwrap();
    f.authority
        .apply_with_witnesses(Input::Propose(proposal(1, 1)), vec![witness])
        .unwrap();
    f.authority
        .apply(Input::Dispatch {
            proposal_id: "proposal-1".into(),
            now_ns: 0,
        })
        .unwrap();
    assert!(
        !transition(&mut f.authority, "surface", Action::Take)
            .unwrap()
            .control_ready
    );
    assert_eq!(
        transition(&mut f.authority, "surface", Action::Release)
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
    assert_eq!(
        f.authority
            .apply(Input::Drain {
                proposal_id: "proposal-1".into(),
                epoch: 0
            })
            .unwrap()
            .reason,
        Some(Refusal::Policy)
    );
    assert!(
        f.authority
            .apply(Input::Drain {
                proposal_id: "proposal-1".into(),
                epoch: 1
            })
            .unwrap()
            .control_ready
    );
    assert!(transition(&mut f.authority, "surface", Action::Release)
        .unwrap()
        .reason
        .is_none());
}

#[test]
fn frame_refusals_are_journalled_without_a_refresh_fence() {
    let mut f = Fixture::new();
    for (candidate, witnesses, reason) in [
        (frame(0), vec![], Refusal::StaleFrame),
        (
            Frame {
                sha256: "zz".into(),
                ..frame(2)
            },
            vec![],
            Refusal::Policy,
        ),
        (
            Frame {
                width: 0,
                ..frame(2)
            },
            vec![],
            Refusal::Policy,
        ),
        (frame(2), vec![], Refusal::Policy),
        (
            frame(2),
            vec![metaviewer_core::journal::Witness {
                sha256: frame(2).sha256,
                byte_len: 0,
            }],
            Refusal::Policy,
        ),
        (
            Frame {
                sha256: "a".repeat(64),
                ..frame(2)
            },
            vec![metaviewer_core::journal::Witness {
                sha256: "a".repeat(64),
                byte_len: 5,
            }],
            Refusal::Policy,
        ),
    ] {
        let before = f.authority.state().core_seq;
        assert_eq!(
            publish_frame(&mut f.authority, "surface", candidate, witnesses)
                .unwrap()
                .reason,
            Some(reason)
        );
        assert_eq!(f.authority.state().core_seq, before + 1);
    }
    let path = f.root.join("sessions/human-input/journal.jsonl");
    let expected = f.authority.state().snapshot().unwrap();
    drop(f.authority);
    assert_eq!(
        Authority::recover(&path, path.parent().unwrap())
            .unwrap()
            .state()
            .snapshot()
            .unwrap(),
        expected
    );
}
