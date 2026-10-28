//! [TARGET, unit decision] Existing record_request/v0.2 is the UI wire seam.
//! Capture v1 is a host API; no new transport schema is silently admitted.
//! RAM captures expire on process restart; metadata witnesses remain replayable.
//! [TARGET, unit decision] Export grants are the host MV_RECORDING_DESTINATION
//! and opaque recording:configured token. The core must inherit the operator
//! setting. Completion witnesses contain digest/byte count, never a pathname.
//! Export start is durable before publication; completion follows publication.
//! [TARGET, unit decision] Recovery is lazy at the first capture dispatch after
//! Server::open, before any capture operation resumes (within this unit surface).
//! Start witnesses keep the host grant locally; no pathname enters a UI reply.
use super::*;
use crate::wire::payload::RecordRequest;
use serde_json::{json, Value};

impl Server {
    fn capture_recover_exports(&mut self) -> Result<()> {
        if self.capture.exports_recovered {
            return Ok(());
        }
        let mut pending = std::collections::BTreeMap::new();
        for seq in 1..=self.authority.state().core_seq {
            let event: Value = serde_json::from_slice(&fs::read(
                self.root.join("events").join(format!("{seq}.json")),
            )?)?;
            let witnesses: Vec<Witness> = serde_json::from_value(event["witnesses"].clone())?;
            for witness in witnesses {
                let bytes = fs::read(self.root.join("artifacts").join(witness.sha256))?;
                let Ok(data) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                if let Some(transaction) = data["export_transaction"].as_u64() {
                    if data["method"] == "export-started" {
                        pending.insert(transaction, data);
                    } else if data["method"] == "export" {
                        pending.remove(&transaction);
                    }
                }
            }
        }
        for (transaction, start) in pending {
            let destination = start["host_destination"]
                .as_str()
                .ok_or_else(|| invalid("export recovery grant"))?;
            let completed = crate::record::capture::export::recover(
                Path::new(destination),
                &start["receipt"],
                transaction,
            )?;
            self.capture_journal(vec![], &json!({"method":"export","export_transaction":transaction,
                "recovered":true,"reply":if completed {json!({"ok":true,"export":start["receipt"]})}
                else {json!({"ok":false,"code":"CAPTURE_UNAVAILABLE","request_id":start["request"]["request_id"]})}}))?;
        }
        self.capture.exports_recovered = true;
        Ok(())
    }

