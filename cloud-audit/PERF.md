# Performance audit: a wall of 6 animated capsules

Base: `ci/assets-375b9be79` at `375b9be`. This is a report only. No product code was changed.

## Scope and method

- Scenario: 6 capsules, each producing 10 distinct frames per second, so 60 frames/s in total
  [TARGET]. The frame is 1280x900 RGB24, which is 3 456 000 B [CITED `daemon/environment.go:226`
  comment, `capsule/identity_profiles.go:118`]. Animated content means no frame is deduplicated.
- Host: 4 vCPU Intel Xeon at 2.1 GHz with `sha_ni`, Go 1.26.0, Rust 1.97 `--release`, Node 22.
  There is no display stack, no GPU, no Docker and no KVM.
- Throwaway benchmarks were not committed:
  - Go `testing.B` in package `frames`. It uses the production `PublishConfig` and `Budget`
    (`daemon/environment.go:208`, `:229`) on a tmpfs root under `/dev/shm`.
  - A Rust integration test that drives the real `Journal::create`, `retain_frame_witness` and
    `append` with 1, 6 and 12 live surfaces, on ext4 under `/tmp`.
  - Node microbenchmarks for the Electron copy, hash and clone steps.
- Labels:
  - **Measured** means a benchmark ran the code or the identical primitive.
  - **Read only** means the cost comes from reading the code, sometimes combined with a measured
    primitive cost.
  - Projections to 60 frames/s are arithmetic on measured numbers, marked [TARGET].
- No finding raises a budget. Costs under 1 % of a frame are left out, except where the brief
  asked for them (the journal state clone).

## Cost per frame by stage (6 capsules, ring mode, one 3.4 MB frame)

| Stage | Where | Cost per frame | Basis |
|---|---|---|---|
| Ring read: 2 slots read and hashed, best slot copied | `daemon-adapter/internal/frames/ringsource.go:240-272` | ~6.4 ms [TARGET] (2 x 2.24 ms SHA-256 + 2 x 3.4 MB alloc/copy) | Read only, primitive costs measured |
| Publisher: hash again, plan the budget, tmpfs write, link | `frames/publisher.go:419-812` | 4.61 ms [MEASURED] (hash 2.65 ms [MEASURED]) | Measured `BenchmarkPublishRaw6` |
| frame_ready JSON, adapter to core IPC | `frames/subscriptions.go:677` | small JSON; pixels go by tmpfs path | Read only, below 1 % |
| Core: read shm into Vec + verify SHA-256 | `core/src/serve/mod.rs:837-848`, `core/src/journal/sha256.rs` | 12.2 ms hash [MEASURED] + ~1 ms copy [MEASURED] | Measured |
| Core: write frame witness artifact to disk | `core/src/journal/mod.rs:3091` (`publish_unsynced`), called from `serve/mod.rs:955` | ~10 ms on ext4, no fsync [TARGET] (22.6 ms retain minus 12.2 ms rehash [MEASURED]) | Measured |
| Core: journal append (state clone, reducer rerun, snapshots, event file, checkpoint) | `core/src/journal/mod.rs:3112-3391` | 0.41 ms [MEASURED] | Measured |
| Electron main: read, 3 extra copies, sha256, port clone | `ui/electron/hostBindings.js:390`, `:403`, `frameReader.js:804`, `:809`, `framePort.js:710-728` | ~5-13 ms [MEASURED, Node proxy] + 2.28 ms hash [MEASURED] | Proxy measured |
| Renderer: RGB to RGBA, putImageData | `ui/src/frames/displayPortRouter.js:209-214` | 3.5-3.8 ms conversion [MEASURED, proxy]; paint cannot be measured | Proxy measured |

The same frame is fully hashed 5 times end to end in ring mode: twice in the ring read, once in the
publisher, once in core and once in Electron main [read only, count]. It is copied as a whole at
least 8 times: ring payload, ring best copy, tmpfs publish, core Vec, core artifact, Electron alloc,
Electron subarray copy, Electron snapshot, plus the port clone.

## Findings ranked by gain per risk

### 1. Core uses a hand-rolled SHA-256 that is 5 times slower than the `sha2` crate it already ships
- Where: `core/src/journal/sha256.rs:1` ("Approved SHA-256 implementation"). It backs `sha256_hex`
  and `StreamingSha256`, which `VerifiedPixels::read_verified*` uses for every frame
  (`journal/mod.rs:920-1016`).
