#[test]
fn full_journal_stops_in_order_without_retiring_peers_or_publishing_refused_frames() {
    run(async {
        let mut f = Fixture::new();
        f.seed();
        let mut second = f.server.authority.state().surfaces["surface-demo"].clone();
        second.frame = None;
        f.server
            .authority
            .apply(Input::Surface {
                id: "surface-second".into(),
                surface: second,
            })
            .unwrap();
        let daemon = f.attach(Component::Daemon, 64);
        let ui = f.attach(Component::Ui, 64);
        let agent = f.attach(Component::Agent, 64);
        f.server.observers.insert(f.endpoint(Component::Ui));
        let limit = f.server.authority.state().core_seq + 3;
        crate::journal::set_record_limit_for_test(&f.server.root, limit);
        let shm = ShmFixture::new();
        let frame = |generation| {
            let path = shm.0.join(format!("frame-{generation}.rgb"));
            fs::write(&path, [1, 2, 3]).unwrap();
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            json!({"schema":"frame_ref/v0.2", "surface_id":"surface-demo",
                "generation":generation,"tick":generation,"ts_ns":generation,
                "width":1,"height":1,"format":"rgb24","ramws_path":path,
                "sha256":sha256_hex(&[1,2,3]),"capture_us":1})
        };
        for n in 2..=4 {
            f.route(Component::Daemon, n, frame(n)).await.unwrap();
        }
        assert_eq!(f.server.authority.state().core_seq, limit);
        assert!(
            f.server.journal_end.is_none(),
            "negative control: accepted frames do not end a session"
        );
        let accepted: Vec<_> = ui.try_iter().collect();
        assert!(accepted
            .iter()
            .any(|e| matches!(e.body, Command::FrameRef(_))));
        let snapshot = f.server.snapshot().unwrap();
        let journal_path = f.server.root.join("journal.jsonl");
        let bytes = fs::read(&journal_path).unwrap();
        f.route(Component::Daemon, 5, frame(5))
            .await
            .expect("capacity is a session refusal, not a daemon transport failure");
        assert_eq!(f.server.snapshot().unwrap(), snapshot);
        assert_eq!(fs::read(&journal_path).unwrap(), bytes);
        assert_eq!(f.server.connections.len(), 3);
        assert_eq!(
            serde_json::to_value(ui.try_recv().unwrap().body).unwrap()["data"]["code"],
            "JOURNAL_FULL"
        );
        assert!(ui.try_recv().is_err(), "refused frame must never fan out");
        assert_eq!(
            serde_json::to_value(agent.try_recv().unwrap().body).unwrap()["data"]["code"],
            "JOURNAL_FULL"
        );
        let stop = serde_json::to_value(daemon.try_recv().unwrap().body).unwrap();
        assert_eq!(stop["op"], "destroy");
        assert_eq!(stop["params"]["surface_id"], "surface-demo");
        assert!(
            daemon.try_recv().is_err(),
            "second stop waits for the first acknowledgment"
        );
        // An unrelated error must not release the ordered stop barrier.
        f.route(
            Component::Daemon,
            6,
            json!({"schema":"surface_event/v0.2","event":"error",
            "data":{"surface_id":"unrelated","code":"TEST","detail":"unrelated"}}),
        )
        .await
        .unwrap();
        assert!(daemon.try_recv().is_err());
        let stopped = |id| {
            json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":{
            "schema":"surface/v0.2","surface_id":id,"kind":"browser","display":":92",
            "geometry":{"w":1,"h":1},"state":"destroyed","visibility":"unfolded",
            "control":"agent","profile_id":"test"}}})
        };
        f.route(Component::Daemon, 7, stopped("surface-demo"))
            .await
            .unwrap();
        let next = serde_json::to_value(daemon.try_recv().unwrap().body).unwrap();
        assert_eq!(next["params"]["surface_id"], "surface-second");
        f.route(Component::Daemon, 8, stopped("surface-second"))
            .await
            .unwrap();
        assert!(daemon.try_recv().is_err());
        f.route(
            Component::Ui,
            2,
            json!({"schema":"surface_request/v0.2","op":"list","params":{}}),
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(ui.try_recv().unwrap().body).unwrap()["data"]["code"],
            "JOURNAL_FULL"
        );
        assert_eq!(f.server.connections.len(), 3);
        f.server.authority.flush_sync().unwrap();
        let replay = crate::journal::scan(&journal_path, &f.server.root).unwrap();
        assert_eq!(replay.state.snapshot().unwrap(), snapshot);
        assert_eq!(replay.boundaries.len() as u64, limit);
        let config = f.server.config.clone();
        f.server.shutdown().unwrap();
        let replacement = Server::open(
            config.clone(),
            &f.root.join("unused"),
            effective_uid().unwrap(),
        )
        .unwrap();
        let old = std::mem::replace(&mut f.server, replacement);
        drop(old);
        let recovered = Server::open(config, &f.root, effective_uid().unwrap()).unwrap();
        assert_eq!(recovered.snapshot().unwrap(), snapshot);
        assert!(
            recovered.journal_end.is_some(),
            "restart must preserve terminal admission closure"
        );
        f.server = recovered;
        let marker_path = f.server.root.join("journal-ended.json");
        let marker = fs::read(&marker_path).unwrap();
        let mut tampered: Value = serde_json::from_slice(&marker).unwrap();
        tampered["core_seq"] = 0.into();
        fs::write(&marker_path, serde_json::to_vec(&tampered).unwrap()).unwrap();
        f.server.load_journal_end().unwrap();
        assert!(
            f.server.journal_end.is_none(),
            "negative control: a mismatched hint cannot end admission"
        );
        assert_eq!(
            f.server.snapshot().unwrap(),
            snapshot,
            "replay remains authoritative"
        );
        assert!(f.server.root.join("journal-ended.ignored.json").exists());
        fs::write(&marker_path, marker).unwrap();
    });
}

