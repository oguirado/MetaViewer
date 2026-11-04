# Documentation index

Start with [Judges](JUDGES.md) for installation, requirements and a paste block
for your own AI. After installation, use the [Judge tour](JUDGE_TOUR.md).

## Judge reading order

Answers: where to start, judge guide, installation, evidence

Read the judge hub, choose your installation tier, then run the tour.

| Question | Document |
| --- | --- |
| What is MetaViewer and why use capsules? | [Project overview](../README.md) |
| Can my AI install it? | [Judge hub and authorized paste block](JUDGES.md#what-do-i-paste-into-my-own-ai) |
| Which commands and outputs should I expect? | [Judge Quickstart](JUDGE_QUICKSTART.md) |
| Can I try it without Docker? | [App-only route](JUDGE_NO_DOCKER.md) |
| What can I demonstrate after install? | [Judge tour](JUDGE_TOUR.md) |
| What does a refusal mean? | [Troubleshooting](JUDGE_TROUBLESHOOTING.md) |
| What was actually verified? | [Evidence and limits](EVIDENCE.md) |
| What may I use or redistribute? | [Evaluation notice](../NOTICE-EVALUATION.md) and [pre-existing work](PREEXISTING.md) |

The source targets `0.2.6` [CITED: `../VERSION`]. Verify that its matching tag,
release assets and manifest digest are published before following its download
commands. The [earlier public release](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.5)
has its own instructions and x64 assets; it does not prove availability or behavior
of a later package. A source clone supplies neither the packaged app nor private
runtimes. ARM64 compiled assets are `ABSENT — do not invent` here.

## Build and operate

Answers: source build, operator commands, AI operation, architecture

Use the build guide for source prerequisites and the operator guides for runtime work.

| Need | Document |
| --- | --- |
| Build and package | [Install](INSTALL.md) |
| Operate the wall | [User guide](USER_GUIDE.md) |
| Give an AI the runtime contract | [AI operator guide](AI_OPERATOR_GUIDE.md) and [agent entry](AGENT_ENTRY.md) |
| Run checks and a demonstration | [Testing](TESTING.md) and [demo runbook](DEMO_RUNBOOK.md) |
| Understand input limits | [Adapter input limits](ADAPTER_INPUT_LIMITS.md) |
| Read the public design | [Architecture](ARCHITECTURE.md), [UI architecture](UI_ARCHITECTURE.md), [contracts](../contracts/v0.2/README.md) |
| Prepare a contribution | [Commit laws](COMMIT_LAWS.md), [release history](../CHANGELOG.md), [change fragments](../changes/README.md) |

## Historical design and research

Answers: roadmap, research, old plans, source lookup

Historical plans explain earlier decisions; current code and tests establish behavior.

[Roadmap](ROADMAP.md), [research](research/), [research log](RESEARCH_LOG.md) and
[router bootstrap](ROUTER_BOOTSTRAP.md) preserve planning context. They are not
completion receipts. The [generated code map](../route/README.md) returns source
coordinates; read the current cited bytes before relying on a finding.
