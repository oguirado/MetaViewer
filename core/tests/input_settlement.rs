#![forbid(unsafe_code)]
use metaviewer_core::admission::{AdmissionRequest, CoreState, Frame, Input, Surface};
use metaviewer_core::{Component, Endpoint, Refusal};
use serde_json::json;

fn admitted() -> CoreState {
    let agent = Endpoint {
        component: Component::Agent,
        instance: "agent-1".into(),
    };
    let mut state = CoreState::new("session-1", 10).unwrap();
    state.apply(&Input::Connect).unwrap();
    state
        .apply(&Input::Surface {
            id: "surface-1".into(),
            surface: Surface {
                display: "display-1".into(),
                owner: agent.clone(),
                agent_controlled: true,
                live: true,
                frame: Some(Frame {
                    sha256: "a".repeat(64),
                    generation: 1,
                    width: 10,
                    height: 10,
                }),
                refresh_after: None,
                allowed_verbs: vec![],
            },
        })
        .unwrap();
    let raw = json!({"schema":"envelope/v0.2","msg_id":"msg-1","session_id":"session-1","ts_ns":0,"from":agent,"to":{"component":"core","instance":"core-1"},"nonce":"nonce-1","seq":1,"body":{"schema":"action_proposal/v0.2","proposal_id":"proposal-1","surface_id":"surface-1","based_on_frame":{"generation":1,"sha256":"a".repeat(64)},"action":{"type":"key","keys":["a"]},"expectation":{"type":"text_present","text":"ready"},"budget":{"max_ms":100,"max_retries":1}}});
    let request = AdmissionRequest::decode(&raw.to_string(), &agent, "session-1", 1, 0).unwrap();
    assert_eq!(state.apply(&Input::Propose(request)).unwrap().reason, None);
    state
}

#[test]
fn invalid_failure_settlements_preserve_leases_and_budget() {
    for mode in [
        "unknown",
        "never-dispatched",
        "previous-epoch",
        "previous-epoch-drain",
    ] {
        let mut state = admitted();
        if mode != "never-dispatched" {
            assert!(
                state
                    .apply(&Input::Dispatch {
                        proposal_id: "proposal-1".into(),
                        now_ns: 1
                    })
                    .unwrap()
                    .dispatch
            );
        }
        if mode.starts_with("previous-epoch") {
            if mode.ends_with("drain") {
                state
                    .apply(&Input::TakeControl {
                        surface_id: "surface-1".into(),
                    })
                    .unwrap();
            }
            state.apply(&Input::Connect).unwrap();
        }
        let before = state.domain_snapshot().unwrap();
        let input = if mode.ends_with("drain") {
            Input::Drain {
                proposal_id: "proposal-1".into(),
                epoch: 1,
            }
        } else {
            Input::Receipt {
                proposal_id: if mode == "unknown" {
                    "unknown"
                } else {
                    "proposal-1"
                }
                .into(),
                epoch: 1,
            }
        };
        assert_eq!(
            state.apply(&input).unwrap().reason,
            Some(Refusal::Policy),
            "{mode}"
        );
        assert_eq!(state.domain_snapshot().unwrap(), before, "{mode}");
    }
}
