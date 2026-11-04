//! Additive closed REWIND family. Existing envelope schemas remain immutable.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
macro_rules! message {
    ($name:ident,$schema:literal) => {
        #[derive(Clone, Debug, PartialEq, Eq, Serialize)]
        #[serde(transparent)]
        pub struct $name(pub Value);
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let value = Value::deserialize(d)?;
                let schema: Value = serde_json::from_str(include_str!(concat!(
                    "../../../contracts/v0.2/",
                    $schema,
                    ".schema.json"
                )))
                .map_err(serde::de::Error::custom)?;
                if !super::valid(&value, &schema, &schema) {
                    return Err(serde::de::Error::custom("invalid rewind contract"));
                }
                Ok(Self(value))
            }
        }
    };
}
message!(RewindRequest, "rewind_request");
message!(RewindEvent, "rewind_event");
message!(RewindSession, "rewind_session");
message!(RewindPoint, "rewind_point");
/// Private reset metadata, never a public envelope body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct RewindGuestReset(pub Value);
impl<'de> Deserialize<'de> for RewindGuestReset {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(d)?;
        let mut schema: Value = serde_json::from_str(include_str!(
            "../../../contracts/v0.2/rewind_guest_reset.schema.json"
        ))
        .map_err(serde::de::Error::custom)?;
        // The public scalar validator deliberately has no general regex engine.
        // Discharge this exact private lookahead with an equivalent byte predicate,
        // then use the unchanged canonical structure/other constraints.
        let rule = schema.pointer_mut("/oneOf/0/properties/entropy").unwrap();
        if rule["pattern"] != "^(?=[0-9a-f]{128}$)[0-9a-f]*[1-9a-f][0-9a-f]*$" {
            return Err(serde::de::Error::custom("unknown reset entropy rule"));
        }
        rule.as_object_mut().unwrap().remove("pattern");
        let entropy_ok = value["op"] != "reseed"
            || value["entropy"].as_str().is_some_and(|s| {
                s.len() == 128
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    && s.bytes().any(|b| b != b'0')
            });
        if !entropy_ok || !super::valid(&value, &schema, &schema) {
            return Err(serde::de::Error::custom("invalid rewind reset metadata"));
        }
        Ok(Self(value))
    }
}
