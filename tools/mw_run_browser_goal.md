# Browser goal runs

Run without a stored site or workflow:

```sh
python3 -m metaviewer_agents.mw_run --surface-kind browser --identity fixture --goal 'Operator Name' --steps 1
python3 -m metaviewer_agents.mw_run --surface-kind browser --identity fixture --goal 'Operator Name' --text 'Synthetic value' --steps 3 --key Enter
```

The caller supplies the identity, goal and any text. Rules planning requires a
unique exact normalized AX name. `--planner muse` selects an annotated native AX
mark; the locked Wender planner and the same grounding gates authorize its click.
AX supplies geometry; retained pixels and core settlement remain mandatory.
Vision-engine cross-checking is not implemented. Model readings are commentary.

`--steps` bounds input actions [TARGET, unit decision]. Text consumes a focus
click followed by typing, with optional Enter after exact native `ax --text-of`
readback. A differently bound editor, truncated response or different text
refuses. Receipt journals preserve delivered input even if readback fails.
The command reports bounded verified actions, without claiming goal completion.

Use a private RAM `XDG_STATE_HOME` beneath `/dev/shm` for this lane. Its private
report names the intent, dispatch, settlement and readback journals. Login and
CAPTCHA walls return `HUMAN_HANDOFF` with rc `4` [TARGET], before wall input.
Stored `--site` / `--workflow` behavior is unchanged.
