use super::*;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "mv-rcpt-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn bytes(&self, b: &[u8]) -> String {
        let hash = format!("{:x}", Sha256::digest(b));
        std::fs::write(self.0.join(&hash), b).unwrap();
        hash
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn proposal(before: &Value, receipt: &Value) -> Value {
    json!({"schema":"action_proposal/v0.2", "proposal_id":receipt["proposal_id"],
        "surface_id":before["surface_id"], "based_on_frame":{"sha256":before["sha256"],"generation":before["generation"]},
        "action":{"type":"key","keys":["Escape"]},
        "expectation":{"type":"changed_region","bbox":{"x":0,"y":0,"w":1,"h":1}},
        "budget":{"max_ms":1000,"max_retries":0}})
}
fn envelope(receipt: Value) -> Value {
    json!({"schema":"envelope/v0.2", "msg_id":"proof", "ts_ns":0,
        "from":{"component":"daemon","instance":"daemon"},"to":{"component":"core","instance":"core"},
        "session_id":"proof","seq":1,"nonce":"proof","body":receipt})
}
fn fixture(temp: &Temp) -> (Value, Value, Value) {
    let mut r: Value = serde_json::from_str(include_str!(
        "../../../contracts/examples/v0.2/action_receipt.valid.native-key.json"
    ))
    .unwrap();
    r["after_frame"]["width"] = 2.into();
    r["after_frame"]["height"] = 1.into();
    r["after_frame"]["generation"] = 2.into();
    r["after_frame"]["sha256"] = temp.bytes(&[0, 0, 255, 0, 255, 0]).into();
    let mut b = r["after_frame"].clone();
    b["generation"] = 1.into();
    b["ts_ns"] = 0.into();
    b["sha256"] = temp.bytes(&[255, 0, 0, 0, 255, 0]).into();
    (proposal(&b, &r), b, r)
}
#[test]
fn native_evidence_closed_decoding_and_negative_controls() {
    let temp = Temp::new();
    let (p, b, r) = fixture(&temp);
    assert!(decode_envelope(&envelope(r.clone()).to_string()).is_ok());
    let result = verified_native_fields(&p, &b, &r, &temp.0).unwrap();
    assert_eq!(result["receipt"]["verified"], true);
    assert_eq!(result["status"], "verified");
    let typed: crate::wire::payload::MvToolResult = serde_json::from_value({
        let mut v = result;
        v["schema"] = "mv_tool_result/v0.2".into();
        v["request_id"] = "wait".into();
        v["op"] = "wait_verify".into();
        v
    })
    .unwrap();
    assert!(matches!(
        typed,
        crate::wire::payload::MvToolResult::Case5(_)
    ));
    for mode in [
        "missing",
        "stale",
        "wrong-surface",
        "wrong-focus",
        "future",
        "kind",
        "unchanged",
        "error",
        "late",
    ] {
        let mut bad = r.clone();
        match mode {
            "missing" => {
                bad.as_object_mut().unwrap().remove("native_evidence");
            }
            "stale" => {
                bad["native_evidence"]["input_ts_ns"] = 0.into();
            }
            "wrong-surface" => bad["native_evidence"]["surface_id"] = "other".into(),
            "wrong-focus" => bad["native_evidence"]["focus_verified"] = false.into(),
            "future" => bad["native_evidence"]["input_ts_ns"] = 3000000.into(),
            "kind" => bad["native_evidence"]["kind"] = "click".into(),
            "unchanged" => bad["after_frame"]["sha256"] = b["sha256"].clone(),
            "error" => bad["error"] = "failed".into(),
            "late" => bad["after_frame"]["ts_ns"] = 2000000000u64.into(),
            _ => unreachable!(),
        }
        let mut before = b.clone();
        if mode == "stale" {
            before["ts_ns"] = 1.into();
        }
        assert!(
            verified_native_fields(&p, &before, &bad, &temp.0).is_none(),
            "{mode}"
        );
    }
    for field in ["unknown", "focus_verified", "input_ts_ns"] {
        let mut bad = r.clone();
        if field == "unknown" {
            bad["native_evidence"][field] = true.into();
        } else {
            bad["native_evidence"][field] = Value::Null;
        }
        assert!(
            decode_envelope(&envelope(bad).to_string()).is_err(),
            "{field}"
        );
    }
}
#[test]
fn go_wire_handler_receipt_decodes_and_verifies_in_core() {
    let temp = Temp::new();
    let export = temp.0.join("adapter.json");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let output = std::process::Command::new(std::env::var_os("GO").unwrap_or_else(|| "go".into()))
        .args([
            "test",
            "./internal/daemon",
            "-run",
            "^TestWireReceiptNativeEvidence/cross-valid$",
            "-count=1",
        ])
        .current_dir(root.join("daemon-adapter"))
        .env("MV_RCPT_TEST_EXPORT", &export)
        .output()
        .expect("Go toolchain required for cross-language receipt test");
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let pair: Value = serde_json::from_slice(&std::fs::read(export).unwrap()).unwrap();
    let receipt = &pair["receipt"];
    assert!(decode_envelope(&envelope(receipt.clone()).to_string()).is_ok());
    assert_eq!(
        pair["before"]["sha256"],
        temp.bytes(&[255, 0, 0, 0, 255, 0])
    );
    assert_eq!(
        receipt["after_frame"]["sha256"],
        temp.bytes(&[0, 0, 255, 0, 255, 0])
    );
    let result = verified_native_fields(
        &proposal(&pair["before"], receipt),
        &pair["before"],
        receipt,
        &temp.0,
    )
    .unwrap();
    assert_eq!(result["receipt"]["verified"], true);
    assert_eq!(result["focus_verified"], true);
    assert_eq!(
        result["input_mono_ns"],
        receipt["native_evidence"]["input_mono_ns"]
    );
}

