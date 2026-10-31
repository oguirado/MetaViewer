# More than one capsule

[TARGET, unit decision] This section is written as its own file while another unit
edits `USER_GUIDE.md`; it is meant to be folded into the User Guide as the section
"More than one capsule" at integration.

**Add capsule** opens one more browser capsule each time you press it, up to a
ceiling of 4 live capsules [TARGET]. Each press takes the first configured browser
profile that is not already in use and whose identity exists. The first capsule at
startup always uses the preferred profile (`MV_SRF_LIVE_PROFILE`).

## What you must prepare

1. **Create one identity per extra capsule first.** Each profile id is also the id
   of a native identity, and the capsule cannot start unless that identity already
   exists. Open **Identities** in the top bar and create `mv-live-2`, `mv-live-3`
   and so on, each with its own account label. MetaViewer never creates identities
   for you and never reads their credentials; it only asks the Identities list for
   the ids.
2. **Describe the profiles in `MV_SRF_PROFILES`.** The value is one JSON object
   keyed by profile id. Example for four capsules:

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

   Keep `MV_SRF_LIVE_PROFILE` set to the first id (`mv-live-1`). Profile ids use
   lowercase letters, digits and `-`, up to 64 characters. Extra profiles beyond
   four are accepted in the map but never run together.
3. **Use the one fixed RAM root for every profile.** The native stack writes every
   capsule's frames beneath `/dev/shm/vqa-ramws/opensuperficies/os-cu-0`, one
   subdirectory per run id, so each profile's `RAMRoot` must be exactly that
   path. The directory must already exist with mode `0700` and be owned by you.
   Do not invent a separate root per profile [CITED: native surface constant
   `RAMRoot`, OpenSuperficies pin `a9ac1ac85`].

## Shared root and isolation

Identical canonical existing RAM roots are admitted. Distinct roots must remain
nonoverlapping; nested roots, symlink aliases and unclean paths are refused.
Each profile must have a distinct display: use `:100`, `:101`, `:102`, `:103`
for the four profiles [TARGET]. The manager binds identity frames beneath
`RAMRoot/<run_id>/frames/w1` and refuses reused live run ids and overlapping
frame allocations, including native-provided Holdings directories. The publisher
checks allocation membership before opening source files and retains publications
by surface; a rejected cross-run frame cannot replace retained pixels.

Only the human operator creates identities. No AI creates `mv-live-2`,
`mv-live-3` or `mv-live-4`. In **Identities**, create those exact ids yourself.
Then set the launcher environment to this line before starting MetaViewer
(four profiles [TARGET], fixed root [CITED: supplied native RAMRoot constant]):

```sh
export MV_SRF_LIVE_PROFILE=mv-live-1
export MV_SRF_PROFILES='{"mv-live-1":{"Kind":"browser","NativeKind":"browser","RAMRoot":"/dev/shm/vqa-ramws/opensuperficies/os-cu-0","Display":":100","Width":1280,"Height":900,"text_input":"paste"},"mv-live-2":{"Kind":"browser","NativeKind":"browser","RAMRoot":"/dev/shm/vqa-ramws/opensuperficies/os-cu-0","Display":":101","Width":1280,"Height":900,"text_input":"paste"},"mv-live-3":{"Kind":"browser","NativeKind":"browser","RAMRoot":"/dev/shm/vqa-ramws/opensuperficies/os-cu-0","Display":":102","Width":1280,"Height":900,"text_input":"paste"},"mv-live-4":{"Kind":"browser","NativeKind":"browser","RAMRoot":"/dev/shm/vqa-ramws/opensuperficies/os-cu-0","Display":":103","Width":1280,"Height":900,"text_input":"paste"}}'
```

Restart the launcher with that environment, then press **Add capsule** for each
additional identity. The host lists identity ids through the existing identity
tool; it never reads identity-store contents directly. An uncertain create stays
reserved until a frame state reconciles it; restart after diagnosing a failed
start if its outcome cannot be proven [TARGET, unit decision].

The host currently sends typed refusal codes through the frozen preload reply
shape. Rendering the richer messages and the identity shortcut below requires
the conductor to connect the existing picker copy in `preload.js`,
`ui/src/core/hostAdapters.js` and `ui/src/App.vue` (outside this unit surface).

## What the refusals mean

| Message after pressing Add capsule | Code | What to do |
| --- | --- | --- |
| "At most 4 capsules run at once…" | `CAPSULE_LIMIT_REACHED` | Close a capsule, then try again. |
| "N configured capsule profiles are all in use…" | `NO_FREE_PROFILE` | Add profiles to `MV_SRF_PROFILES` (up to 4) and restart MetaViewer. |
| "No free capsule profile has an identity yet…" with **Create identity…** | `NO_IDENTITY` | The button opens Identities; create an identity whose id matches a profile in `MV_SRF_PROFILES`. |
| "The identity list could not be read…" | `IDENTITY_LIST_UNAVAILABLE` | Open Identities, check that the identity tool runs, then try again. |

## Shared CPU and memory

All capsules run on the same 5 CPU cores (`--cpuset-cpus 10-14`), and each may use
up to 4 GiB of memory plus 2 GiB of shared memory [CITED: native capsule launch
flags]. Frame rate drops as more capsules run: about 2 fps with a single capsule
[MEASURED]. Four concurrent capsules is the supported ceiling on this host
[TARGET]. RAM admission keeps a floor of `min(20 GiB, MemTotal / 4)` plus 512 MiB
per live capsule, counted one record per surface [CITED:
`daemon-adapter/internal/daemon/ram_admission.go`]; a new capsule is refused, and
siblings are left untouched, when memory is short.
