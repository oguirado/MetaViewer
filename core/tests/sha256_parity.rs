use metaviewer_core::journal::{sha256_hex, StreamingSha256};
use sha2::{Digest, Sha256};
use std::{hint::black_box, time::Instant};

// Fixed seeds make failures reproducible without another dependency.
struct Random(u64);
impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.next() as u8).collect()
    }
}

fn reference(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn streamed(bytes: &[u8], rng: &mut Random, cap: usize) -> String {
    let mut h = StreamingSha256::new();
    h.update(&[]);
    let mut pos = 0;
    while pos < bytes.len() {
        let size = 1 + rng.next() as usize % cap.min(bytes.len() - pos);
        h.update(&bytes[pos..pos + size]);
        h.update(&[]);
        pos += size;
    }
    h.finalize_hex()
}

#[test]
fn nist_vectors() {
    for (bytes, expected) in [
        (
            b"".as_slice(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ),
        (
            b"abc".as_slice(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        ),
        (
            b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".as_slice(),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        ),
    ] {
        assert_eq!(sha256_hex(bytes), expected);
        assert_eq!(streamed(bytes, &mut Random(123), 17), expected);
    }
    let million_a = vec![b'a'; 1_000_000];
    let expected = "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0";
    assert_eq!(sha256_hex(&million_a), expected);
    assert_eq!(streamed(&million_a, &mut Random(456), 1000), expected);
}

#[test]
fn parity_random_lengths_0_to_4097() {
    let mut rng = Random(0xc0ff_ee12_dead_beef);
    for len in 0..=4097 {
        let bytes = rng.bytes(len);
        let expected = reference(&bytes);
        assert_eq!(sha256_hex(&bytes), expected, "one-shot len={len}");
        assert_eq!(
            streamed(&bytes, &mut rng, 257),
            expected,
            "streamed len={len}"
        );
    }
}

#[test]
fn parity_chunk_boundaries() {
    let mut rng = Random(0x5ca1_a256_2026);
    for len in [55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 4097] {
        let bytes = rng.bytes(len);
        let expected = reference(&bytes);
        for step in [1, 7, 55, 56, 63, 64, 65, 257] {
            let mut h = StreamingSha256::default();
            for chunk in bytes.chunks(step) {
                h.update(chunk);
                h.update(&[]);
            }
            assert_eq!(h.finalize_hex(), expected, "len={len} step={step}");
        }
        for boundary in [55, 56, 63, 64, 65] {
            if boundary <= len {
                let mut h = StreamingSha256::new();
                h.update(&bytes[..boundary]);
                h.update(&bytes[boundary..]);
                assert_eq!(h.finalize_hex(), expected, "split={boundary} len={len}");
            }
        }
    }
}

#[test]
fn parity_frame_random_chunks() {
    let mut rng = Random(0x3456_0000_1280_0900);
    let bytes = rng.bytes(3_456_000);
    let expected = reference(&bytes);
    assert_eq!(sha256_hex(&bytes), expected);
    for cap in [129, 8192, 131_072] {
        assert_eq!(streamed(&bytes, &mut rng, cap), expected, "cap={cap}");
    }
}

#[test]
#[ignore = "opt-in host performance measurement; run in release with --ignored --nocapture"]
fn bench_sha256_3_456_000_bytes() {
    let bytes = Random(0xb100_ef50_2026_0025).bytes(3_456_000);
    let expected = reference(&bytes);
    // [MEASURED] Committed implementation, same release profile and host, before edits:
    // p50=5.288 ms, p95=5.511 ms; 3 warmups, 21 runs, 3,456,000 bytes.
    println!("before [MEASURED] p50_ms=5.288 p95_ms=5.511 warmups=3 runs=21");
    for (name, hash) in [
        ("scalar", sha256_hex as fn(&[u8]) -> String),
        ("sha2", reference),
    ] {
        for _ in 0..3 {
            assert_eq!(black_box(hash(black_box(&bytes))), expected);
        }
        let mut ms = Vec::with_capacity(21);
        for _ in 0..21 {
            let start = Instant::now();
            let digest = black_box(hash(black_box(&bytes)));
            ms.push(start.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(digest, expected);
        }
        ms.sort_by(f64::total_cmp);
        // Nearest-rank percentiles for 21 samples.
        println!(
            "{name} [MEASURED] p50_ms={:.3} p95_ms={:.3} warmups=3 runs=21",
            ms[10], ms[19]
        );
        if name == "scalar" {
            assert!(ms[10] <= 15.0, "scalar p50 exceeded 15 ms [TARGET]");
        }
    }
}
