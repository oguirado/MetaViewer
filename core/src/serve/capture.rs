//! [TARGET, unit decision] Existing record_request/v0.2 is the UI wire seam.
//! Capture v1 is a host API; no new transport schema is silently admitted.
//! RAM captures expire on process restart; metadata witnesses remain replayable.
use super::*;
use crate::wire::payload::RecordRequest;
use serde_json::{json, Value};

impl Server {
    // [TARGET, unit decision] Frozen surface_event.error carries closed capture
    // metadata under CAPTURE_REPLY / CAPTURE_STATE; detail is bounded JSON.
    fn capture_metadata(&mut self, peer: &Endpoint, code: &str, value: Value) -> Result<()> {
        self.send(
            peer,
            Command::SurfaceEvent(Box::new(serde_json::from_value(json!({
                "schema":"surface_event/v0.2","event":"error",
                "data":{"surface_id":"capture","code":code,"detail":serde_json::to_string(&value)?}
            }))?)),
        )
    }
    pub(super) fn capture_list_wire(&mut self, env: &Envelope, boundary: Witness) -> Result<()> {
        let (reply, _) = self.capture_transition("list", Value::Null, vec![boundary])?;
        self.capture_metadata(
            &env.from,
            "CAPTURE_REPLY",
            json!({"request_id":env.msg_id,"method":"list","reply":reply}),
        )
    }
    fn capture_publish_states(&mut self, events: &[Value]) -> Result<()> {
        let (_, reply, _) = self
            .capture
            .prepare("list", &Value::Null, Default::default(), 0)
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
                self.capture_metadata(peer, "CAPTURE_STATE", state.clone())?;
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
    pub(super) fn capture_frame(&mut self, frame: &FrameRef, pixels: Vec<u8>) -> Result<()> {
        let mut next = self.capture.clone();
        // Oversized/unavailable frames do not disable normal authority rendering.
        let Ok(events) = next.frame(frame, pixels, self.origin.elapsed().as_millis() as u64) else {
            return Ok(());
        };
        if !events.is_empty() {
            self.capture_journal(vec![], &json!({"capture_frame":events}))?;
        }
        self.capture = next;
        self.capture_publish_states(&events)?;
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
        let keys = match method {
            "screenshot" => vec!["request_id", "schema", "surface_id"],
            "recordStart" => vec!["mode", "request_id", "schema", "surface_id"],
            "recordStop" => vec!["recording_id", "request_id", "schema"],
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
                || !request[if method == "recordStop" {
                    "recording_id"
                } else {
                    "surface_id"
                }]
                .as_str()
                .is_some_and(crate::record::valid_id)
                || (method == "recordStart" && request["mode"] != "ai")
            {
                return Err(invalid("capture shape"));
            }
        }
        self.capture_transition(method, request, vec![])
            .map(|(reply, _)| reply)
    }
    fn capture_transition(
        &mut self,
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
            .prepare(
                method,
                &request,
                surfaces,
                self.origin.elapsed().as_millis() as u64,
            )
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
        env: &Envelope,
        request: &RecordRequest,
        boundary: Witness,
    ) -> Result<()> {
        let raw = serde_json::to_value(request)?;
        let method = match raw["op"].as_str() {
            Some("ram_start") => "recordStart",
            Some("ram_stop") => "recordStop",
            Some("screenshot") => "screenshot",
            _ => return self.unsupported(env, boundary),
        };
        let mut req = json!({"schema":"capture_request/v1","request_id":raw["request_id"]});
        if method == "recordStop" {
            req["recording_id"] = raw["params"]["recording_id"].clone();
        } else {
            req["surface_id"] = raw["params"]["surface_id"].clone();
        }
        if method == "recordStart" {
            if raw["params"]["ring_bytes"] != 8 * 1024 * 1024 || raw["params"]["max_fps"] != 30 {
                return self.unsupported(env, boundary);
            }
            req["mode"] = "ai".into();
            req["_host_id"] = raw["params"]["recording_id"].clone();
        }
        if method == "screenshot" {
            req["_host_id"] = raw["params"]["capture_id"].clone();
        }
        let (reply, events) = self.capture_transition(method, req, vec![boundary])?;
        self.capture_metadata(
            &env.from,
            "CAPTURE_REPLY",
            json!({"request_id":raw["request_id"],"method":method,"reply":reply}),
        )?;
        self.capture_publish_states(&events)?;
        for entry in events {
            for event in entry["events"]
                .as_array()
                .ok_or_else(|| invalid("capture events"))?
            {
                let mut event = event.clone();
                event["request_id"] = raw["request_id"].clone();
                self.send(
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
    #[test]
    fn host_capture_is_journaled_replays_and_expires_ram_on_restart() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("mv-capture-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
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
            server.capture_wire(&env, &request, boundary).unwrap();
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
        server.capture_list_wire(&list, boundary).unwrap();
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
        fs::remove_dir_all(root).unwrap();
    }
}
