# Demo proposals for the Saturday recording

Storyboards for the hackathon video (at most 3 minutes). Drafted from the product docs, ranked by an independent judge, and cut by the conductor. Every live beat is [TARGET] until it has been recorded once on the operator's machine; fallbacks are listed per beat.

Prerequisite for any live beat that shows the window: the packaged app must render its UI (the "forbidden" window seen on Oct 30 is tracked as unit PKG-RENDERER). Until that lands, record from the source-tree UI.

## Recommended cut: "Teach it, hand it to any AI, keep the receipt" (175 s [TARGET])

| # | Time | Screen | Action | What the viewer understands | Risk | Fallback |
|---|---|---|---|---|---|---|
| 1 | 35 s | "Automate from a demo" dialog, then the loopback login viewer | Pick `perplexity-main`, a demo id and the site; Start; the operator asks a question and submits; Stop; Check site | MetaViewer learns a site from one demonstration; the recording keeps only how many characters were typed, never the text | viewer URL slow, check fails | pre-recorded Start/Stop clip; a pre-authored site |
| 2 | 20 s | Identities menu | Show `perplexity-main` and `chatgpt-main` logged in | Several accounts per site; only a human types credentials, in the login view, while agent input is refused | a session expired overnight | still screenshot |
| 3 | 25 s | Top bar, then an external AI chat | "Use MetaViewer" → Copied; paste into the AI | Any AI enters MetaViewer through one prompt, with the operator present | clipboard or AI improvising | still of the pasted prompt |
| 4 | 35 s | Terminal and the capsule | The AI runs `python3 -m metaviewer_agents.mw_run --identity perplexity-main --site perplexity --workflow ask --slot prompt="…"` | Every input is an admitted proposal followed by a verified receipt; the AI replays the stored workflow, it does not improvise clicks | site layout changed | offline fixture replay clip |
| 5 | 25 s | Capsule with the persistent hand-off notice | A CAPTCHA or bot check stops the run (rc 4, HUMAN_HANDOFF); the operator takes control and solves it | MetaViewer stops and hands over; it never tries to evade a bot check | no CAPTCHA appears | pre-recorded hand-off clip |
| 6 | 35 s | Notepad program capsule and the run receipt | Copy the answer into the notepad; open `memoryweb-run.json` | The result is usable work, and the success claim is backed by a verified summary (rc 0 only when the summary exists and verifies) | long private paths on screen | a prepared receipt file |

## Backup cut: fully offline (165 s [TARGET])

Identities menu (25 s) → per-capsule Network panel with the mode fixed at start (25 s) → "Automate from a demo" with dummy data (35 s) → notepad program capsule on the same wall (25 s) → the offline fixture run `run_web_live.sh` with T1–T3 PASS, pre-recorded (30 s) → hosted CI green plus a prepared run receipt (25 s). No live site, no account, no network.

## Other drafts (kept for reference)

- **D, "Answer for the deck"** (ranked first as a narrative): two ready accounts → external AI enters → replay, not improvisation → the answer lands in the notepad → proof in one file. Misses the hand-off and teach-by-demonstration.
- **A, "Outside in"**: the full external-AI loop with the hand-off; the most live failure points in 3 minutes.
- **E, "Nothing moves without verification"**: custody first (login lock, network fixed at start, propose then verify, hand-off, receipts); strongest on trust, slower and more abstract.
- **C, "Teach it once"**: the most distinctive feature; a 6-step chain that is fragile within 180 s.
- **B, "Trust first"**: safest and fully offline; least AI agency on screen.

## Before Saturday

1. Packaged UI renders (PKG-RENDERER), or record from the source-tree UI.
2. One full dry run of the recommended cut on the operator's machine, timing each beat.
3. Record the fallback clips (beats 1, 4 and 5) during that dry run.
4. The built-in Meta site for judges (unit META-SITE) as an extra offline beat if it lands.
