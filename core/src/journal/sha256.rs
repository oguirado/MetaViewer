//! Approved SHA-256 implementation; the public digest format stays lowercase hex.
#[cfg(test)]
use sha2::{Digest, Sha256 as RefSha256};

macro_rules! rotr {
    ($x:ident, $n:expr) => {
        (($x >> $n) | ($x << (32 - $n)))
    };
}

macro_rules! s0 {
    ($x:ident) => {
        (rotr!($x, 7) ^ rotr!($x, 18) ^ ($x >> 3))
    };
}

macro_rules! s1 {
    ($x:ident) => {
        (rotr!($x, 17) ^ rotr!($x, 19) ^ ($x >> 10))
    };
}

macro_rules! ep0 {
    ($x:ident) => {
        (rotr!($x, 2) ^ rotr!($x, 13) ^ rotr!($x, 22))
    };
}

macro_rules! ep1 {
    ($x:ident) => {
        (rotr!($x, 6) ^ rotr!($x, 11) ^ rotr!($x, 25))
    };
}

macro_rules! rnd {
    ($a:ident, $b:ident, $c:ident, $d:ident, $e:ident, $f:ident, $g:ident, $h:ident, $w:expr, $k:expr) => {{
        let t1 = (($h as u64)
            + (ep1!($e) as u64)
            + (($g ^ ($e & ($f ^ $g))) as u64)
            + ($k as u64)
            + ($w as u64)) as u32;
        $d = (($d as u64) + (t1 as u64)) as u32;
        $h = ((t1 as u64) + (ep0!($a) as u64) + ((($a & ($b | $c)) | ($b & $c)) as u64)) as u32;
    }};
}

macro_rules! sched {
    ($w0:ident, $w1:ident, $w9:ident, $w14:ident) => {{
        $w0 = (($w0 as u64) + (s0!($w1) as u64) + ($w9 as u64) + (s1!($w14) as u64)) as u32;
        $w0
    }};
}

