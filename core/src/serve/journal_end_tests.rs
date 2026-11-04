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
        assert!(
            f.server.load_journal_end().is_err(),
            "negative control: marker must agree with replay"
        );
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
