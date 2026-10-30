# Judge the offline conversation

From the repository root, with Node on PATH and the locked Wender checkout
configured through `MV_MW_WENDER_ROOT`, run:

```sh
node tests/e2e/packs/builtin-fixtures/META/hosted.mjs
```

This command needs no account, browser, display, downloads or network. It runs
the real MemoryWeb runner through the existing hosted RPC path against the
hosted capsule and core fakes. The reviewed neutral page is
`tests/e2e/packs/builtin-fixtures/META/pages/meta-chat.html`; its digest is
pinned by the adjacent `automation.json`. The `meta-ai/ask-fixture` workflow
focuses Prompt, types an invocation-only test prompt, presses Return and
verifies ANSWER_READY. The hosted fake evaluates the page's own submit handler.
The regression suite (`python3 -m unittest discover -s tests -p test_meta_site.py -v`)
also proves refusal without `fixtures_offline`, refusal of a foreign
receipt, and operator handoff at CAPTCHA and login walls. This is an offline
simulation, not evidence about the live service's current interface.

The fixture harness invokes the existing runner with `--hosted-rpc`,
`--pack tests/e2e/packs/builtin-fixtures/META`, `--mw-root memoryweb-builtin`
and `--mw-workflow meta-ai/ask-fixture` (paths resolved from the repository).
It supplies an invocation-only private slot value and hosted backend responses;
the runner retains fixture pins, offline proof, corpus validation and receipt
gates. Pages resolve inside the explicitly selected pack. Inline script exists
only in the reviewed built-in fixture directory. Default discovery remains
exactly T1, T2, T3; META requires explicit `--pack` selection and never adds a
task to the operator's default release run.

# Operator-present live use

`memoryweb-builtin/sites/meta-ai` is the reviewed built-in draft. A site in the
private, gitignored `memoryweb/sites/meta-ai` home takes precedence as a whole.
The product reads the built-in only if that user site is absent; it never copies
it into the home. Invalid or linked user paths refuse instead of falling back.
The accompanying schema projections are checked against the locked Wender
schema by the existing corpus loader.

Live anchors are **ABSENT — no inventar**, listed in the site's `NOTES.md`.
No live run has been performed. The `new-chat` and `ask` drafts deliberately
refuse admission until the operator's first live replay establishes the composer,
new-chat and answer predicates. To customize, the operator explicitly creates
a private site from the draft and keeps schema projections compatible with the
locked engine. Verify the authored site offline before using an active identity:

```sh
MV_MEMORYWEB_REPO="$MEMORYWEB_CHECKOUT" python3 tools/mv_demo.py check --site meta-ai
```

After anchors are verified, the operator opens `https://meta.ai/` in their own
active identity and remains present. The existing engine entry is:

```sh
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --identity "$IDENTITY" --site meta-ai --workflow new-chat
PYTHONPATH=agents python3 -m metaviewer_agents.mw_run \
  --identity "$IDENTITY" --site meta-ai --workflow ask --slot 'prompt=A public test question'
```

Use a public prompt for this CLI example because command arguments can appear
in shell history. The runner's private slot transport does not persist typed
characters in its evidence. CAPTCHA, login and other observed walls hand off
to the operator; no workflow types credentials, solves challenges or restarts
the capsule. The operator handles login directly, then starts a fresh run.
