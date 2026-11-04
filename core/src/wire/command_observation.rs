//! Read-only core-to-creator-UI metadata; never an executable command.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct GuestCommandObservation(pub Value);

impl<'de> Deserialize<'de> for GuestCommandObservation {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(d)?;
        let schema = super::schemas::schema("guest_command_observation.schema.json")
            .ok_or_else(|| serde::de::Error::custom("missing command observation schema"))?;
        if !super::valid(&value, &schema, &schema) {
            return Err(serde::de::Error::custom("invalid command observation"));
        }
        Ok(Self(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{decode_envelope, wire::Command};
    use serde_json::json;

    fn envelope() -> Value {
        serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/guest_command_observation_envelope.valid.json"
        ))
        .unwrap()
    }

    #[test]
    fn observation_wire_is_closed_directional_and_separate() {
        let value = envelope();
        let decoded = decode_envelope(&value.to_string()).unwrap();
        assert!(matches!(decoded.body, Command::GuestCommandObservation(_)));
        for tag in [
            "envelope/v0.2",
            "capsule_envelope/v0.2",
            "rewind_envelope/v0.2",
        ] {
            let mut bad = value.clone();
            bad["schema"] = json!(tag);
            assert!(decode_envelope(&bad.to_string()).is_err());
        }
        let mut wrong_body = value.clone();
        wrong_body["body"] = serde_json::from_str::<Value>(include_str!(
            "../../../contracts/examples/v0.2/hello.valid.json"
        ))
        .unwrap();
        assert!(decode_envelope(&wrong_body.to_string()).is_err());
        for (key, component) in [("from", "agent"), ("from", "daemon"), ("to", "agent")] {
            let mut bad = value.clone();
            bad[key]["component"] = json!(component);
            assert!(decode_envelope(&bad.to_string()).is_err());
        }
        for key in ["stdin_b64", "authority_epoch", "native_handle"] {
            let mut bad = value.clone();
            bad["body"][key] = json!("forbidden");
            assert!(decode_envelope(&bad.to_string()).is_err());
        }
        let mut bad = value;
        bad["body"]["generation"] = json!(true);
        assert!(decode_envelope(&bad.to_string()).is_err());
    }
}