#[inline(always)]
fn compress_block(state: &mut [u32; 8], block: &[u8; 64]) {
    let mut w0 = ((block[0] as u32) << 24)
        | ((block[1] as u32) << 16)
        | ((block[2] as u32) << 8)
        | (block[3] as u32);
    let mut w1 = ((block[4] as u32) << 24)
        | ((block[5] as u32) << 16)
        | ((block[6] as u32) << 8)
        | (block[7] as u32);
    let mut w2 = ((block[8] as u32) << 24)
        | ((block[9] as u32) << 16)
        | ((block[10] as u32) << 8)
        | (block[11] as u32);
    let mut w3 = ((block[12] as u32) << 24)
        | ((block[13] as u32) << 16)
        | ((block[14] as u32) << 8)
        | (block[15] as u32);
    let mut w4 = ((block[16] as u32) << 24)
        | ((block[17] as u32) << 16)
        | ((block[18] as u32) << 8)
        | (block[19] as u32);
    let mut w5 = ((block[20] as u32) << 24)
        | ((block[21] as u32) << 16)
        | ((block[22] as u32) << 8)
        | (block[23] as u32);
    let mut w6 = ((block[24] as u32) << 24)
        | ((block[25] as u32) << 16)
        | ((block[26] as u32) << 8)
        | (block[27] as u32);
    let mut w7 = ((block[28] as u32) << 24)
        | ((block[29] as u32) << 16)
        | ((block[30] as u32) << 8)
        | (block[31] as u32);
    let mut w8 = ((block[32] as u32) << 24)
        | ((block[33] as u32) << 16)
        | ((block[34] as u32) << 8)
        | (block[35] as u32);
    let mut w9 = ((block[36] as u32) << 24)
        | ((block[37] as u32) << 16)
        | ((block[38] as u32) << 8)
        | (block[39] as u32);
    let mut w10 = ((block[40] as u32) << 24)
        | ((block[41] as u32) << 16)
        | ((block[42] as u32) << 8)
        | (block[43] as u32);
    let mut w11 = ((block[44] as u32) << 24)
        | ((block[45] as u32) << 16)
        | ((block[46] as u32) << 8)
        | (block[47] as u32);
    let mut w12 = ((block[48] as u32) << 24)
        | ((block[49] as u32) << 16)
        | ((block[50] as u32) << 8)
        | (block[51] as u32);
    let mut w13 = ((block[52] as u32) << 24)
        | ((block[53] as u32) << 16)
        | ((block[54] as u32) << 8)
        | (block[55] as u32);
    let mut w14 = ((block[56] as u32) << 24)
        | ((block[57] as u32) << 16)
        | ((block[58] as u32) << 8)
        | (block[59] as u32);
    let mut w15 = ((block[60] as u32) << 24)
        | ((block[61] as u32) << 16)
        | ((block[62] as u32) << 8)
        | (block[63] as u32);

    let mut a = state[0];
    let mut b = state[1];
    let mut c = state[2];
    let mut d = state[3];
    let mut e = state[4];
    let mut f = state[5];
    let mut g = state[6];
    let mut h = state[7];

    rnd!(a, b, c, d, e, f, g, h, w0, 0x428a2f98);
    rnd!(h, a, b, c, d, e, f, g, w1, 0x71374491);
    rnd!(g, h, a, b, c, d, e, f, w2, 0xb5c0fbcf);
    rnd!(f, g, h, a, b, c, d, e, w3, 0xe9b5dba5);
    rnd!(e, f, g, h, a, b, c, d, w4, 0x3956c25b);
    rnd!(d, e, f, g, h, a, b, c, w5, 0x59f111f1);
    rnd!(c, d, e, f, g, h, a, b, w6, 0x923f82a4);
    rnd!(b, c, d, e, f, g, h, a, w7, 0xab1c5ed5);
    rnd!(a, b, c, d, e, f, g, h, w8, 0xd807aa98);
    rnd!(h, a, b, c, d, e, f, g, w9, 0x12835b01);
    rnd!(g, h, a, b, c, d, e, f, w10, 0x243185be);
    rnd!(f, g, h, a, b, c, d, e, w11, 0x550c7dc3);
    rnd!(e, f, g, h, a, b, c, d, w12, 0x72be5d74);
    rnd!(d, e, f, g, h, a, b, c, w13, 0x80deb1fe);
    rnd!(c, d, e, f, g, h, a, b, w14, 0x9bdc06a7);
    rnd!(b, c, d, e, f, g, h, a, w15, 0xc19bf174);

    rnd!(a, b, c, d, e, f, g, h, sched!(w0, w1, w9, w14), 0xe49b69c1);
    rnd!(h, a, b, c, d, e, f, g, sched!(w1, w2, w10, w15), 0xefbe4786);
    rnd!(g, h, a, b, c, d, e, f, sched!(w2, w3, w11, w0), 0x0fc19dc6);
    rnd!(f, g, h, a, b, c, d, e, sched!(w3, w4, w12, w1), 0x240ca1cc);
    rnd!(e, f, g, h, a, b, c, d, sched!(w4, w5, w13, w2), 0x2de92c6f);
    rnd!(d, e, f, g, h, a, b, c, sched!(w5, w6, w14, w3), 0x4a7484aa);
    rnd!(c, d, e, f, g, h, a, b, sched!(w6, w7, w15, w4), 0x5cb0a9dc);
    rnd!(b, c, d, e, f, g, h, a, sched!(w7, w8, w0, w5), 0x76f988da);
    rnd!(a, b, c, d, e, f, g, h, sched!(w8, w9, w1, w6), 0x983e5152);
    rnd!(h, a, b, c, d, e, f, g, sched!(w9, w10, w2, w7), 0xa831c66d);
    rnd!(g, h, a, b, c, d, e, f, sched!(w10, w11, w3, w8), 0xb00327c8);
    rnd!(f, g, h, a, b, c, d, e, sched!(w11, w12, w4, w9), 0xbf597fc7);
    rnd!(
        e,
        f,
        g,
        h,
        a,
        b,
        c,
        d,
        sched!(w12, w13, w5, w10),
        0xc6e00bf3
    );
    rnd!(
        d,
        e,
        f,
        g,
        h,
        a,
        b,
        c,
        sched!(w13, w14, w6, w11),
        0xd5a79147
    );
    rnd!(
        c,
        d,
        e,
        f,
        g,
        h,
        a,
        b,
        sched!(w14, w15, w7, w12),
        0x06ca6351
    );
    rnd!(b, c, d, e, f, g, h, a, sched!(w15, w0, w8, w13), 0x14292967);

    rnd!(a, b, c, d, e, f, g, h, sched!(w0, w1, w9, w14), 0x27b70a85);
    rnd!(h, a, b, c, d, e, f, g, sched!(w1, w2, w10, w15), 0x2e1b2138);
    rnd!(g, h, a, b, c, d, e, f, sched!(w2, w3, w11, w0), 0x4d2c6dfc);
    rnd!(f, g, h, a, b, c, d, e, sched!(w3, w4, w12, w1), 0x53380d13);
    rnd!(e, f, g, h, a, b, c, d, sched!(w4, w5, w13, w2), 0x650a7354);
    rnd!(d, e, f, g, h, a, b, c, sched!(w5, w6, w14, w3), 0x766a0abb);
    rnd!(c, d, e, f, g, h, a, b, sched!(w6, w7, w15, w4), 0x81c2c92e);
    rnd!(b, c, d, e, f, g, h, a, sched!(w7, w8, w0, w5), 0x92722c85);
    rnd!(a, b, c, d, e, f, g, h, sched!(w8, w9, w1, w6), 0xa2bfe8a1);
    rnd!(h, a, b, c, d, e, f, g, sched!(w9, w10, w2, w7), 0xa81a664b);
    rnd!(g, h, a, b, c, d, e, f, sched!(w10, w11, w3, w8), 0xc24b8b70);
    rnd!(f, g, h, a, b, c, d, e, sched!(w11, w12, w4, w9), 0xc76c51a3);
    rnd!(
        e,
        f,
        g,
        h,
        a,
        b,
        c,
        d,
        sched!(w12, w13, w5, w10),
        0xd192e819
    );
    rnd!(
        d,
        e,
        f,
        g,
        h,
        a,
        b,
        c,
        sched!(w13, w14, w6, w11),
        0xd6990624
    );
    rnd!(
        c,
        d,
        e,
        f,
        g,
        h,
        a,
        b,
        sched!(w14, w15, w7, w12),
        0xf40e3585
    );
    rnd!(b, c, d, e, f, g, h, a, sched!(w15, w0, w8, w13), 0x106aa070);

    rnd!(a, b, c, d, e, f, g, h, sched!(w0, w1, w9, w14), 0x19a4c116);
    rnd!(h, a, b, c, d, e, f, g, sched!(w1, w2, w10, w15), 0x1e376c08);
    rnd!(g, h, a, b, c, d, e, f, sched!(w2, w3, w11, w0), 0x2748774c);
    rnd!(f, g, h, a, b, c, d, e, sched!(w3, w4, w12, w1), 0x34b0bcb5);
    rnd!(e, f, g, h, a, b, c, d, sched!(w4, w5, w13, w2), 0x391c0cb3);
    rnd!(d, e, f, g, h, a, b, c, sched!(w5, w6, w14, w3), 0x4ed8aa4a);
    rnd!(c, d, e, f, g, h, a, b, sched!(w6, w7, w15, w4), 0x5b9cca4f);
    rnd!(b, c, d, e, f, g, h, a, sched!(w7, w8, w0, w5), 0x682e6ff3);
    rnd!(a, b, c, d, e, f, g, h, sched!(w8, w9, w1, w6), 0x748f82ee);
    rnd!(h, a, b, c, d, e, f, g, sched!(w9, w10, w2, w7), 0x78a5636f);
    rnd!(g, h, a, b, c, d, e, f, sched!(w10, w11, w3, w8), 0x84c87814);
    rnd!(f, g, h, a, b, c, d, e, sched!(w11, w12, w4, w9), 0x8cc70208);
    rnd!(
        e,
        f,
        g,
        h,
        a,
        b,
        c,
        d,
        sched!(w12, w13, w5, w10),
        0x90befffa
    );
    rnd!(
        d,
        e,
        f,
        g,
        h,
        a,
        b,
        c,
        sched!(w13, w14, w6, w11),
        0xa4506ceb
    );
    rnd!(
        c,
        d,
        e,
        f,
        g,
        h,
        a,
        b,
        sched!(w14, w15, w7, w12),
        0xbef9a3f7
    );
    rnd!(b, c, d, e, f, g, h, a, sched!(w15, w0, w8, w13), 0xc67178f2);

    state[0] = ((state[0] as u64) + (a as u64)) as u32;
    state[1] = ((state[1] as u64) + (b as u64)) as u32;
    state[2] = ((state[2] as u64) + (c as u64)) as u32;
    state[3] = ((state[3] as u64) + (d as u64)) as u32;
    state[4] = ((state[4] as u64) + (e as u64)) as u32;
    state[5] = ((state[5] as u64) + (f as u64)) as u32;
    state[6] = ((state[6] as u64) + (g as u64)) as u32;
    state[7] = ((state[7] as u64) + (h as u64)) as u32;
}