#[test]
fn journal_capacity_over_real_sockets_keeps_daemon_and_ui_alive() {
    run(async {
        let mut f = Fixture::new();
        f.seed();
        let replacement = Server::open(
            f.server.config.clone(),
            &f.root.join("unused"),
            effective_uid().unwrap(),
        )
        .unwrap();
        let actual = std::mem::replace(&mut f.server, replacement);
        let archive_root = actual.root.clone();
        crate::journal::set_record_limit_for_test(&archive_root, 4);
        let shared = Arc::new(Mutex::new(actual));
        let uid = effective_uid().unwrap();
        let socket = f.root.join("capacity.sock");
        let listener = bind(&socket, uid).await.unwrap();
        let service = tokio::spawn(serve(listener, shared.clone(), uid));
        let mut daemon = UnixStream::connect(&socket).await.unwrap();
        let reg = f
            .server
            .config
            .peers
            .iter()
            .find(|p| p.endpoint.component == Component::Daemon)
            .unwrap();
        write_frame(
            &mut daemon,
            &f.envelope(
                Component::Daemon,
                1,
                serde_json::to_value(&reg.hello).unwrap(),
            ),
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame(&mut daemon).await.unwrap().unwrap().body,
            Command::Hello(_)
        ));
        let mut ui = UnixStream::connect(&socket).await.unwrap();
        let reg = f
            .server
            .config
            .peers
            .iter()
            .find(|p| p.endpoint.component == Component::Ui)
            .unwrap();
        write_frame(
            &mut ui,
            &f.envelope(Component::Ui, 1, serde_json::to_value(&reg.hello).unwrap()),
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame(&mut ui).await.unwrap().unwrap().body,
            Command::Hello(_)
        ));
        let notice = |n| {
            f.envelope(
                Component::Daemon,
                n,
                json!({"schema":"surface_event/v0.2","event":"error",
            "data":{"surface_id":"surface-demo","code":"TEST","detail":"capacity test"}}),
            )
        };
        write_frame(&mut daemon, &notice(2)).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while shared.lock().unwrap().authority.state().core_seq < 4 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let accepted = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut ui))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(accepted.body).unwrap()["data"]["code"],
            "TEST"
        );
        write_frame(&mut daemon, &notice(3)).await.unwrap();
        let diagnostic = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut ui))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(diagnostic.body).unwrap()["data"]["code"],
            "JOURNAL_FULL"
        );
        let stop = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut daemon))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::to_value(stop.body).unwrap()["op"], "destroy");
        // A second UI round trip proves the notification did not retire its socket.
        write_frame(
            &mut ui,
            &f.envelope(
                Component::Ui,
                2,
                json!({"schema":"surface_request/v0.2","op":"list","params":{}}),
            ),
        )
        .await
        .unwrap();
        let again = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut ui))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(again.body).unwrap()["data"]["code"],
            "JOURNAL_FULL"
        );
        write_frame(&mut daemon, &notice(4)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(shared
            .lock()
            .unwrap()
            .connections
            .contains_key(&f.endpoint(Component::Daemon)));
        assert_eq!(shared.lock().unwrap().authority.state().core_seq, 4);
        let replay =
            crate::journal::scan(&archive_root.join("journal.jsonl"), &archive_root).unwrap();
        assert_eq!(replay.state.core_seq, 4);
        drop(daemon);
        drop(ui);
        service.abort();
        let _ = service.await;
        let deadline = Instant::now() + Duration::from_secs(2);
        while !shared.lock().unwrap().connections.is_empty() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        shared.lock().unwrap().shutdown().unwrap();
        drop(shared);
    });
}

