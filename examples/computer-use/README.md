# Computer-use examples

These examples make the operations in [the playbook](../../docs/COMPUTER_USE_PLAYBOOK.md)
concrete. They do not launch or inspect a display until explicitly asked.

Answers: how do I run the computer use examples; what dependencies and checks are needed.

## Requirements and entry points

Use Linux with Python and an authorized X11 display. GUI examples need tkinter;
image processing needs ffmpeg and ffprobe; UI control needs xwininfo and xdotool. Window
discovery in the playbook uses wmctrl. The app launcher needs a working systemd
user manager. No Python packages from PyPI are required by these examples.
The checked player additionally needs the installed MetaViewer operator resources,
their locked components and a sourced live attachment; see the playbook.

Answers: which example should I use; do I need additional Python packages.

| File | Purpose | Entry example |
|---|---|---|
| `ui.py` | Explicit display/window, geometry check, capture after each action | `python3 ui.py --help` |
| `frames.py` | Contact sheets and unscaled crops of saved images | `python3 frames.py --help` |
| `model_keys.py` | Observe, ask a CLI, validate, checked key, observe again | `python3 model_keys.py --help` |
| `launch.py` | Start app in resource scope; generate executable wrappers from supplied paths | `python3 launch.py --help` |
| `connect_four.py` | Original shared-state turn-based game, local to this example | `python3 connect_four.py --help` |
| `drawing.py` | Display bounded JSON shapes without executing generated code | `python3 drawing.py --help` |
| `test_examples.py` | Offline regression and negative controls | `python3 -B test_examples.py` |

`launch.py command-wrapper OUTPUT --command PROGRAM ARG...` accepts a command
as separate arguments. It writes a new shell wrapper with quoted arguments and
never overwrites one. Only create wrappers for programs you intend to run.

## Checks and limits

Offline checks cover argument handling, valid and invalid model decisions, RGB
encoding, game rules, invalid drawings, and wrapper quoting. They do not prove
window focus, keyboard delivery, live observation, model service access or
Rewind. Those require a dedicated display and configured app.

Answers: what was tested; what still needs a live display.

Run checks under the same resource limits as the application [TARGET]:

```sh
systemd-run --user --scope -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=0 \
  python3 -B examples/computer-use/test_examples.py
```

Do not run display tests on an occupied desktop. Test the new launchers and both
seats on a dedicated display before using the fixed-coordinate recipe. The loop
stops on failed model output or unverified input; inspect its private evidence
directory before any restart. A generic CLI adapter must match the documented
JSON contract. The Muse flag example is based on the maintainer's session and
still needs validation against your installed CLI.

Use a trusted model CLI: its process inherits host permissions and environment.
The decision schema and workspace argument are not a sandbox. Do not let another
actor control the capsule during a player run. The local lock coordinates only
these example loops. Keep game state under a private, operator-controlled work
directory; the examples do not accept shared untrusted state as a service.

The example game and drawing viewer belong to this repository's license. They
do not include external game assets. No captured user data or live receipts are
stored in this directory.
