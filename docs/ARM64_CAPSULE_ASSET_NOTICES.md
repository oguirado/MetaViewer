# ARM64 capsule asset notices

Draft for local-asset setup; not a redistribution clearance or source offer.
MetaViewer and its original guest-command broker remain AGPL-3.0-only.
External asset licenses do not change MetaViewer's license or grant rights to private components.
The current setup references operator-local artifacts with `redistribute=false`; these binaries/images are not added to the public repository or bundled by this draft.

## Recorded assets

SHA256 values below identify measured local bytes unless explicitly marked as a retained image identifier.

| Asset | Identity | License evidence and status |
|---|---|---|
| Firecracker ARM64 | v1.17.0; `fe726e0b43c04363ac07e358be4dee982c3947c65ed3ae10c770fef5e1cd756c` [MEASURED] | Apache-2.0; upstream release LICENSE, NOTICE and THIRD-PARTY must remain together when conveying this asset. THIRD-PARTY contains Chromium BSD terms; NOTICE also identifies libseccomp LGPLv2.1 build-time/cBPF content. |
| Linux guest kernel | Linux 6.18.52 Image; `43597af54cfbca19bcd7d7d91666a0a55e5a33632eada679827b9ac43393edcf` [MEASURED] | Kernel COPYING: GPL-2.0-only with Linux-syscall-note; other per-file licenses also apply. Built from the pinned upstream archive and recorded configuration. |
| BusyBox executable | Ubuntu busybox-static package 1:1.36.1-6ubuntu3.1 arm64; `52151e7f322f926b64049cdaa1410dc3ea6485525e0624b05813791c219ae933` [MEASURED] | Installed package copyright declares GNU GPL version 2. The executable is named busybox; package naming is not an additional executable path guarantee. |
| Original guest-command broker | `9c6e47d2fd7dd7b609edda29139d02f9637155ccc67163939f4eb9daf3de98e0` [MEASURED] | AGPL-3.0-only, declared in its public Cargo.toml; Cargo.lock and third-party runtime notices must accompany any future distribution assessment. |
| Operator VM image | Docker image ID `sha256:91a8a4b921aa078450cdeb9c97fecc7cfc7eac457dd7648def6343f495be3730` [CITED: retained VM receipt] | License, origin, complete component/source inventory and redistribution permission are UNKNOWN. Operator-local use only; no download/import/redistribution permission is implied. |
| Private native/VE/Wender/OpenSuperficies tools | Existing operator-provided compiled tools, under their separate grants | Not relicensed by MetaViewer; existing judge/evaluation authorization is not a public source or redistribution grant. No private source is incorporated into these notices. |

Firecracker provenance: official [v1.17.0 release](https://github.com/firecracker-microvm/firecracker/releases/tag/v1.17.0), archive SHA256 `e351ebe4f7a16b5873bbd51005d2e6767103cff4d5ebc829df2d3f95a93e2256` [MEASURED against retained receipt].
Kernel provenance: [Linux 6.18.52 source archive](https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.18.52.tar.xz), SHA256 `2b69564f7d4fea0c859b1959ba33709ee6e9139bd100e30a853b57159a8221b8` [MEASURED]. The retained source acquisition verified a published checksum, not a source signature; do not describe it as signature-verified.

## Broker dependency notices

The actual Cargo.lock SHA256 is `1393b1c67a8410d158ac0c379c42df9c1587a33775598a475550dfa9e4917ce5` [MEASURED].
Its 21 registry packages [MEASURED] have locally retained source manifests/license files and registry archives whose hashes match the lock checksums. The lock graph includes build/proc-macro packages; this is not a claim that every package is linked into the final executable.

| Declared license expression | Locked packages |
|---|---|
| MIT OR Apache-2.0 | block-buffer 0.10.4; cfg-if 1.0.5; cpufeatures 0.2.17; crypto-common 0.1.7; digest 0.10.7; itoa 1.0.18; libc 0.2.191; proc-macro2 1.0.107; quote 1.0.47; serde/serde_core/serde_derive 1.0.229; serde_json 1.0.154; sha2 0.10.9; syn 3.0.9; typenum 1.20.1 [MEASURED manifests] |
| MIT | generic-array 0.14.7; zmij 1.0.23 [MEASURED manifests] |
| Unlicense OR MIT | memchr 2.8.3 [MEASURED manifest] |
| (MIT OR Apache-2.0) AND Unicode-3.0 | unicode-ident 1.0.27 [MEASURED manifest]; retain the Unicode notice in addition to the chosen alternative license. |
| MIT/Apache-2.0 | version_check 0.9.5 [MEASURED manifest spelling]; retain its upstream license texts rather than silently changing that declaration. |

Cargo metadata is not a complete binary license inventory. The broker was built for the GNU target with static CRT, and its symbol table contains __libc_start_main. A future redistributor must identify the exact C runtime, Rust standard-library/compiler runtime contributions and applicable exceptions/notices. The local glibc package identifies LGPL-2.1-or-later for most library code with further component terms; the full static-link compliance gate is not closed by this draft.

## Before any future redistribution

- Preserve applicable copyright notices and complete license texts; for Apache-2.0 retain applicable NOTICE material and mark modifications as required by its section 4.
- For kernel/BusyBox object-code conveyance, satisfy GPLv2 section 3 using a valid corresponding-source route. Keep the exact source, patches, generated build configuration and build scripts needed for the conveyed artifact. A generic upstream homepage or this document is not a source offer.
- For broker conveyance, satisfy AGPLv3 section 6; assess section 13 when offering a modified program for remote network interaction. Preserve the separate dependency notices. This draft supplies no invented source URL or written offer.
- For statically linked LGPL-covered runtime content, resolve LGPLv2.1 section 6 requirements, including the applicable modification/relinking route and notices; do not treat a Cargo license list as sufficient.
- Obtain the operator VM image's actual provenance, component licenses, source obligations and distribution authorization before enabling redistribution. Unknown does not mean permissive.
- Resolve exact build/source correspondence: the retained broker source pins match code/lock files, but its old Cargo.toml hash differs from the current public manifest. Preserve that discrepancy; rebuild or document it before claiming a complete corresponding-source bundle.
- Private components remain outside public source packaging. Any proposed distribution or combination requires its own authorized license review; existing local evaluation grants are not expanded.

No binary blob, private source, private host path, credential, or new distribution permission is supplied by this notice.