fn journal_review_notice() -> Value {
    json!({"schema":"surface_event/v0.2","event":"error","data":{
        "surface_id":"surface-demo","code":"TEST","detail":"capacity probe"}})
}

#[test]
fn journal_review_empty_unreadable_and_mismatched_markers_do_not_block_replay() {
    use std::os::unix::fs::PermissionsExt;
    for contents in [
        b"".as_slice(),
        b"{",
        br#"{"schema":"metaviewer.journal-ended/v1","core_seq":0,"state_sha256":"stale"}"#,
    ] {
        let mut f = Fixture::new();
        f.seed();
        let snapshot = f.server.snapshot().unwrap();
        let path = f.server.root.join("journal-ended.json");
        fs::write(&path, contents).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        f.server
            .load_journal_end()
            .expect("a hint cannot overrule replay");
        assert!(f.server.journal_end.is_none());
        assert_eq!(f.server.snapshot().unwrap(), snapshot);
    }
    let mut f = Fixture::new();
    f.seed();
    fs::create_dir(f.server.root.join("journal-ended.json")).unwrap();
    f.server
        .load_journal_end()
        .expect("unreadable marker is absent");
    assert!(f.server.journal_end.is_none());
}

#[test]
fn journal_review_marker_write_failure_never_resets_peer_and_retries_are_closed() {
    run(async {
        let mut f = Fixture::new();
        f.seed();
        let _daemon = f.attach(Component::Daemon, 64);
        let ui = f.attach(Component::Ui, 64);
        // A directory at the destination forces the final rename to fail.
        fs::create_dir(f.server.root.join("journal-ended.json")).unwrap();
        let limit = f.server.authority.state().core_seq;
        crate::journal::set_record_limit_for_test(&f.server.root, limit);
        let snapshot = f.server.snapshot().unwrap();
        for n in 2..=3 {
            f.route(Component::Daemon, n, journal_review_notice())
                .await
                .expect("marker I/O must not turn capacity refusal into transport failure");
        }
        assert!(f.server.journal_end.is_some());
        assert_eq!(f.server.connections.len(), 2);
        assert_eq!(f.server.snapshot().unwrap(), snapshot);
        assert_eq!(
            serde_json::to_value(ui.try_recv().unwrap().body).unwrap()["data"]["code"],
            "JOURNAL_FULL"
        );
    });
}

#[test]
fn journal_review_terminal_destroy_refusal_advances_but_policy_failure_does_not() {
    run(async {
        let mut f = Fixture::new();
        f.seed();
        let mut second = f.server.authority.state().surfaces["surface-demo"].clone();
        second.frame = None;
        f.server
            .authority
            .apply(Input::Surface {
                id: "surface-second".into(),
                surface: second,
            })
            .unwrap();
        let daemon = f.attach(Component::Daemon, 64);
        let ui = f.attach(Component::Ui, 64);
        let limit = f.server.authority.state().core_seq;
        crate::journal::set_record_limit_for_test(&f.server.root, limit);
        f.route(Component::Daemon, 2, journal_review_notice())
            .await
            .unwrap();
        let _ = ui.try_recv().unwrap();
        assert_eq!(
            serde_json::to_value(daemon.try_recv().unwrap().body).unwrap()["params"]["surface_id"],
            "surface-demo"
        );
        let err = |id, code, detail| json!({"schema":"surface_event/v0.2","event":"error","data":{"surface_id":id,"code":code,"detail":detail}});
        f.route(
            Component::Daemon,
            3,
            err(
                "surface-demo",
                "POLICY",
                "input must be drained before destroy",
            ),
        )
        .await
        .unwrap();
        assert!(daemon.try_recv().is_err());
        assert_eq!(
            serde_json::to_value(ui.try_recv().unwrap().body).unwrap()["data"]["code"],
            "JOURNAL_STOP_FAILED"
        );
        f.route(
            Component::Daemon,
            4,
            err("unrelated", "surface", "unknown or terminal surface"),
        )
        .await
        .unwrap();
        assert!(daemon.try_recv().is_err());
        f.route(
            Component::Daemon,
            5,
            err("surface-demo", "surface", "unknown or terminal surface"),
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(daemon.try_recv().unwrap().body).unwrap()["params"]["surface_id"],
            "surface-second"
        );
        assert!(
            ui.try_recv().is_err(),
            "already stopped is not a stop failure"
        );
    });
}

