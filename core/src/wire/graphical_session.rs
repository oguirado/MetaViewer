//! Closed graphical QEMU session messages, independent of MicroVM rewind.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

macro_rules! message {
    ($name:ident, $schema:literal) => {
        #[derive(Clone, Debug, PartialEq, Eq, Serialize)]
        #[serde(transparent)]
        pub struct $name(pub Value);
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let value = Value::deserialize(d)?;
                let schema: Value = serde_json::from_str(include_str!(concat!(
                    "../../../contracts/v0.2/", $schema, ".schema.json"
                )))
                .map_err(serde::de::Error::custom)?;
                if !super::valid(&value, &schema, &schema) {
                    return Err(serde::de::Error::custom("invalid graphical session contract"));
                }
                Ok(Self(value))
            }
        }
    };
}
message!(GraphicalSessionRequest, "graphical_session_request");
message!(GraphicalSessionEvent, "graphical_session_event");
message!(GraphicalSession, "graphical_session");
