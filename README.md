# OmniLink

**A free, open-source, offline-first desktop app for ExpressLRS drone-radio
hardware. No account. No subscription. No cloud. Bring your own AI key — or none
at all.**

[![License: GPL v3 or later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)
[![CI](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/ci.yml/badge.svg)](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/ci.yml)
[![Linux Build](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/linux-build.yml/badge.svg)](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/linux-build.yml)
[![Windows Build](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/windows-build.yml/badge.svg)](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/windows-build.yml)
[![macOS Build](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/macos-build.yml/badge.svg)](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/macos-build.yml)

Configure, flash, and monitor **ExpressLRS** gear from Windows, macOS, or Linux.
Built with **Tauri 2** (Rust), **React 19**, and **TypeScript** (strict).

OmniLink talks to ExpressLRS hardware over **CRSF** (serial USB-CDC), over the
device's **WiFi** captive-portal / mDNS HTTP API, and to the **ExpressLRS Backpack**
companion hardware. It renders a live telemetry dashboard (RSSI / LQ / SNR, antenna
polar plot, GPS flight map), flashes firmware through a guided wizard, manages
portable `.elrsp` config profiles, imports Betaflight blackbox logs, and ships an
optional bring-your-own-key LLM assistant.

---

## What OmniLink is — and what it will never be

Every feature is free. There is no paid tier, no "Pro" edition, and no feature
locked behind anything.

| | |
|---|---|
| **Free and open source** | GPL-3.0-or-later. Fork it, modify it, redistribute it. |
| **Offline-first** | Device config, flashing from cache, telemetry, profiles, and log analysis all work with networking fully disabled. |
| **No account, ever** | No login, no identity, no session, no user record — local or remote. |
| **No server** | There is no OmniLink backend to go down, get acquired, or start charging. The app runs entirely on your machine. |
| **No telemetry** | OmniLink does not phone home. There is no "anonymous statistics" toggle because nothing is collected to toggle. |
| **BYOK AI** | The optional assistant uses *your* API key for a provider *you* chose — or Ollama, running locally. The key is stored in your OS keychain and never leaves your machine except to reach that provider. |

These are architectural commitments, not current priorities.
[`CONTRIBUTING.md`](CONTRIBUTING.md#scope-boundary--what-will-not-be-accepted)
records them as a hard scope boundary: contributions requiring a server, an
account, a payment, or telemetry are declined on sight.

> **Note on project history.** Earlier development explored an accounts/billing
> platform, cloud profile sync, a subscription tier, and a hosted AI service. **All
> of it was retired and deleted at `3.0.0`, before this repository was published** —
> removed from the codebase, not disabled and left in place. None of it was ever
> reachable by a user: every surface was flag-gated off and present only in a
> development build, never in a shipped installer.
>
> This repository begins at `3.0.2`. Earlier commits, tags and branches are not part
> of it, and the planning documents from that period are private working notes that
> are not published anywhere — so there is no archive to go and dig through, and you
> should not go looking for one. What you can check is all here, in front of you:
> [`CHANGELOG.md`](CHANGELOG.md) under **`[3.0.0]`** names every deleted surface and
> says plainly why it went; `src/lib/featureFlags.ts` declares exactly one flag, and
> it is not a billing flag; and the rule that keeps this from coming back is written
> down as standing policy, in
> [`AGENTS.md`](AGENTS.md#important-project-policies) §8 ("no recurring cost, no
> server, no accounts") and in `CONTRIBUTING.md`'s
> [scope boundary](CONTRIBUTING.md#scope-boundary--what-will-not-be-accepted), which
> lists accounts, payments, entitlements and a hosted API among the contributions
> that are declined on sight. A commitment you can read in the code and in the rules
> for changing it is worth more than one you have to take on trust.
>
> Multi-machine profile portability was rebuilt as **your own folder** and shipped in
> `3.0.1` — point OmniLink at a directory, and if that directory happens to live in
> Dropbox, Drive, Syncthing, or a git checkout, you get sync with zero infrastructure
> on anyone's side.

---

## Honest status

This section is deliberate. OmniLink would rather under-promise than have you
discover a gap yourself.

- **Source version `3.0.2`, and this repository's published history begins there.**
  There are no `1.x` or `2.x` releases, tags or commits here to compare against — the
  work those version numbers refer to happened before publication and is described in
  [`CHANGELOG.md`](CHANGELOG.md), not stored here. For what is actually downloadable
  right now, read the
  [Releases page](https://github.com/AbdulrahmanHR/OmniLink/releases) rather than this
  sentence: the tagged release pipeline builds Windows, Linux and macOS installers,
  and the in-app updater (Settings → App Update — manual, never automatic) reads that
  same feed.
- **On-hardware acceptance is still pending.** The core paths are real, not mock —
  device connection, live telemetry, firmware flashing, profile persistence,
  blackbox-log import, WiFi/Backpack discovery, and the BYOK assistant all run on a
  genuine Rust/serial/SQLite/HTTP/LLM backend, and every one is covered by tests.
  But **no ExpressLRS device has ever been physically connected to this app.** The
  maintainer owns no ELRS hardware. GPS mapping, the flash path, and the pre-flash
  safety guards are best validated against live gear, and that validation has not
  happened. Treat first use with appropriate caution, and please
  [report what you find](https://github.com/AbdulrahmanHR/OmniLink/issues/new/choose)
  — hardware reports are the single most valuable contribution this project can
  receive. There are eight ready-to-run protocols in
  [`docs/HARDWARE_VALIDATION.md`](docs/HARDWARE_VALIDATION.md); the results land in
  the [compatibility matrix](#hardware-compatibility-matrix) below.
- **Installers are not OS-code-signed.** Updater artifacts *are* minisign-signed and
  verified, but the installers themselves carry no Authenticode or Apple signature,
  so **SmartScreen (Windows) and Gatekeeper (macOS) will warn on first launch.** A
  code-signing certificate is a recurring cost this project does not have. See
  [`docs/SIGNING.md`](docs/SIGNING.md).
- **The bundled map tiles are placeholders.** The `.ompack` offline-tile framework
  and the regional-pack download machinery are real and working, but the shipped
  base map and regional packs are **solid-colour placeholder tiles — not real
  geography.** A licensed OSM raster set is not yet bundled. Flight paths render
  correctly; the ground underneath them does not.
- **The `blackbox_decode` path is real.** `.bbl` logs are decoded in-process by the
  pure-Rust `blackbox-log` crate, fully offline, with no external sidecar.

---

## Hardware compatibility matrix

**This table is empty because nobody has filled it in yet, and that is the honest
state of the project.** No ExpressLRS device has ever been connected to OmniLink.
Every row below will be a claim somebody made after running a protocol on their own
gear.

| Device | Type | ELRS firmware | Connection | Verified | Protocol | By | Date |
|--------|------|---------------|------------|----------|----------|----|------|
| _no reports yet_ | | | | | | | |

<details>
<summary><strong>How to add a row</strong></summary>

1. Pick a protocol from
   [`docs/HARDWARE_VALIDATION.md`](docs/HARDWARE_VALIDATION.md) — eight of them,
   each self-contained, most under thirty minutes. HW-1 (serial connection) needs
   nothing but a radio and a USB cable.
2. Run it on your hardware and
   [file a hardware report](https://github.com/AbdulrahmanHR/OmniLink/issues/new?template=hardware_report.yml).
3. Open a pull request adding one row here. Sign off with `git commit -s`
   ([DCO](CONTRIBUTING.md#developer-certificate-of-origin-dco--required)).

Column conventions:

- **Device** — brand and exact model. `BETAFPV Nano TX` and `BETAFPV Micro TX 1W`
  are different targets; do not collapse them.
- **Type** — `TX`, `RX`, `Backpack (TX)`, `Backpack (VRX)`, or `FC bridge`.
- **ELRS firmware** — the version you actually ran, e.g. `3.5.3`. Not "latest".
- **Connection** — `Serial`, `WiFi`, `Backpack`, or `Bridge`.
- **Verified** — what you *observed working*, in a few words: `connect + telemetry`,
  `flash over UART`, `GPS + map`, `passthrough to RX`. Add `partial` or a `—` for
  anything that failed, and link the issue.
- **Protocol** — `HW-1` … `HW-8`.
- **By** — your GitHub handle.
- **Date** — `YYYY-MM-DD`, when you ran it.

**Only claim what you saw.** A row reading `connect only — flashing not tested` is
more useful than one implying full coverage, because the next person knows exactly
where to pick up. A `FAIL` row with a linked issue is the most useful row of all.

</details>

---

## Features

| Area | What it does | Backend |
|------|--------------|---------|
| **Device connection** | Connect/disconnect state machine, real target name + firmware version, structured error surfacing (permission / busy port / handshake timeout) | Serial enumeration + CRSF handshake |
| **Telemetry dashboard** | Live RSSI / LQ / SNR metric cards, sparklines, link chart, a D3 antenna polar plot, and a GPS flight map with live track | Decoded CRSF Link Statistics + GPS → SQLite persistence |
| **Anomaly detection** | Flags link dropouts, LQ collapses and RSSI cliffs over the live/recorded stream | Pure analysis over the telemetry store |
| **Local diagnostics** | Deterministic on-device signal-health score, rule findings, post-flight patterns, per-device trends and conservative setup suggestions | Fully local, offline, no ML, no cloud |
| **Firmware flashing** | Guided Brand → Model → Frequency → Binding → Review wizard; streams a real PlatformIO/esptool flash with progress, binding-phrase UID patching, and a config backup | GitHub firmware catalogue + PlatformIO flasher |
| **Flash safety guards** | A TX-target image cannot be flashed to an RX device (or vice versa), Backpack types cannot cross, and the guard runs before any erase or write | Pre-flash guard, enforced in Rust |
| **ExpressLRS Backpack** | Discover, flash, and configure Backpack companion hardware via a schema-driven form | Backpack discovery + flash (MSP) |
| **WiFi discovery** | Find devices broadcasting their self-AP SSID or advertising over mDNS, then probe their HTTP identity | Platform WiFi scan (`nmcli`/`netsh`/`airport`) + mDNS browse |
| **Config profiles** | Browse, apply, rename, import/export, and diff portable `.elrsp` profiles against the device config; profiles persist across restarts | Local profile store + `.elrsp` file I/O |
| **Folder sync** | Mirror your saved profiles into a folder you already own, with a manual four-way diff (only here / only in the folder / in sync / differs) and per-entry Push, Pull or Skip — see below | Scoped `.elrsp` file I/O in one user-granted directory |
| **Flight-log import** | Import a Betaflight/iNav blackbox `.bbl` (decoded in-process, fully offline) or an exported OmniLink session CSV, then chart + scrub + analyze it | In-process pure-Rust `blackbox-log` decoder → `blackbox_decode`-compatible CSV (no external sidecar) |
| **Offline maps** | Renders flight paths over bundled offline tiles with no network required — see the honest-status note on placeholder tiles above | Self-contained `.ompack` tile store served over the `omnitiles://` scheme |
| **Replay simulator** | Replays a recorded session through the live dashboard at adjustable speed, with a clear SIMULATED badge | Pure wall-clock replay engine over the shared telemetry store |
| **Controller bridge** | Use a Betaflight/iNav flight controller as a **read-only** passthrough bridge to an ELRS receiver, with guided diagnostics and a redacted support-report export | MSP probe; the only write ever issued is `MSP_SET_PASSTHROUGH` |
| **BYOK AI assistant** | Slide-in chat panel; bring-your-own-key LLM over Anthropic / OpenAI / Gemini / OpenRouter / Groq / Mistral / Ollama / a custom endpoint, with OS-keychain key storage and telemetry-aware, **sanitised** context | Real LLM API calls with your key, direct to your provider |
| **Grounded answers (RAG)** | Assistant answers cite trusted ExpressLRS documentation, retrieved by a **local BM25 index** — no cloud retrieval, works offline, and says "no source found" rather than fabricating a citation | Local index over bundled + user-imported docs |

### Sync your profiles across machines

OmniLink has no server, so it does not sync anything for you. Instead it uses a
folder you already own.

On **Profiles → Folder**, pick a directory. OmniLink writes your saved profiles
into it as plain `.elrsp` files — one file per profile, named after the profile,
pretty-printed and hand-editable. Open the folder in your file manager and you
will understand it immediately: there is no index, no manifest and no database.

If that directory happens to live inside Dropbox, Google Drive, OneDrive,
Syncthing, or a git checkout, then **that** tool carries your profiles to your
other machines, on the account you already pay for (or nothing, for Syncthing and
git). On the other machine, point OmniLink at the same folder and pull.

What this deliberately is not:

- **No OmniLink server, no account, no upload.** Nothing leaves your machine over
  a network on this path — there is no network call in it at all.
- **Not automatic.** There is no watcher, no timer, and no background sync. You
  see a four-way diff — *only on this machine* / *only in the folder* / *in sync*
  / *differs* — and press **Push**, **Pull** or **Skip** per entry.
- **Never a silent overwrite.** When the same name holds different content on both
  sides, you get both versions side by side and choose: keep this machine's, keep
  the folder's, or **keep both** (your copy is renamed `Name (2).elrsp` so nothing
  is lost).
- **Opt-in and inert.** With no folder chosen, the feature does nothing and reads
  nothing.

OmniLink can only touch the one directory you picked: the desktop shell grants
exactly six filesystem operations, scoped to that directory, and refuses any
profile name that would resolve outside it.

**AI privacy:** the assistant never receives binding phrases, GPS coordinates, MAC
addresses, IP addresses, or email addresses — context is scrubbed by
`sanitize_context()` before it leaves the machine. It also cannot suggest changes to
safety-critical fields (RF power, failsafe, arming, binding secret); a closed,
deny-by-default validator rejects them even from a crafted model response.

## Tech stack

- **Shell:** [Tauri 2.x](https://tauri.app/) (Rust) — serial, HTTP, SQLite, custom URI schemes
- **UI:** [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) (strict), [Vite 7](https://vite.dev/)
- **Styling:** [Tailwind CSS v4](https://tailwindcss.com/) + shadcn/ui-style primitives (`class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/*`)
- **State:** [Zustand 5](https://github.com/pmndrs/zustand)
- **Charts & maps:** [Recharts 3](https://recharts.org/) + [D3 7](https://d3js.org/) + [MapLibre GL](https://maplibre.org/)
- **Routing:** [React Router 7](https://reactrouter.com/)
- **i18n:** [react-i18next](https://react.i18next.com/) / i18next (English + Spanish, at full parity; **zero hardcoded user-facing strings** policy)
- **Icons:** [lucide-react](https://lucide.dev/)
- **Testing:** [Vitest 3](https://vitest.dev/) (unit) + [Playwright](https://playwright.dev/) (E2E) + `cargo test` (Rust)

Visual design system: **"Signal Lab"** — dark-first, with light and "Carbon &
Copper" amber themes, full `prefers-reduced-motion` support (see `src/index.css`).

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) LTS (22+) + npm
- [Rust toolchain](https://www.rust-lang.org/tools/install) (1.81+) and the
  [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS
  (only needed to run the native desktop shell)

Per-OS prerequisite detail is in [`CONTRIBUTING.md`](CONTRIBUTING.md#building-omnilink).

### Install

```bash
git clone https://github.com/AbdulrahmanHR/OmniLink.git
cd OmniLink
npm install
```

### Run

```bash
# Frontend only (browser — fastest for UI work; backends degrade to offline)
npm run dev

# Full native desktop app (Tauri) — required for serial / flashing / WiFi
npm run tauri dev
```

> The browser dev server runs without any Tauri backend: every device/serial/
> WiFi/AI call rejects gracefully and the UI shows its honest empty state. Use
> the native shell (`npm run tauri dev`) to talk to real hardware.

### Linux serial permissions (udev / dialout)

On Linux, opening a serial port (`/dev/ttyUSB*`, `/dev/ttyACM*`) requires your
user to have access to the device. A freshly-plugged ExpressLRS device most
often fails to connect with **"Permission denied"** because the user lacks
access to the node.

**`.deb` install** — nothing to do. The package ships a udev rule
(`60-omnilink-elrs.rules`) to `/usr/lib/udev/rules.d/` that grants your logged-in
user access to the known ExpressLRS USB-serial bridges (Silicon Labs CP210x, WCH
CH340/CH341, FTDI, and Espressif native-USB ESP32-S2/S3/C3) automatically. Just
replug the device after installing.

**AppImage / other** — there's no system install step, so add the rule yourself.
It ships next to the app at `resources/linux/60-omnilink-elrs.rules` (also in the
repo under [`src-tauri/resources/linux/`](src-tauri/resources/linux/60-omnilink-elrs.rules)):

```bash
sudo cp 60-omnilink-elrs.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
# then replug the device
```

**Fallback** — if you'd rather not install the rule, adding your user to the
`dialout` group also works:

```bash
sudo usermod -aG dialout "$USER"
# then log out and back in (or reboot) for the group change to take effect
```

If a connection fails, OmniLink surfaces the exact reason in the top bar (click
the red **Error** chip to expand the full message) — permission, busy port, or a
CRSF handshake timeout.

### Windows: "unknown publisher" warning and the firewall prompt

Two separate Windows dialogs, neither of which means the app is malware:

- **"Windows protected your PC" / "unknown publisher"** (SmartScreen) — the
  installer and updater bundles are not yet Authenticode code-signed. Click
  **More info → Run anyway**, or remove the warning for good by signing the
  builds. See [`docs/SIGNING.md`](docs/SIGNING.md) for the certificate options
  and the exact config/CI wiring.
- **"Allow OmniLink to communicate on these networks?"** (Defender Firewall) —
  expected: the app uses mDNS and connects to an ExpressLRS device's WiFi
  self-AP to flash firmware. Click **Allow** (Private networks is enough).

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Vite dev server (frontend) |
| `npm run build` | Type-check then production build (`tsc && vite build`) |
| `npm run preview` | Preview the production build |
| `npm run tauri dev` | Run the native desktop app |
| `npm run lint` | ESLint over `src/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit suite |
| `npm run test:watch` | Vitest in watch mode |
| `npm run e2e` | Playwright end-to-end suite |

## Routes

All pages render inside the `AppShell` layout (sidebar + device bar + floating AI
button) and are **lazy-loaded** for a smaller initial bundle.

| Path | Page |
|------|------|
| `/` | Home |
| `/flash` | Flash — the guided Brand → Model → Frequency → Binding → Review flashing wizard is embedded here (there is **no** separate `/wizard` route) |
| `/telemetry` | Telemetry dashboard + GPS flight map |
| `/profiles` | Config profiles + diff |
| `/analysis` | Session Analysis — flight-log import, scrubber, anomaly + local-diagnostics panels, and the replay simulator |
| `/trends` | Trends — per-device local trends + setup suggestions |
| `/settings` | Settings (BYOK AI config, WiFi/Backpack, offline tile packs, in-app update) |

Two legacy paths are kept as redirects so old deep links don't 404 — the former
**Logs** and **Simulator** pages were consolidated into Session Analysis in
v1.7.0: `/logs` → `/analysis` and `/simulator` → `/analysis`.

## Project structure

```
OmniLink/
├── src/
│   ├── components/
│   │   ├── ui/          shadcn-style primitives (button, card, dialog, sheet, …)
│   │   ├── layout/      AppShell, Sidebar, DeviceBar
│   │   ├── telemetry/   metric cards, sparkline, link chart, D3 polar plot, GPS panel
│   │   ├── map/         MapLibre flight map + offline tile style
│   │   ├── logs/        blackbox/session import, scrubber, anomaly panel
│   │   ├── simulator/   replay source + transport controls
│   │   ├── wizard/      stepper, per-step screens, flash progress, WiFi/Backpack steps
│   │   ├── bridge/      read-only flight-controller bridge surfaces
│   │   ├── settings/    AI/provider config, tile-pack manager, app-update card
│   │   └── ai/          chat button, panel, message bubble, typing indicator
│   ├── pages/           one component per route (lazy-loaded)
│   ├── stores/          Zustand stores: theme, device, telemetry, profiles, wizard, assistant, session, wifi, bridge
│   ├── hooks/           useDevice, useTelemetryStream
│   ├── lib/             i18n, the Tauri command seam, telemetry-crsf/-db, replay, elrsp, tile-packs, wifiDiscovery, knowledge/
│   ├── locales/{en,es}/ translation.json (English + Spanish, at parity)
│   └── index.css        Tailwind v4 setup + Signal Lab design tokens
├── src-tauri/           Rust shell
│   └── src/
│       ├── commands/    device, flash, ai, tiles, logs, profiles, wifi, bridge, secret_store
│       ├── flash/       engine, platformio, msp, patch, backup, backpack, bridge, guard
│       ├── crsf/        CRSF protocol parser
│       └── db/          SQLite migrations (telemetry + GPS + sessions)
├── data/                device catalogue, presets, knowledge packs, prompts, fixtures
├── docs/                releasing, signing, translations, third-party licences, HW validation
└── tests/
    ├── unit/            Vitest specs
    └── e2e/             Playwright specs
```

## Backend surface

Every subsystem is reached through a single seam (`src/lib/tauri.ts` ↔ a Rust
`#[tauri::command]`), so the UI never special-cases transport. The registered
command surface:

| Domain | Commands |
|--------|----------|
| Device | `list_serial_ports`, `connect_device`, `disconnect_device` |
| Flashing | `fetch_firmware_releases`, `derive_uid`, `start_flash`, `cancel_flash` |
| AI (BYOK) | `ai_send_message`, `ai_list_models`, `ai_set_api_key`, `ai_clear_api_key`, `ai_has_api_key`, `ai_preview_payload` |
| Offline tiles | `list_tile_packs`, `download_tile_pack`, `cancel_tile_pack_download`, `delete_tile_pack` |
| Flight logs | `decode_blackbox_log`, `cancel_blackbox_decode` |
| Profiles | `save_profile`, `load_profiles`, `delete_profile` |
| Folder sync | `plugin:folder-sync\|{grant,revoke,list,read,write,delete}` — the app's only filesystem commands, and the only ones under an explicit capability grant (`folder-sync:allow-*` in `src-tauri/capabilities/default.json`), each confined to the single directory the user granted |
| WiFi discovery | `start_wifi_scan`, `stop_wifi_scan`, `probe_wifi_device` |
| Controller bridge | `probe_bridge`, `run_passthrough_check`, `fetch_bridge_context` |

Live telemetry is event-driven (`device://link-stats` → the telemetry store +
batching SQLite writer) rather than a request/response command.

## Testing & quality gates

```bash
npm run typecheck                  # tsc --noEmit — must pass
npm run lint                       # eslint (0 warnings)
npm test                           # vitest unit suite
npm run e2e                        # playwright E2E
npm run build                      # full production build

cd src-tauri
cargo fmt --check                  # formatting
cargo test                         # Rust unit tests
cargo clippy --all-targets -- -D warnings
```

CI ([`.github/workflows`](.github/workflows)) runs Clippy + ESLint, `tsc --noEmit`,
the unit suites, and the Playwright E2E job on every push and pull request —
including pull requests from forks, which get a read-only token and touch no
secrets.

> **Worker counts are pinned** to two in `vitest.config.ts` and
> `playwright.config.ts`, so every way of starting the runners — including CI —
> agrees. Two timing-sensitive ML specs and Playwright's MapLibre specs flake when
> the machine is oversubscribed. No flag needed; pass one to override.
>
> **The E2E suite is fully green** — 70 passed, 0 failed, with no expected-failure
> allowance. The one test that used to fail on a clean checkout
> (`tests/e2e/notifications.spec.ts:58`) was a real product defect and is fixed in
> `3.0.1` — see
> [`CONTRIBUTING.md`](CONTRIBUTING.md#the-e2e-suite-is-fully-green).

## Contributing

Contributions are very welcome — **especially hardware reports.** The maintainer
owns no ELRS hardware, which makes on-device validation the project's single
biggest structural gap. If you have a radio and thirty minutes, you are the most
valuable contributor this project can get.

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — build instructions, quality gates, project
  conventions (the i18n rule and the seam pattern in particular), the safety rules
  that are not negotiable, maintainer capacity, and the **DCO sign-off requirement**
  (`git commit -s`).
- [`docs/HARDWARE_VALIDATION.md`](docs/HARDWARE_VALIDATION.md) — **eight numbered
  protocols you can run on your own gear.** Self-contained: pick one, follow the
  steps, paste the report block into an issue.
- [`data/CONTRIBUTING.md`](data/CONTRIBUTING.md) — the schema of every catalogue plus
  a worked example that adds a radio end to end. **The easiest useful pull request
  here, and it needs no hardware to submit.**
- [`AGENTS.md`](AGENTS.md) — the architecture and convention guide, canonical for both
  humans and AI coding assistants. `claude.md` points at it.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1.
- [`SECURITY.md`](SECURITY.md) — private vulnerability reporting. **Please do not
  open a public issue for a security problem.** OmniLink writes firmware to
  hardware, so flash-path and binding-phrase issues are the highest-severity class.

Good first contributions that need no hardware: device catalogue and preset
additions under [`data/`](data/CONTRIBUTING.md), translations, documentation fixes,
and accessibility improvements.

## Project history

OmniLink was built in phases, because ELRS hardware was unavailable throughout
development: first a complete high-fidelity UI on mock data, then each mock
replaced by a real Rust/serial/SQLite backend behind an already-isolated seam.

**None of the versions below are in this repository.** They were built before it was
published, and the summary here plus [`CHANGELOG.md`](CHANGELOG.md) is the record of
them — there is no `v1.5` tag or `v2.4` branch to check out. The code that survived
all of it is what you have.

- **v1.0** — real serial connection, CRSF telemetry + SQLite, firmware flashing,
  BYOK AI, and a hardening pass.
- **v1.5** — GPS telemetry and sessions, offline maps, blackbox-log import, anomaly
  detection, replay simulator, profile persistence, WiFi discovery, and ExpressLRS
  Backpack support.
- **v1.6** — cross-platform installers and a tagged release pipeline with
  minisign-signed updater artifacts (the installers themselves stayed unsigned, as
  they still are), in-app update checks, session management, live telemetry alerts,
  and a second locale (Spanish) with an accessibility pass.
- **v1.7** — consolidated the overlapping Logs and Simulator pages into one Session
  Analysis surface, added a persistent notification center, and hardened three
  already-shipped flashing paths.
- **v2.0** — local smart diagnostics: an on-device signal-health score, rule
  findings, post-flight patterns, optional BYOK "explain this finding", and local
  trends. All local, offline, and account-free.
- **v2.2** — a read-only Betaflight/iNav controller bridge. Never a flight-controller
  configurator: the only write it issues is the passthrough transport command.
- **v2.4** — a local BM25 knowledge index with cited retrieval, RAG-grounded
  assistant answers, user-imported docs, and an AI-assisted flashing wizard that
  always falls back to the static one.
- **v2.5** — a UI refactor, an ML research line published as an honest **negative
  result** (the models failed their own gate and reach no user), and a device/flash
  hardening release that fixed 32 defects found across three audits.
- **v3.0** — the open-source pivot: GPL-3.0-or-later, the retired platform stack
  deleted, and the project committed permanently to zero cost, no server, and no
  accounts.

Detailed per-release notes are in [`CHANGELOG.md`](CHANGELOG.md).

## License

**GPL-3.0-or-later.** See [`LICENSE`](LICENSE) for the full text.

OmniLink is free software: you may use, study, share, and modify it. If you
distribute a modified version, it must also be GPL-licensed and ship its source.

The licence matches the ecosystem — ExpressLRS and Betaflight are both GPL-3.0 — so
code can flow between these projects in the direction that matters.

Third-party dependency licences, with a GPL-3.0 compatibility verdict for each, are
audited in [`docs/THIRD_PARTY_LICENSES.md`](docs/THIRD_PARTY_LICENSES.md).
