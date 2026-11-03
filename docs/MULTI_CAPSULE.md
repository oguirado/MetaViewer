# More than one capsule

The maintained setup is in [USER_GUIDE.md](USER_GUIDE.md#more-than-one-capsule)
and [INSTALL.md](INSTALL.md#concurrent-identities-and-ram-admission). This page
replaces an integration draft whose fixed ceiling and host performance claims
no longer describe the assembly.

The configured ceiling is `16` [CITED: `ui/electron/profilePicker.js`,
`daemon-adapter/internal/daemon/environment.go`]. This is an admission limit,
not a measured concurrency or frame-rate result. Available identities, profiles,
display slots and RAM can reduce admission below that ceiling. An unknown memory
state refuses admission; a failed new capsule does not evict its siblings
[CITED: `daemon-adapter/internal/daemon/ram_admission.go`].

Create identities through **Identities**, configure their browser profiles as
shown in the user guide, and use **Add capsule**. The guide's profile example
illustrates a subset of the admitted capacity. Do not assume CPU pinning or a
particular frame rate from this example.

| Refusal | Action |
| --- | --- |
| `CAPSULE_LIMIT_REACHED` | Close a capsule before opening another. |
| `NO_FREE_PROFILE` | Configure more profiles and restart. |
| `NO_IDENTITY` | Create the identity matching a configured profile. |
| `IDENTITY_LIST_UNAVAILABLE` | Check the identity tool and retry. |

[CITED: `ui/electron/profilePicker.js`, `ui/src/core/hostAdapters.js`]

## Browser profile example

This `MV_SRF_PROFILES` example configures `4` browser profiles [CITED:
`daemon-adapter/internal/daemon/profiles_doc_test.go`], a subset of the admission
ceiling. Create the matching identities first and set `MV_SRF_LIVE_PROFILE=mv-live-1`.
Use distinct displays and the shared canonical RAM root shown below; the example
is checked by the adapter's documented-profile tests and their negative controls.

```json
{
  "mv-live-1": {
    "Kind": "browser", "NativeKind": "browser",
    "RAMRoot": "/dev/shm/vqa-ramws/opensuperficies/os-cu-0",
    "Display": ":100", "Width": 1280, "Height": 900, "text_input": "paste"
  },
  "mv-live-2": {
    "Kind": "browser", "NativeKind": "browser",
    "RAMRoot": "/dev/shm/vqa-ramws/opensuperficies/os-cu-0",
    "Display": ":101", "Width": 1280, "Height": 900, "text_input": "paste"
  },
  "mv-live-3": {
    "Kind": "browser", "NativeKind": "browser",
    "RAMRoot": "/dev/shm/vqa-ramws/opensuperficies/os-cu-0",
    "Display": ":102", "Width": 1280, "Height": 900, "text_input": "paste"
  },
  "mv-live-4": {
    "Kind": "browser", "NativeKind": "browser",
    "RAMRoot": "/dev/shm/vqa-ramws/opensuperficies/os-cu-0",
    "Display": ":103", "Width": 1280, "Height": 900, "text_input": "paste"
  }
}
```
