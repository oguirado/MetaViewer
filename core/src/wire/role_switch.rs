//! Additive host-only role transfer. Frozen surface and envelope contracts stay unchanged.
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
                let schema = super::schemas::schema(concat!($schema, ".schema.json"))
                    .ok_or_else(|| serde::de::Error::custom("missing role switch schema"))?;
                if !super::valid(&value, &schema, &schema) {
                    return Err(serde::de::Error::custom("invalid role switch"));
                }
                Ok(Self(value))
            }
        }
    };
}
message!(RoleSwitchRequest, "role_switch");
message!(RoleSwitchResult, "role_switch_result");
