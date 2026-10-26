//! Embedded contract references for scalar and union validation.
pub(super) fn schema(name: &str) -> Option<serde_json::Value> {
    let raw = match name {
        "action_proposal.schema.json" => {
            include_str!("../../../contracts/v0.2/action_proposal.schema.json")
        }
        "action_receipt.schema.json" => {
            include_str!("../../../contracts/v0.2/action_receipt.schema.json")
        }
        "action_verdict.schema.json" => {
            include_str!("../../../contracts/v0.2/action_verdict.schema.json")
        }
        "capsule_meta.schema.json" => {
            include_str!("../../../contracts/v0.2/capsule_meta.schema.json")
        }
        "catalog_entry.schema.json" => {
            include_str!("../../../contracts/v0.2/catalog_entry.schema.json")
        }
        "envelope.schema.json" => include_str!("../../../contracts/v0.2/envelope.schema.json"),
        "frame_ref.schema.json" => include_str!("../../../contracts/v0.2/frame_ref.schema.json"),
        "hello.schema.json" => include_str!("../../../contracts/v0.2/hello.schema.json"),
        "mv_tool_call.schema.json" => {
            include_str!("../../../contracts/v0.2/mv_tool_call.schema.json")
        }
        "mv_tool_result.schema.json" => {
            include_str!("../../../contracts/v0.2/mv_tool_result.schema.json")
        }
        "observation.schema.json" => {
            include_str!("../../../contracts/v0.2/observation.schema.json")
        }
        "record_event.schema.json" => {
            include_str!("../../../contracts/v0.2/record_event.schema.json")
        }
        "record_request.schema.json" => {
            include_str!("../../../contracts/v0.2/record_request.schema.json")
        }
        "session_record.schema.json" => {
            include_str!("../../../contracts/v0.2/session_record.schema.json")
        }
        "settings.schema.json" => include_str!("../../../contracts/v0.2/settings.schema.json"),
        "surface.schema.json" => include_str!("../../../contracts/v0.2/surface.schema.json"),
        "surface_event.schema.json" => {
            include_str!("../../../contracts/v0.2/surface_event.schema.json")
        }
        "surface_request.schema.json" => {
            include_str!("../../../contracts/v0.2/surface_request.schema.json")
        }
        "terminal_session.schema.json" => {
            include_str!("../../../contracts/v0.2/terminal_session.schema.json")
        }
        "ui_intent.schema.json" => include_str!("../../../contracts/v0.2/ui_intent.schema.json"),
        _ => return None,
    };
    serde_json::from_str(raw).ok()
}