- Measured: 12.21 ms for `sha256_hex` and 13.32 ms for `StreamingSha256` over 3 456 000 B
  [MEASURED]. `sha2 = "=0.10.9"` (`core/Cargo.toml:13`) takes 2.40 ms on the same buffer
  [MEASURED], because it detects SHA-NI at runtime. Method: 10 iterations each, `--release`.
- At 60 frames/s: 732 ms CPU/s in core [TARGET], which is 73 % of a core. With `sha2` it drops to
  144 ms/s [TARGET]. The hash runs in `spawn_blocking` for frames of at least 512x512
  (`serve/mod.rs:1179`), so it does not block the current-thread runtime. It still costs CPU and
  adds 10 ms of latency to each frame.
- Smallest change: keep the public API and digest format, and implement both functions on top of
  `sha2::Sha256`. `sha2` is already a production dependency (`serve/canonical.rs:1`, `rewind.rs:6`,
  `rewind_flow.rs:7`), and `sha256.rs:3` already uses it as the test oracle.
- Risk: low technically. It needs maintainer sign-off because the file is marked "approved".
- **Small and safe: yes, after sign-off.**

### 2. Adapter ring mode hashes every frame three times and allocates two full buffers per capture
- Where:
  - `frames/ringsource.go:240` runs `make` for a full payload on every poll.
  - `:253` and `:259` read and SHA-256 **every** slot, and the ring has 2 slots
    (`displaytap_ring.go:88`, `:123-124`).
  - `:272` appends the best slot into a nil slice, which is a second allocation and copy.
  - `publisher.go:445` hashes the in-process payload again after `take` (`ringsource.go:332`).
- Measured: Go SHA-256 is 2.24 ms per frame [MEASURED, `BenchmarkSHA256Frame`]. Allocate plus copy
  is 0.94 ms, against 0.30 ms for a reused buffer [MEASURED]. The publisher's own hash is 2.65 ms
  per publish [MEASURED, `hash_us/op`].
- At 60 frames/s: 3 x 2.24 x 60 = 403 ms CPU/s on hashing [TARGET]. Garbage is 6.9 MB per frame,
  or 415 MB/s [TARGET], which drives GC.
- Smallest change:
  1. Read both 64 B slot headers first. Then read and hash only the newest valid slot, and fall
     back to the other slot on mismatch. This saves 1 hash per frame.
  2. Allocate `raw` with an exact size, or swap `payload` into `raw` instead of appending.
- Not proposed: skipping the publisher rehash at `:445` would save another hash, but it removes a
  defence check on an in-process handoff. That is a security decision.
- Gain: about 135-200 ms CPU/s [TARGET].
- Risk: low for (1) and (2). The seqlock check (`pre == post`) and the digest check stay per slot
  read.
- **Small and safe: yes, for (2). (1) is post-release.**

### 3. Electron main makes three avoidable full-frame copies per verified frame
- Where:
  - `ui/electron/hostBindings.js:390`: `Buffer.alloc(info.size + 1)` zero-fills the buffer.
  - `hostBindings.js:403`: `new Uint8Array(bytes.subarray(0,offset))` makes a copy.
  - `ui/electron/frameReader.js:809`: `new Uint8Array(received)` makes another copy.
- Measured with Node 22 proxies, same size, 30-60 iterations after warm-up:
  - zero-fill: 0.7-3.5 ms, against 0.17-0.2 ms for `allocUnsafe` [MEASURED];
  - the copy at `:403`: 1.3-4.6 ms [MEASURED];
  - the copy at `:809`: 0.9-2.7 ms [MEASURED].
- At 60 frames/s: about 175-650 ms/s of main-process CPU [TARGET].
- Smallest change: use `Buffer.allocUnsafe`, because the `offset !== info.size` check already
  proves every returned byte was written. Return the `subarray` view.
- Risk: low to medium. The copy at `frameReader.js:809` backs the "owned snapshot" argument in the
  comment at `:801-803`, so keep it if lease reuse is possible.
- Read only for correctness. The costs are proxy measurements.
- **Small and safe: yes, for `:390` and `:403`. `:809` is post-release.**

### 4. The renderer converts RGB24 to RGBA with the slow byte loop, though a faster one exists
- Where: `ui/src/frames/displayPortRouter.js:209-214`. The word-wise `convertRgb24ToRgba` is
  already exported from `ui/src/surfaces/tileScheduler.js` (around `:593` and `:613`).
