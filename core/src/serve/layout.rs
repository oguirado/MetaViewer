//! [TARGET, unit decision] A slot is the surface ID (or its kit DOM ID
//! cuk-ai-slot-<surface_id>). Placement belongs to that identity, including its
//! attached terminal; layout never creates, stops or rebinds a terminal session.
//! Existing v0.2 move/tab target a group and index, not another capsule ID.
//! Groups are declarative names because no group registry exists in the ABI.
//! Human/shared authority is WRITE; agent authority is READ for placement.
//! Accepted intents are published unchanged by core and replayed from committed
//! witnesses. Hidden slots must be shown before placement or folding changes.
use super::*;
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Placement {
    pub hidden: bool,
    pub position: Option<Value>,
}

impl tools::ToolState {
    pub(super) fn slot_surface<'a>(&self, slot: &'a str) -> &'a str {
        // Exact identities win: a real ID may itself start with the DOM prefix.
        if self.has_surface(slot) {
            slot
        } else {
            slot.strip_prefix("cuk-ai-slot-").unwrap_or(slot)
        }
    }

    pub(super) fn placement_change(
        &self,
        sid: &str,
        value: &Value,
    ) -> std::result::Result<Placement, &'static str> {
        let mut next = self.placements.get(sid).cloned().unwrap_or_default();
        match value["op"].as_str() {
            Some("hide") if !next.hidden => next.hidden = true,
            Some("show") if next.hidden => next.hidden = false,
            Some("move" | "tab" | "float") if !next.hidden => {
                next.position = Some(value.clone());
            }
            Some("fold" | "unfold") if !next.hidden => {}
            _ => return Err("LAYOUT_ILLEGAL_TRANSITION"),
        }
        Ok(next)
    }
}

impl Server {
    pub(super) fn layout_refusal(
        &mut self,
        env: &Envelope,
        boundary: Witness,
        code: &str,
    ) -> Result<()> {
        self.unsupported(env, boundary)?;
        let value = serde_json::to_value(&env.body)?;
        let event = serde_json::from_value(serde_json::json!({
            "schema":"surface_event/v0.2", "event":"error", "data":{
                "surface_id":value["params"]["slot_id"], "code":code,
                "detail":value["request_id"]
            }
        }))?;
        self.send(&env.from, Command::SurfaceEvent(Box::new(event)))
    }
}