pub struct StreamingSha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total_len: u64,
}

impl Default for StreamingSha256 {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamingSha256 {
    pub fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buf: [0u8; 64],
            buf_len: 0,
            total_len: 0,
        }
    }

    pub fn update(&mut self, mut input: &[u8]) {
        #[cfg(test)]
        let t0 = std::time::Instant::now();
        self.total_len += input.len() as u64;
        if self.buf_len > 0 {
            let need = 64 - self.buf_len;
            if input.len() < need {
                self.buf[self.buf_len..self.buf_len + input.len()].copy_from_slice(input);
                self.buf_len += input.len();
                #[cfg(test)]
                crate::journal::STAGE_TIMINGS.with(|cell| {
                    let mut s = cell.get();
                    s.hash_ns += t0.elapsed().as_nanos();
                    cell.set(s);
                });
                return;
            }
            self.buf[self.buf_len..64].copy_from_slice(&input[..need]);
            let block = self.buf;
            compress_block(&mut self.state, &block);
            self.buf_len = 0;
            input = &input[need..];
        }
        while let Some((block, rest)) = input.split_first_chunk::<64>() {
            compress_block(&mut self.state, block);
            input = rest;
        }
        if !input.is_empty() {
            self.buf[..input.len()].copy_from_slice(input);
            self.buf_len = input.len();
        }
        #[cfg(test)]
        crate::journal::STAGE_TIMINGS.with(|cell| {
            let mut s = cell.get();
            s.hash_ns += t0.elapsed().as_nanos();
            cell.set(s);
        });
    }

    pub fn finalize_hex(mut self) -> String {
        #[cfg(test)]
        let t0 = std::time::Instant::now();
        let bit_len = self.total_len * 8;
        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;
        if self.buf_len > 56 {
            self.buf[self.buf_len..64].fill(0);
            let block = self.buf;
            compress_block(&mut self.state, &block);
            self.buf_len = 0;
        }
        self.buf[self.buf_len..56].fill(0);
        self.buf[56..64].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buf;
        compress_block(&mut self.state, &block);

        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut out = [0u8; 64];
        for (i, &word) in self.state.iter().enumerate() {
            let b0 = ((word >> 24) & 0xff) as usize;
            let b1 = ((word >> 16) & 0xff) as usize;
            let b2 = ((word >> 8) & 0xff) as usize;
            let b3 = (word & 0xff) as usize;
            let base = i * 8;
            out[base] = HEX[b0 >> 4];
            out[base + 1] = HEX[b0 & 0x0f];
            out[base + 2] = HEX[b1 >> 4];
            out[base + 3] = HEX[b1 & 0x0f];
            out[base + 4] = HEX[b2 >> 4];
            out[base + 5] = HEX[b2 & 0x0f];
            out[base + 6] = HEX[b3 >> 4];
            out[base + 7] = HEX[b3 & 0x0f];
        }
        let hex_str = String::from_utf8(out.to_vec()).unwrap();
        #[cfg(test)]
        crate::journal::STAGE_TIMINGS.with(|cell| {
            let mut s = cell.get();
            s.hash_ns += t0.elapsed().as_nanos();
            if self.total_len >= 1_000_000 {
                s.hash_calls_3mb += 1;
            }
            cell.set(s);
        });
        hex_str
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = StreamingSha256::new();
    hasher.update(bytes);
    hasher.finalize_hex()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_sha256_matches_reference_sha2_across_boundaries() {
        for len in [
            0usize, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 4097, 131_073,
        ] {
            let data: Vec<u8> = (0..len)
                .map(|i| (i.wrapping_mul(37) ^ (i >> 3)) as u8)
                .collect();
            let expected = format!("{:x}", RefSha256::digest(&data));
            assert_eq!(sha256_hex(&data), expected, "mismatch at len={len}");
            for chunk_size in [1usize, 7, 63, 64, 65, 512, 8192] {
                let mut h = StreamingSha256::new();
                for chunk in data.chunks(chunk_size) {
                    h.update(chunk);
                }
                assert_eq!(
                    h.finalize_hex(),
                    expected,
                    "chunked mismatch len={len} chunk={chunk_size}"
                );
            }
        }
    }
}
