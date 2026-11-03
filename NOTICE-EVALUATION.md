# Notice: licensing and evaluation of external components

MetaViewer's own source code in this repository is licensed under the
[GNU Affero General Public License, version 3 only](LICENSE) (SPDX: `AGPL-3.0-only`).
Copyright (c) 2026 oguirado (https://github.com/oguirado). Releases up to and including
v0.2.4 remain under the licence they were published with, PolyForm Strict 1.0.0.

## External components

`wender-agent`, `vision-engine` and `OpenSuperficies` are separate, proprietary and fully
private programs: their repositories and source code are private and are not published.
MetaViewer starts them as separate processes and talks to them over documented process
and socket interfaces. They are not part of MetaViewer's source code and are not covered
by the AGPL. `capsule-ui-kit` is a separate public repository, also under `AGPL-3.0-only`.

## Additional permission under AGPL section 7

As an additional permission under section 7 of the licence, the copyright holder of
MetaViewer permits you to run MetaViewer with `wender-agent`, `vision-engine` and
`OpenSuperficies`, and to convey MetaViewer together with their compiled forms where
this notice allows it, without those components becoming subject to the AGPL. The licence
continues to apply to MetaViewer itself. This permission grants no rights in the components.

## Evaluation of compiled components

The licensor permits the judges of the hackathon in which MetaViewer is entered to
install, run and evaluate the compiled forms of those three components, as supplied in
MetaViewer's release assets, for the purpose of judging that entry. No other right in
them is granted: no redistribution, no modification, no reverse engineering, and no use
for any other purpose.

This notice is a statement of permission by the licensor, not legal advice. Installation
steps for judges are in [docs/JUDGE_QUICKSTART.md](docs/JUDGE_QUICKSTART.md).