#[test]
fn wait_verify_publishes_verified_or_typed_failure_from_settled_receipt() {
    use crate::serve::{Config, Connection, Registration};
    let registration = |component: &str| -> Registration {
        serde_json::from_value(json!({"endpoint":{"component":component,"instance":component},
            "hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,
            "component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
    };
    let temp = Temp::new();
    let config = Config {
        session_id: "receipt-proof".into(),
        core: registration("core"),
        peers: vec![
            registration("daemon"),
            registration("agent"),
            registration("ui"),
        ],
    };
    let mut server = Server::open(
        config,
        &temp.0.join("state"),
        crate::serve::effective_uid().unwrap(),
    )
    .unwrap();
    let (p, mut b, r) = fixture(&temp);
    b["ts_ns"] = 1.into();
    for frame in [&b, &r["after_frame"]] {
        let hash = frame["sha256"].as_str().unwrap();
        std::fs::copy(temp.0.join(hash), server.root.join("artifacts").join(hash)).unwrap();
    }
    let peer = registration("agent").endpoint;
    let (queue, rx) = std::sync::mpsc::sync_channel(MAX_SEND_QUEUE);
    server.connections.insert(
        peer.clone(),
        Connection {
            id: 1,
            epoch: 0,
            queue,
            terminal: Arc::new(Mutex::new(None)),
        },
    );
    for mode in ["valid", "missing", "stale", "wrong-surface", "wrong-focus"] {
        let mut receipt = r.clone();
        match mode {
            "missing" => {
                receipt.as_object_mut().unwrap().remove("native_evidence");
            }
            "stale" => receipt["native_evidence"]["input_ts_ns"] = 0.into(),
            "wrong-surface" => receipt["native_evidence"]["surface_id"] = "foreign".into(),
            "wrong-focus" => receipt["native_evidence"]["focus_verified"] = false.into(),
            _ => {}
        }
        let id = r["proposal_id"].as_str().unwrap().to_owned();
        server
            .tool_state
            .verification_contexts
            .insert(id.clone(), (p.clone(), b.clone()));
        server.tool_state.retain(&Command::ActionReceipt(Box::new(
            serde_json::from_value(receipt).unwrap(),
        )));
        server.tool_state.waiters.push(Waiter {
            peer: peer.clone(),
            request_id: mode.into(),
            proposal_id: id,
            deadline: Instant::now() + Duration::from_secs(1),
        });
        server.poll_tool_waiters().unwrap();
        let result = serde_json::to_value(rx.try_recv().unwrap().body).unwrap();
        assert_eq!(result["request_id"], mode);
        if mode == "valid" {
            assert_eq!(result["status"], "verified");
            assert_eq!(result["receipt"]["verified"], true);
        } else {
            assert_eq!(result["status"], "error");
            assert_eq!(result["code"], "VERIFICATION_FAILED");
        }
        assert!(server.tool_state.waiters.is_empty());
    }
}

#[test]
fn r3_t1_01_daemon_verified_receipt_requires_native_evidence_before_custody_settlement_or_agent_emission(
) {
    use crate::serve::{Config, Connection, Registration};
    let registration = |component: &str| -> Registration {
        serde_json::from_value(json!({"endpoint":{"component":component,"instance":component},
            "hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,
            "component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
    };
    let temp = Temp::new();
    let config = Config {
        session_id: "session".into(),
        core: registration("core"),
        peers: vec![
            registration("daemon"),
            registration("agent"),
            registration("ui"),
        ],
    };
    let uid = crate::serve::effective_uid().unwrap();
    let mut server = Server::open(config.clone(), &temp.0.join("state"), uid).unwrap();
    let (mut p, mut b, mut r) = fixture(&temp);
    p["proposal_id"] = "p-r3-t1-01".into();
    b["ts_ns"] = 1.into();
    b["generation"] = 1.into();
    r["proposal_id"] = "p-r3-t1-01".into();
    r["after_frame"]["generation"] = 2.into();
    for frame in [&b, &r["after_frame"]] {
        let hash = frame["sha256"].as_str().unwrap();
        std::fs::copy(temp.0.join(hash), server.root.join("artifacts").join(hash)).unwrap();
    }

    let daemon_ep = registration("daemon").endpoint;
    let agent_ep = registration("agent").endpoint;
    let (daemon_tx, daemon_rx) = std::sync::mpsc::sync_channel(MAX_SEND_QUEUE);
    let (agent_tx, agent_rx) = std::sync::mpsc::sync_channel(MAX_SEND_QUEUE);
    server.connections.insert(
        daemon_ep.clone(),
        Connection {
            id: 1,
            epoch: 1,
            queue: daemon_tx,
            terminal: Arc::new(Mutex::new(None)),
        },
    );
    server.connections.insert(
        agent_ep.clone(),
        Connection {
            id: 2,
            epoch: 1,
            queue: agent_tx,
            terminal: Arc::new(Mutex::new(None)),
        },
    );

    server.authority.apply(Input::Connect).unwrap();
    let before_bytes = std::fs::read(temp.0.join(b["sha256"].as_str().unwrap())).unwrap();
    let witness = server.authority.retain_witness(&before_bytes).unwrap();
    server
        .authority
        .apply_with_witnesses(
            Input::Surface {
                id: p["surface_id"].as_str().unwrap().into(),
                surface: Surface {
                    display: "display-1".into(),
                    owner: agent_ep.clone(),
                    agent_controlled: true,
                    live: true,
                    frame: Some(Frame {
                        sha256: b["sha256"].as_str().unwrap().into(),
                        generation: 1,
                        width: b["width"].as_u64().unwrap(),
                        height: b["height"].as_u64().unwrap(),
                    }),
                    refresh_after: None,
                    allowed_verbs: vec!["keyboard".into()],
                },
            },
            vec![witness],
        )
        .unwrap();
    let sid = p["surface_id"].as_str().unwrap().to_owned();
    server
        .tool_state
        .surfaces
        .insert(sid.clone(), json!({"surface_id": sid, "state": "active"}));
    server.tool_state.frames.insert(sid, b.clone());

    let make_peer = |c: &str| -> ReadyPeer {
        let reg = registration(c);
        let policy = HandshakePolicy::new(
            uid,
            reg.endpoint.clone(),
            config.core.endpoint.clone(),
            "session".into(),
            reg.hello.clone(),
        )
        .unwrap();
        let hello = decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": format!("h-{c}"),
                "ts_ns": 0,
                "from": reg.endpoint,
                "to": config.core.endpoint,
                "session_id": "session",
                "seq": 1,
                "nonce": format!("h-{c}"),
                "body": reg.hello
            })
            .to_string(),
        )
        .unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let (mut a, mut b_sock) = UnixStream::pair().unwrap();
                let t = tokio::spawn(async move { write_frame(&mut a, &hello).await.unwrap() });
                let ready = handshake_at(
                    &mut b_sock,
                    &policy,
                    &WireLimits::default(),
                    tokio::time::Instant::now(),
                )
                .await
                .unwrap();
                t.await.unwrap();
                ready
            })
    };
    let agent_peer = make_peer("agent");
    let daemon_peer = make_peer("daemon");

    let prop_env = decode_envelope(
        &json!({
            "schema": "envelope/v0.2",
            "msg_id": "prop-1",
            "ts_ns": 0,
            "from": agent_ep,
            "to": config.core.endpoint,
            "session_id": "session",
            "seq": 2,
            "nonce": "prop-1",
            "body": p
        })
        .to_string(),
    )
    .unwrap();
    server.route(&agent_peer, 1, prop_env).unwrap();
    let _admitted_verdict = agent_rx.try_recv().unwrap();
    let _dispatched_input = daemon_rx.try_recv().unwrap();
    assert!(server.authority.state().pending.contains_key("p-r3-t1-01"));

    // 1. Daemon receipt claiming verified=true with evidence that does not verify
    // (focus_verified=false and forged verification method/detail) settles execution
    // but forwards the core-recomputed verdict (verified=false, pixel method).
    let mut unverified_claim = r.clone();
    unverified_claim["verified"] = true.into();
    unverified_claim["native_evidence"]["focus_verified"] = false.into();
    unverified_claim["verification"] = json!({
        "method": "state_sha256",
        "detail": "forged daemon claim"
    });
    let bad_env = decode_envelope(
        &json!({
            "schema": "envelope/v0.2",
            "msg_id": "rec-bad",
            "ts_ns": 0,
            "from": daemon_ep,
            "to": config.core.endpoint,
            "session_id": "session",
            "seq": 2,
            "nonce": "rec-bad",
            "body": unverified_claim
        })
        .to_string(),
    )
    .unwrap();
    server.route(&daemon_peer, 1, bad_env).unwrap();
    assert!(server.authority.state().pending.is_empty());
    assert!(server.authority.state().leases.is_empty());
    let forwarded_unverified = serde_json::to_value(agent_rx.try_recv().unwrap().body).unwrap();
    assert_eq!(forwarded_unverified["schema"], "action_receipt/v0.2");
    assert_eq!(forwarded_unverified["proposal_id"], "p-r3-t1-01");
    assert_eq!(forwarded_unverified["verified"], false);
    assert_eq!(forwarded_unverified["verification"]["method"], "pixel");
    assert_eq!(
        forwarded_unverified["verification"]["detail"],
        "missing, invalid or unmatched witness"
    );
    assert_eq!(server.tool_state.receipts["p-r3-t1-01"]["verified"], false);

    // 2. Negative control: a second proposal with valid native evidence + frame witness
    // forwards the core-recomputed verified=true verdict and pixel verification method/detail
    // when the daemon claims verified=true with a forged verification method/detail.
    let mut p2 = p.clone();
    p2["proposal_id"] = "p-r3-t1-01-ok".into();
    let prop2_env = decode_envelope(
        &json!({
            "schema": "envelope/v0.2",
            "msg_id": "prop-2",
            "ts_ns": 0,
            "from": agent_ep,
            "to": config.core.endpoint,
            "session_id": "session",
            "seq": 3,
            "nonce": "prop-2",
            "body": p2
        })
        .to_string(),
    )
    .unwrap();
    server.route(&agent_peer, 1, prop2_env).unwrap();
    let _admitted_verdict2 = agent_rx.try_recv().unwrap();
    let _dispatched_input2 = daemon_rx.try_recv().unwrap();

    let mut valid_claim = r.clone();
    valid_claim["proposal_id"] = "p-r3-t1-01-ok".into();
    valid_claim["verified"] = true.into();
    valid_claim["verification"] = json!({
        "method": "state_sha256",
        "detail": "forged daemon claim"
    });
    let ok_env = decode_envelope(
        &json!({
            "schema": "envelope/v0.2",
            "msg_id": "rec-ok",
            "ts_ns": 0,
            "from": daemon_ep,
            "to": config.core.endpoint,
            "session_id": "session",
            "seq": 3,
            "nonce": "rec-ok",
            "body": valid_claim
        })
        .to_string(),
    )
    .unwrap();
    server.route(&daemon_peer, 1, ok_env).unwrap();
    assert!(server.authority.state().pending.is_empty());
    assert!(server.authority.state().leases.is_empty());
    let forwarded = serde_json::to_value(agent_rx.try_recv().unwrap().body).unwrap();
    assert_eq!(forwarded["schema"], "action_receipt/v0.2");
    assert_eq!(forwarded["proposal_id"], "p-r3-t1-01-ok");
    assert_eq!(forwarded["verified"], true);
    assert_eq!(forwarded["verification"]["method"], "pixel");
    assert_eq!(
        forwarded["verification"]["detail"],
        "frame-bound witness matched"
    );
}