#[test]
fn journal_review_mismatched_marker_is_reported_and_ignored() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.seed();
    let snapshot = f.server.snapshot().unwrap();
    let path = f.server.root.join("journal-ended.json");
    fs::write(
        &path,
        br#"{"schema":"metaviewer.journal-ended/v1","core_seq":0,"state_sha256":"stale"}"#,
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    f.server
        .load_journal_end()
        .expect("stale hint cannot block replay");
    assert!(f.server.journal_end.is_none());
    assert_eq!(f.server.snapshot().unwrap(), snapshot);
    assert!(!path.exists(), "mismatch is moved aside");
    assert!(f.server.root.join("journal-ended.ignored.json").exists());
}

#[test]
fn journal_archive_byte_limit_preserves_replay_and_transport_with_a_torn_hint() {
    run(async {
        let mut f = Fixture::new();
        f.seed();
        // Enlarge legitimate reduced state, without changing either product limit.
        for n in 0..32 {
            let mut surface = f.server.authority.state().surfaces["surface-demo"].clone();
            surface.frame = None;
            surface.allowed_verbs = vec!["mouse".into(); 128];
            f.server
                .authority
                .apply(Input::Surface {
                    id: format!("archive-{n}"),
                    surface,
                })
                .unwrap();
        }
        let daemon = f.attach(Component::Daemon, 64);
        let ui = f.attach(Component::Ui, 64);
        let shm = ShmFixture::new();
        let path = shm.0.join("archive.rgb");
        fs::write(&path, [1, 2, 3]).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        // Simulate a prior interrupted marker write: P3 must still close cleanly.
        fs::write(f.server.root.join("journal-ended.json"), b"").unwrap();
        let mut generation = 2;
        loop {
            let snapshot = f.server.snapshot().unwrap();
            let journal_bytes = fs::read(f.server.root.join("journal.jsonl")).unwrap();
            f.route(
                Component::Daemon,
                generation,
                json!({"schema":"frame_ref/v0.2","surface_id":"surface-demo",
                "generation":generation,"tick":generation,"ts_ns":generation,"width":1,"height":1,
                "format":"rgb24","ramws_path":path,"sha256":sha256_hex(&[1,2,3]),"capture_us":1}),
            )
            .await
            .expect("archive capacity with a torn hint must not reset the daemon");
            if f.server.journal_end.is_some() {
                assert_eq!(f.server.snapshot().unwrap(), snapshot);
                assert_eq!(
                    fs::read(f.server.root.join("journal.jsonl")).unwrap(),
                    journal_bytes
                );
                break;
            }
            for message in ui.try_iter() {
                let value = serde_json::to_value(message.body).unwrap();
                assert_ne!(
                    value["data"]["code"], "JOURNAL_FULL",
                    "accepted records do not close admission"
                );
            }
            generation += 1;
            assert!(
                generation < 2000,
                "P3 must fire well before the record limit"
            );
        }
        assert_eq!(f.server.connections.len(), 2);
        assert_eq!(
            serde_json::to_value(ui.try_recv().unwrap().body).unwrap()["data"]["code"],
            "JOURNAL_FULL"
        );
        assert_eq!(
            serde_json::to_value(daemon.try_recv().unwrap().body).unwrap()["op"],
            "destroy"
        );
        f.server.authority.flush_sync().unwrap();
        let root = f.server.root.clone();
        let snapshot = f.server.snapshot().unwrap();
        let mut accounted = fs::metadata(root.join("genesis.json")).unwrap().len();
        for n in 1..=f.server.authority.state().core_seq {
            let bytes = fs::read(root.join("events").join(format!("{n}.json"))).unwrap();
            let event: Value = serde_json::from_slice(&bytes).unwrap();
            accounted += bytes.len() as u64
                + crate::journal::canonical_bytes(&event["state"])
                    .unwrap()
                    .len() as u64;
        }
        assert!(accounted <= 64 * 1024 * 1024);
        assert!(
            accounted > 63 * 1024 * 1024,
            "archive budget, not P1 or journal bytes, is exhausted"
        );
        assert!(fs::metadata(root.join("journal.jsonl")).unwrap().len() < 1024 * 1024);
        let replay = crate::journal::scan(&root.join("journal.jsonl"), &root).unwrap();
        assert_eq!(replay.state.snapshot().unwrap(), snapshot);
        eprintln!(
            "P3 accepted records={} accounted_bytes={accounted}",
            replay.state.core_seq
        );
        let config = f.server.config.clone();
        f.server.shutdown().unwrap();
        let replacement = Server::open(
            config.clone(),
            &f.root.join("unused"),
            effective_uid().unwrap(),
        )
        .unwrap();
        drop(std::mem::replace(&mut f.server, replacement));
        f.server = Server::open(config, &f.root, effective_uid().unwrap()).unwrap();
        assert_eq!(f.server.snapshot().unwrap(), snapshot);
        assert!(
            f.server.journal_end.is_some(),
            "P3 restart preserves the ended session"
        );
    });
}

