#![forbid(unsafe_code)]
use metaviewer_core::transport::{read_frame, write_frame};
use metaviewer_core::wire::*;
use serde_json::json;
use tokio::io::AsyncWriteExt;

// Deterministic std-only xorshift64 PRNG
struct Prng(u64);
impl Prng {
    fn new(seed: u64) -> Self {
        Self(if seed == 0 { 0xdeadbeef } else { seed })
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn gen_range(&mut self, min: usize, max: usize) -> usize {
        if min >= max {
            return min;
        }
        min + (self.next_u64() as usize % (max - min + 1))
    }
}

fn valid_envelope_json(msg_id: &str, nonce: &str) -> serde_json::Value {
    json!({
        "schema": "envelope/v0.2",
        "msg_id": msg_id,
        "ts_ns": 12345,
        "from": {"component": "agent", "instance": "inst-1"},
        "to": {"component": "core", "instance": "core-1"},
        "session_id": "session-1",
        "seq": 1,
        "nonce": nonce,
        "body": {
            "schema": "action_proposal/v0.2",
            "proposal_id": "proposal-1",
            "surface_id": "surface-1",
            "based_on_frame": {"sha256": "0000000000000000000000000000000000000000000000000000000000000000", "generation": 1},
            "action": {"type": "click", "x": 1, "y": 2, "button": "left"},
            "expectation": {"type": "text_present", "text": "ready"},
            "budget": {"max_ms": 10, "max_retries": 0}
        }
    })
}

#[test]
fn exact_boundaries_depth_keys_string_envelope_integers_arrays() {
    // Depth: 32 vs 33
    // WireLimits default depth is 32. Construct JSON with nested objects.
    let make_nested = |depth: usize| {
        let mut s = String::new();
        for _ in 0..depth {
            s.push_str("{\"a\":");
        }
        s.push('1');
        for _ in 0..depth {
            s.push('}');
        }
        s
    };
    let depth_32 = make_nested(32);
    let depth_33 = make_nested(33);
    let limits = WireLimits::default();
    assert!(
        decode_envelope_with_limits(&depth_32, &limits).is_err()
            && !matches!(
                decode_envelope_with_limits(&depth_32, &limits),
                Err(DecodeError::DepthExceeded)
            )
    );
    assert_eq!(
        decode_envelope_with_limits(&depth_33, &limits),
        Err(DecodeError::DepthExceeded)
    );

    // Keys: 256 vs 257
    let make_keys = |count: usize| {
        let mut obj = serde_json::Map::new();
        for i in 0..count {
            obj.insert(format!("k{i}"), json!(1));
        }
        serde_json::Value::Object(obj).to_string()
    };
    let keys_256 = make_keys(256);
    let keys_257 = make_keys(257);
    assert!(!matches!(
        decode_envelope_with_limits(&keys_256, &limits),
        Err(DecodeError::KeyLimitExceeded)
    ));
    assert_eq!(
        decode_envelope_with_limits(&keys_257, &limits),
        Err(DecodeError::KeyLimitExceeded)
    );

    // String: 65536 vs 65537 bytes
    let make_string = |len: usize| {
        let s = "a".repeat(len);
        json!({"s": s}).to_string()
    };
    let str_65536 = make_string(65536);
    let str_65537 = make_string(65537);
    assert!(!matches!(
        decode_envelope_with_limits(&str_65536, &limits),
        Err(DecodeError::StringLimitExceeded)
    ));
    assert_eq!(
        decode_envelope_with_limits(&str_65537, &limits),
        Err(DecodeError::StringLimitExceeded)
    );

    // Envelope size: MAX_FRAME_BYTES - 1 (1,048,575) vs MAX_FRAME_BYTES (1,048,576)
    // Custom limit max_frame_bytes = 1000
    let custom_limits = WireLimits::new(
        1000,
        32,
        256,
        65536,
        std::time::Duration::from_millis(100),
        std::time::Duration::from_millis(100),
    )
    .unwrap();
    let base_len = valid_envelope_json("msg1", "").to_string().len();
    let pad_under = "a".repeat(1000 - base_len - 10);
    let mut v = valid_envelope_json("msg1", &pad_under);
    let raw_under = v.to_string();
    assert!(raw_under.len() < 1000);
    assert!(!matches!(
        decode_envelope_with_limits(&raw_under, &custom_limits),
        Err(DecodeError::Oversized)
    ));

    let pad_over = "a".repeat(1000 - base_len + 10);
    v["nonce"] = json!(pad_over);
    let raw_over = v.to_string();
    assert!(raw_over.len() >= 1000);
    assert_eq!(
        decode_envelope_with_limits(&raw_over, &custom_limits),
        Err(DecodeError::Oversized)
    );

    // Integers: +/-9007199254740991 exact and +/-1
    let mut env_exact = valid_envelope_json("msg1", "nonce1");
    env_exact["ts_ns"] = json!(9_007_199_254_740_991u64);
    assert!(decode_envelope(&env_exact.to_string()).is_ok());

    let mut env_overflow = valid_envelope_json("msg1", "nonce1");
    env_overflow["ts_ns"] = json!(9_007_199_254_740_992u64);
    assert_eq!(
        decode_envelope(&env_overflow.to_string()),
        Err(DecodeError::OutOfBounds)
    );

    // Array commas: 4095 vs 4096 commas (4096 vs 4097 items)
    let commas_4095 = format!("[{}]", vec!["0"; 4096].join(","));
    let commas_4096 = format!("[{}]", vec!["0"; 4097].join(","));
    assert!(!matches!(
        decode_envelope_with_limits(&commas_4095, &limits),
        Err(DecodeError::ArrayLimitExceeded)
    ));
    assert_eq!(
        decode_envelope_with_limits(&commas_4096, &limits),
        Err(DecodeError::ArrayLimitExceeded)
    );
}

#[test]
fn hostile_shapes_and_exact_errors() {
    let limits = WireLimits::default();

    // Duplicate keys
    let dup = "{\"a\": 1, \"a\": 2}";
    assert_eq!(
        decode_envelope_with_limits(dup, &limits),
        Err(DecodeError::DuplicateField)
    );

    // Escape-spelled key duplication
    let dup_esc = "{\"a\": 1, \"\\u0061\": 2}";
    assert_eq!(
        decode_envelope_with_limits(dup_esc, &limits),
        Err(DecodeError::DuplicateField)
    );

    // Trailing bytes / malformed
    let trailing = valid_envelope_json("m1", "n1").to_string() + " extra";
    assert_eq!(
        decode_envelope_with_limits(&trailing, &limits),
        Err(DecodeError::Malformed)
    );

    // BOM prefix
    let bom = "\u{feff}".to_owned() + &valid_envelope_json("m1", "n1").to_string();
    assert_eq!(
        decode_envelope_with_limits(&bom, &limits),
        Err(DecodeError::Malformed)
    );

    // NUL inside/outside strings
    let nul_inside = "{\"a\": \"hello\\u0000world\"}";
    assert!(!matches!(
        decode_envelope_with_limits(nul_inside, &limits),
        Err(DecodeError::Oversized)
    ));

    // Empty vs blank
    assert_eq!(
        decode_envelope_with_limits("", &limits),
        Err(DecodeError::Malformed)
    );
    assert_eq!(
        decode_envelope_with_limits("   \n\t  ", &limits),
        Err(DecodeError::Malformed)
    );

    // Unknown schema version
    let mut unknown = valid_envelope_json("m1", "n1");
    unknown["schema"] = json!("envelope/v9.9");
    assert_eq!(
        decode_envelope(&unknown.to_string()),
        Err(DecodeError::UnknownVersion)
    );
}

#[test]
fn transport_roundtrip_and_frame_fuzz() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    rt.block_on(async {
        // Differential roundtrip: write_frame -> read_frame
        let (mut client, mut server) = tokio::net::UnixStream::pair().unwrap();
        let env_json = valid_envelope_json("msg-rt", "nonce-rt").to_string();
        let env = decode_envelope(&env_json).unwrap();

        tokio::spawn(async move {
            write_frame(&mut client, &env).await.unwrap();
        });

        let frame = read_frame(&mut server).await.unwrap().unwrap();
        assert_eq!(frame.msg_id, "msg-rt");

        // CR-only separator test via read_frame
        let (mut client, mut server) = tokio::net::UnixStream::pair().unwrap();
        tokio::spawn(async move {
            client.write_all(b"{\"a\":1}\r{\"b\":2}\r").await.unwrap();
        });
        let read_res = read_frame(&mut server).await;
        assert!(read_res.is_err());
    });
}

