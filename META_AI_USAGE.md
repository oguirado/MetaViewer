# Meta AI usage ledger

How Meta models were used to build MetaViewer, and how a Meta model can plan
moves inside it. This is a record of development tooling and of one opt-in
planner. It says nothing about driving any AI product's web page: MetaViewer
ships no built-in site, fixture or workflow for one.

The per-lane data is in [docs/meta-ai/muse_lanes.json](docs/meta-ai/muse_lanes.json).
Every number below is recomputed from that file unless it says otherwise.

## What were Meta models used for?

Answers: which Meta model built MetaViewer, how was Muse Spark used, what is a room, what is a lane

Meta Muse Spark 1.3 (model id `muse-spark-1.3` in every lane record
[CITED: docs/meta-ai/muse_lanes.json]) was the main code and context generator
during development. The maintainer describes **rooms** with a shared prompt
prefix (preamble and context) and independent **lanes** with narrow scopes and
acceptance checks. The ledger records effort `max` and usage counters
[CITED: docs/meta-ai/muse_lanes.json]. Those counters do not establish byte-identical
prompts or that every integration passed repository gates. Prompt comparisons
and per-integration gate receipts: `ABSENT — do not invent`. The required gate
policy is in [LAWS.md](LAWS.md).

| Role | What a lane produced |
|---|---|
| Research | Exact component APIs and prior art, before design |
| Context packs | Shared-prefix context for code-writing lanes, as described by the maintainer |
| Build | Code and tests for one owned surface |
| Review | Adversarial review and verification of findings against the current code |
| Fix | One confirmed finding per lane, with a regression test |
| Docs and release | Release documentation drafts, checked by the maintainer |

The maintainer describes a conductor (core, adapter, agents, integration) and
a UI orchestrator sharing an admission-controlled lane budget. The role table
and orchestration description are reported workflow, not proof of prompt
identity or successful integration.

## How much was used?

Answers: how many Muse lanes, how many tokens, what did it cost, cache hit rate

| Metric | Value |
|---|---:|
| Rooms | 136 [MEASURED: distinct `room` values in `lanes`] |
| Lanes launched and finished OK | 3,538 [CITED: docs/meta-ai/muse_lanes.json, key totals] |
| Agent steps | 96,949 [CITED: docs/meta-ai/muse_lanes.json, key totals] |
| Lane-hours of agent work | 213.8 [CITED: docs/meta-ai/muse_lanes.json, key totals] |
| Fresh input tokens | 360,893,926 [CITED: docs/meta-ai/muse_lanes.json, key totals] |
| Cache-read input tokens | 5,967,854,262 [CITED: docs/meta-ai/muse_lanes.json, key totals] |
| Prompt cache hit % | 94.3 [CITED: docs/meta-ai/muse_lanes.json, key totals] |
| Output tokens | 74,948,160 [CITED: docs/meta-ai/muse_lanes.json, key totals] |
| Thinking tokens | 46,994,729 [CITED: docs/meta-ai/muse_lanes.json, key totals] |
| Cost (USD, as reported by the client) | 63.0147 [CITED: docs/meta-ai/muse_lanes.json, key totals] |
| Peak concurrent lanes | 42 [CITED: docs/meta-ai/muse_lanes.json, key peak_concurrent_lanes] |
| Pre-event lanes / build-period lanes | 55 / 3,483 [MEASURED: `phase` values in `lanes`] |

The ledger labels lanes as pre-event or build-period. Those phase labels do
not independently establish which changes were integrated or when.

The ledger reports substantial cache-read usage; the maintainer attributes it
to shared room prefixes. Counters alone do not prove prompt identity or the
provider's cache behavior. Cache hit % = cache-read input tokens / (fresh input
+ cache-read input tokens) [CITED: docs/meta-ai/muse_lanes.json].

## Can a Meta model drive MetaViewer?

Answers: planner muse, Muse Code, can an AI choose the moves, games loop, does Muse need an account

Yes, as an opt-in planner that proposes moves; MetaViewer's core still admits,
delivers and verifies each one. `tools/mw_run_program.py` takes
`--planner rules` (default, no account) or `--planner muse`
[CITED: tools/mw_run_program.py:1190]. With `muse`, a `MuseProgramPlanner`
wraps the locked rules planner [CITED: tools/mw_run_program.py:1249] and sends
visual marks and projected observations to an installed, authenticated Muse
Code through the locked engine's model client. Only unique, mark-bound moves
that pass the same custody gate are admitted; there is no fallback from rules.
Setup and limits: [tools/mw_run_program.md](tools/mw_run_program.md).

Games loop, **maintainer-reported**, not independently reproduced here: Muse Spark 1.3 chose the keys and
the core verified each move. 2048: 58 of 58 verified; dominoes: 28 of 28;
Tuxemon: 40 of 42 in one run, the other 2 ending `INPUT_UNCERTAIN`
[CITED: README.md, maintainer report only]. The run journals, video takes and loop scripts are
not published in this repository; their public location is `ABSENT — do not invent`. `INPUT_UNCERTAIN` means delivery
could not be confirmed; it is never retried automatically
[CITED: agents/metaviewer_agents/mw_refusals.py:36].

## What was removed from this ledger?

Answers: why are some lanes withdrawn, redacted lanes

Lanes that drafted automation for third-party AI web products are kept in the
counts but their `lane` and `title` read `withdrawn-NN` and "Withdrawn from the
public ledger". Their usage numbers are unchanged, so every total above still
adds up. The earlier per-room and per-lane tables were dropped from this page;
the JSON file is the per-lane record.

## Method and scope

Answers: where do these numbers come from, which tools are not counted

- Source: the per-lane run record of each Muse Spark 1.3 call (model id, effort,
  usage counters, USD as reported by the client, agent steps, wall time). Start
  time comes from the session UUIDv7.
- Scope: Meta model usage only. Other development tools (editor, CI, non-Meta
  coding assistants and external reviewers) are outside this ledger and are not
  part of the product.
