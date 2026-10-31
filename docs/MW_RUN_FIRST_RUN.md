# First run: Use MetaViewer -> mw_run perplexity ask

One page for the operator. `$MV_OPERATOR_REPO` is the MetaViewer checkout the app
was started with, and `$MV_WENDER_ROOT` is the wender-agent checkout at its
`deps.lock` commit. Both come from your launcher environment file.

## Steps

1. **Start MetaViewer** with your usual launcher. Start the browser capsule for
   identity `mv-live-1`, sign in to Perplexity **by hand** inside the capsule, and
   leave it on the Perplexity home page with an empty composer. Keep only one
   MetaViewer app running.
2. **Check the MemoryWeb home** (from `$MV_OPERATOR_REPO`):

   ```bash
   python3 tools/mw_home_check.py --repo . --workflow perplexity/ask
   ```

   Expected: `{"schema":"metaviewer.mw_home/v1",...,"ok":true,"code":null,"faults":[]}`.
   If you see `"code":"MW_PROVENANCE"`, do step 3 once, then repeat step 2.
3. **One-time provenance fix (only if step 2 asks for it).** The imported
   definitions name a document that is not in the home, so the pinned MemoryWeb
   gate refuses them (`MW_GATE_IO`). If you vouch for these definitions, record
   that yourself. Write the notes file **before** pinning it:

   ```bash
   cd "$MV_OPERATOR_REPO/memoryweb/sites/perplexity"
   cp "$MV_OPERATOR_REPO/tests/e2e/fixtures/mw_perplexity/repair/NOTES.md" PROVENANCE.md
   # Optional: reword PROVENANCE.md in your own words; keep its six "## " headings.
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

4. **Copy the prompt.** Click **Use MetaViewer** and paste the copied prompt into
   the external AI. Give it `MV_OPERATOR_REPO` and `MV_WENDER_ROOT` when it asks.
   Do not give it the app's own variables: `mw_run` attaches to the running app
   by itself.
5. **Watch the run.** The AI runs, from `$MV_OPERATOR_REPO/agents`:

   ```bash
   MV_WENDER_ROOT=... python3 -m metaviewer_agents.mw_run --identity mv-live-1 \
     --site perplexity --workflow ask --slot 'prompt=<your question>'
   ```

   Expected on stderr first: `mw_run: perplexity/ask acts on identity mv-live-1
   (network legacy) in 10 s; interrupt now to cancel`. Press Ctrl+C within those
   10 s to cancel before any input. Then the capsule shows a click on the
   composer, the pasted question, and Return.

## Expected result

- stdout, one line: `{"schema":"metaviewer.mw_run/v1","rc":0,"verdict_code":"VERIFIED","receipt":".../memoryweb-run.json","report":".../report.json"}`.
- `report.json`: `"attach":"discovered"`, `"corpus":"staged_builtin_schemas"`,
  `"notice_s":10`, `"network":{"effective_mode":"legacy",...}`, and
  `"answer":{"captured":true,"path":".../answer.txt",...}`.
- `memoryweb-run.json`: `"steps_total":3`, `"steps_verified":3`, `"rc":0`.
- `answer.txt` holds the answer's visible text (owner-only file).
- A sign-in dialog or a CAPTCHA gives `rc 4`, `HUMAN_HANDOFF`, and a handoff
  record path in `receipt`. Nothing on the wall is clicked or typed. Deal with it
  by hand in the capsule, then start a new run if you want.

## Common refusals

| Code | Meaning | Fix |
| --- | --- | --- |
| `MW_RUN_ATTACH` | No app, several apps, the app quit, or a caller value differs | Keep exactly one MetaViewer running; unset the variables named on stderr |
| `MW_DEPENDENCY` | `MV_WENDER_ROOT` unset or not at the `deps.lock` commit | Export the pinned checkout |
| `MW_HOME_*` | MemoryWeb home not admitted | Run step 2 and follow its code |
| `MW_GATE_IO` | Provenance file missing (message names the file) | Step 3 |
| `MW_NETWORK` | Capsule network setting changed after start | Restart the capsule |
| `MW_RUN_NO_SURFACE` / `MW_RUN_AMBIGUOUS` | Zero or several live surfaces for `mv-live-1` | Keep one capsule for the identity |

## If it fails, send back

1. The stdout JSON line and every `mw_run:` stderr line.
2. `report.json`. It holds codes, paths and the network witness, never the
   question text.
3. The handoff record (`memoryweb-run.handoff.json`) if `rc` was 4.
4. The output of step 2.

Do not send `answer.txt` unless you choose to. Never send the identity store,
tokens, keys or `auth.json`.
