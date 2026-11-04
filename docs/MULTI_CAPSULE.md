# More than one capsule

Open another capsule with **Add capsule**. Each capsule needs an available
profile or launch configuration and enough host resources. For ordinary setup,
use [the user guide](USER_GUIDE.md#more-than-one-capsule); this page retains the
browser-profile example checked by the adapter tests.

## What limits the number of open capsules?

The configured ceiling is `16` capsules [CITED: `ui/electron/profilePicker.js`,
`MAX_CAPSULES`; `daemon-adapter/internal/daemon/environment.go`]. It is an
admission limit, not a measured capacity or frame-rate guarantee.

Answers: concurrent capsules; capacity; RAM admission; available profiles

Profiles, identities, display slots and RAM can reduce admission below that
ceiling. An unknown memory state refuses admission. Failure to admit a new
capsule does not evict its siblings. See
[ram_admission.go](../daemon-adapter/internal/daemon/ram_admission.go).

## How do I resolve a profile refusal?

Read the refusal and repair the missing prerequisite before retrying.

Answers: CAPSULE_LIMIT_REACHED; NO_FREE_PROFILE; NO_IDENTITY; IDENTITY_LIST_UNAVAILABLE

| Refusal | Action |
| --- | --- |
| `CAPSULE_LIMIT_REACHED` | Stop an open capsule before opening another |
| `NO_FREE_PROFILE` | Configure additional browser profiles and restart MetaViewer |
| `NO_IDENTITY` | Create the identity whose id matches an available profile |
| `IDENTITY_LIST_UNAVAILABLE` | Open Identities and check the identity tool |

The copy and selection rules are in
[profilePicker.js](../ui/electron/profilePicker.js).

## Browser profile example

This synthetic example supplies `4` browser profiles [CITED:
`daemon-adapter/internal/daemon/profiles_doc_test.go`]. The test fixes the
identifiers, shared RAM root, display numbers, dimensions and text-input mode
shown below; they are example values, not a report of a running installation.

Answers: MV_SRF_PROFILES; browser profile configuration; distinct displays

Create matching identities before use. Set `MV_SRF_LIVE_PROFILE=mv-live-1`
and pass this JSON through `MV_SRF_PROFILES` as described in
[INSTALL.md](INSTALL.md#concurrent-identities-and-ram-admission). The shared RAM
root must exist and pass the adapter's checks. For a real installation, provision
appropriate available displays and paths; do not infer a performance result
from this fixture.

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
