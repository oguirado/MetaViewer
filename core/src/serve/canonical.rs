use sha2::{Digest, Sha256};

pub const MAX_STATE_BYTES: usize = 1_048_576;
pub const CANONICAL_MAX_DEPTH: usize = 64;
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalError {
    Empty,
    Oversize(usize),
    InvalidUtf8,
    Syntax(&'static str),
    RootNotObject,
    DepthExceeded,
    DuplicateKey,
    FloatForbidden,
    ExponentForbidden,
    IntegerOutOfRange,
    DigestMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Str(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

pub fn canonicalise_and_verify_state(
    raw: &[u8],
    claimed_sha256: &str,
) -> Result<Vec<u8>, CanonicalError> {
    if !is_hex64(claimed_sha256) {
        return Err(CanonicalError::DigestMismatch);
    }
    let canonical = canonicalise_state(raw)?;
    let digest = sha256_hex(&canonical);
    if digest != claimed_sha256 {
        return Err(CanonicalError::DigestMismatch);
    }
    Ok(canonical)
}

pub fn canonicalise_state(raw: &[u8]) -> Result<Vec<u8>, CanonicalError> {
    if raw.is_empty() {
        return Err(CanonicalError::Empty);
    }
    if raw.len() > MAX_STATE_BYTES {
        return Err(CanonicalError::Oversize(raw.len()));
    }
    let text = std::str::from_utf8(raw).map_err(|_| CanonicalError::InvalidUtf8)?;
    let mut parser = Parser::new(text.as_bytes());
    parser.skip_ws();
    let root = parser.parse_value(0)?;
    parser.skip_ws();
    if parser.pos != parser.src.len() {
        return Err(CanonicalError::Syntax("trailing bytes after JSON value"));
    }
    if !matches!(root, Value::Object(_)) {
        return Err(CanonicalError::RootNotObject);
    }
    let mut out = Vec::with_capacity(raw.len());
    emit_canonical(&root, &mut out);
    if out.len() > MAX_STATE_BYTES {
        return Err(CanonicalError::Oversize(out.len()));
    }
    Ok(out)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

struct Parser<'a> {
    src: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(src: &'a [u8]) -> Self {
        Self { src, pos: 0 }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.src.len() {
            match self.src[self.pos] {
                b' ' | b'\t' | b'\n' | b'\r' => self.pos += 1,
                _ => break,
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.src.get(self.pos).copied()
    }

    fn parse_value(&mut self, depth: usize) -> Result<Value, CanonicalError> {
        if depth > CANONICAL_MAX_DEPTH {
            return Err(CanonicalError::DepthExceeded);
        }
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.parse_object(depth),
            Some(b'[') => self.parse_array(depth),
            Some(b'"') => self.parse_string().map(Value::Str),
            Some(b't') => self.parse_literal(b"true", Value::Bool(true)),
            Some(b'f') => self.parse_literal(b"false", Value::Bool(false)),
            Some(b'n') => self.parse_literal(b"null", Value::Null),
            Some(b'-') | Some(b'0'..=b'9') => self.parse_number(),
            _ => Err(CanonicalError::Syntax("unexpected token")),
        }
    }

    fn parse_literal(&mut self, lit: &[u8], val: Value) -> Result<Value, CanonicalError> {
        if self.src.get(self.pos..self.pos + lit.len()) == Some(lit) {
            self.pos += lit.len();
            Ok(val)
        } else {
            Err(CanonicalError::Syntax("invalid literal"))
        }
    }

    fn parse_object(&mut self, depth: usize) -> Result<Value, CanonicalError> {
        self.pos += 1; // '{'
        self.skip_ws();
        let mut entries = Vec::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Object(entries));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(CanonicalError::Syntax("expected object key string"));
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(CanonicalError::Syntax("expected ':' after object key"));
            }
            self.pos += 1;
            let value = self.parse_value(depth + 1)?;
            entries.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(CanonicalError::Syntax("expected ',' or '}' in object")),
            }
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for pair in entries.windows(2) {
            if pair[0].0 == pair[1].0 {
                return Err(CanonicalError::DuplicateKey);
            }
        }
        Ok(Value::Object(entries))
    }

    fn parse_array(&mut self, depth: usize) -> Result<Value, CanonicalError> {
        self.pos += 1; // '['
        self.skip_ws();
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Array(items));
        }
        loop {
            let item = self.parse_value(depth + 1)?;
            items.push(item);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(CanonicalError::Syntax("expected ',' or ']' in array")),
            }
        }
        Ok(Value::Array(items))
    }

    fn parse_string(&mut self) -> Result<String, CanonicalError> {
        self.pos += 1; // opening '"'
        let mut out = String::new();
        while self.pos < self.src.len() {
            let b = self.src[self.pos];
            if b == b'"' {
                self.pos += 1;
                return Ok(out);
            }
            if b == b'\\' {
                self.pos += 1;
                let esc = *self
                    .src
                    .get(self.pos)
                    .ok_or(CanonicalError::Syntax("unterminated escape"))?;
                self.pos += 1;
                match esc {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\u{0008}'),
                    b'f' => out.push('\u{000c}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let unit = self.parse_hex4()?;
                        if (0xD800..=0xDBFF).contains(&unit) {
                            if self.src.get(self.pos..self.pos + 2) != Some(b"\\u") {
                                return Err(CanonicalError::Syntax("unpaired high surrogate"));
                            }
                            self.pos += 2;
                            let low = self.parse_hex4()?;
                            if !(0xDC00..=0xDFFF).contains(&low) {
                                return Err(CanonicalError::Syntax("invalid low surrogate"));
                            }
                            let cp =
                                0x10000 + (((unit as u32 - 0xD800) << 10) | (low as u32 - 0xDC00));
                            let ch = char::from_u32(cp)
                                .ok_or(CanonicalError::Syntax("invalid surrogate code point"))?;
                            out.push(ch);
                        } else if (0xDC00..=0xDFFF).contains(&unit) {
                            return Err(CanonicalError::Syntax("unpaired low surrogate"));
                        } else {
                            let ch = char::from_u32(unit as u32)
                                .ok_or(CanonicalError::Syntax("invalid unicode escape"))?;
                            out.push(ch);
                        }
                    }
                    _ => return Err(CanonicalError::Syntax("invalid escape character")),
                }
                continue;
            }
            if b < 0x20 {
                return Err(CanonicalError::Syntax("unescaped control character"));
            }
            let tail = std::str::from_utf8(&self.src[self.pos..])
                .map_err(|_| CanonicalError::InvalidUtf8)?;
            let ch = tail
                .chars()
                .next()
                .ok_or(CanonicalError::Syntax("unterminated string"))?;
            out.push(ch);
            self.pos += ch.len_utf8();
        }
        Err(CanonicalError::Syntax("unterminated string"))
    }

    fn parse_hex4(&mut self) -> Result<u16, CanonicalError> {
        let slice = self
            .src
            .get(self.pos..self.pos + 4)
            .ok_or(CanonicalError::Syntax("truncated unicode escape"))?;
        let mut val: u16 = 0;
        for &b in slice {
            let d = match b {
                b'0'..=b'9' => b - b'0',
                b'a'..=b'f' => b - b'a' + 10,
                b'A'..=b'F' => b - b'A' + 10,
                _ => {
                    return Err(CanonicalError::Syntax(
                        "invalid hex digit in unicode escape",
                    ))
                }
            };
            val = (val << 4) | (d as u16);
        }
        self.pos += 4;
        Ok(val)
    }

    fn parse_number(&mut self) -> Result<Value, CanonicalError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        let digits_start = self.pos;
        match self.peek() {
            Some(b'0') => {
                self.pos += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(CanonicalError::Syntax("leading zero in number"));
                }
            }
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return Err(CanonicalError::Syntax("expected digit in number")),
        }
        if self.pos == digits_start {
            return Err(CanonicalError::Syntax("missing digits in number"));
        }
        if self.peek() == Some(b'.') {
            return Err(CanonicalError::FloatForbidden);
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            return Err(CanonicalError::ExponentForbidden);
        }
        let token = std::str::from_utf8(&self.src[start..self.pos])
            .map_err(|_| CanonicalError::InvalidUtf8)?;
        if token == "-0" {
            return Ok(Value::Int(0));
        }
        let parsed = token
            .parse::<i128>()
            .map_err(|_| CanonicalError::IntegerOutOfRange)?;
        if parsed < -(MAX_SAFE_INTEGER as i128) || parsed > (MAX_SAFE_INTEGER as i128) {
            return Err(CanonicalError::IntegerOutOfRange);
        }
        Ok(Value::Int(parsed as i64))
    }
}