#[test]
fn journal_review_restart_after_completed_stops_tolerates_terminal_probes() {
    run(async {
        let mut f = Fixture::new();
        f.seed();
        let mut second = f.server.authority.state().surfaces["surface-demo"].clone();
        second.frame = None;
        f.server
            .authority
            .apply(Input::Surface {
                id: "surface-second".into(),
                surface: second,
            })
            .unwrap();
        let daemon = f.attach(Component::Daemon, 64);
        let limit = f.server.authority.state().core_seq;
        crate::journal::set_record_limit_for_test(&f.server.root, limit);
        f.route(Component::Daemon, 2, journal_review_notice())
            .await
            .unwrap();
        let stopped = |id| {
            json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":{
            "schema":"surface/v0.2","surface_id":id,"kind":"browser","display":":92",
            "geometry":{"w":1,"h":1},"state":"destroyed","visibility":"unfolded","control":"agent","profile_id":"test"}}})
        };
        assert_eq!(
            serde_json::to_value(daemon.try_recv().unwrap().body).unwrap()["params"]["surface_id"],
            "surface-demo"
        );
        f.route(Component::Daemon, 3, stopped("surface-demo"))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(daemon.try_recv().unwrap().body).unwrap()["params"]["surface_id"],
            "surface-second"
        );
        f.route(Component::Daemon, 4, stopped("surface-second"))
            .await
            .unwrap();
        assert!(daemon.try_recv().is_err());
        let snapshot = f.server.snapshot().unwrap();
        let config = f.server.config.clone();
        f.server.shutdown().unwrap();
        let replacement = Server::open(
            config.clone(),
            &f.root.join("unused"),
            effective_uid().unwrap(),
        )
        .unwrap();
        drop(std::mem::replace(&mut f.server, replacement));
        f.server = Server::open(config, &f.root, effective_uid().unwrap()).unwrap();
        let daemon = f.attach(Component::Daemon, 64);
        let ui = f.attach(Component::Ui, 64);
        f.server
            .resume_journal_end(1, &f.endpoint(Component::Daemon))
            .unwrap();
        for (n, id) in [(10, "surface-demo"), (11, "surface-second")] {
            assert_eq!(
                serde_json::to_value(daemon.try_recv().unwrap().body).unwrap()["params"]
                    ["surface_id"],
                id
            );
            f.route(
                Component::Daemon,
                n,
                json!({"schema":"surface_event/v0.2","event":"error",
                "data":{"surface_id":id,"code":"surface","detail":"unknown or terminal surface"}}),
            )
            .await
            .unwrap();
        }
        assert!(daemon.try_recv().is_err());
        assert!(ui.try_recv().is_err());
        assert_eq!(f.server.snapshot().unwrap(), snapshot);
    });
}

