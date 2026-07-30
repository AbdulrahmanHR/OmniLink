# OmniLink

**A free, open-source, offline-first desktop application for ExpressLRS drone-radio hardware. No accounts. No subscriptions. No cloud dependencies.**

[![License: GPL v3 or later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)
[![CI](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/ci.yml/badge.svg)](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/ci.yml)
[![Linux Build](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/linux-build.yml/badge.svg)](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/linux-build.yml)
[![Windows Build](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/windows-build.yml/badge.svg)](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/windows-build.yml)
[![macOS Build](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/macos-build.yml/badge.svg)](https://github.com/AbdulrahmanHR/OmniLink/actions/workflows/macos-build.yml)

OmniLink is a cross-platform desktop suite for configuring, flashing, and monitoring **ExpressLRS** gear across Windows, macOS, and Linux. Built on **Tauri 2 (Rust)**, **React 19**, and **TypeScript**.

OmniLink communicates directly with ExpressLRS hardware over **CRSF** (serial USB-CDC), device **Wi-Fi** APIs, and **ExpressLRS Backpack** companion devices. It provides real-time telemetry dashboards (RSSI / LQ / SNR, antenna polar plots, GPS mapping), guided firmware flashing, local profile management, Betaflight blackbox log decoding, and an optional bring-your-own-key (BYOK) AI assistant.

---

## Core Principles

Every feature in OmniLink is open and fully accessible. 

| Principle | Description |
|---|---|
| **Free & Open Source** | Released under **GPL-3.0-or-later**. Free to use, inspect, modify, and redistribute. |
| **Offline-First** | Telemetry, firmware flashing from cache, config profiles, and log analysis operate 100% offline. |
| **Zero Account Dependency** | No user registration, authentication, identity tracking, or personal data collection. |
| **No Cloud Backend** | The application runs completely on your local machine with zero external server dependencies. |
| **Privacy & Zero Telemetry** | No tracking or analytical pinging. Privacy is enforced at the architectural level. |
| **Bring Your Own Key (BYOK) AI** | Optional AI assistance powered by your own API key (Anthropic, OpenAI, Gemini, Groq, Ollama, etc.), stored securely in your OS keychain. |

> Architectural commitments are detailed in [`CONTRIBUTING.md`](CONTRIBUTING.md#scope-boundary--what-will-not-be-accepted). Contributions requiring central servers, paid entitlements, or telemetry tracking are strictly out of scope.

---

## Key Features

| Domain | Capability | Implementation Details |
|------|--------------|---------|
| **Device Connection** | Auto-enumeration, connection state machine, target & firmware identification, structured port diagnostics | Serial USB-CDC enumeration + CRSF handshake |
| **Telemetry Dashboard** | Real-time RSSI, LQ, SNR metrics, link quality sparklines, D3 polar plots, and live GPS map tracking | CRSF telemetry decoder + local SQLite storage |
| **Anomaly Detection** | Automated detection of link dropouts, LQ dips, and RSSI cliffs | Pure offline signal stream analysis |
| **Local Diagnostics** | On-device signal health scoring, post-flight trend analysis, and configuration recommendations | Local deterministic engine (no cloud ML) |
| **Firmware Flashing** | Guided Brand → Model → Frequency → Binding Phrase wizard with progress monitoring and config backups | Official release catalogue + PlatformIO/esptool flasher |
| **Flash Safety Guards** | Cross-target protection enforcing TX vs. RX image verification prior to hardware write ops | Rust-enforced pre-flash safety checks |
| **Backpack & Wi-Fi** | Discover, update, and manage ExpressLRS Backpack companion gear and Wi-Fi access point devices | Platform Wi-Fi scanning + mDNS discovery + MSP |
| **Config Profiles & Sync** | Create, diff, and export `.elrsp` configuration files. Sync across devices using any local or cloud-synced folder (Dropbox, Syncthing, Git) | Local `.elrsp` serialization + sandboxed folder mirror |
| **Blackbox Log Analysis** | Import and analyze Betaflight/iNav `.bbl` logs with full interactive scrubber controls | In-process pure-Rust `blackbox-log` parser |
| **Offline Maps & Replay** | Replay flight telemetry sessions with adjustable speed and view paths on offline tile sets | MapLibre GL + offline `.ompack` tile engine |
| **Flight Controller Bridge** | Read-only passthrough telemetry inspection via flight controller USB connections | Non-destructive MSP passthrough bridge |
| **BYOK AI Assistant** | Grounded technical assistant with local BM25 documentation indexing (RAG) and automatic PII scrubbing | Secure local keychain + direct provider API integration |

---

## Getting Started

### Prerequisites

* **[Node.js](https://nodejs.org/)** LTS (v22+) & `npm`
* **[Rust Toolchain](https://www.rust-lang.org/)** (v1.81+) & [Tauri Prerequisites](https://tauri.app/start/prerequisites/) for your operating system

### Installation & Execution

```bash
# Clone the repository
git clone https://github.com/AbdulrahmanHR/OmniLink.git
cd OmniLink

# Install dependencies
npm install

# Run frontend in browser mode (UI design & simulation)
npm run dev

# Run full desktop application (Tauri native shell for hardware serial/Wi-Fi access)
npm run tauri dev
```

---

## Operating System Setup

### Linux Serial Port Permissions (udev rules)

Accessing USB serial devices (`/dev/ttyUSB*`, `/dev/ttyACM*`) requires serial access permissions:

* **Debian / Ubuntu `.deb` Packages**: Pre-configured with udev rules (`60-omnilink-elrs.rules`) located in `/usr/lib/udev/rules.d/`.
* **AppImage / Source Installs**: Install the udev rules manually:
  ```bash
  sudo cp src-tauri/resources/linux/60-omnilink-elrs.rules /etc/udev/rules.d/
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```
* **Dialout Group Alternative**:
  ```bash
  sudo usermod -aG dialout "$USER"
  # Log out and log back in to apply group changes
  ```

### Windows Security & Firewall Prompts

* **SmartScreen Warning ("Unknown Publisher")**: Installers and updater binaries are unsigned by default. Click **More Info → Run Anyway**. For signing instructions, see [`docs/SIGNING.md`](docs/SIGNING.md).
* **Defender Firewall**: Allow network permissions when prompted to enable mDNS device discovery and Wi-Fi access point connections.

---

## Hardware Compatibility & Validation

Community validation ensures broad hardware reliability across ExpressLRS targets.

| Device | Type | Firmware Version | Connection | Verified Features | Protocol | Contributor | Date |
|--------|------|------------------|------------|-------------------|----------|-------------|------|
| _Awaiting initial reports_ | - | - | - | - | - | - | - |

<details>
<summary><strong>How to submit a Hardware Validation Report</strong></summary>

1. Choose a test protocol from [`docs/HARDWARE_VALIDATION.md`](docs/HARDWARE_VALIDATION.md).
2. Execute the protocol on your ExpressLRS hardware.
3. Submit a [Hardware Validation Issue](https://github.com/AbdulrahmanHR/OmniLink/issues/new?template=hardware_report.yml).
4. Submit a Pull Request updating the compatibility matrix table above.

</details>

---

## Tech Stack

* **Desktop Runtime**: [Tauri 2.x](https://tauri.app/) (Rust backend for serial, SQLite, and network protocol handling)
* **Frontend**: [React 19](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Vite 7](https://vite.dev/)
* **Styling**: [Tailwind CSS v4](https://tailwindcss.com/) & Radix UI primitives
* **State Management**: [Zustand 5](https://github.com/pmndrs/zustand)
* **Visualization & Mapping**: [Recharts 3](https://recharts.org/), [D3.js 7](https://d3js.org/), [MapLibre GL](https://maplibre.org/)
* **Internationalization**: `react-i18next` (Full English and Spanish support)
* **Testing**: [Vitest 3](https://vitest.dev/) (Unit), [Playwright](https://playwright.dev/) (E2E), `cargo test` (Rust)

---

## Quality & Testing Gates

All commits pass strict automated verification suites:

```bash
# Frontend quality checks
npm run typecheck       # Strict TypeScript verification
npm run lint            # ESLint rules
npm test                # Vitest unit suite
npm run e2e             # Playwright E2E testing
npm run build           # Production bundle build

# Rust backend checks
cd src-tauri
cargo fmt --check       # Formatting check
cargo clippy            # Linter check
cargo test              # Backend unit tests
```

---

## Contributing

We welcome contributions from developers, pilots, and technical writers!

* [`CONTRIBUTING.md`](CONTRIBUTING.md) — Architectural guidelines, build instructions, and DCO sign-off details (`git commit -s`).
* [`docs/HARDWARE_VALIDATION.md`](docs/HARDWARE_VALIDATION.md) — Hardware testing protocols and submission templates.
* [`data/CONTRIBUTING.md`](data/CONTRIBUTING.md) — Schema guidelines for adding new device targets and presets.
* [`AGENTS.md`](AGENTS.md) — Architecture reference for human contributors and AI assistants.
* [`SECURITY.md`](SECURITY.md) — Vulnerability disclosure policy.

---

## License

OmniLink is released under the **[GPL-3.0-or-later](LICENSE)** license. You are free to use, modify, and distribute this software under the terms of the GNU General Public License. Third-party dependency licenses are cataloged in [`docs/THIRD_PARTY_LICENSES.md`](docs/THIRD_PARTY_LICENSES.md).