- Measured: 3.5-3.8 ms against 2.4 ms per frame [MEASURED, Node proxy].
- At 60 frames/s: about 70 ms/s of renderer time saved [TARGET].
- Smallest change: call the existing helper. Risk: low, because its endianness guard exists.
- **Small and safe: yes.**

### 5. Every frame on any tile re-renders every tile, so the work grows with the square of the tile count
- Where:
  - `ui/src/App.vue:1477`: one global `presentationRevision` is bumped for every presentation.
  - `ui/src/core/hostAdapters.js:164-165`: the rows array is rebuilt for every frame notice.
  - The templates then call the per-tile witness 4 times per tile.
- At 6 tiles and 60 frames/s: up to 360 tile re-renders per second instead of 60 [TARGET].
- Read only. The real Vue and DOM cost cannot be measured without a display stack.
- Smallest change: keep a revision per surface and compute the witness once per tile.
- Risk: medium, because the witness-retention UI tests must be rerun.
- **Post-release.**

### 6. Core writes a 3.4 MB witness artifact per frame to the state disk while it holds the authority lock
- Where: `serve/mod.rs:955` calls `retain_in_authority`, which runs `journal/mod.rs:2979-3111`, and
  that runs `publish_unsynced(&path, bytes)` (`:3091`) into `$XDG_STATE_HOME/metaviewer/sessions/...`
  (`journal/mod.rs:3988`). This happens inside `frame()`, with the server mutex taken at
  `serve/mod.rs:1195`, on the current-thread runtime (`bin/metaviewer-core.rs:24`).
- Measured: plain `fs::write` of 3 456 000 B to ext4 takes 12.86 ms here [MEASURED]. The full
  `retain_frame_witness` takes 22.6 ms including a rehash [MEASURED].
- At 60 frames/s: about 600 ms/s of serve-thread time [TARGET], and 207 MB/s of disk writes
  [TARGET]. Fsync is batched by the worker with a 50 ms window and up to 8 frames
  (`journal/mod.rs:61-62`).
- Read only: I found no removal path for **committed** frame artifacts in `journal/mod.rs`. Only
  uncommitted ones are evicted (`:3056-3066`). If that holds, disk use grows by the same 207 MB/s
  for the whole session, and the 64 MiB archive budget does not count it. This needs confirmation
  by a maintainer or a long run.
- Smallest change: write the artifact to an unsynced temp file inside the existing `spawn_blocking`
  pre-verify step, and only link it under the lock.
- Risk: medium-high, because the journal ordering and recovery invariants (SW-0011, SW-0201) must
  hold.
- **Post-release.**

### 7. Publisher holds the global budget lock and every peer lock across the tmpfs write
- Where: `frames/publisher.go:533` (`lockGroup`) and `:599-612`, which locks every peer
  `Publisher`. These are held across `Openat`, the 3.4 MB `Write`, `link` and `unlink`
  (`:741-762`) and both `Lstat` calls (`:701`, `:766`).
- Measured: a tmpfs write of one frame takes 1.23 ms [MEASURED, `BenchmarkTmpfsWriteFrame`].
  Six goroutines publishing in parallel reach 1.49 ms per frame in aggregate, against 4.61 ms
  serial on 4 vCPU [MEASURED]. That gain exists because the hash runs before the lock.
- At 60 frames/s: at least 74 ms/s of fully serialised time [TARGET]. When 6 frames arrive
  together, the last one waits up to about 6 ms [TARGET].
- Smallest change: reserve the bytes in the budget under the lock, write the temp file outside it,
  then commit the link and evictions under the lock. The reservation keeps the 512 MiB limit exact.
- Risk: medium, because the budget accounting is subtle.
- **Post-release.**

### 8. Journal append clones and serialises the full state for every frame. CPU is small; archive budget is the real cost
- Where: `core/src/journal/mod.rs:3112-3391`.
  - `admission/mod.rs:1418` clones the state and applies it.
  - `journal/mod.rs:3132` clones the state again and reruns the reducer.
  - Three full `snapshot()` calls run at `:3135`, `:3136` and `:3169`. Each is `to_value`, then a
    sorted deep clone, then `to_vec` (`:1230-1249`, `admission/mod.rs:338`).
  - `to_value(state)` runs at `:3161`, and the event is canonicalised at `:3155`.
  - `archive_next` copies the whole event into a new preimage (`:1613`).
  - Each frame writes a new `events/<n>.json` (`:3340`) and a checkpoint (`:3366`).
