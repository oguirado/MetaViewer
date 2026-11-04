//! Pure MVGC v1 framing and closed metadata validation; no socket or guest effects.
use crate::{refused, Result};
use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const HEADER: usize = 24;
pub const MAX_META: usize = 4096;
pub const MAX_PAYLOAD: usize = 65536;
const MAX_SAFE: u64 = 9007199254740991;

#[derive(Debug, Clone, PartialEq)]
pub struct Metadata(BTreeMap<String, Value>);
impl<'de> Deserialize<'de> for Metadata {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Unique;
        impl<'de> Visitor<'de> for Unique {
            type Value = Metadata;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("closed scalar metadata object")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Metadata, A::Error> {
                let mut m = BTreeMap::new();
                while let Some((k, v)) = a.next_entry::<String, Value>()? {
                    if v.is_array() || v.is_object() || m.insert(k, v).is_some() {
                        return Err(de::Error::custom("nested value or duplicate key"));
                    }
                }
                Ok(Metadata(m))
            }
        }
        d.deserialize_map(Unique)
    }
}
impl Metadata {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > MAX_META {
            return Err(refused("metadata length"));
        }
        let m: Self = serde_json::from_slice(bytes).map_err(|_| refused("metadata JSON"))?;
        m.validate()?;
        Ok(m)
    }
    pub fn text(&self, k: &str) -> Result<&str> {
        self.0
            .get(k)
            .and_then(Value::as_str)
            .ok_or_else(|| refused("string field"))
    }
    pub fn number(&self, k: &str) -> Result<u64> {
        self.0
            .get(k)
            .and_then(Value::as_u64)
            .ok_or_else(|| refused("integer field"))
    }
    pub fn value(&self, k: &str) -> Option<&Value> {
        self.0.get(k)
    }
    pub fn kind(&self) -> &str {
        self.0["kind"].as_str().expect("validated metadata")
    }
    pub fn canonical(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let b = serde_json::to_vec(&self.0).map_err(|_| refused("metadata encoding"))?;
        if b.len() > MAX_META {
            return Err(refused("encoded metadata length"));
        }
        Ok(b)
    }
    fn range(&self, k: &str, min: u64, max: u64) -> Result<()> {
        let n = self.number(k)?;
        if n < min || n > max {
            return Err(refused("integer bounds"));
        }
        Ok(())
    }
    fn id(&self, k: &str, prefix: &str, nullable: bool) -> Result<()> {
        if nullable && self.0.get(k) == Some(&Value::Null) {
            return Ok(());
        }
        let s = self.text(k)?;
        let tail = s.strip_prefix(prefix).ok_or_else(|| refused("ID prefix"))?;
        if tail.is_empty()
            || tail.len() > 64
            || !tail.as_bytes()[0].is_ascii_lowercase() && !tail.as_bytes()[0].is_ascii_digit()
            || !tail
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
        {
            return Err(refused("ID grammar"));
        }
        Ok(())
    }
    fn choice(&self, k: &str, choices: &[&str]) -> Result<()> {
        if !choices.contains(&self.text(k)?) {
            return Err(refused("enum"));
        }
        Ok(())
    }
    fn validate(&self) -> Result<()> {
        let extra: &[&str] = match self.text("kind")? {
            "hello" => &["nonce", "owner_id", "profile_id"],
            "exec" => &[
                "request_id",
                "job_id",
                "cwd",
                "timeout_ms",
                "command_bytes",
                "stdin_bytes",
            ],
            "cancel" => &["request_id", "run_request_id", "job_id"],
            "stop" | "stopping" => &["request_id"],
            "ready" => &[],
            "accepted" => &["request_id", "op", "job_id"],
            "output" => &["request_id", "job_id", "stream", "chunk_index"],
            "job_finished" => &[
                "request_id",
                "job_id",
                "cancel_request_id",
                "stop_request_id",
                "cause",
                "exit_code",
                "signal",
                "output_complete",
                "job_empty",
                "stdout_sent_bytes",
                "stderr_sent_bytes",
            ],
            "error" => &["request_id", "code"],
            _ => return Err(refused("metadata kind")),
        };
        let expected: BTreeSet<_> = ["kind", "workload_id", "generation", "reservation_id"]
            .into_iter()
            .chain(extra.iter().copied())
            .collect();
        if self.0.keys().map(String::as_str).collect::<BTreeSet<_>>() != expected {
            return Err(refused("missing or unknown fields"));
        }
        self.id("workload_id", "workload-", false)?;
        self.id("reservation_id", "reservation-", false)?;
        self.range("generation", 1, MAX_SAFE)?;
        for k in [
            "request_id",
            "run_request_id",
            "cancel_request_id",
            "stop_request_id",
        ] {
            if self.0.contains_key(k) {
                self.id(
                    k,
                    "request-",
                    k != "run_request_id" && (k != "request_id" || self.kind() == "error"),
                )?;
            }
        }
        if self.0.contains_key("job_id") {
            self.id("job_id", "job-", self.kind() == "accepted")?;
        }
        match self.kind() {
            "hello" => {
                self.id("owner_id", "actor-", false)?;
                let n = self.text("nonce")?;
                if n.len() != 64
                    || !n
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                {
                    return Err(refused("nonce"));
                }
                self.choice("profile_id", &["guest-command-arm64-v1"])?;
            }
            "exec" => {
                crate::sandbox::RelativeCwd::new(self.text("cwd")?)?;
                self.range("timeout_ms", 1, 60000)?;
                self.range("command_bytes", 1, 16384)?;
                self.range("stdin_bytes", 0, 49152)?;
            }
            "accepted" => {
                self.choice("op", &["exec", "cancel", "stop"])?;
                if (self.text("op")? == "stop") != (self.0["job_id"] == Value::Null) {
                    return Err(refused("accepted job correlation"));
                }
            }
            "output" => {
                self.choice("stream", &["stdout", "stderr"])?;
                self.range("chunk_index", 0, 65535)?;
            }
            "job_finished" => {
                self.choice(
                    "cause",
                    &["exit", "cancel", "stop", "timeout", "output_limit"],
                )?;
                let exit = self.0["exit_code"] != Value::Null;
                let signal = self.0["signal"] != Value::Null;
                if exit == signal {
                    return Err(refused("exclusive wait status"));
                }
                if exit {
                    self.range("exit_code", 0, 255)?;
                } else {
                    self.range("signal", 1, 64)?;
                }
                if self.0["job_empty"] != Value::Bool(true) {
                    return Err(refused("job not empty"));
                }
                let complete = self.0["output_complete"]
                    .as_bool()
                    .ok_or_else(|| refused("output boolean"))?;
                if complete == (self.text("cause")? == "output_limit") {
                    return Err(refused("lost output"));
                }
                for (cause, key) in [("cancel", "cancel_request_id"), ("stop", "stop_request_id")] {
                    if self.text("cause")? == cause && self.0[key] == Value::Null {
                        return Err(refused("missing accepted control"));
                    }
                }
                self.range("stdout_sent_bytes", 0, 65536)?;
                self.range("stderr_sent_bytes", 0, 65536)?;
                if self.number("stdout_sent_bytes")? + self.number("stderr_sent_bytes")? > 65536 {
                    return Err(refused("combined output"));
                }
            }
            "error" => self.choice(
                "code",
                &[
                    "AUTH",
                    "PROTOCOL",
                    "BUSY",
                    "INVALID",
                    "DEADLINE",
                    "OUTPUT_LIMIT",
                    "RESOURCE",
                    "CLEANUP",
                ],
            )?,
            _ => {}
        }
        Ok(())
    }
    fn tag(&self) -> u8 {
        match self.kind() {
            "hello" => 1,
            "exec" => 2,
            "cancel" => 3,
            "stop" => 4,
            _ => 5,
        }
    }
    fn payload(&self, data: &[u8]) -> Result<()> {
        match self.kind() {
            "exec" => {
                let cmd = self.number("command_bytes")? as usize;
                if cmd + self.number("stdin_bytes")? as usize != data.len() {
                    return Err(refused("exec payload lengths"));
                }
                let script =
                    std::str::from_utf8(&data[..cmd]).map_err(|_| refused("command UTF8"))?;
                if script.contains('\0') {
                    return Err(refused("command NUL"));
                }
            }
            "output" if (1..=16384).contains(&data.len()) => {}
            "output" => return Err(refused("output chunk length")),
            _ if !data.is_empty() => return Err(refused("unexpected payload")),
            _ => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Header {
    pub tag: u8,
    pub metadata_len: usize,
    pub payload_len: usize,
    pub sequence: u64,
}
impl Header {
    pub fn parse(b: &[u8]) -> Result<Self> {
        if b.len() != HEADER
            || &b[..4] != b"MVGC"
            || b[4] != 1
            || !(1..=5).contains(&b[5])
            || b[6..8] != [0, 0]
        {
            return Err(refused("frame header"));
        }
        let h = Self {
            tag: b[5],
            metadata_len: u32::from_be_bytes(b[8..12].try_into().unwrap()) as usize,
            payload_len: u32::from_be_bytes(b[12..16].try_into().unwrap()) as usize,
            sequence: u64::from_be_bytes(b[16..24].try_into().unwrap()),
        };
        if !(1..=MAX_META).contains(&h.metadata_len)
            || h.payload_len > MAX_PAYLOAD
            || h.sequence == 0
        {
            return Err(refused("frame bounds"));
        }
        Ok(h)
    }
    pub fn frame_len(&self) -> usize {
        HEADER + self.metadata_len + self.payload_len
    }
}
#[derive(Debug)]
pub struct Frame {
    pub metadata: Metadata,
    pub payload: Vec<u8>,
    pub sequence: u64,
}
impl Frame {
    pub fn decode(b: &[u8]) -> Result<Self> {
        if b.len() < HEADER {
            return Err(refused("short header"));
        }
        let h = Header::parse(&b[..HEADER])?;
        if b.len() != h.frame_len() {
            return Err(refused("short or trailing frame bytes"));
        }
        let m = Metadata::parse(&b[HEADER..HEADER + h.metadata_len])?;
        if m.tag() != h.tag {
            return Err(refused("tag/kind mismatch"));
        }
        let payload = b[HEADER + h.metadata_len..].to_vec();
        m.payload(&payload)?;
        Ok(Self {
            metadata: m,
            payload,
            sequence: h.sequence,
        })
    }
    pub fn encode(metadata: &Metadata, payload: &[u8], sequence: u64) -> Result<Vec<u8>> {
        if sequence == 0 || payload.len() > MAX_PAYLOAD {
            return Err(refused("frame bounds"));
        }
        metadata.payload(payload)?;
        let m = metadata.canonical()?;
        let mut b = Vec::with_capacity(HEADER + m.len() + payload.len());
        b.extend_from_slice(b"MVGC");
        b.extend_from_slice(&[1, metadata.tag(), 0, 0]);
        b.extend_from_slice(&(m.len() as u32).to_be_bytes());
        b.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        b.extend_from_slice(&sequence.to_be_bytes());
        b.extend_from_slice(&m);
        b.extend_from_slice(payload);
        Ok(b)
    }
}

/// Host-to-guest sequence and immutable HELLO binding. Errors permanently fence it.
pub struct Receiver {
    nonce: String,
    owner: String,
    binding: Option<(String, u64, String)>,
    sender_taken: bool,
    next: u64,
    failed: bool,
}
impl Receiver {
    pub fn new(nonce: String, owner: String) -> Self {
        Self {
            nonce,
            owner,
            binding: None,
            sender_taken: false,
            next: 1,
            failed: false,
        }
    }
    pub fn accept(&mut self, bytes: &[u8]) -> Result<Frame> {
        if self.failed {
            return Err(refused("receiver fenced"));
        }
        let result = self.check(bytes);
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn check(&mut self, bytes: &[u8]) -> Result<Frame> {
        let f = Frame::decode(bytes)?;
        if f.sequence != self.next {
            return Err(refused("sequence gap/replay"));
        }
        let m = &f.metadata;
        let tuple = (
            m.text("workload_id")?.to_owned(),
            m.number("generation")?,
            m.text("reservation_id")?.to_owned(),
        );
        match &self.binding {
            None => {
                if m.kind() != "hello"
                    || m.text("nonce")? != self.nonce
                    || m.text("owner_id")? != self.owner
                {
                    return Err(refused("HELLO authentication"));
                }
                self.binding = Some(tuple);
            }
            Some(bound) => {
                if bound != &tuple || !["exec", "cancel", "stop"].contains(&m.kind()) {
                    return Err(refused("binding or direction"));
                }
            }
        }
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| refused("sequence exhausted"))?;
        Ok(f)
    }
}

/// Guest writer identity is derived only from an authenticated receiver.
/// The caller must serialize writes and fence the transport after any failed send;
/// encode consumes the sequence and never permits retrying that encoded event.
pub struct Sender {
    binding: (String, u64, String),
    next: u64,
    failed: bool,
}
impl Receiver {
    pub fn sender(&mut self) -> Result<Sender> {
        if self.failed || self.sender_taken {
            return Err(refused("receiver fenced or writer already issued"));
        }
        let binding = self
            .binding
            .clone()
            .ok_or_else(|| refused("HELLO required"))?;
        self.sender_taken = true;
        Ok(Sender {
            binding,
            next: 1,
            failed: false,
        })
    }
}
impl Sender {
    pub fn ready_metadata(&self) -> Result<Metadata> {
        if self.failed {
            return Err(refused("sender fenced"));
        }
        Metadata::parse(
            &serde_json::to_vec(&serde_json::json!({
                "kind":"ready", "workload_id":self.binding.0,
                "generation":self.binding.1, "reservation_id":self.binding.2
            }))
            .map_err(|_| refused("ready encoding"))?,
        )
    }
    pub fn fence(&mut self) {
        self.failed = true;
    }
    pub fn encode(&mut self, metadata: &Metadata, payload: &[u8]) -> Result<Vec<u8>> {
        if self.failed {
            return Err(refused("sender fenced"));
        }
        let valid = metadata.tag() == 5
            && metadata.text("workload_id")? == self.binding.0
            && metadata.number("generation")? == self.binding.1
            && metadata.text("reservation_id")? == self.binding.2;
        if !valid {
            self.failed = true;
            return Err(refused("event binding or direction"));
        }
        match Frame::encode(metadata, payload, self.next) {
            Ok(bytes) => {
                match self.next.checked_add(1) {
                    Some(n) => self.next = n,
                    None => {
                        self.failed = true;
                        return Err(refused("sequence exhausted"));
                    }
                }
                Ok(bytes)
            }
            Err(e) => {
                self.failed = true;
                Err(e)
            }
        }
    }
}

/// Fixed first-byte deadline calculation, independent of socket fragmentation.
pub fn frame_deadline(first_byte_ms: Option<u64>, lifetime_end_ms: u64) -> u64 {
    first_byte_ms
        .map(|t| t.saturating_add(3000).min(lifetime_end_ms))
        .unwrap_or(lifetime_end_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn meta(kind: &str) -> Value {
        json!({"kind":kind,"workload_id":"workload-a","generation":1,"reservation_id":"reservation-a"})
    }
    fn parse(v: Value) -> Result<Metadata> {
        Metadata::parse(&serde_json::to_vec(&v).unwrap())
    }
    fn hello() -> Metadata {
        let mut v = meta("hello");
        v["nonce"] = json!("a".repeat(64));
        v["owner_id"] = json!("actor-a");
        v["profile_id"] = json!("guest-command-arm64-v1");
        parse(v).unwrap()
    }
    fn exec() -> Value {
        let mut v = meta("exec");
        v["request_id"] = json!("request-a");
        v["job_id"] = json!("job-a");
        v["cwd"] = json!("");
        v["timeout_ms"] = json!(60000);
        v["command_bytes"] = json!(4);
        v["stdin_bytes"] = json!(0);
        v
    }
    #[test]
    fn roundtrip_and_network_header() {
        let b = Frame::encode(&hello(), &[], 1).unwrap();
        assert_eq!(&b[..8], b"MVGC\x01\x01\0\0");
        assert_eq!(&b[16..24], &1u64.to_be_bytes());
        assert_eq!(Frame::decode(&b).unwrap().metadata, hello());
        let m = parse(exec()).unwrap();
        assert_eq!(
            Frame::decode(&Frame::encode(&m, b"true", 2).unwrap())
                .unwrap()
                .payload,
            b"true"
        );
    }
    #[test]
    fn duplicate_unknown_wrong_scalars() {
        let b = hello().canonical().unwrap();
        let s = String::from_utf8(b).unwrap();
        assert!(Metadata::parse(s.replacen("{", "{\"kind\":\"hello\",", 1).as_bytes()).is_err());
        for v in [
            json!(true),
            json!(1.0),
            json!(0),
            json!(9007199254740992u64),
            json!("1"),
            json!({"x":1}),
        ] {
            let mut m = exec();
            m["generation"] = v;
            assert!(parse(m).is_err());
        }
        let mut m = exec();
        m["extra"] = Value::Null;
        assert!(parse(m).is_err());
        let mut m = exec();
        m.as_object_mut().unwrap().remove("stdin_bytes");
        assert!(parse(m).is_err());
        assert!(Metadata::parse(b"{\"kind\":NaN}").is_err());
        assert!(Metadata::parse(b"{\"kind\":\"\\uD800\"}").is_err());
    }
    #[test]
    fn hostile_headers_before_allocation() {
        let b = Frame::encode(&hello(), &[], 1).unwrap();
        for (i, val) in [(0, 0), (4, 2), (5, 0), (5, 6), (6, 1), (7, 1)] {
            let mut m = b.clone();
            m[i] = val;
            assert!(Frame::decode(&m).is_err());
        }
        for (range, n) in [(8..12, 0u32), (8..12, 4097), (12..16, 65537)] {
            let mut m = b.clone();
            m[range].copy_from_slice(&n.to_be_bytes());
            assert!(Frame::decode(&m).is_err());
        }
        for len in 0..b.len() {
            assert!(Frame::decode(&b[..len]).is_err());
        }
        let mut m = b.clone();
        m.push(0);
        assert!(Frame::decode(&m).is_err());
        let mut m = b.clone();
        m[5] = 2;
        assert!(Frame::decode(&m).is_err());
    }
    #[test]
    fn exec_payload_and_unicode_bounds() {
        let m = parse(exec()).unwrap();
        for b in [b"tru".as_slice(), b"truex", b"tr\0e", b"\xffrue"] {
            assert!(Frame::encode(&m, b, 1).is_err());
        }
        let mut v = exec();
        v["command_bytes"] = json!(16384);
        v["stdin_bytes"] = json!(49152);
        let m = parse(v).unwrap();
        assert_eq!(
            Frame::decode(&Frame::encode(&m, &vec![b'x'; 65536], 1).unwrap())
                .unwrap()
                .payload
                .len(),
            65536
        );
        for cwd in ["../x", "/x", "x//y", "x/./y", "a\n", "a\u{7f}"] {
            let mut v = exec();
            v["cwd"] = json!(cwd);
            assert!(parse(v).is_err());
        }
    }
    #[test]
    fn frozen_encoding_vectors() {
        let vectors: Value =
            serde_json::from_str(include_str!("../tests/fixtures/encoding.json")).unwrap();
        for v in vectors["vectors"].as_array().unwrap() {
            let mut m = exec();
            m["cwd"] = v["cwd"].clone();
            if v["max_ids"] == true {
                for (k, prefix) in [
                    ("workload_id", "workload-"),
                    ("reservation_id", "reservation-"),
                    ("request_id", "request-"),
                    ("job_id", "job-"),
                ] {
                    m[k] = json!(format!("{}{}", prefix, "a".repeat(64)));
                }
                m["generation"] = json!(MAX_SAFE);
            }
            let result = parse(m);
            assert_eq!(
                result.is_ok(),
                v["expected_admit"].as_bool().unwrap(),
                "{}",
                v["name"]
            );
            if let Ok(m) = result {
                assert_eq!(
                    m.canonical().unwrap().len() as u64,
                    v["encoded_metadata_bytes"].as_u64().unwrap()
                );
            }
        }
    }
    #[test]
    fn bound_receiver_fences_replay_and_foreign_identity() {
        let b = Frame::encode(&hello(), &[], 1).unwrap();
        let mut r = Receiver::new("a".repeat(64), "actor-a".into());
        r.accept(&b).unwrap();
        assert!(r.accept(&b).is_err());
        assert!(r
            .accept(&Frame::encode(&parse(exec()).unwrap(), b"true", 2).unwrap())
            .is_err());
        for key in ["generation", "workload_id", "reservation_id"] {
            let mut r = Receiver::new("a".repeat(64), "actor-a".into());
            r.accept(&b).unwrap();
            let mut v = exec();
            v[key] = if key == "generation" {
                json!(2)
            } else {
                json!("foreign")
            };
            assert!(
                parse(v.clone()).is_err()
                    || r.accept(&Frame::encode(&parse(v).unwrap(), b"true", 2).unwrap())
                        .is_err()
            );
        }
        for (n, o) in [("b".repeat(64), "actor-a"), ("a".repeat(64), "actor-b")] {
            assert!(Receiver::new(n, o.into()).accept(&b).is_err());
        }
        let mut r = Receiver::new("a".repeat(64), "actor-a".into());
        assert!(r
            .accept(&Frame::encode(&parse(exec()).unwrap(), b"true", 1).unwrap())
            .is_err());
    }
    #[test]
    fn terminal_control_and_output_negative_cases() {
        let mut v = meta("job_finished");
        for (k, x) in [
            ("request_id", json!("request-a")),
            ("job_id", json!("job-a")),
            ("cancel_request_id", Value::Null),
            ("stop_request_id", Value::Null),
            ("cause", json!("exit")),
            ("exit_code", json!(0)),
            ("signal", Value::Null),
            ("output_complete", json!(true)),
            ("job_empty", json!(true)),
            ("stdout_sent_bytes", json!(2)),
            ("stderr_sent_bytes", json!(3)),
        ] {
            v[k] = x;
        }
        parse(v.clone()).unwrap();
        for (k, x) in [
            ("signal", json!(9)),
            ("job_empty", json!(false)),
            ("output_complete", json!(false)),
            ("cause", json!("cancel")),
            ("cause", json!("stop")),
            ("stdout_sent_bytes", json!(65536)),
        ] {
            let mut m = v.clone();
            m[k] = x;
            assert!(parse(m).is_err());
        }
        let mut o = meta("output");
        o["request_id"] = json!("request-a");
        o["job_id"] = json!("job-a");
        o["stream"] = json!("stdout");
        o["chunk_index"] = json!(0);
        let m = parse(o).unwrap();
        for n in [0, 16385] {
            assert!(Frame::encode(&m, &vec![0; n], 1).is_err());
        }
        Frame::encode(&m, &[0; 3], 1).unwrap();
    }
    #[test]
    fn every_closed_variant_requires_all_keys() {
        let mut rows = vec![hello().0, parse(exec()).unwrap().0];
        for (kind, extra) in [
            (
                "cancel",
                json!({"request_id":"request-c","run_request_id":"request-a","job_id":"job-a"}),
            ),
            ("stop", json!({"request_id":"request-s"})),
            ("ready", json!({})),
            (
                "accepted",
                json!({"request_id":"request-s","op":"stop","job_id":null}),
            ),
            ("stopping", json!({"request_id":"request-s"})),
            ("error", json!({"request_id":null,"code":"PROTOCOL"})),
        ] {
            let mut v = meta(kind);
            for (k, x) in extra.as_object().unwrap() {
                v[k] = x.clone();
            }
            rows.push(parse(v).unwrap().0);
        }
        for row in rows {
            for key in row.keys() {
                let mut m = row.clone();
                m.remove(key);
                assert!(Metadata::parse(&serde_json::to_vec(&m).unwrap()).is_err());
            }
            let mut m = row;
            m.insert("unknown".into(), Value::Null);
            assert!(Metadata::parse(&serde_json::to_vec(&m).unwrap()).is_err());
        }
    }
    #[test]
    fn guest_ready_is_derived_from_authenticated_binding() {
        let mut r = Receiver::new("a".repeat(64), "actor-a".into());
        assert!(r.sender().is_err());
        r.accept(&Frame::encode(&hello(), &[], 1).unwrap()).unwrap();
        let mut s = r.sender().unwrap();
        assert!(r.sender().is_err());
        let m = s.ready_metadata().unwrap();
        let f = Frame::decode(&s.encode(&m, &[]).unwrap()).unwrap();
        assert_eq!(f.sequence, 1);
        assert_eq!(f.metadata.text("workload_id").unwrap(), "workload-a");
        let mut foreign = meta("ready");
        foreign["workload_id"] = json!("workload-b");
        assert!(s.encode(&parse(foreign).unwrap(), &[]).is_err());
        assert!(s.encode(&m, &[]).is_err());
    }
    #[test]
    fn absolute_partial_deadline() {
        assert_eq!(frame_deadline(None, 60000), 60000);
        assert_eq!(frame_deadline(Some(100), 60000), 3100);
        assert_eq!(frame_deadline(Some(59000), 60000), 60000);
    }
}
