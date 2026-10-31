# mw_perplexity offline fixture

Used only by `tests/e2e/test_mw_run_perplexity_offline.py`; nothing here touches the network.

- `site/` is a byte copy of the operator's MemoryWeb `sites/perplexity/site.json`
  and `workflows/ask.json` (draft, imported 2026-10-29). The UI labels are the live
  site's labels in the operator's locale and stay verbatim, because the workflow
  matches them exactly.
- `pages/` holds static HTML snapshots. `data-box` gives each element's
  window-local `[x,y,w,h]`. The test's fake native AX reads these pages the way
  `srf-identity-surface ax` reports a page: role, name, box, focused, container,
  and `value_len`, never a field value.
- `login.html` and `captcha.html` are walls. A run that reaches one must stop
  with `HUMAN_HANDOFF` without clicking or typing anything on it.