fn emit_canonical(val: &Value, out: &mut Vec<u8>) {
    match val {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Int(n) => {
            if *n == 0 {
                out.push(b'0');
            } else {
                out.extend_from_slice(n.to_string().as_bytes());
            }
        }
        Value::Str(s) => emit_canonical_string(s, out),
        Value::Array(items) => {
            out.push(b'[');
            for (idx, item) in items.iter().enumerate() {
                if idx > 0 {
                    out.push(b',');
                }
                emit_canonical(item, out);
            }
            out.push(b']');
        }
        Value::Object(entries) => {
            out.push(b'{');
            for (idx, (k, v)) in entries.iter().enumerate() {
                if idx > 0 {
                    out.push(b',');
                }
                emit_canonical_string(k, out);
                out.push(b':');
                emit_canonical(v, out);
            }
            out.push(b'}');
        }
    }
}

fn emit_canonical_string(s: &str, out: &mut Vec<u8>) {
    out.push(b'"');
    for ch in s.chars() {
        let code = ch as u32;
        match code {
            0x22 => out.extend_from_slice(b"\\\""),
            0x5c => out.extend_from_slice(b"\\\\"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0c => out.extend_from_slice(b"\\f"),
            0x0a => out.extend_from_slice(b"\\n"),
            0x0d => out.extend_from_slice(b"\\r"),
            0x09 => out.extend_from_slice(b"\\t"),
            0x00..=0x1f => {
                let hex = b"0123456789abcdef";
                out.extend_from_slice(&[
                    b'\\',
                    b'u',
                    b'0',
                    b'0',
                    hex[((code >> 4) & 0x0f) as usize],
                    hex[(code & 0x0f) as usize],
                ]);
            }
            _ => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out.push(b'"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_vectors_match_js_implementation_byte_for_byte() {
        let cases: &[(&str, &str, &str)] = &[
            (
                "sorted_keys",
                r#"{"z":1,"a":2,"m":{"b":true,"":null,"0":false},"é":3,"\ud83d\ude00":4,"\uffee":5}"#,
                "{\"a\":2,\"m\":{\"\":null,\"0\":false,\"b\":true},\"z\":1,\"é\":3,\"￮\":5,\"😀\":4}",
            ),
            (
                "unicode_verbatim",
                r#"{"text":"caf\u00e9 \u4e2d\u6587 \ud83e\udd80 \u03b1\u03b2\u03b3","nested":["\u20ac","\ud83c\uddfa\ud83c\uddf8"]}"#,
                "{\"nested\":[\"€\",\"🇺🇸\"],\"text\":\"café 中文 🦀 αβγ\"}",
            ),
            (
                "control_chars",
                r#"{"normal":" ~","escapes":"\"\\\b\f\n\r\t\u0000\u0001\u0007\u001B\u001f"}"#,
                "{\"escapes\":\"\\\"\\\\\\b\\f\\n\\r\\t\\u0000\\u0001\\u0007\\u001b\\u001f\",\"normal\":\" ~\"}",
            ),
            (
                "html_angle_amp_raw",
                r#"{"url":"https:\/\/example.test\/?a=1\u0026b=2\u003c3\u003e","expr":"a \u003c b \u0026\u0026 c \u003e d & e=\"<tag attr='val'/>\""}"#,
                "{\"expr\":\"a < b && c > d & e=\\\"<tag attr='val'/>\\\"\",\"url\":\"https://example.test/?a=1&b=2<3>\"}",
            ),
            (
                "max_safe_int_and_bounds",
                r#"{"zero":0,"neg_zero":-0,"min":-9007199254740991,"max":9007199254740991,"big_str":"9007199254740992"}"#,
                "{\"big_str\":\"9007199254740992\",\"max\":9007199254740991,\"min\":-9007199254740991,\"neg_zero\":0,\"zero\":0}",
            ),
            (
                "holdings_state_fixture",
                r#"{
                  "schema": "wender.state/v1",
                  "source": { "kind": "cdp", "url": "app://holdings/index.html?x=1\u0026y=2", "title": "Holdings \u003cLive\u003e" },
                  "prune": { "name": "default", "version": 1 },
                  "ax_sha256": "1111111111111111111111111111111111111111111111111111111111111111",
                  "ax_stable_sha256": "2222222222222222222222222222222222222222222222222222222222222222",
                  "viewport": { "width": 1280, "height": 720 },
                  "nodes": [
                    {
                      "id": "0123456789abcdef",
                      "role": "button",
                      "name": "Buy & Hold <100>\nNext\t\u0007",
                      "depth": 0,
                      "parent": null,
                      "ordinal": 0,
                      "states": { "balance_wei": "99999999999999999999999999", "pressed": "false" },
                      "actionable": true,
                      "box": [10, 20, 100, 40]
                    }
                  ],
                  "actionable": ["0123456789abcdef"],
                  "counts": { "raw": 1, "nodes": 1, "actionable": 1 }
                }"#,
                "{\"actionable\":[\"0123456789abcdef\"],\"ax_sha256\":\"1111111111111111111111111111111111111111111111111111111111111111\",\"ax_stable_sha256\":\"2222222222222222222222222222222222222222222222222222222222222222\",\"counts\":{\"actionable\":1,\"nodes\":1,\"raw\":1},\"nodes\":[{\"actionable\":true,\"box\":[10,20,100,40],\"depth\":0,\"id\":\"0123456789abcdef\",\"name\":\"Buy & Hold <100>\\nNext\\t\\u0007\",\"ordinal\":0,\"parent\":null,\"role\":\"button\",\"states\":{\"balance_wei\":\"99999999999999999999999999\",\"pressed\":\"false\"}}],\"prune\":{\"name\":\"default\",\"version\":1},\"schema\":\"wender.state/v1\",\"source\":{\"kind\":\"cdp\",\"title\":\"Holdings <Live>\",\"url\":\"app://holdings/index.html?x=1&y=2\"},\"viewport\":{\"height\":720,\"width\":1280}}",
            ),
        ];
        let expected_sha256: &[(&str, &str)] = &[
            (
                "sorted_keys",
                "be76c7f6428412ebd2e657d1f9f4add0818cc8d8e43694d8fc83a36d858dcce8",
            ),
            (
                "unicode_verbatim",
                "88704a20fa176e02dc116547b693f537cb0da736c0ed4aabe429ebf8b7cfae48",
            ),
            (
                "control_chars",
                "6e2a9015b050892930ebef1c5a0a7ce63f8ad8ea4813c6f777e716f1b4eb1418",
            ),
            (
                "html_angle_amp_raw",
                "5921eb5e9922d1ed24bf6aaaabf22895bdde52e44da22e115f21c1683d800bcd",
            ),
            (
                "max_safe_int_and_bounds",
                "b682126a32fb817940dd094d8127661ee3f55bf9e357100e81dfa8e5f0ece612",
            ),
            (
                "holdings_state_fixture",
                "752988613fda42d018626fa551a2024dbf74fb41ce6542b7397a437072057da5",
            ),
        ];

        for ((name, raw, want_canonical), (_, want_sha)) in cases.iter().zip(expected_sha256.iter())
        {
            let got = canonicalise_and_verify_state(raw.as_bytes(), want_sha)
                .unwrap_or_else(|e| panic!("{name}: unexpected error {e:?}"));
            assert_eq!(
                std::str::from_utf8(&got).unwrap(),
                *want_canonical,
                "{name}: canonical bytes mismatch"
            );
            assert_eq!(sha256_hex(&got), *want_sha, "{name}: sha256 mismatch");
        }
    }

    #[test]
    fn canonical_refuses_float_exponent_unsafe_int_and_deep_nesting() {
        assert_eq!(
            canonicalise_state(br#"{"v":1.5}"#),
            Err(CanonicalError::FloatForbidden)
        );
        assert_eq!(
            canonicalise_state(br#"{"v":1.0}"#),
            Err(CanonicalError::FloatForbidden)
        );
        assert_eq!(
            canonicalise_state(br#"{"v":1e5}"#),
            Err(CanonicalError::ExponentForbidden)
        );
        assert_eq!(
            canonicalise_state(br#"{"v":1E-2}"#),
            Err(CanonicalError::ExponentForbidden)
        );
        assert_eq!(
            canonicalise_state(br#"{"v":9007199254740992}"#),
            Err(CanonicalError::IntegerOutOfRange)
        );
        assert_eq!(
            canonicalise_state(br#"{"v":-9007199254740992}"#),
            Err(CanonicalError::IntegerOutOfRange)
        );

        let mut ok_64 = String::from("{\"a\":");
        for _ in 0..63 {
            ok_64.push('[');
        }
        ok_64.push('1');
        for _ in 0..63 {
            ok_64.push(']');
        }
        ok_64.push('}');
        assert!(canonicalise_state(ok_64.as_bytes()).is_ok());

        let mut too_deep_65 = String::from("{\"a\":");
        for _ in 0..64 {
            too_deep_65.push('[');
        }
        too_deep_65.push('1');
        for _ in 0..64 {
            too_deep_65.push(']');
        }
        too_deep_65.push('}');
        assert_eq!(
            canonicalise_state(too_deep_65.as_bytes()),
            Err(CanonicalError::DepthExceeded)
        );

        let oversize = vec![b' '; MAX_STATE_BYTES + 1];
        assert_eq!(
            canonicalise_state(&oversize),
            Err(CanonicalError::Oversize(MAX_STATE_BYTES + 1))
        );
    }
}
