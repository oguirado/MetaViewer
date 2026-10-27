//! Pure closed decoding and checked logical clocks.
//! [TARGET, unit decision] Until contract upper rails are published, all wire
//! integers use the interoperable JSON safe-integer range, +/- 9007199254740991.
//! Existing schema bounds remain authoritative when narrower.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::time::Duration;
pub mod payload;
mod schemas;
pub use payload::Command;

pub const MAX_FRAME_BYTES: usize = 1_048_576;
pub const MAX_ENVELOPE_BYTES: usize = MAX_FRAME_BYTES - 1;
pub const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(5);
pub const IDLE_DEADLINE: Duration = Duration::from_secs(30);
pub const MAX_SEND_QUEUE: usize = 256;

macro_rules! error_type {
    ($name:ident { $($v:ident),* $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum $name { $($v),* }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{self:?}") }
        }
        impl std::error::Error for $name {}
    };
}
pub(crate) use error_type;
error_type!(NumericError { Overflow });
error_type!(LimitError {
    MissingOrZero,
    Inconsistent
});
error_type!(DecodeError {
    Oversized,
    OutOfBounds,
    Malformed,
    DuplicateField,
    UnknownVersion,
    InvalidField,
    DepthExceeded,
    KeyLimitExceeded,
    StringLimitExceeded,
    ArrayLimitExceeded
});

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Clock(u64);
impl Clock {
    pub fn new(value: u64) -> Self {
        Self(value)
    }
    pub fn get(self) -> u64 {
        self.0
    }
    pub fn checked_next(self) -> Result<Self, NumericError> {
        self.0
            .checked_add(1)
            .map(Self)
            .ok_or(NumericError::Overflow)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Component {
    Core,
    Ui,
    Daemon,
    Agent,
    Vision,
    Wender,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    pub component: Component,
    pub instance: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub schema: String,
    pub msg_id: String,
    pub ts_ns: Clock,
    pub from: Endpoint,
    pub to: Endpoint,
    pub session_id: String,
    pub seq: u64,
    pub nonce: String,
    pub body: Command,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Refusal {
    StaleFrame,
    SurfaceNotAgentControlled,
    LockedByOther,
    BudgetExceeded,
    OutOfBounds,
    Policy,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::StaleFrame => "STALE_FRAME",
            Self::SurfaceNotAgentControlled => "SURFACE_NOT_AGENT_CONTROLLED",
            Self::LockedByOther => "LOCKED_BY_OTHER",
            Self::BudgetExceeded => "BUDGET_EXCEEDED",
            Self::OutOfBounds => "OUT_OF_BOUNDS",
            Self::Policy => "POLICY",
        }
    }
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
#[derive(Clone, Debug)]
pub struct WireLimits {
    max_frame_bytes: usize,
    max_depth: usize,
    max_keys: usize,
    max_string_bytes: usize,
    pub(crate) read_deadline: Duration,
    pub(crate) write_deadline: Duration,
}
impl Default for WireLimits {
    fn default() -> Self {
        Self {
            max_frame_bytes: MAX_FRAME_BYTES,
            max_depth: 32,
            max_keys: 256,
            max_string_bytes: 65536,
            read_deadline: IDLE_DEADLINE,
            write_deadline: IDLE_DEADLINE,
        }
    }
}
impl WireLimits {
    pub fn new(
        max_frame_bytes: usize,
        max_depth: usize,
        max_keys: usize,
        max_string_bytes: usize,
        read_deadline: Duration,
        write_deadline: Duration,
    ) -> Result<Self, LimitError> {
        if [max_frame_bytes, max_depth, max_keys, max_string_bytes].contains(&0)
            || read_deadline.is_zero()
            || write_deadline.is_zero()
        {
            return Err(LimitError::MissingOrZero);
        }
        if !(2..=MAX_FRAME_BYTES).contains(&max_frame_bytes)
            || max_depth > 32
            || max_keys > 256
            || max_string_bytes > 65536
        {
            return Err(LimitError::Inconsistent);
        }
        Ok(Self {
            max_frame_bytes,
            max_depth,
            max_keys,
            max_string_bytes,
            read_deadline,
            write_deadline,
        })
    }
    pub fn max_frame_bytes(&self) -> usize {
        self.max_frame_bytes
    }
}

// This lexical pass rejects duplicate keys and container limits before serde can
// buffer an untagged union. Strings are decoded individually to count UTF-8 bytes.
fn preflight(raw: &str, limits: &WireLimits) -> Result<(), DecodeError> {
    let bytes = raw.as_bytes();
    let mut stack: Vec<(u8, BTreeSet<String>, usize)> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' | b'[' => {
                if stack.len() >= limits.max_depth {
                    return Err(DecodeError::DepthExceeded);
                }
                stack.push((bytes[i], BTreeSet::new(), 0));
                i += 1;
            }
            b'}' | b']' => {
                stack.pop();
                i += 1;
            }
            b'"' => {
                let start = i;
                i += 1;
                while i < bytes.len() {
                    match bytes[i] {
                        b'\\' => {
                            i = i.checked_add(2).ok_or(DecodeError::Malformed)?;
                        }
                        b'"' => break,
                        _ => i += 1,
                    }
                }
                if i >= bytes.len() {
                    return Err(DecodeError::Malformed);
                }
                i += 1;
                let value: String =
                    serde_json::from_str(&raw[start..i]).map_err(|_| DecodeError::Malformed)?;
                if value.len() > limits.max_string_bytes {
                    return Err(DecodeError::StringLimitExceeded);
                }
                let mut next = i;
                while next < bytes.len() && bytes[next].is_ascii_whitespace() {
                    next += 1;
                }
                if bytes.get(next) == Some(&b':') {
                    let Some((b'{', keys, _)) = stack.last_mut() else {
                        return Err(DecodeError::Malformed);
                    };
                    if !keys.insert(value) {
                        return Err(DecodeError::DuplicateField);
                    }
                    if keys.len() > limits.max_keys {
                        return Err(DecodeError::KeyLimitExceeded);
                    }
                }
            }
            b',' => {
                if let Some((b'[', _, count)) = stack.last_mut() {
                    *count += 1;
                    if *count >= 4096 {
                        return Err(DecodeError::ArrayLimitExceeded);
                    }
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    Ok(())
}

pub fn decode_envelope(raw: &str) -> Result<Envelope, DecodeError> {
    decode_envelope_with_limits(raw, &WireLimits::default())
}
pub fn decode_envelope_with_limits(
    raw: &str,
    limits: &WireLimits,
) -> Result<Envelope, DecodeError> {
    if raw
        .len()
        .checked_add(1)
        .is_none_or(|n| n > limits.max_frame_bytes)
    {
        return Err(DecodeError::Oversized);
    }
    preflight(raw, limits)?;
    let value: Value = serde_json::from_str(raw).map_err(|_| DecodeError::Malformed)?;
    check_integer_rails(&value)?;
    // Diagnose version refusal before the closed typed enum rejects it as shape.
    if value["schema"]
        .as_str()
        .is_some_and(|v| v != "envelope/v0.2")
        || is_unknown_body_version(value["body"]["schema"].as_str())
        || value["body"]["schema"] == "hello/v0.2"
            && value["body"]["contract_version"]
                .as_str()
                .is_some_and(|v| v != "v0.2")
    {
        return Err(DecodeError::UnknownVersion);
    }
    let envelope: Envelope = serde_json::from_str(raw).map_err(|_| DecodeError::Malformed)?;
    if envelope.schema != "envelope/v0.2" {
        return Err(DecodeError::UnknownVersion);
    }
    let value = serde_json::to_value(&envelope).map_err(|_| DecodeError::InvalidField)?;
    let schema = schemas::schema("envelope.schema.json").ok_or(DecodeError::InvalidField)?;
    if !valid(&value, &schema, &schema) || !terminal_lengths(&value) {
        return Err(DecodeError::InvalidField);
    }
    Ok(envelope)
}

pub const MAX_WIRE_INTEGER: u64 = 9_007_199_254_740_991;
fn is_unknown_body_version(schema: Option<&str>) -> bool {
    let Some((family, version)) = schema.and_then(|s| s.split_once('/')) else {
        return false;
    };
    !version.is_empty()
        && version != "v0.2"
        && family != "envelope"
        && schemas::schema(&format!("{family}.schema.json")).is_some()
}
fn check_integer_rails(value: &Value) -> Result<(), DecodeError> {
    match value {
        Value::Number(n) => {
            if n.as_u64().is_some_and(|v| v > MAX_WIRE_INTEGER)
                || n.as_i64().is_some_and(|v| v < -(MAX_WIRE_INTEGER as i64))
                || n.is_f64()
                    && n.as_f64()
                        .is_some_and(|v| v.abs() > MAX_WIRE_INTEGER as f64)
            {
                return Err(DecodeError::OutOfBounds);
            }
        }
        Value::Array(a) => {
            for v in a {
                check_integer_rails(v)?;
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                check_integer_rails(v)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn terminal_lengths(v: &Value) -> bool {
    let body = &v["body"];
    if body["schema"] != "terminal_session/v0.2"
        || !matches!(body["op"].as_str(), Some("data" | "write"))
    {
        return true;
    }
    let Some(s) = body["params"]["b64"].as_str() else {
        return false;
    };
    let n = s.len() / 4 * 3 - s.bytes().rev().take_while(|b| *b == b'=').count();
    body["params"]["byte_count"].as_u64() == u64::try_from(n).ok()
}

fn pattern_ok(s: &str, pattern: &str) -> bool {
    if pattern == "^[A-Za-z0-9][A-Za-z0-9._:-]*$" {
        return s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b));
    }
    if pattern == "^[0-9a-f]{40}$" || pattern == "^[0-9a-f]{64}$" {
        let len = if pattern.contains("40") { 40 } else { 64 };
        return s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    }
    if pattern.starts_with("^(?:[A-Za-z0-9+/") {
        if !s.len().is_multiple_of(4) {
            return false;
        }
        let data = s.trim_end_matches('=');
        return s.len() - data.len() <= 2
            && data
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/".contains(&b));
    }
    if pattern.starts_with("^/") {
        let prefix = if pattern.starts_with("^/dev/shm/") {
            "/dev/shm/"
        } else {
            "/"
        };
        let tail = s.strip_prefix(prefix);
        let forbidden = "\0\r\n";
        return tail.is_some_and(|t| {
            (!pattern.ends_with("+$") || !t.is_empty()) && !t.chars().any(|c| forbidden.contains(c))
        });
    }
    false
}
pub fn valid(v: &Value, s: &Value, root: &Value) -> bool {
    if let Some(reference) = s["$ref"].as_str() {
        let (file, fragment) = reference.split_once('#').unwrap_or((reference, ""));
        let external;
        let base = if file.is_empty() {
            root
        } else {
            external = match schemas::schema(file) {
                Some(x) => x,
                None => return false,
            };
            &external
        };
        let target = if fragment.is_empty() {
            base
        } else {
            match base.pointer(fragment) {
                Some(x) => x,
                None => return false,
            }
        };
        if !valid(v, target, base) {
            return false;
        }
    }
    if let Some(c) = s.get("const") {
        if v != c {
            return false;
        }
    }
    if let Some(e) = s["enum"].as_array() {
        if !e.contains(v) {
            return false;
        }
    }
    if let Some(branches) = s["oneOf"].as_array() {
        if branches.iter().filter(|b| valid(v, b, root)).count() != 1 {
            return false;
        }
    }
    match s["type"].as_str() {
        Some("object") => {
            let Some(obj) = v.as_object() else {
                return false;
            };
            let Some(props) = s["properties"].as_object() else {
                return false;
            };
            if s["required"].as_array().is_some_and(|r| {
                r.iter()
                    .any(|k| !obj.contains_key(k.as_str().unwrap_or("")))
            }) {
                return false;
            }
            if s["maxProperties"]
                .as_u64()
                .is_some_and(|m| obj.len() as u64 > m)
            {
                return false;
            }
            obj.iter().all(|(k, value)| {
                props
                    .get(k)
                    .is_some_and(|schema| valid(value, schema, root))
            })
        }
        Some("array") => {
            let Some(a) = v.as_array() else {
                return false;
            };
            !s["minItems"].as_u64().is_some_and(|n| (a.len() as u64) < n)
                && !s["maxItems"].as_u64().is_some_and(|n| a.len() as u64 > n)
                && a.iter().all(|v| valid(v, &s["items"], root))
        }
        Some("string") => {
            let Some(text) = v.as_str() else {
                return false;
            };
            let count = text.chars().count() as u64;
            !s["minLength"].as_u64().is_some_and(|n| count < n)
                && !s["maxLength"].as_u64().is_some_and(|n| count > n)
                && s["pattern"].as_str().is_none_or(|p| pattern_ok(text, p))
        }
        Some("integer" | "number") => {
            if !v.is_number()
                || (s["type"] == "integer" && v.as_u64().is_none() && v.as_i64().is_none())
            {
                return false;
            }
            // Schema bounds are exact safe integers; compare integer rails before
            // floating point so large wire integers never round across a bound.
            for (key, minimum) in [("minimum", true), ("maximum", false)] {
                if let Some(bound) = s.get(key).and_then(Value::as_i64) {
                    let order = if let Some(n) = v.as_i64() {
                        Some(n.cmp(&bound))
                    } else if let Some(n) = v.as_u64() {
                        Some(i128::from(n).cmp(&i128::from(bound)))
                    } else {
                        v.as_f64().and_then(|n| n.partial_cmp(&(bound as f64)))
                    };
                    if order.is_none_or(|o| if minimum { o.is_lt() } else { o.is_gt() }) {
                        return false;
                    }
                }
            }
            true
        }
        Some("boolean") => v.is_boolean(),
        Some("null") => v.is_null(),
        None => true,
        _ => false,
    }
}

/// Presence differs from JSON null; an optional non-nullable field must still
/// reject an explicitly supplied null.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Optional<T> {
    Missing,
    Present(T),
}

impl<T> Optional<T> {
    pub fn missing() -> Self {
        Self::Missing
    }
    pub fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Optional<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        T::deserialize(d).map(Self::Present)
    }
}
impl<T: Serialize> Serialize for Optional<T> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Present(value) => value.serialize(s),
            Self::Missing => s.serialize_none(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{schemas, valid};
    use serde_json::json;

    #[test]
    fn ref_evaluates_target_and_sibling_keywords() {
        let schema = json!({
            "$defs": {
                "token": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
                    "minLength": 1,
                    "maxLength": 128
                }
            },
            "type": "object",
            "additionalProperties": false,
            "required": ["tag"],
            "maxProperties": 256,
            "properties": {
                "tag": {
                    "$ref": "#/$defs/token",
                    "const": "pinned-token"
                }
            }
        });
        assert!(valid(&json!({"tag": "pinned-token"}), &schema, &schema));
        assert!(!valid(&json!({"tag": "other-token"}), &schema, &schema));

        let bad_const_schema = json!({
            "$defs": schema["$defs"],
            "type": "object",
            "additionalProperties": false,
            "required": ["tag"],
            "maxProperties": 256,
            "properties": {
                "tag": {
                    "$ref": "#/$defs/token",
                    "const": "!invalid!"
                }
            }
        });
        assert!(!valid(
            &json!({"tag": "!invalid!"}),
            &bad_const_schema,
            &bad_const_schema
        ));

        let frame_gen1: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        let mut frame_gen2 = frame_gen1.clone();
        frame_gen2["generation"] = json!(2);
        let mut frame_bad_sha = frame_gen1.clone();
        frame_bad_sha["sha256"] = json!("not-a-valid-sha256");

        let external_ref_schema = json!({
            "$ref": "frame_ref.schema.json",
            "const": frame_gen1
        });
        assert!(schemas::schema("frame_ref.schema.json").is_some());
        assert!(valid(
            &frame_gen1,
            &external_ref_schema,
            &external_ref_schema
        ));
        assert!(!valid(
            &frame_gen2,
            &external_ref_schema,
            &external_ref_schema
        ));

        let external_bad_const_schema = json!({
            "$ref": "frame_ref.schema.json",
            "const": frame_bad_sha
        });
        assert!(!valid(
            &frame_bad_sha,
            &external_bad_const_schema,
            &external_bad_const_schema
        ));
    }
}