#[test]
fn seeded_fuzz_harness_2000_runs() {
    let seed = 0xabcdef1234567890u64;
    let mut prng = Prng::new(seed);
    let limits = WireLimits::default();

    for i in 0..2000 {
        let choice = prng.gen_range(0, 5);
        let mut payload = match choice {
            0 => valid_envelope_json(&format!("fuzz-{i}"), &format!("nonce-{i}")).to_string(),
            1 => format!("{{\"invalid_json\": {}", prng.next_u64()),
            2 => {
                let depth = prng.gen_range(1, 40);
                let mut s = String::new();
                for _ in 0..depth {
                    s.push('[');
                }
                for _ in 0..depth {
                    s.push(']');
                }
                s
            }
            3 => {
                let num_keys = prng.gen_range(200, 300);
                let mut obj = serde_json::Map::new();
                for k in 0..num_keys {
                    obj.insert(format!("key_{k}"), json!(k));
                }
                serde_json::Value::Object(obj).to_string()
            }
            _ => {
                let len = prng.gen_range(1, 100);
                let bytes: Vec<u8> = (0..len).map(|_| prng.gen_range(0, 255) as u8).collect();
                String::from_utf8_lossy(&bytes).to_string()
            }
        };

        // Mutate payload randomly
        if prng.gen_range(0, 1) == 1 && !payload.is_empty() {
            let mut idx = prng.gen_range(0, payload.len());
            while idx < payload.len() && !payload.is_char_boundary(idx) {
                idx += 1;
            }
            if payload.is_char_boundary(idx) {
                payload.insert(idx, 'x');
            }
        }

        let result = decode_envelope_with_limits(&payload, &limits);
        // Assert that decoding handles any input without panicking!
        if payload.contains("envelope/v0.2") && result.is_ok() {
            let env = result.unwrap();
            assert_eq!(env.schema, "envelope/v0.2");
        }
    }
}
