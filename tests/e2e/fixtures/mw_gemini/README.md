# mw_gemini offline fixture

Used only by `tests/e2e/test_mw_run_gemini_offline.py`; nothing here touches the network.

- `site/` holds the draft `sites/gemini/site.json` and `workflows/ask.json`
  modelled on `mw_perplexity/site/`.
- `pages/` holds static HTML snapshots (`home.html`, `answer.html`, `login.html`,
  `captcha.html`). `data-box` gives each element's window-local `[x,y,w,h]`. The
  test's fake native AX reads these pages the way `srf-identity-surface ax`
  reports a page: role, name, box, focused, container, and `value_len`, never a
  field value.
- `login.html` and `captcha.html` are walls. A run that reaches one must stop
  with `HUMAN_HANDOFF` (`rc 4`) without clicking or typing anything on it.

## UNVERIFIED-LIVE declarations

Because no live `gemini.google.com` session is available in the offline environment:

- **UNVERIFIED-LIVE** accessible control labels: the draft workflow binds the
  Spanish operator-locale AX names modelled on `mw_perplexity` (precondition
  button `"Nuevo"`, composer textbox `"Pregunta lo que sea…"`, postcondition
  answer copy button `"Copiar"`). Live `gemini.google.com` accessible labels in
  the operator's browser locale are **UNVERIFIED-LIVE** and must be verified or
  updated against `srf-identity-surface ax` output in the signed-in capsule if
  they differ.
- **UNVERIFIED-LIVE** answer container DOM/AX hierarchy and streaming completion:
  `answer.html` places `"Copiar"` inside `<article id="answer-1">` so
  `ax --text-container` resolves a unique container id after `Return`. Whether
  live `gemini.google.com` exposes a unique AX container id on the response turn
  or requires an additional composer re-click / polled completion step (as noted
  in `agents/tests/test_sitfix_owner.py`) is **UNVERIFIED-LIVE** (`capture_answer`
  is non-fatal and never alters the `VERIFIED` run verdict).
- **UNVERIFIED-LIVE** submit key and wall wording: submitting via `Return` on the
  focused composer and the exact live Google sign-in / challenge strings (beyond
  the casefolded `SIGN_IN_PHRASES` and `CAPTCHA_CUES` in `tools/mw_run_backend.py`)
  are **UNVERIFIED-LIVE**.

## Operator steps to seed and run E5 (`gemini/ask`)

Never let automation write into your MemoryWeb home. Run these commands yourself
from your `$MV_OPERATOR_REPO` checkout before running E5:

1. **Copy the draft site and provenance notes into your private MemoryWeb home:**

   ```bash
   mkdir -p -m 0700 "$MV_OPERATOR_REPO/memoryweb" "$MV_OPERATOR_REPO/memoryweb/sites"
   cp -R "$MV_OPERATOR_REPO/tests/e2e/fixtures/mw_gemini/site" \
     "$MV_OPERATOR_REPO/memoryweb/sites/gemini"
   cp "$MV_OPERATOR_REPO/tests/e2e/fixtures/mw_gemini/repair/NOTES.md" \
     "$MV_OPERATOR_REPO/memoryweb/sites/gemini/PROVENANCE.md"
   ```

2. **Pin human provenance on `site.json` and `workflows/ask.json`:**

   ```bash
   cd "$MV_OPERATOR_REPO/memoryweb/sites/gemini"
   python3 - <<'EOF'
   import hashlib, json
   notes = open('PROVENANCE.md', 'rb').read()
   for name in ('site.json', 'workflows/ask.json'):
       value = json.load(open(name, encoding='utf-8'))
       value['provenance'].update(source='human', source_ref='PROVENANCE.md', receipt_sha256=None,
                                  quote_sha256=hashlib.sha256(notes).hexdigest())
       open(name, 'wb').write((json.dumps(value, sort_keys=True, separators=(',', ':'),
                                          ensure_ascii=False) + '\n').encode())
   EOF
   ```

3. **Verify admission with `mw_home_check.py`:**

   ```bash
   cd "$MV_OPERATOR_REPO"
   python3 tools/mw_home_check.py --repo . --workflow gemini/ask
   ```

   Expected output: `{"schema":"metaviewer.mw_home/v1",...,"ok":true,"code":null,"faults":[]}` (`rc 0`).

4. **Sign in by hand and run:**
   In the running MetaViewer capsule for `mv-live-1`, sign in to
   `https://gemini.google.com/app` by hand and leave the tab on the home page
   with an empty composer (if live AX labels differ from the `UNVERIFIED-LIVE`
   defaults above, replace EVERY occurrence of each of the three labels (there are 9 `"name"` bindings plus the matching `ax:` anchor refs in `anchor_ref`/`required_anchor_refs`) in
   `memoryweb/sites/gemini/workflows/ask.json` to match your capsule's
   `srf-identity-surface ax` labels). Then run from `$MV_OPERATOR_REPO/agents`:

   ```bash
   export MV_WENDER_ROOT=<wender-agent checkout at its deps.lock commit>  # production reads only MV_WENDER_ROOT
   ```

   ```bash
   MV_WENDER_ROOT="$MV_WENDER_ROOT" python3 -m metaviewer_agents.mw_run \
     --identity mv-live-1 --site gemini --workflow ask --slot 'prompt=<your question>'
   ```
