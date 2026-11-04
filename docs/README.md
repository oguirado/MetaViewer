# Documentation index

- [Judge tour](JUDGE_TOUR.md): guided product flows and architecture verification status after installation.

## Judge reading order

- [Project status and limits](../README.md): what exists and what remains unmeasured.
- [Pre-existing work](PREEXISTING.md): historical scaffold and current integration pins.
- [Licensing and external component notice](../NOTICE-EVALUATION.md): MetaViewer source is AGPL-3.0-only; compiled external components have limited judge evaluation permission.
- [Judge Quickstart](JUDGE_QUICKSTART.md): asset verification, host doctor, installation and live wall.
- [Offline fixture](JUDGES.md): hosted simulation, requiring a locally available locked Wender checkout.

The public [v0.2.5 pre-release](https://github.com/oguirado/MetaViewer/releases/tag/v0.2.5)
provides x64 compiled assets; its notes give the checksum manifest digest [CITED: release].
ARM64 compiled assets for that release are **ABSENT — do not invent**. A clone alone
contains no packaged application or private runtime. Use [the no-Docker route](JUDGE_NO_DOCKER.md)
for app-only installation, and [the evidence guide](EVIDENCE.md) to distinguish
source checks from reported live qualification. Live wall evaluation requires a
graphical session; Host program and Desktop window are not isolated.

## Build and operate

- [Install and package](INSTALL.md), [operator guide](USER_GUIDE.md), and [AI operator guide](AI_OPERATOR_GUIDE.md).
- [Testing](TESTING.md), [demo runbook](DEMO_RUNBOOK.md), and [adapter input limits](ADAPTER_INPUT_LIMITS.md).
- [Architecture](ARCHITECTURE.md), [UI architecture](UI_ARCHITECTURE.md), and [contracts](../contracts/v0.2/README.md).
- [Commit laws](COMMIT_LAWS.md), [release history](../CHANGELOG.md), and [pending fragment workflow](../changes/README.md).

## Historical design and research

[Roadmap](ROADMAP.md) is the pre-event plan, not a completion record.
[Research](research/), [research log](RESEARCH_LOG.md), [router bootstrap](ROUTER_BOOTSTRAP.md),
[Holdings lessons](HOLDINGS_LESSONS_UI_ORCHESTRATOR.md), the P18 and Xpra design
notes, rehearsal notes and recursive demo script preserve planning context.
They do not establish current APIs or live acceptance results.

The [generated code map](../route/README.md) supplies source coordinates that
must be checked against this tree. It is distinct from `router/` tooling and
`catalogue/` identity data; the agent entry still declares context routing unavailable.
