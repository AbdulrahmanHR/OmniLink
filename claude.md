# OmniLink — see `AGENTS.md`

**The project guide moved to [`AGENTS.md`](AGENTS.md) at M74 (v3.0.1). This file is
a pointer; `AGENTS.md` is canonical.**

Read [`AGENTS.md`](AGENTS.md) before making any change. It carries the architecture,
the repository layout, the backend seam pattern, the design system, the coding
conventions — including the **zero-hardcoded-user-facing-strings i18n rule** and the
Zustand store conventions — the milestone status, and the project policies §1–§8.
Those policies are binding, not advisory: **BYOK-only AI, no accounts, no server, no
recurring cost, no telemetry.**

## Why the move

`AGENTS.md` is the emerging cross-tool convention for exactly this file: a
convention guide an AI coding assistant reads unprompted, whichever assistant it is.
Contributors increasingly work through one, and a guide only one tool looks for is a
guide most tools miss.

This pointer stays for two reasons. `CHANGELOG.md` refers to `claude.md` by name in
seven historical entries — including policy-section citations — and that record is
not rewritten. And Claude-specific tooling looks here by convention.

There is one guide, not two. Everything is in [`AGENTS.md`](AGENTS.md); nothing is
maintained in this file. If you are adding a convention, add it there.

## Other entry points

| File | For |
|------|-----|
| [`AGENTS.md`](AGENTS.md) | **The canonical guide.** Architecture, conventions, policies §1–§8. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Build steps, quality gates, DCO sign-off, maintainer capacity, scope boundary. |
| [`data/CONTRIBUTING.md`](data/CONTRIBUTING.md) | Catalogue schemas and a worked example of adding a radio. |
| [`docs/HARDWARE_VALIDATION.md`](docs/HARDWARE_VALIDATION.md) | Eight on-hardware protocols a contributor can run. |
| [`CHANGELOG.md`](CHANGELOG.md) | Per-release detail, and the honest record of what did and did not ship. |
