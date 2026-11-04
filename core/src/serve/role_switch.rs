use super::*;
use crate::wire::role_switch::{RoleSwitchRequest, RoleSwitchResult};

impl Server {
    pub(super) fn role_switch_request(
        &mut self,
        now: u64,
        env: &Envelope,
        request: &RoleSwitchRequest,
        boundary: Witness,
    ) -> Result<()> {
        let value = &request.0;
        let sid = value["surface_id"]
            .as_str()
            .ok_or_else(|| invalid("surface required"))?;
        let request_id = value["request_id"]
            .as_str()
            .ok_or_else(|| invalid("request required"))?;
        let human = value["role"] == "human";
        if request_id != env.msg_id {
            return self.role_switch_refusal(
                now,
                env,
                request,
                "CAPSULE_MODE_REQUEST_INVALID",
                boundary,
            );
        }
        let available = self.tool_state.surfaces.get(sid).is_some_and(|s| {
            matches!(s["kind"].as_str(), Some("browser" | "desktop_capsule"))
                && s["state"] == "active"
        }) && !self.human_inputs.values().any(|h| h.surface_id == sid);
        let daemon = self
            .config
            .peers
            .iter()
            .find(|p| p.endpoint.component == Component::Daemon)
            .map(|p| p.endpoint.clone())
            .ok_or_else(|| invalid("no daemon"))?;
        if !available || !self.connections.contains_key(&daemon) {
            return self.role_switch_refusal(
                now,
                env,
                request,
                "CAPSULE_MODE_UNAVAILABLE",
                boundary,
            );
        }
        let out = self.authority.apply_with_witnesses(
            Input::BeginRoleSwitch {
                sender: env.from.clone(),
                request_id: request_id.into(),
                surface_id: sid.into(),
                human,
            },
            vec![boundary],
        )?;
        if out.reason.is_some() {
            let result = serde_json::from_value(
                serde_json::json!({"schema":"metaviewer.role_switch_result/v0.3","request_id":request_id,"surface_id":sid,"role":value["role"],"ok":false,"code":"CAPSULE_MODE_BUSY"}),
            )?;
            return self.send_at(now, &env.from, Command::RoleSwitchResult(Box::new(result)));
        }
        self.tool_state.clear_surface_ground_truth(sid);
        // A failed send leaves the durable no-input fence intact.
        self.send_at(
            now,
            &daemon,
            Command::RoleSwitchRequest(Box::new(request.clone())),
        )
    }

    fn role_switch_refusal(
        &mut self,
        now: u64,
        env: &Envelope,
        request: &RoleSwitchRequest,
        code: &str,
        boundary: Witness,
    ) -> Result<()> {
        self.authority.apply_with_witnesses(
            Input::Refuse {
                reason: Refusal::Policy,
            },
            vec![boundary],
        )?;
        let value = &request.0;
        let result = serde_json::from_value(
            serde_json::json!({"schema":"metaviewer.role_switch_result/v0.3","request_id":value["request_id"],"surface_id":value["surface_id"],"role":value["role"],"ok":false,"code":code}),
        )?;
        self.send_at(now, &env.from, Command::RoleSwitchResult(Box::new(result)))
    }

    pub(super) fn role_switch_result(
        &mut self,
        now: u64,
        env: &Envelope,
        result: &RoleSwitchResult,
        boundary: Witness,
    ) -> Result<()> {
        let value = &result.0;
        let sid = value["surface_id"]
            .as_str()
            .ok_or_else(|| invalid("surface required"))?;
        let request_id = value["request_id"]
            .as_str()
            .ok_or_else(|| invalid("request required"))?;
        let Some(pending) = self.authority.state().role_switches.get(sid).cloned() else {
            return self.unsupported_at(now, env, boundary);
        };
        if pending.request_id != request_id || pending.human != (value["role"] == "human") {
            return self.unsupported_at(now, env, boundary);
        }
        let success = value["ok"] == true;
        if success {
            let expected = if pending.human { "human" } else { "agent" };
            let Some(surface) = self.role_switch_surfaces.get(sid) else {
                return self.unsupported_at(now, env, boundary);
            };
            let changed = serde_json::to_value(surface)?;
            let Some(mut original) = self.tool_state.surfaces.get(sid).cloned() else {
                return self.unsupported_at(now, env, boundary);
            };
            original["control"] = expected.into();
            if original != changed {
                return self.unsupported_at(now, env, boundary);
            }
        }
        let out = self.authority.apply_with_witnesses(
            Input::FinishRoleSwitch {
                request_id: request_id.into(),
                surface_id: sid.into(),
                success,
            },
            vec![boundary],
        )?;
        if out.reason.is_some() {
            return Ok(());
        }
        if let Some(surface) = self.role_switch_surfaces.remove(sid) {
            if success {
                let event = serde_json::from_value(
                    serde_json::json!({"schema":"surface_event/v0.2","event":"state_changed","data":{"surface":surface}}),
                )?;
                self.tool_state
                    .retain(&Command::SurfaceEvent(Box::new(event)));
            }
        }
        // Update host authority before resolving its correlated success reply.
        if let Some(event) = self.tool_state.surface_event(sid, self.authority.state()) {
            self.fanout_at(now, event);
        }
        self.send_at(
            now,
            &pending.sender,
            Command::RoleSwitchResult(Box::new(result.clone())),
        )
    }
}
