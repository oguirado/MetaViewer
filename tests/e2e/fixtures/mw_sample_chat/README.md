# mw_sample_chat offline fixture

Used by `tests/e2e/test_mw_run_sample_chat_offline.py`, `tests/test_mw_ax_dump.py`,
`tests/test_mw_readback_deadline.py`, `tests/test_mw_wall_deadline.py` and
`tests/e2e/rehearse_e1_packaged.py`; nothing here touches the network.

- `site/` holds a neutral draft `sites/sample-chat/site.json` and `workflows/ask.json`
  on the reserved origin `chat.example.com`. The accessible names are Spanish-locale
  label data kept verbatim, because the workflow and the walls match them exactly.
- `pages/` holds static HTML snapshots. `data-box` gives each element's
  window-local `[x,y,w,h]`. The test's fake native AX reads these pages the way
  `srf-identity-surface ax` reports a page: role, name, box, focused, container,
  and `value_len`, never a field value.
- `packaged/` holds the same pages for the packaged rehearsal and the AX dump test.
- `login.html` and `captcha.html` are walls. A run that reaches one must stop
  with `HUMAN_HANDOFF` without clicking or typing anything on it. The challenge
  is never clicked or solved.
- `repair/NOTES.md` is the EXPLANATION-format provenance the test writes as
  `PROVENANCE.md` (see `docs/MW_RUN_FIRST_RUN.md`).