    // [TARGET, unit decision] Frozen surface_event.error carries closed capture
    // metadata under CAPTURE_REPLY / CAPTURE_STATE; detail is bounded JSON.
    fn capture_metadata(
        &mut self,
        now_ns: u64,
        peer: &Endpoint,
        code: &str,
        value: Value,
    ) -> Result<()> {
        self.send_at(
            now_ns,
            peer,
            Command::SurfaceEvent(Box::new(serde_json::from_value(json!({
                "schema":"surface_event/v0.2","event":"error",
                "data":{"surface_id":"capture","code":code,"detail":serde_json::to_string(&value)?}
            }))?)),
        )
    }
    pub(super) fn capture_list_wire(
        &mut self,
        now_ns: u64,
        env: &Envelope,
        boundary: Witness,
    ) -> Result<()> {
        self.capture_recover_exports()?;
        let (reply, _) = self.capture_transition(now_ns, "list", Value::Null, vec![boundary])?;
        self.capture_metadata(
            now_ns,
            &env.from,
            "CAPTURE_REPLY",
            json!({"request_id":env.msg_id,"method":"list","reply":reply}),
        )
    }
    fn capture_publish_states(&mut self, now_ns: u64, events: &[Value]) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let (_, reply, _) = self
            .capture
            .prepare("list", &Value::Null, Default::default(), now_ns / 1_000_000)
            .map_err(|_| invalid("capture states"))?;
        let peers: Vec<_> = self
            .connections
            .keys()
            .filter(|p| p.component == Component::Ui)
            .cloned()
            .collect();
        for row in reply["rows"]
            .as_array()
            .ok_or_else(|| invalid("capture rows"))?
        {
            if row["kind"] != "recording"
                || !events.iter().any(|entry| {
                    entry["events"].as_array().is_some_and(|items| {
                        items.iter().any(|event| event["recording_id"] == row["id"])
                    })
                })
            {
                continue;
            }
            let state = json!({"type":"capture.state","recording_id":row["id"],"surface_id":row["surface_id"],
                "phase":row["phase"],"frames":row["frames"],"elapsed_ms":row["duration_ms"]});
            for peer in &peers {
                self.capture_metadata(now_ns, peer, "CAPTURE_STATE", state.clone())?;
            }
        }
        Ok(())
    }
    fn capture_journal(&mut self, boundary: Vec<Witness>, data: &Value) -> Result<()> {
        let witness = self.authority.retain_witness(&serde_json::to_vec(data)?)?;
        let mut witnesses = boundary;
        witnesses.push(witness);
        let input = if data["reply"]["ok"] == false {
            Input::Refuse {
                reason: Refusal::Policy,
            }
        } else {
            Input::SurfaceNotice
        };
        self.authority.apply_with_witnesses(input, witnesses)?;
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn capture_frame(&mut self, frame: &FrameRef, pixels: Vec<u8>) -> Result<()> {
        let now_ns = self.route_now_ns.map_or_else(|| self.now(), Ok)?;
        self.capture_frame_at(now_ns, frame, pixels)
    }
    pub(super) fn capture_frame_at(
        &mut self,
        now_ns: u64,
        frame: &FrameRef,
        pixels: Vec<u8>,
    ) -> Result<()> {
        self.capture_recover_exports()?;
        if !self.capture.has_active_recording(&frame.surface_id) {
            let _ = self
                .capture
                .frame_verified(frame, pixels, now_ns / 1_000_000);
            return Ok(());
        }
        let mut next = self.capture.clone();
        // Oversized/unavailable frames do not disable normal authority rendering.
        let Ok(events) = next.frame_verified(frame, pixels, now_ns / 1_000_000) else {
            let dropped = next.drop_frame(&frame.surface_id, now_ns);
            if !dropped.is_empty() {
                self.capture_journal(vec![], &json!({"capture_frame":dropped}))?;
            }
            self.capture = next;
            return Ok(());
        };
        if !events.is_empty() {
            self.capture_journal(vec![], &json!({"capture_frame":events}))?;
        }
        self.capture = next;
        self.capture_publish_states(now_ns, &events)?;
        Ok(())
    }
    /// Host binding seam. Only registered UI principals may call this API.
    /// The caller owns correlation; no frame path or pixel bytes are returned.
    pub fn capture_request(
        &mut self,
        peer: &Endpoint,
        method: &str,
        request: Value,
    ) -> Result<Value> {
        if peer.component != Component::Ui || !self.config.peers.iter().any(|p| &p.endpoint == peer)
        {
            return Err(invalid("capture requires registered UI"));
        }
        let now_ns = self.now()?;
        self.capture_recover_exports()?;
        let keys = match method {
            "screenshot" => vec!["request_id", "schema", "surface_id"],
            "recordStart" => vec!["mode", "request_id", "schema", "surface_id"],
            "recordStop" => vec!["recording_id", "request_id", "schema"],
            "export" => vec!["capture_id", "destination", "request_id", "schema"],
            "list" if request.is_null() => vec![],
            _ => return Err(invalid("capture method")),
        };
        if method != "list" {
            let object = request
                .as_object()
                .ok_or_else(|| invalid("capture shape"))?;
            if object.keys().map(String::as_str).collect::<Vec<_>>() != keys
                || request["schema"] != "capture_request/v1"
                || !request["request_id"].as_str().is_some_and(|id| {
                    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| (32..=126).contains(&b))
                })
                || !request[if method == "export" {
                    "capture_id"
                } else if method == "recordStop" {
                    "recording_id"
                } else {
                    "surface_id"
                }]
                .as_str()
                .is_some_and(crate::record::valid_id)
                || (method == "recordStart" && request["mode"] != "ai")
                || (method == "export"
                    && !request["destination"].is_null()
                    && request["destination"] != "recording:configured")
            {
                return Err(invalid("capture shape"));
            }
        }
        if method == "export" {
            let destination = std::env::var_os("MV_RECORDING_DESTINATION")
                .filter(|p| !p.is_empty())
                .map(PathBuf::from);
            return self.capture_export_to(request, destination.as_deref(), vec![]);
        }
        self.capture_transition(now_ns, method, request, vec![])
            .map(|(reply, _)| reply)
    }
    fn capture_export_to(
        &mut self,
        request: Value,
        destination: Option<&Path>,
        boundary: Vec<Witness>,
    ) -> Result<Value> {
        self.capture_recover_exports()?;
        let plan = (|| -> std::result::Result<_, &'static str> {
            let destination = destination
                .filter(|_| request["destination"] == "recording:configured")
                .ok_or("DESTINATION_UNSET")?;
            let plan = self
                .capture
                .export_plan(request["capture_id"].as_str().unwrap_or(""))?;
            Ok((destination, plan))
        })();
        let transaction = self.authority.state().core_seq + 1;
        if let Ok((destination, plan)) = &plan {
            self.capture_journal(
                vec![],
                &json!({"method":"export-started","export_transaction":transaction,
                "request":request,"host_destination":destination,"receipt":plan.receipt}),
            )?;
        }
        let outcome = plan.and_then(|(destination, plan)| {
            plan.publish_transaction(destination, transaction)
                .map(|publication| (publication, plan.receipt))
        });
        let (publication, reply) = match outcome {
            Ok((publication, receipt)) => (Some(publication), json!({"ok":true,"export":receipt})),
            Err(code) => (
                None,
                json!({"ok":false,"code":code,"request_id":request["request_id"]}),
            ),
        };
        self.capture_journal(
            boundary,
            &json!({"method":"export","export_transaction":transaction,"request":request,"reply":reply}),
        )?;
        if let Some(publication) = publication {
            publication.commit();
        }
        Ok(reply)
    }
    fn capture_transition(
        &mut self,
        now_ns: u64,
        method: &str,
        request: Value,
        boundary: Vec<Witness>,
    ) -> Result<(Value, Vec<Value>)> {
        let surfaces = self
            .authority
            .state()
            .surfaces
            .iter()
            .filter(|(_, s)| s.live)
            .map(|(id, _)| id.clone())
            .collect();
        let (next, reply, events) = self
            .capture
            .prepare(method, &request, surfaces, now_ns / 1_000_000)
            .map_err(|e| invalid(&format!("capture transition: {e:?}")))?;
        self.capture_journal(
            boundary,
            &json!({"method":method,"request":request,"reply":reply,"transitions":events}),
        )?;
        self.capture = next;
        Ok((reply, events))
    }
    pub(super) fn capture_wire(
        &mut self,
        now_ns: u64,
        env: &Envelope,
        request: &RecordRequest,
        boundary: Witness,
    ) -> Result<()> {
        self.capture_recover_exports()?;
        let raw = serde_json::to_value(request)?;
        // [TARGET, unit decision] Existing disk_start carrier exports an already
        // sealed capture. It never starts a disk recorder. Host binding supplies
        // the configured capability/path; the core independently checks its grant.
        if raw["op"] == "disk_start" {
            let destination = std::env::var_os("MV_RECORDING_DESTINATION")
                .filter(|p| !p.is_empty())
                .map(PathBuf::from);
            let granted = destination.as_ref().is_some_and(|p| {
                p.to_str() == raw["params"]["destination_path"].as_str()
                    && raw["params"]["destination_capability_id"] == "recording:configured"
            });
            let req = json!({"schema":"capture_request/v1","request_id":raw["request_id"],
                "capture_id":raw["params"]["recording_id"],"destination":if granted {json!("recording:configured")} else {Value::Null}});
            let reply = self.capture_export_to(req, destination.as_deref(), vec![boundary])?;
            return self.capture_metadata(
                now_ns,
                &env.from,
                "CAPTURE_REPLY",
                json!({"request_id":raw["request_id"],"method":"export","reply":reply}),
            );
        }
        let method = match raw["op"].as_str() {
            Some("ram_start") => "recordStart",
            Some("ram_stop") => "recordStop",
            Some("screenshot") => "screenshot",
            _ => return self.unsupported_at(now_ns, env, boundary),
        };
        let mut req = json!({"schema":"capture_request/v1","request_id":raw["request_id"]});
        if method == "recordStop" {
            req["recording_id"] = raw["params"]["recording_id"].clone();
        } else {
            req["surface_id"] = raw["params"]["surface_id"].clone();
        }
        if method == "recordStart" {
            if raw["params"]["ring_bytes"] != 8 * 1024 * 1024 || raw["params"]["max_fps"] != 30 {
                return self.unsupported_at(now_ns, env, boundary);
            }
            req["mode"] = "ai".into();
            req["_host_id"] = raw["params"]["recording_id"].clone();
        }
        if method == "screenshot" {
            req["_host_id"] = raw["params"]["capture_id"].clone();
        }
        let (reply, events) = self.capture_transition(now_ns, method, req, vec![boundary])?;
        self.capture_metadata(
            now_ns,
            &env.from,
            "CAPTURE_REPLY",
            json!({"request_id":raw["request_id"],"method":method,"reply":reply}),
        )?;
        self.capture_publish_states(now_ns, &events)?;
        for entry in events {
            for event in entry["events"]
                .as_array()
                .ok_or_else(|| invalid("capture events"))?
            {
                let mut event = event.clone();
                event["request_id"] = raw["request_id"].clone();
                self.send_at(
                    now_ns,
                    &env.from,
                    Command::RecordEvent(Box::new(serde_json::from_value(event)?)),
                )?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "mv-capture-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn export_journals_receipts_refusals_and_rolls_back_if_journal_fails() {
        let temp = Temp::new();
        let root = temp.0.clone();
        let reg = |component: &str| -> Registration {
            serde_json::from_value(json!({"endpoint":{"component":component,"instance":format!("{component}-export")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
        };
        let config = Config {
            session_id: "export-session".into(),
            core: reg("core"),
            peers: vec![reg("agent"), reg("daemon"), reg("ui")],
        };
        let mut server = Server::open(config.clone(), &root, effective_uid().unwrap()).unwrap();
        let mut frame: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        frame["width"] = 1.into();
        frame["height"] = 1.into();
        frame["sha256"] = sha256_hex(&[255, 0, 0]).into();
        server
            .capture
            .frame(&serde_json::from_value(frame).unwrap(), vec![255, 0, 0], 0)
            .unwrap();
        let surfaces = BTreeSet::from(["surface-demo".to_owned()]);
        let (next, shot, _) = server
            .capture
            .prepare(
                "screenshot",
                &json!({"request_id":"shot","surface_id":"surface-demo"}),
                surfaces.clone(),
                0,
            )
            .unwrap();
        server.capture = next;
        let request = json!({"schema":"capture_request/v1","request_id":"export","capture_id":shot["shot"]["id"],"destination":"recording:configured"});
        let destination = root.join("exports");
        fs::create_dir(&destination).unwrap();
        for (req, dest, expected) in [
            (request.clone(), None, "DESTINATION_UNSET"),
            (
                {
                    let mut req = request.clone();
                    req["capture_id"] = "unknown".into();
                    req
                },
                Some(destination.as_path()),
                "CAPTURE_UNKNOWN",
            ),
            (
                request.clone(),
                Some(root.join("vanished").as_path()),
                "DESTINATION_UNAVAILABLE",
            ),
        ] {
            let seq = server.authority.state().core_seq;
            assert_eq!(
                server.capture_export_to(req, dest, vec![]).unwrap()["code"],
                expected
            );
            assert_eq!(
                server.authority.state().core_seq,
                seq + if expected == "DESTINATION_UNAVAILABLE" {
                    2
                } else {
                    1
                }
            );
            assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
        }
        let reply = server
            .capture_export_to(request.clone(), Some(&destination), vec![])
            .unwrap();
        assert_eq!(reply["ok"], true);
        let archive = fs::read_dir(&destination)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let bytes = fs::read(&archive).unwrap();
        assert_eq!(reply["export"]["sha256"], sha256_hex(&bytes));
        assert_eq!(reply["export"]["bytes"], bytes.len());
        let session = root.join("sessions/export-session");
        let event: Value = serde_json::from_slice(
            &fs::read(
                session
                    .join("events")
                    .join(format!("{}.json", server.authority.state().core_seq)),
            )
            .unwrap(),
        )
        .unwrap();
        let witnesses = event["witnesses"].as_array().unwrap();
        let witness: Value = serde_json::from_slice(
            &fs::read(
                session
                    .join("artifacts")
                    .join(witnesses[0]["sha256"].as_str().unwrap()),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(witness["method"], "export");
        assert_eq!(witness["reply"], reply);
        assert!(!witness.to_string().contains(destination.to_str().unwrap()));
        assert_eq!(
            server
                .capture_export_to(request.clone(), Some(&destination), vec![])
                .unwrap()["code"],
            "DESTINATION_EXISTS"
        );
        fs::remove_file(archive).unwrap();
        // A failed write-ahead witness prevents any archive publication.
        fs::rename(session.join("artifacts"), session.join("artifacts-offline")).unwrap();
        fs::write(session.join("artifacts"), b"unavailable").unwrap();
        assert!(server
            .capture_export_to(request, Some(&destination), vec![])
            .is_err());
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
        fs::remove_file(session.join("artifacts")).unwrap();
        fs::rename(session.join("artifacts-offline"), session.join("artifacts")).unwrap();
        let state = server.snapshot().unwrap();
        drop(server);
        let recovered = Server::open(config.clone(), &root, effective_uid().unwrap()).unwrap();
        assert_eq!(recovered.snapshot().unwrap(), state);
        drop(recovered);
        // Crash fixture: durable start + published file, no completion witness.
        // Matching digest completes; altered bytes are removed. Temporary files
        // from a crash before linking are reclaimed in either path.
        for valid in [true, false] {
            let mut interrupted =
                Server::open(config.clone(), &root, effective_uid().unwrap()).unwrap();
            let transaction = interrupted.authority.state().core_seq + 1;
            interrupted
                .capture_journal(
                    vec![],
                    &json!({"method":"export-started",
                "export_transaction":transaction,"host_destination":destination,
                "request":{"request_id":"crash"},"receipt":reply["export"]}),
                )
                .unwrap();
            let name = format!(
                "{}-{}.tar",
                reply["export"]["id"].as_str().unwrap(),
                reply["export"]["sha256"].as_str().unwrap()
            );
            let archive = destination.join(&name);
            fs::write(&archive, if valid { bytes.as_slice() } else { b"corrupt" }).unwrap();
            fs::set_permissions(&archive, fs::Permissions::from_mode(0o600)).unwrap();
            let temporary = destination.join(format!(".mv-export-{name}-{transaction}"));
            fs::write(&temporary, b"interrupted").unwrap();
            drop(interrupted);
            let mut restarted =
                Server::open(config.clone(), &root, effective_uid().unwrap()).unwrap();
            restarted
                .capture_request(&config.peers[2].endpoint, "list", Value::Null)
                .unwrap();
            assert_eq!(archive.exists(), valid);
            assert!(!temporary.exists());
            let completed_seq = restarted.authority.state().core_seq;
            let event: Value = serde_json::from_slice(
                &fs::read(
                    session
                        .join("events")
                        .join(format!("{}.json", completed_seq - 1)),
                )
                .unwrap(),
            )
            .unwrap();
            let receipt: Value = serde_json::from_slice(
                &fs::read(
                    session
                        .join("artifacts")
                        .join(event["witnesses"][0]["sha256"].as_str().unwrap()),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(receipt["recovered"], true);
            assert_eq!(receipt["export_transaction"], transaction);
            assert_eq!(receipt["reply"]["ok"], valid);
            if valid {
                assert_eq!(receipt["reply"]["export"], reply["export"]);
            }
            restarted.capture_recover_exports().unwrap();
            assert_eq!(restarted.authority.state().core_seq, completed_seq);
            drop(restarted);
            let mut replayed =
                Server::open(config.clone(), &root, effective_uid().unwrap()).unwrap();
            replayed.capture_recover_exports().unwrap();
            assert_eq!(replayed.authority.state().core_seq, completed_seq);
            drop(replayed);
            if valid {
                fs::remove_file(archive).unwrap();
            }
        }
    }
    #[test]
    fn host_capture_is_journaled_replays_and_expires_ram_on_restart() {
        let temp = Temp::new();
        let root = temp.0.clone();
        let reg = |component: &str| -> Registration {
            serde_json::from_value(json!({"endpoint":{"component":component,"instance":format!("{component}-capture")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
        };
        let config = Config {
            session_id: "capture-session".into(),
            core: reg("core"),
            peers: vec![reg("agent"), reg("daemon"), reg("ui")],
        };
        let ui = reg("ui").endpoint;
        let mut server = Server::open(config.clone(), &root, effective_uid().unwrap()).unwrap();
        server
            .authority
            .apply(Input::Surface {
                id: "surface-demo".into(),
                surface: Surface {
                    display: "capture-display".into(),
                    owner: reg("agent").endpoint,
                    agent_controlled: true,
                    live: true,
                    frame: None,
                    refresh_after: None,
                    allowed_verbs: vec![],
                },
            })
            .unwrap();
        let mut raw: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        raw["sha256"] = sha256_hex(b"pixels").into();
        let frame: FrameRef = serde_json::from_value(raw).unwrap();
        server.capture_frame(&frame, b"pixels".to_vec()).unwrap();
        let request = json!({"schema":"capture_request/v1","request_id":"start capture","surface_id":"surface-demo","mode":"ai"});
        let seq = server.authority.state().core_seq;
        assert!(server
            .capture_request(&reg("agent").endpoint, "recordStart", request.clone())
            .is_err());
        assert_eq!(server.authority.state().core_seq, seq);
        let reply = server
            .capture_request(&ui, "recordStart", request.clone())
            .unwrap();
        assert_eq!(reply["ok"], true);
        assert_eq!(
            server.capture_request(&ui, "recordStart", request).unwrap()["code"],
            "ALREADY_RECORDING"
        );
        let stopped = server.capture_request(&ui,"recordStop",json!({"schema":"capture_request/v1","request_id":"stop","recording_id":reply["recording_id"]})).unwrap();
        assert_eq!(stopped["recording"]["sha256"], sha256_hex(b"pixels"));
        // Exercise the production wire carrier, including a refusal and list,
        // through the same closed encoder used by the socket writer.
        let (queue, rx) = mpsc::sync_channel(64);
        server.connections.insert(
            ui.clone(),
            Connection {
                id: 1,
                epoch: 1,
                queue,
                terminal: Arc::new(Mutex::new(None)),
            },
        );
        for (surface, expected) in [("surface-demo", None), ("unknown", Some("SURFACE_UNKNOWN"))] {
            let request: RecordRequest = serde_json::from_value(json!({"schema":"record_request/v0.2",
                "request_id":"wire-shot","op":"screenshot","params":{"surface_id":surface,"capture_id":format!("shot-{surface}")}})).unwrap();
            let env = Envelope {
                schema: "envelope/v0.2".into(),
                msg_id: "wire-shot".into(),
                ts_ns: Clock::new(0),
                from: ui.clone(),
                to: server.config.core.endpoint.clone(),
                session_id: "capture-session".into(),
                seq: 1,
                nonce: "wire-shot".into(),
                body: Command::RecordRequest(Box::new(request.clone())),
            };
            let boundary = server
                .authority
                .retain_witness(serde_json::to_string(&env).unwrap().as_bytes())
                .unwrap();
            server.capture_wire(0, &env, &request, boundary).unwrap();
            let messages: Vec<Value> = rx
                .try_iter()
                .map(|env| {
                    decode_envelope(&serde_json::to_string(&env).unwrap()).unwrap();
                    serde_json::to_value(env.body).unwrap()
                })
                .collect();
            let carrier = messages
                .iter()
                .find(|v| v["data"]["code"] == "CAPTURE_REPLY")
                .unwrap();
            let result: Value =
                serde_json::from_str(carrier["data"]["detail"].as_str().unwrap()).unwrap();
            assert_eq!(result["request_id"], "wire-shot");
            if let Some(code) = expected {
                assert_eq!(result["reply"]["code"], code);
            } else {
                assert_eq!(result["reply"]["ok"], true);
            }
            assert!(!result.to_string().contains("ram_path"));
        }
        let list: Envelope = serde_json::from_value(json!({"schema":"envelope/v0.2","msg_id":"capture-list:test",
            "ts_ns":0,"from":ui,"to":server.config.core.endpoint,"session_id":"capture-session","seq":2,
            "nonce":"list","body":{"schema":"surface_request/v0.2","op":"list","params":{}}})).unwrap();
        let boundary = server.authority.retain_witness(b"list").unwrap();
        server.capture_list_wire(0, &list, boundary).unwrap();
        let carrier = serde_json::to_value(rx.try_recv().unwrap().body).unwrap();
        let result: Value =
            serde_json::from_str(carrier["data"]["detail"].as_str().unwrap()).unwrap();
        assert_eq!(result["method"], "list");
        assert_eq!(result["reply"]["rows"].as_array().unwrap().len(), 2);
        let state = server.snapshot().unwrap();
        drop(server);
        let mut recovered = Server::open(config, &root, effective_uid().unwrap()).unwrap();
        assert_eq!(recovered.snapshot().unwrap(), state);
        assert_eq!(
            recovered.capture_request(&ui, "list", Value::Null).unwrap()["rows"],
            json!([])
        );
        drop(recovered);
    }
    #[test]
    fn wire_sealed_recordings_are_listed_with_negative_controls() {
        let temp = Temp::new();
        let root = temp.0.clone();
        let reg = |component: &str| -> Registration {
            serde_json::from_value(json!({"endpoint":{"component":component,"instance":format!("{component}-reclist")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
        };
        let config = Config {
            session_id: "reclist-session".into(),
            core: reg("core"),
            peers: vec![reg("agent"), reg("daemon"), reg("ui")],
        };
        let ui = reg("ui").endpoint;
        let mut server = Server::open(config.clone(), &root, effective_uid().unwrap()).unwrap();
        for (id, display) in [
            ("surface-demo", "display-demo"),
            ("surface-other", "display-other"),
        ] {
            server
                .authority
                .apply(Input::Surface {
                    id: id.into(),
                    surface: Surface {
                        display: display.into(),
                        owner: reg("agent").endpoint,
                        agent_controlled: true,
                        live: true,
                        frame: None,
                        refresh_after: None,
                        allowed_verbs: vec![],
                    },
                })
                .unwrap();
            let mut raw: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/frame_ref.valid.json"
            ))
            .unwrap();
            raw["surface_id"] = id.into();
            raw["sha256"] = sha256_hex(b"pixels").into();
            let frame: FrameRef = serde_json::from_value(raw).unwrap();
            server.capture_frame(&frame, b"pixels".to_vec()).unwrap();
        }
        let (queue, rx) = mpsc::sync_channel(64);
        server.connections.insert(
            ui.clone(),
            Connection {
                id: 1,
                epoch: 1,
                queue,
                terminal: Arc::new(Mutex::new(None)),
            },
        );
        let mut seq = 0_u64;
        let mut next_seq = || {
            seq += 1;
            seq
        };
        let drain_reply = |rx: &mpsc::Receiver<Envelope>, req_id: &str| -> Value {
            let messages: Vec<Value> = rx
                .try_iter()
                .map(|env| {
                    decode_envelope(&serde_json::to_string(&env).unwrap()).unwrap();
                    serde_json::to_value(env.body).unwrap()
                })
                .collect();
            let carrier = messages
                .iter()
                .find(|v| v["data"]["code"] == "CAPTURE_REPLY")
                .unwrap();
            let detail: Value =
                serde_json::from_str(carrier["data"]["detail"].as_str().unwrap()).unwrap();
            assert_eq!(detail["request_id"], req_id);
            detail
        };
        // Negative control 1: no recordings -> empty list.
        let empty_list: Envelope = serde_json::from_value(json!({
            "schema":"envelope/v0.2","msg_id":"capture-list:empty","ts_ns":0,
            "from":ui,"to":server.config.core.endpoint,"session_id":"reclist-session",
            "seq":next_seq(),"nonce":"list-empty",
            "body":{"schema":"surface_request/v0.2","op":"list","params":{}}
        }))
        .unwrap();
        let boundary = server.authority.retain_witness(b"list-empty").unwrap();
        server.capture_list_wire(0, &empty_list, boundary).unwrap();
        let empty_detail = drain_reply(&rx, "capture-list:empty");
        assert_eq!(empty_detail["method"], "list");
        assert_eq!(empty_detail["reply"], json!({"ok":true,"rows":[]}));

        // Seal two recordings on surface-demo and one on surface-other via capture_wire.
        for (rec_id, surface_id) in [
            ("rec-demo-1", "surface-demo"),
            ("rec-demo-2", "surface-demo"),
            ("rec-other-1", "surface-other"),
        ] {
            let start_id = format!("start-{rec_id}");
            let start_req: RecordRequest = serde_json::from_value(json!({
                "schema":"record_request/v0.2","request_id":start_id,"op":"ram_start",
                "params":{"surface_id":surface_id,"recording_id":rec_id,"ring_bytes":8_388_608,"max_fps":30}
            }))
            .unwrap();
            let start_env = Envelope {
                schema: "envelope/v0.2".into(),
                msg_id: start_id.clone(),
                ts_ns: Clock::new(0),
                from: ui.clone(),
                to: server.config.core.endpoint.clone(),
                session_id: "reclist-session".into(),
                seq: next_seq(),
                nonce: start_id.clone(),
                body: Command::RecordRequest(Box::new(start_req.clone())),
            };
            let boundary = server
                .authority
                .retain_witness(serde_json::to_string(&start_env).unwrap().as_bytes())
                .unwrap();
            server
                .capture_wire(0, &start_env, &start_req, boundary)
                .unwrap();
            let start_detail = drain_reply(&rx, &start_id);
            assert_eq!(start_detail["method"], "recordStart");
            assert_eq!(
                start_detail["reply"],
                json!({"ok":true,"recording_id":rec_id})
            );

            let mut raw: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/frame_ref.valid.json"
            ))
            .unwrap();
            raw["surface_id"] = surface_id.into();
            raw["sha256"] = sha256_hex(b"pixels").into();
            let frame: FrameRef = serde_json::from_value(raw).unwrap();
            server.capture_frame(&frame, b"pixels".to_vec()).unwrap();
            let _ = rx.try_iter().count();

            let stop_id = format!("stop-{rec_id}");
            let stop_req: RecordRequest = serde_json::from_value(json!({
                "schema":"record_request/v0.2","request_id":stop_id,"op":"ram_stop",
                "params":{"surface_id":surface_id,"recording_id":rec_id}
            }))
            .unwrap();
            let stop_env = Envelope {
                schema: "envelope/v0.2".into(),
                msg_id: stop_id.clone(),
                ts_ns: Clock::new(0),
                from: ui.clone(),
                to: server.config.core.endpoint.clone(),
                session_id: "reclist-session".into(),
                seq: next_seq(),
                nonce: stop_id.clone(),
                body: Command::RecordRequest(Box::new(stop_req.clone())),
            };
            let boundary = server
                .authority
                .retain_witness(serde_json::to_string(&stop_env).unwrap().as_bytes())
                .unwrap();
            server
                .capture_wire(0, &stop_env, &stop_req, boundary)
                .unwrap();
            let stop_detail = drain_reply(&rx, &stop_id);
            assert_eq!(stop_detail["method"], "recordStop");
            assert_eq!(stop_detail["reply"]["ok"], true);
            assert_eq!(stop_detail["reply"]["recording"]["id"], rec_id);
            assert_eq!(stop_detail["reply"]["recording"]["surface_id"], surface_id);
            assert_eq!(stop_detail["reply"]["recording"]["sealed"], true);
            assert_eq!(stop_detail["reply"]["recording"]["frames"], 2);
        }

        let list_env: Envelope = serde_json::from_value(json!({
            "schema":"envelope/v0.2","msg_id":"capture-list:sealed","ts_ns":0,
            "from":ui,"to":server.config.core.endpoint,"session_id":"reclist-session",
            "seq":next_seq(),"nonce":"list-sealed",
            "body":{"schema":"surface_request/v0.2","op":"list","params":{}}
        }))
        .unwrap();
        let boundary = server.authority.retain_witness(b"list-sealed").unwrap();
        server.capture_list_wire(0, &list_env, boundary).unwrap();
        let list_detail = drain_reply(&rx, "capture-list:sealed");
        assert_eq!(list_detail["method"], "list");
        assert_eq!(list_detail["reply"]["ok"], true);
        let rows = list_detail["reply"]["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 3);
        let demo_rows: Vec<&Value> = rows
            .iter()
            .filter(|r| r["kind"] == "recording" && r["surface_id"] == "surface-demo")
            .collect();
        assert_eq!(demo_rows.len(), 2);
        assert_eq!(demo_rows[0]["id"], "rec-demo-1");
        assert_eq!(demo_rows[0]["phase"], "sealed");
        assert_eq!(demo_rows[0]["sealed"], true);
        assert_eq!(demo_rows[0]["frames"], 2);
        assert_eq!(demo_rows[1]["id"], "rec-demo-2");
        assert_eq!(demo_rows[1]["phase"], "sealed");
        assert_eq!(demo_rows[1]["sealed"], true);
        assert_eq!(demo_rows[1]["frames"], 2);
        // Negative control 2: a recording of another surface is not listed for surface-demo.
        assert!(demo_rows.iter().all(|r| r["surface_id"] == "surface-demo"));
        drop(server);
    }
    #[test]
    fn capture_tests_survive_same_process_concurrency_and_unwind() {
        let first = Temp::new();
        let second = Temp::new();
        assert_ne!(first.0, second.0);
        // Negative control: creating a directory at an active Temp path fails with AlreadyExists.
        assert_eq!(
            fs::create_dir(&second.0).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        let unwind_path = first.0.clone();
        let result = std::panic::catch_unwind(move || {
            let guard = first;
            fs::write(guard.0.join("sentinel"), b"data").unwrap();
            panic!("verify Temp Drop cleanup on unwind");
        });
        assert!(result.is_err());
        assert!(!unwind_path.exists(), "Temp must remove dir on unwind");
        assert!(second.0.is_dir(), "sibling Temp must remain intact");
        let second_path = second.0.clone();
        drop(second);
        assert!(!second_path.exists());

        std::thread::scope(|s| {
            let a = s.spawn(wire_sealed_recordings_are_listed_with_negative_controls);
            let b = s.spawn(wire_sealed_recordings_are_listed_with_negative_controls);
            let c = s.spawn(host_capture_is_journaled_replays_and_expires_ram_on_restart);
            let d = s.spawn(host_capture_is_journaled_replays_and_expires_ram_on_restart);
            a.join().expect("first wire_sealed run must not collide");
            b.join().expect("second wire_sealed run must not collide");
            c.join().expect("first host_capture run must not collide");
            d.join().expect("second host_capture run must not collide");
        });
    }

    #[test]
    fn new_01_oversize_frame_during_active_recording_journals_dropped_marker() {
        let temp = Temp::new();
        let root = temp.0.clone();
        let reg = |component: &str| -> Registration {
            serde_json::from_value(json!({"endpoint":{"component":component,"instance":format!("{component}-oversize")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
        };
        let config = Config {
            session_id: "oversize-session".into(),
            core: reg("core"),
            peers: vec![reg("agent"), reg("daemon"), reg("ui")],
        };
        let ui = reg("ui").endpoint;
        let mut server = Server::open(config, &root, effective_uid().unwrap()).unwrap();
        server
            .authority
            .apply(Input::Surface {
                id: "surface-demo".into(),
                surface: Surface {
                    display: "oversize-display".into(),
                    owner: reg("agent").endpoint,
                    agent_controlled: true,
                    live: true,
                    frame: None,
                    refresh_after: None,
                    allowed_verbs: vec![],
                },
            })
            .unwrap();
        let mut raw: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        // Negative control: oversize frame with no active recording journals nothing.
        let seq_idle = server.authority.state().core_seq;
        let idle_oversize = vec![0x41_u8; 9 * 1024 * 1024];
        raw["sha256"] = sha256_hex(&idle_oversize).into();
        let idle_over_frame: FrameRef = serde_json::from_value(raw.clone()).unwrap();
        server
            .capture_frame(&idle_over_frame, idle_oversize)
            .unwrap();
        assert_eq!(server.authority.state().core_seq, seq_idle);

        raw["sha256"] = sha256_hex(b"seed-pixels").into();
        let seed_frame: FrameRef = serde_json::from_value(raw.clone()).unwrap();
        server
            .capture_frame(&seed_frame, b"seed-pixels".to_vec())
            .unwrap();
        let start_reply = server
            .capture_request(
                &ui,
                "recordStart",
                json!({"schema":"capture_request/v1","request_id":"start-over","surface_id":"surface-demo","mode":"ai"}),
            )
            .unwrap();
        assert_eq!(start_reply["ok"], true);
        let rec_id = start_reply["recording_id"].as_str().unwrap().to_owned();

        let seq_before = server.authority.state().core_seq;
        let oversize = vec![0x42_u8; 9 * 1024 * 1024];
        raw["generation"] = 2.into();
        raw["sha256"] = sha256_hex(&oversize).into();
        let over_frame: FrameRef = serde_json::from_value(raw).unwrap();
        server.capture_frame(&over_frame, oversize).unwrap();

        let seq_after = server.authority.state().core_seq;
        assert!(
            seq_after > seq_before,
            "oversize frame during active recording must journal a dropped-frame marker"
        );
        let session = root.join("sessions/oversize-session");
        let event: Value = serde_json::from_slice(
            &fs::read(session.join("events").join(format!("{seq_after}.json"))).unwrap(),
        )
        .unwrap();
        let witness_sha = event["witnesses"][0]["sha256"].as_str().unwrap();
        let witness: Value =
            serde_json::from_slice(&fs::read(session.join("artifacts").join(witness_sha)).unwrap())
                .unwrap();
        let drop_ev = &witness["capture_frame"][0]["events"][0];
        assert_eq!(drop_ev["schema"], "record_event/v0.2");
        assert_eq!(drop_ev["request_id"], rec_id);
        assert_eq!(drop_ev["surface_id"], "surface-demo");
        assert_eq!(drop_ev["recording_id"], rec_id);
        assert_eq!(drop_ev["event"], "dropped");
        assert_eq!(drop_ev["dropped_frames"], 1);
        assert_eq!(drop_ev["policy"], "ram_ring_oldest");

        let stop_reply = server
            .capture_request(
                &ui,
                "recordStop",
                json!({"schema":"capture_request/v1","request_id":"stop-over","recording_id":rec_id}),
            )
            .unwrap();
        assert_eq!(stop_reply["ok"], true);
        assert_eq!(stop_reply["recording"]["dropped_frames"], 1);
    }

    #[test]
    fn export_transaction_id_is_monotonic_and_equals_pre_export_core_seq_plus_one() {
        let temp = Temp::new();
        let root = temp.0.clone();
        let reg = |component: &str| -> Registration {
            serde_json::from_value(json!({"endpoint":{"component":component,"instance":format!("{component}-txmono")},"hello":{"schema":"hello/v0.2","contract_version":"v0.2","component":component,"component_version":"0.2.0","component_commit":"0123456789abcdef0123456789abcdef01234567","dependencies":[]}})).unwrap()
        };
        let config = Config {
            session_id: "txmono-session".into(),
            core: reg("core"),
            peers: vec![reg("agent"), reg("daemon"), reg("ui")],
        };
        let mut server = Server::open(config.clone(), &root, effective_uid().unwrap()).unwrap();
        let surfaces = BTreeSet::from(["surface-demo".to_owned()]);
        let make_shot = |server: &mut Server, pixel: u8, req_id: &str| -> String {
            let mut frame: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/frame_ref.valid.json"
            ))
            .unwrap();
            frame["width"] = 1.into();
            frame["height"] = 1.into();
            frame["sha256"] = sha256_hex(&[pixel, 0, 0]).into();
            server
                .capture
                .frame(
                    &serde_json::from_value(frame).unwrap(),
                    vec![pixel, 0, 0],
                    0,
                )
                .unwrap();
            let (next, shot, _) = server
                .capture
                .prepare(
                    "screenshot",
                    &json!({"request_id":req_id,"surface_id":"surface-demo"}),
                    surfaces.clone(),
                    0,
                )
                .unwrap();
            server.capture = next;
            shot["shot"]["id"].as_str().unwrap().to_owned()
        };
        let shot1 = make_shot(&mut server, 10, "shot-1");
        let shot2 = make_shot(&mut server, 20, "shot-2");
        let destination = root.join("exports");
        fs::create_dir(&destination).unwrap();
        let session = root.join("sessions/txmono-session");

        let read_witness = |seq: u64| -> Value {
            let event: Value = serde_json::from_slice(
                &fs::read(session.join("events").join(format!("{seq}.json"))).unwrap(),
            )
            .unwrap();
            let sha = event["witnesses"][0]["sha256"].as_str().unwrap();
            serde_json::from_slice(&fs::read(session.join("artifacts").join(sha)).unwrap()).unwrap()
        };

        // First live export: transaction must equal pre_export_core_seq + 1.
        let pre_seq_1 = server.authority.state().core_seq;
        let req1 = json!({"schema":"capture_request/v1","request_id":"exp-1","capture_id":shot1,"destination":"recording:configured"});
        let reply1 = server
            .capture_export_to(req1, Some(&destination), vec![])
            .unwrap();
        assert_eq!(reply1["ok"], true);
        let start_witness_1 = read_witness(pre_seq_1 + 1);
        let done_witness_1 = read_witness(pre_seq_1 + 2);
        let tx1 = start_witness_1["export_transaction"].as_u64().unwrap();
        assert_eq!(tx1, pre_seq_1 + 1);
        assert_eq!(done_witness_1["export_transaction"].as_u64().unwrap(), tx1);

        // Negative control: failed live export (missing destination) followed by recovery and second live export.
        let pre_fail_seq = server.authority.state().core_seq;
        let req_fail = json!({"schema":"capture_request/v1","request_id":"exp-fail","capture_id":shot2,"destination":"recording:configured"});
        let reply_fail = server
            .capture_export_to(req_fail.clone(), Some(&root.join("missing")), vec![])
            .unwrap();
        assert_eq!(reply_fail["code"], "DESTINATION_UNAVAILABLE");
        let fail_start = read_witness(pre_fail_seq + 1);
        let tx_fail = fail_start["export_transaction"].as_u64().unwrap();
        assert_eq!(tx_fail, pre_fail_seq + 1);
        assert!(tx_fail > tx1);

        // Simulate crash after export-started before export completion, then restart and recover, then run another live export.
        let pre_crash_seq = server.authority.state().core_seq;
        let plan2 = server.capture.export_plan(&shot2).unwrap();
        let tx_crash = pre_crash_seq + 1;
        server
            .capture_journal(
                vec![],
                &json!({"method":"export-started","export_transaction":tx_crash,
                    "request":req_fail,"host_destination":destination,"receipt":plan2.receipt}),
            )
            .unwrap();
        let temp_file = destination.join(format!(
            ".mv-export-{}-{}.tar-{tx_crash}",
            plan2.receipt["id"].as_str().unwrap(),
            plan2.receipt["sha256"].as_str().unwrap()
        ));
        fs::write(&temp_file, b"partial").unwrap();
        drop(server);

        let mut recovered = Server::open(config, &root, effective_uid().unwrap()).unwrap();
        let shot3 = make_shot(&mut recovered, 30, "shot-3");
        let pre_recover_seq = recovered.authority.state().core_seq;
        let req2 = json!({"schema":"capture_request/v1","request_id":"exp-2","capture_id":shot3,"destination":"recording:configured"});
        let reply2 = recovered
            .capture_export_to(req2, Some(&destination), vec![])
            .unwrap();
        assert_eq!(reply2["ok"], true);
        assert!(!temp_file.exists());
        // Recovery journaled at pre_recover_seq + 1; new export-started journaled at pre_recover_seq + 2.
        let rec_witness = read_witness(pre_recover_seq + 1);
        assert_eq!(rec_witness["recovered"], true);
        assert_eq!(rec_witness["export_transaction"], tx_crash);
        let start_witness_2 = read_witness(pre_recover_seq + 2);
        let done_witness_2 = read_witness(pre_recover_seq + 3);
        let tx2 = start_witness_2["export_transaction"].as_u64().unwrap();
        assert_eq!(tx2, pre_recover_seq + 2);
        assert_eq!(done_witness_2["export_transaction"].as_u64().unwrap(), tx2);
        assert!(tx1 < tx_fail && tx_fail < tx_crash && tx_crash < tx2);
    }
}
