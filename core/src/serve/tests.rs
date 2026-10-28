use super::*;
use serde_json::json;

fn registration(component: &str) -> Registration {
    serde_json::from_value(json!({"endpoint":{"component":component,"instance":format!("{component}-test")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
}

#[test]
fn lifecycle_attempts_obey_budget_and_reject_non_lifecycle_ops() {
    let mut state = CoreState::new("budget", 1).unwrap();
    let request = |op: &str, params: serde_json::Value| Input::SurfaceRequest {
        request: serde_json::from_value(
            json!({"schema":"surface_request/v0.2","op":op,"params":params}),
        )
        .unwrap(),
    };
    let bypass = request(
        "input",
        json!({"surface_id":"s","proposal_id":"p","action":{"type":"key","keys":["Enter"]}}),
    );
    assert_eq!(state.apply(&bypass).unwrap().reason, Some(Refusal::Policy));
    assert_eq!(state.remaining_budget, 1);
    let list = request("list", json!({}));
    assert_eq!(state.apply(&list).unwrap().reason, None);
    assert_eq!(state.remaining_budget, 0);
    assert_eq!(
        state.apply(&list).unwrap().reason,
        Some(Refusal::BudgetExceeded)
    );
    assert_eq!(state.remaining_budget, 0);
}

#[test]
fn saturation_has_a_reserved_typed_signal_and_disconnect_is_distinct() {
    let root = std::env::temp_dir().join(format!("mv-queue-test-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let config = Config {
        session_id: "queue-session".into(),
        core: registration("core"),
        peers: vec![
            registration("agent"),
            registration("daemon"),
            registration("ui"),
        ],
    };
    let mut server = Server::open(config.clone(), &root, effective_uid().unwrap()).unwrap();
    let peer = registration("ui").endpoint;
    let (tx, rx) = mpsc::sync_channel(1);
    let terminal = Arc::new(Mutex::new(None));
    server.connections.insert(
        peer.clone(),
        Connection {
            id: 1,
            epoch: 0,
            queue: tx,
            terminal: terminal.clone(),
        },
    );
    let body = Command::Hello(Box::new(config.core.hello));
    server.send(&peer, body.clone()).unwrap();
    assert!(terminal.lock().unwrap().is_none());
    let error = server.send(&peer, body.clone()).unwrap_err();
    assert!(
        matches!(error.downcast_ref::<SendFailure>(), Some(SendFailure::QueueOverflow(p)) if p == &peer)
    );
    let notification = terminal.lock().unwrap().take().unwrap();
    let raw = serde_json::to_string(&notification).unwrap();
    decode_envelope(&raw).unwrap();
    let value = serde_json::to_value(&notification.body).unwrap();
    assert_eq!(value["event"], "error");
    assert_eq!(value["data"]["code"], "QUEUE_OVERFLOW");
    // The queued normal message was not silently replaced by the diagnostic.
    assert!(matches!(rx.try_recv().unwrap().body, Command::Hello(_)));
    drop(rx);
    let error = server.send(&peer, body).unwrap_err();
    assert!(
        matches!(error.downcast_ref::<SendFailure>(), Some(SendFailure::Disconnected(p)) if p == &peer)
    );
    assert!(terminal.lock().unwrap().is_none());
    drop(server);
    fs::remove_dir_all(root).unwrap();
}

// Asserts regression-catching frame ceilings on hosted runners (mean <= 300 ms,
// max <= 600 ms; pre-optimisation was ~670 ms on the fast host / > 1.3 s on hosted).
// Setting MV_PERF_STRICT=1 enables the host-tuned strict target (mean <= 60 ms).
#[test]
fn frame_ready_latency_and_concurrent_generations_on_3_45mb_frames() {
    use std::os::unix::fs::PermissionsExt;
    let uid = effective_uid().unwrap();
    let root = std::env::temp_dir().join(format!("mv-frame-lat-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();

    let shm_root = Path::new("/dev/shm").join(format!("mv-frame-lat-shm-{}", std::process::id()));
    let _ = fs::remove_dir_all(&shm_root);
    fs::create_dir(&shm_root).unwrap();
    fs::set_permissions(&shm_root, fs::Permissions::from_mode(0o700)).unwrap();
    let pub_dir = shm_root.join("frames-bench");
    fs::create_dir(&pub_dir).unwrap();
    fs::set_permissions(&pub_dir, fs::Permissions::from_mode(0o700)).unwrap();

    let config = Config {
        session_id: "frame-lat-session".into(),
        core: registration("core"),
        peers: vec![
            registration("agent"),
            registration("daemon"),
            registration("ui"),
        ],
    };
    let mut server = Server::open(config.clone(), &root, uid).unwrap();
    let daemon_ep = registration("daemon").endpoint;
    let ui_ep = registration("ui").endpoint;
    let agent_ep = registration("agent").endpoint;

    let (ui_tx, ui_rx) = mpsc::sync_channel(64);
    server.connections.insert(
        ui_ep.clone(),
        Connection {
            id: 1,
            epoch: 1,
            queue: ui_tx,
            terminal: Arc::new(Mutex::new(None)),
        },
    );
    let (daemon_tx, _daemon_rx) = mpsc::sync_channel(64);
    server.connections.insert(
        daemon_ep.clone(),
        Connection {
            id: 2,
            epoch: 1,
            queue: daemon_tx,
            terminal: Arc::new(Mutex::new(None)),
        },
    );

    server.authority.apply(Input::Connect).unwrap();
    let seed_witness = server.authority.retain_witness(b"seed").unwrap();
    server
        .authority
        .apply_with_witnesses(
            Input::Surface {
                id: "srf-lat".into(),
                surface: Surface {
                    display: ":99".into(),
                    owner: agent_ep,
                    agent_controlled: false,
                    live: true,
                    frame: None,
                    refresh_after: None,
                    allowed_verbs: Vec::new(),
                },
            },
            vec![seed_witness],
        )
        .unwrap();
    server.subscriptions.insert((ui_ep, "srf-lat".into()));

    let daemon_reg = config
        .peers
        .iter()
        .find(|p| p.endpoint == daemon_ep)
        .unwrap()
        .clone();
    let ready_daemon = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let policy = HandshakePolicy::new(
                uid,
                daemon_reg.endpoint.clone(),
                config.core.endpoint.clone(),
                config.session_id.clone(),
                daemon_reg.hello.clone(),
            )
            .unwrap();
            let hello = decode_envelope(
                &json!({
                    "schema": "envelope/v0.2",
                    "msg_id": "hello-daemon",
                    "ts_ns": 0,
                    "from": daemon_reg.endpoint,
                    "to": config.core.endpoint,
                    "session_id": config.session_id,
                    "seq": 1,
                    "nonce": "hello-daemon",
                    "body": daemon_reg.hello,
                })
                .to_string(),
            )
            .unwrap();
            let (mut a, mut b) = UnixStream::pair().unwrap();
            let writer = tokio::spawn(async move { write_frame(&mut a, &hello).await.unwrap() });
            let peer = handshake_at(
                &mut b,
                &policy,
                &WireLimits::default(),
                tokio::time::Instant::now(),
            )
            .await
            .unwrap();
            writer.await.unwrap();
            peer
        });

    let width: u32 = 1280;
    let height: u32 = 900;
    let frame_bytes = (width as usize) * (height as usize) * 3;
    assert_eq!(frame_bytes, 3_456_000);

    let generations = 8u64;
    let mut per_frame_ms = Vec::with_capacity(generations as usize);
    crate::journal::STAGE_TIMINGS.with(|c| c.set(crate::journal::FrameStageTimings::default()));
    let batch_start = Instant::now();

    for gen in 1..=generations {
        let mut raw = vec![(gen as u8).wrapping_mul(17); frame_bytes];
        raw[0] = gen as u8;
        let sha = sha256_hex(&raw);
        let frame_path = pub_dir.join(format!("gen-{gen}.rgb"));
        let t0 = Instant::now();
        fs::write(&frame_path, &raw).unwrap();
        fs::set_permissions(&frame_path, fs::Permissions::from_mode(0o600)).unwrap();

        let env = decode_envelope(
            &json!({
                "schema": "envelope/v0.2",
                "msg_id": format!("frame-{gen}"),
                "ts_ns": gen * 100_000_000,
                "from": daemon_ep,
                "to": config.core.endpoint,
                "session_id": config.session_id,
                "seq": gen + 1,
                "nonce": format!("frame-{gen}"),
                "body": {
                    "schema": "surface_event/v0.2",
                    "event": "frame_ready",
                    "data": {
                        "frame_ref": {
                            "schema": "frame_ref/v0.2",
                            "surface_id": "srf-lat",
                            "generation": gen,
                            "tick": gen,
                            "ts_ns": gen * 100_000_000,
                            "width": width,
                            "height": height,
                            "format": "rgb24",
                            "ramws_path": frame_path.to_str().unwrap(),
                            "sha256": sha,
                            "capture_us": 1000
                        }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        crate::journal::STAGE_TIMINGS.with(|c| {
            let mut s = c.get();
            s.test_prep_ns += t0.elapsed().as_nanos();
            c.set(s);
        });

        server
            .route_at(gen * 100_000_000, &ready_daemon, 1, env)
            .unwrap();
        let forwarded = ui_rx.try_recv().expect("frame_ready must forward to UI");
        let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
        per_frame_ms.push(elapsed_ms);
        let value = serde_json::to_value(&forwarded.body).unwrap();
        assert_eq!(value["event"], "frame_ready");
        assert_eq!(value["data"]["frame_ref"]["generation"], gen);
    }

    let batch_ms = batch_start.elapsed().as_secs_f64() * 1000.0;
    let max_ms = per_frame_ms.iter().copied().fold(0.0_f64, f64::max);
    let mean_ms = per_frame_ms.iter().sum::<f64>() / (generations as f64);
    let gens_during_batch_at_100ms = batch_ms / 100.0;
    let st = crate::journal::STAGE_TIMINGS.with(|c| c.get());
    eprintln!(
        "STAGE_BREAKDOWN_PER_FRAME test_prep_ms={:.2} shm_read_ms={:.2} witness_verify_read_ms={:.2} total_hash_ms={:.2} witness_copy_ms={:.2} journal_write_ms={:.2} fsync_ms={:.2} fsync_calls_per_frame={:.1} capture_ms={:.2} fanout_ms={:.2}",
        st.test_prep_ns as f64 / 1_000_000.0 / (generations as f64),
        st.shm_read_ns as f64 / 1_000_000.0 / (generations as f64),
        st.witness_verify_read_ns as f64 / 1_000_000.0 / (generations as f64),
        st.hash_ns as f64 / 1_000_000.0 / (generations as f64),
        st.witness_copy_ns as f64 / 1_000_000.0 / (generations as f64),
        st.journal_write_ns as f64 / 1_000_000.0 / (generations as f64),
        st.fsync_ns as f64 / 1_000_000.0 / (generations as f64),
        st.fsync_calls as f64 / (generations as f64),
        st.capture_ns as f64 / 1_000_000.0 / (generations as f64),
        st.fanout_ns as f64 / 1_000_000.0 / (generations as f64),
    );
    eprintln!(
        "MEASURED_CORE_FRAME_PATH frames={} bytes={} mean_ms={:.2} max_ms={:.2} batch_ms={:.2} poll_100ms_gens_during_batch={:.2}",
        generations, frame_bytes, mean_ms, max_ms, batch_ms, gens_during_batch_at_100ms
    );

    let strict = std::env::var("MV_PERF_STRICT").as_deref() == Ok("1");
    let mean_ceiling_ms = if strict { 60.0 } else { 300.0 };
    assert!(
        mean_ms <= mean_ceiling_ms,
        "1280x900 mean frame cost {mean_ms:.2} ms exceeded {mean_ceiling_ms:.0} ms target"
    );
    assert!(
        max_ms <= 600.0,
        "1280x900 max frame cost {max_ms:.2} ms exceeded 600 ms ceiling"
    );

    drop(server);
    let session_root = root.join("sessions/frame-lat-session");
    let verified =
        crate::journal::scan(&session_root.join("journal.jsonl"), &session_root).unwrap();
    assert_eq!(verified.boundaries.len(), (2 + generations) as usize);
    assert_eq!(
        verified.state.surfaces["srf-lat"]
            .frame
            .as_ref()
            .unwrap()
            .generation,
        generations
    );
    let _ = fs::remove_dir_all(&shm_root);
    let _ = fs::remove_dir_all(&root);
}