- Measured over 600 frames, 64 B witnesses:

  | Live surfaces | clone | apply | one snapshot | snapshot size | append total | event file | archive charge |
  |---|---|---|---|---|---|---|---|
  | 1 | 1.1 µs | 1.9 µs | 12.0 µs | 498 B | 557 µs | 1 529 B | 2 027 B |
  | 6 | 2.2 µs | 2.7 µs | 32.1 µs | 1 908 B | 408 µs | 2 929 B | 4 837 B |
  | 12 | 4.1 µs | 4.6 µs | 61.6 µs | 3 592 B | 521 µs | 4 608 B | 8 200 B |

  All values in the table are [MEASURED].
- CPU: about 0.4 ms against roughly 24 ms of core work per frame [TARGET], so under 2 %. The state
  clone alone is under 1 %. It grows linearly with the capsule count.
- Archive: 64 MiB / 4 837 B = 13 870 frames [TARGET]. At 60 frames/s that is about 231 s, about
  3.9 min [TARGET], before `append` returns `Policy` (`:3174`). The charge per frame grows with the
  total capsule count, so total archive use grows with the square of the capsule count.
- Overlap with prior audits: `cloud-audit/JOURNAL.md` (F3, double state charge) on
  `cloud/audit-journal`, and `LIMITS.md` (100 000 replay entries, about 28 min at this rate) on
  `cloud/audit-limits`.
- Smallest change, with the 64 MiB limit unchanged: frame events record only the surface and frame
  delta and a hash of the prior state, not the full `state`.
- Risk: high. It needs a new event schema and its example pair first (contracts first), plus a
  replay change.
- **Post-release.** A cheaper CPU-only step is low risk but under 1 %: reuse the first snapshot for
  the third, removing `:3169`.

### 9. The legacy PNG path decodes and verifies at 13 ms per frame
- Where: `frames/publisher.go:395-417` and `:526`.
- Measured: 13.1 ms and 4.67 MB allocated per frame, 50 allocations [MEASURED,
  `BenchmarkPNGDecodeVerify`, 1280x900 frame, 438 KB PNG].
- At 60 frames/s: 786 ms CPU/s [TARGET].
- The fix already exists: ring mode. No small change is proposed. Read only on whether walls still
  use the legacy path in practice.

### 10. Full-frame structured clone over the Electron port without transfer (no small fix)
- Where: `ui/electron/framePort.js:710-728` and `:1327-1339`.
- MessagePortMain cannot transfer ArrayBuffers. A Node MessagePort clone of one frame takes
  1.0-1.4 ms, against 0.2 ms with transfer [MEASURED, proxy]. The real Electron IPC cost cannot be
  measured here.
- Fixing it needs an architecture decision, such as shared memory the renderer can map.
- **Post-release.**

## Checked and below 1 % of a frame
- Per-publish simulation copies in `publisher.go:585-643` grow with the number of surfaces:
  7.4 KB and 19 allocations with 1 surface, against 22.3 KB and 37 allocations with 6 [MEASURED].
  That is per capsule work that grows with the total capsule count, but it stays under 1 % of a
  4.6 ms publish.
- frame_ready JSON marshal (`subscriptions.go:677`) and stage statistics
  (`subscriptions.go:257-300`, capped at `maxStageSamples`).
- DISPLAY polling and per-frame `openPinned` in Electron. These cost latency, not CPU.

## Cannot be measured without a display stack
- Real capture producers: xpra, the display tap, VM pairs and the true frame rate.
- `putImageData` upload, GPU versus software canvas, compositing and frame pacing.
- Electron MessagePortMain serialise, IPC and deserialise cost, and Vue/DOM re-render cost.
- End-to-end latency, from capture to pixels on screen.
- The ext4 numbers come from this container's disk. A user's SSD may differ by several times.

## Small and safe before release
- Finding 1, after sign-off on the hash implementation.
- Finding 2(2): exact-size allocation for `raw`.
- Finding 3: `:390` and `:403`.
- Finding 4.

Everything else is post-release work.

---
Model: Claude (exact model identifier kept out of repository files by session policy). Reasoning effort: low.
