use super::{CatalogEntry, CatalogError, Kind, Network};
use crate::wire::DecodeError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub memory_bytes: u64,
    pub cpu_milli: u32,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogEntryWire {
    pub schema: String,
    pub entry_id: String,
    pub kind: Kind,
    pub profile_id: String,
    pub label: String,
    pub image: String,
    pub window_width_px: u32,
    pub window_height_px: u32,
    pub display_width_px: u32,
    pub display_height_px: u32,
    pub display_only: bool,
    pub network: Network,
    pub seccomp_identity: bool,
    pub nested_depth: u32,
    pub limits: Limits,
}

/// Input excludes the framing LF; its byte budget still reserves that byte.
pub fn decode_entry(raw: &str) -> Result<CatalogEntry, CatalogError> {
    preflight(raw).map_err(CatalogError::Wire)?;
    let row: CatalogEntryWire =
        serde_json::from_str(raw).map_err(|_| CatalogError::Wire(DecodeError::Malformed))?;
    CatalogEntry::try_from(row)
}

// Bound containers and decoded strings before typed allocation. Serde performs
// the complete syntax/shape check afterward, including unknown/duplicate fields.
fn preflight(raw: &str) -> Result<(), DecodeError> {
    if raw.len() > crate::wire::MAX_ENVELOPE_BYTES {
        return Err(DecodeError::Oversized);
    }
    let bytes = raw.as_bytes();
    let mut stack: Vec<(u8, BTreeSet<String>, usize)> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' | b'[' => {
                if stack.len() >= 32 {
                    return Err(DecodeError::DepthExceeded);
                }
                stack.push((bytes[i], BTreeSet::new(), 0));
                i = i.checked_add(1).ok_or(DecodeError::Malformed)?;
            }
            b'}' | b']' => {
                stack.pop();
                i = i.checked_add(1).ok_or(DecodeError::Malformed)?;
            }
            b'"' => {
                let start = i;
                i = i.checked_add(1).ok_or(DecodeError::Malformed)?;
                while i < bytes.len() {
                    match bytes[i] {
                        b'\\' => i = i.checked_add(2).ok_or(DecodeError::Malformed)?,
                        b'"' => break,
                        _ => i = i.checked_add(1).ok_or(DecodeError::Malformed)?,
                    }
                }
                if i >= bytes.len() {
                    return Err(DecodeError::Malformed);
                }
                i = i.checked_add(1).ok_or(DecodeError::Malformed)?;
                let value: String =
                    serde_json::from_str(&raw[start..i]).map_err(|_| DecodeError::Malformed)?;
                if value.len() > 65536 {
                    return Err(DecodeError::StringLimitExceeded);
                }
                let mut next = i;
                while next < bytes.len() && bytes[next].is_ascii_whitespace() {
                    next = next.checked_add(1).ok_or(DecodeError::Malformed)?;
                }
                if bytes.get(next) == Some(&b':') {
                    let Some((b'{', keys, _)) = stack.last_mut() else {
                        return Err(DecodeError::Malformed);
                    };
                    if !keys.insert(value) {
                        return Err(DecodeError::DuplicateField);
                    }
                    if keys.len() > 256 {
                        return Err(DecodeError::KeyLimitExceeded);
                    }
                }
            }
            b',' => {
                if let Some((b'[', _, count)) = stack.last_mut() {
                    *count = count
                        .checked_add(1)
                        .ok_or(DecodeError::ArrayLimitExceeded)?;
                    if *count >= 4096 {
                        return Err(DecodeError::ArrayLimitExceeded);
                    }
                }
                i = i.checked_add(1).ok_or(DecodeError::Malformed)?;
            }
            _ => i = i.checked_add(1).ok_or(DecodeError::Malformed)?,
        }
    }
    Ok(())
}
