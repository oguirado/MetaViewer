//! Closed graphical QEMU session messages, independent of MicroVM rewind.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

macro_rules! message {
    ($name:ident, $schema:literal, $tag:literal) => {
        #[derive(Clone, Debug, PartialEq, Eq, Serialize)]
        #[serde(transparent)]
        pub struct $name(pub Value);
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let value = Value::deserialize(d)?;
                if value.get("schema").and_then(Value::as_str) != Some($tag) {
                    return Err(serde::de::Error::custom("wrong graphical session schema tag"));
                }
                let schema = super::schemas::schema(concat!($schema, ".schema.json"))
                    .ok_or_else(|| serde::de::Error::custom("missing graphical session schema"))?;
                if !super::valid(&value, &schema, &schema) {
                    return Err(serde::de::Error::custom("invalid graphical session contract"));
                }
                Ok(Self(value))
            }
        }
    };
}
message!(GraphicalSessionRequest, "graphical_session_request", "graphical_session_request/v0.2");
message!(GraphicalSessionEvent, "graphical_session_event", "graphical_session_event/v0.2");
message!(GraphicalSession, "graphical_session", "graphical_session/v0.2");
