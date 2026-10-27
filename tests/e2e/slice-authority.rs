// [TARGET, unit decision] Test-owned line protocol joins the admitted Authority
// API to adapter publications. No replacement reducer or synthetic verdicts.
use metaviewer_core::admission::*;
use metaviewer_core::{Component, Endpoint};
use serde_json::{json, Value};
use std::io::{self, BufRead};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
fn main() {
    let root = PathBuf::from(std::env::args().nth(1).unwrap());
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&root)
        .unwrap();
    let mut a = Authority::create(&root, CoreState::session("slice-session").unwrap()).unwrap();
    a.apply(Input::Connect).unwrap();
    let mut retained = std::collections::BTreeMap::new();
    for line in io::stdin().lock().lines() {
        let q: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let id = q["id"].as_str().unwrap_or("").to_owned();
        let mut witnesses = vec![];
        let input = match q["op"].as_str().unwrap() {
            "surface" | "frame" => {
                let f = &q["frame"];
                let bytes = std::fs::read(f["ramws_path"].as_str().unwrap()).unwrap();
                let w = a.retain_witness(&bytes).unwrap();
                assert_eq!(w.sha256, f["sha256"].as_str().unwrap());
                retained.insert(w.sha256.clone(), w.clone());
                witnesses.push(w.clone());
                let frame = Frame {
                    sha256: w.sha256,
                    generation: f["generation"].as_u64().unwrap(),
                    width: f["width"].as_u64().unwrap(),
                    height: f["height"].as_u64().unwrap(),
                };
                if q["op"] == "surface" {
                    Input::Surface {
                        id,
                        surface: Surface {
                            display: ":100".into(),
                            owner: Endpoint {
                                component: Component::Agent,
                                instance: "slice-agent".into(),
                            },
                            agent_controlled: true,
                            live: true,
                            frame: Some(frame),
                            refresh_after: None,
                            allowed_verbs: vec![],
                        },
                    }
                } else {
                    Input::Frame {
                        surface_id: id,
                        frame,
                    }
                }
            }
            "propose" => {
                let hash = q["envelope"]["body"]["based_on_frame"]["sha256"]
                    .as_str()
                    .unwrap();
                witnesses.push(retained.get(hash).unwrap().clone());
                Input::Propose(
                    AdmissionRequest::decode(
                        &q["envelope"].to_string(),
                        &Endpoint {
                            component: Component::Agent,
                            instance: "slice-agent".into(),
                        },
                        "slice-session",
                        1,
                        0,
                    )
                    .unwrap(),
                )
            }
            "take" => Input::TakeControl { surface_id: id },
            "release" => Input::ReleaseControl { surface_id: id },
            "dispatch" => Input::Dispatch {
                proposal_id: id,
                now_ns: 0,
            },
            "drain" => Input::Drain {
                proposal_id: id,
                epoch: 1,
            },
            "receipt" => Input::Receipt {
                proposal_id: id,
                epoch: 1,
            },
            _ => panic!("closed test protocol"),
        };
        let out = a.apply_with_witnesses(input, witnesses).unwrap();
        println!(
            "{}",
            json!({"reason":out.reason,"dispatch":out.dispatch,
            "cancelled":out.cancelled,"control_ready":out.control_ready,
            "state":serde_json::from_slice::<Value>(&a.state().snapshot().unwrap()).unwrap(),
            "domain":serde_json::from_slice::<Value>(&a.state().domain_snapshot().unwrap()).unwrap()})
        );
    }
}