#[test]
fn journal_review_open_rederives_an_ignored_hint_at_the_next_capacity_refusal() {
    run(async {
        let mut f = Fixture::new();
        f.seed();
        let limit = f.server.authority.state().core_seq;
        crate::journal::set_record_limit_for_test(&f.server.root, limit);
        fs::write(f.server.root.join("journal-ended.json"), b"").unwrap();
        let snapshot = f.server.snapshot().unwrap();
        let config = f.server.config.clone();
        f.server.shutdown().unwrap();
        let replacement = Server::open(
            config.clone(),
            &f.root.join("unused"),
            effective_uid().unwrap(),
        )
        .unwrap();
        drop(std::mem::replace(&mut f.server, replacement));
        f.server = Server::open(config, &f.root, effective_uid().unwrap()).unwrap();
        assert!(f.server.journal_end.is_none());
        let daemon = f.attach(Component::Daemon, 64);
        let ui = f.attach(Component::Ui, 64);
        f.route(Component::Daemon, 20, journal_review_notice())
            .await
            .unwrap();
        assert!(f.server.journal_end.is_some());
        assert_eq!(f.server.snapshot().unwrap(), snapshot);
        assert_eq!(
            serde_json::to_value(ui.try_recv().unwrap().body).unwrap()["data"]["code"],
            "JOURNAL_FULL"
        );
        assert_eq!(
            serde_json::to_value(daemon.try_recv().unwrap().body).unwrap()["op"],
            "destroy"
        );
        let marker: Value =
            serde_json::from_slice(&fs::read(f.server.root.join("journal-ended.json")).unwrap())
                .unwrap();
        assert_eq!(marker["core_seq"], limit);
        assert_eq!(marker["state_sha256"], sha256_hex(&snapshot));
    });
}

#[test]
fn journal_review_native_wire_terminal_refusal_advances_without_false_failure() {
    run(async {
        let mut f = Fixture::new();
        f.seed();
        let mut second = f.server.authority.state().surfaces["surface-demo"].clone();
        second.frame = None;
        f.server
            .authority
            .apply(Input::Surface {
                id: "surface-second".into(),
                surface: second,
            })
            .unwrap();
        let daemon = f.attach(Component::Daemon, 64);
        let ui = f.attach(Component::Ui, 64);
        let limit = f.server.authority.state().core_seq;
        crate::journal::set_record_limit_for_test(&f.server.root, limit);
        f.route(Component::Daemon, 2, journal_review_notice())
            .await
            .unwrap();
        ui.try_recv().unwrap();
        daemon.try_recv().unwrap();
        // wireFailure uses WireCode and Fault::Error, not Manager::HandleFor.
        f.route(Component::Daemon,3,json!({"schema":"surface_event/v0.2","event":"error","data":{
            "surface_id":"surface-demo","code":"ADAPTER_SURFACE","detail":"surface: unknown or terminal surface"}})).await.unwrap();
        assert!(
            ui.try_recv().is_err(),
            "a terminal target is not JOURNAL_STOP_FAILED"
        );
        assert_eq!(
            serde_json::to_value(daemon.try_recv().unwrap().body).unwrap()["params"]["surface_id"],
            "surface-second"
        );
        // The same code with a different detail is still a genuine failure.
        f.route(Component::Daemon,4,json!({"schema":"surface_event/v0.2","event":"error","data":{
            "surface_id":"surface-second","code":"ADAPTER_SURFACE","detail":"surface: not confirmed stopped"}})).await.unwrap();
        assert_eq!(
            serde_json::to_value(ui.try_recv().unwrap().body).unwrap()["data"]["code"],
            "JOURNAL_STOP_FAILED"
        );
        assert!(daemon.try_recv().is_err());
    });
}

#[test]
fn journal_end_ui_and_agent_capacity_start_stops_with_one_notice() {
    run(async {
        for caller in [Component::Ui, Component::Agent] {
            let mut f = Fixture::new();
            f.seed();
            let daemon = f.attach(Component::Daemon, 64);
            let ui = f.attach(Component::Ui, 64);
            let agent = f.attach(Component::Agent, 64);
            // A list is journaled, but does not itself request a destroy.
            let request = json!({"schema":"surface_request/v0.2","op":"list","params":{}});
            f.route(caller, 2, request.clone()).await.unwrap();
            assert!(f.server.journal_end.is_none(), "accepted work keeps admission open");
            daemon.try_recv().unwrap();
            let limit = f.server.authority.state().core_seq;
            crate::journal::set_record_limit_for_test(&f.server.root, limit);
            let snapshot = f.server.snapshot().unwrap();
            f.route(caller, 3, request).await.unwrap();
            assert!(f.server.journal_end.is_some());
            assert_eq!(f.server.snapshot().unwrap(), snapshot);
            for rx in [&ui, &agent] {
                let notice = serde_json::to_value(rx.try_recv().unwrap().body).unwrap();
                assert_eq!(notice["data"]["code"], "JOURNAL_FULL");
                assert!(rx.try_recv().is_err(), "one notice per peer at the end");
            }
            let stop = serde_json::to_value(daemon.try_recv().unwrap().body).unwrap();
            assert_eq!(stop["op"], "destroy");
            assert_eq!(stop["params"]["surface_id"], "surface-demo");
            assert!(daemon.try_recv().is_err());
        }
    });
}
