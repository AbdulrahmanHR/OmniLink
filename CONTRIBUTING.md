# Contributing to OmniLink

Thanks for considering a contribution. OmniLink is a free, open-source
(GPL-3.0-or-later), offline-first desktop app for ExpressLRS hardware. It has no
server, no accounts, and no paid tier — and it never will. That constraint shapes
what can be merged, so please read the [Scope boundary](#scope-boundary--what-will-not-be-accepted)
section before starting anything substantial.

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Table of contents

- [Maintainer capacity — read this before you start](#maintainer-capacity--read-this-before-you-start)
- [Scope boundary — what will not be accepted](#scope-boundary--what-will-not-be-accepted)
- [Good first contributions](#good-first-contributions)
  - [Catalogue data — the easiest useful pull request here](#catalogue-data--the-easiest-useful-pull-request-here)
- [Developer Certificate of Origin (DCO) — required](#developer-certificate-of-origin-dco--required)
- [Building OmniLink](#building-omnilink)
- [Quality gates](#quality-gates)
  - [Worker counts are pinned](#worker-counts-are-pinned)
  - [The E2E suite is fully green](#the-e2e-suite-is-fully-green)
- [Project conventions](#project-conventions)
  - [The i18n rule — zero hardcoded user-facing strings](#the-i18n-rule--zero-hardcoded-user-facing-strings)
  - [The backend seam pattern](#the-backend-seam-pattern)
  - [State management (Zustand)](#state-management-zustand)
  - [Rust backend conventions](#rust-backend-conventions)
- [Safety rules that are not negotiable](#safety-rules-that-are-not-negotiable)
- [Submitting a pull request](#submitting-a-pull-request)
- [Reporting bugs and security issues](#reporting-bugs-and-security-issues)
- [Licensing of contributions](#licensing-of-contributions)

---

## Maintainer capacity — read this before you start

Plainly, so nobody wastes their time:

**One unpaid maintainer.** OmniLink is a solo project worked on in spare time. There
is no team, no company behind it, no funding, and no rota. Nobody is on call.

**No ExpressLRS hardware.** The maintainer owns none and cannot buy any. Every test
in this repository runs against a mock, a fixture, or a fake device. That is why
[`docs/HARDWARE_VALIDATION.md`](docs/HARDWARE_VALIDATION.md) exists and why a
hardware report is worth more here than almost any patch.

**Realistic response window.** A first response usually within **one to two weeks**;
sometimes longer. A security report via
[private advisory](SECURITY.md) is triaged first and everything else waits behind
it. Silence means a backlog, not disinterest — a polite ping after two weeks is
welcome and will not annoy anyone.

**Review is slower than writing.** A large pull request from a stranger against a
tool that writes firmware to hardware takes real time to read properly, and it will
not be merged unread. **Open an issue before building anything substantial.** A
five-minute exchange about scope routinely saves a weekend of work that cannot be
merged.

### What gets merged readily

- **Hardware reports and on-device validation.** The single biggest gap. If you have
  a radio and thirty minutes you are the most valuable contributor this project can
  get. Start at [`docs/HARDWARE_VALIDATION.md`](docs/HARDWARE_VALIDATION.md).
- **Device catalogue and preset data** under `data/` — see
  [`data/CONTRIBUTING.md`](data/CONTRIBUTING.md). Small, self-contained, gated by
  automated schema checks, quick to review.
- **Translations and i18n fixes**, including improving machine-copied Spanish
  strings.
- **Bug fixes with a regression test.** The test is what makes it quick to review:
  it says what was wrong, and it stops it coming back.
- **Documentation corrections**, including to this file. If something here is wrong
  or unclear, that is a defect.
- **Accessibility fixes.**

### What is declined on sight

Not "deprioritised" — declined, however well written, because the architecture
forbids it. In full detail below, in summary here: **anything requiring a server, an
account, telemetry or analytics, or a paid tier.** See
[Scope boundary](#scope-boundary--what-will-not-be-accepted).

This boundary is stated once, publicly, in advance. It is not a judgement of the
idea; it is the reason the project can stay free permanently and cost its author
nothing to run. Knowing it up front saves you writing code that cannot be merged,
and saves the project the slow accumulation of obligations that ends solo projects.

**A "no" is about scope, not about you.** If an idea does not fit, the honest answer
comes quickly rather than sitting in a queue pretending to be under consideration.

---

## Scope boundary — what will not be accepted

**OmniLink accepts no feature that requires a server, an account, or a payment.**

This is a hard architectural boundary, not a matter of current priorities or of
maintainer bandwidth. A pull request implementing any of the following will be
declined on sight, however well written:

- **A server, backend service, or hosted API of any kind** — including "just a small
  proxy", a sync service, a relay, or a hosted database.
- **User accounts, login, identity, sessions, or user records** — local or remote.
- **Payments, subscriptions, entitlements, credits, licence keys, or a paid tier.**
- **Telemetry, analytics, crash reporting to a remote endpoint, or usage tracking.**
  OmniLink does not phone home. It has no "anonymous statistics" toggle because it
  collects nothing to toggle.
- **Anything that introduces a recurring cost to operate the project** — a managed
  database, an auth vendor, a per-MAU service, a paid CI tier.
- **Making an existing offline workflow require a network connection.** Device
  config, flashing from cache, telemetry, profiles, and log analysis must all keep
  working with networking fully disabled.

AI assistance is **bring-your-own-key (BYOK) only**. You supply an API key for a
provider you already pay (or run Ollama locally); it is stored in your OS keychain
and never leaves your machine except to call the provider you chose. There is no
OmniLink-operated AI service and no plan for one.

This boundary exists so the project stays free permanently and costs its sole
maintainer nothing to run. Stating it once, publicly, saves you from writing code
that cannot be merged.

**What is very welcome** is listed under
[Maintainer capacity](#what-gets-merged-readily), plus performance work with a
measurement attached.

If you are unsure whether an idea fits, open an issue and ask before building it.

---

## Good first contributions

### Catalogue data — the easiest useful pull request here

**Adding a radio, a Backpack target, or a config preset needs no hardware to
submit.** It is a few lines of data, it is validated automatically, and until
recently only the maintainer could do it — which made the most obviously
crowd-sourceable part of the project its narrowest bottleneck.

[**`data/CONTRIBUTING.md`**](data/CONTRIBUTING.md) documents the schema of every
catalogue and walks through adding one transmitter end to end: finding its real
ExpressLRS build target, writing the entry, running the gate, and what to say in the
pull request. One command validates your work:

```bash
npm test -- tests/unit/dataCatalogueSchema.test.ts
```

A malformed entry fails there in seconds with your file named, rather than in review
days later.

**Submitting is not verifying, and saying so is part of the contribution.** A
catalogue entry is a claim about real hardware: anyone can write it, but only
somebody holding the device can confirm it. Both of these are good pull-request
bodies —

> Target name taken from the ExpressLRS target list. **I own this radio** and flashed
> it over UART successfully.

> Target name taken from the ExpressLRS target list. **I do not own this radio** and
> have not flashed it; needs someone with the hardware to confirm.

— and the second is not a lesser contribution. An unstated assumption is the only
bad answer.

If you *do* own the hardware, please also run the matching protocol in
[`docs/HARDWARE_VALIDATION.md`](docs/HARDWARE_VALIDATION.md) and add a row to the
[compatibility matrix](README.md#hardware-compatibility-matrix). The matrix is a
plain Markdown table, seeded empty, and it is the project's only public evidence
that any of this runs on real gear.

### Other good first contributions

- **Translations** — `src/locales/{en,es}/translation.json`, at strict key parity.
  See [`docs/TRANSLATIONS.md`](docs/TRANSLATIONS.md).
- **Documentation fixes**, including to this file and to the hardware protocols. An
  unclear protocol is a defect in the protocol.
- **Accessibility improvements** — every page is scanned by `axe` in the E2E suite,
  so a fix comes with its own evidence.

---

## Developer Certificate of Origin (DCO) — required

OmniLink uses the **DCO**, not a CLA. You keep the copyright in your contribution;
you simply certify that you have the right to submit it. Every commit must carry a
`Signed-off-by` trailer:

```bash
git commit -s -m "fix: reject zero-length firmware images before flashing"
```

`-s` appends, using your configured git identity:

```
Signed-off-by: Your Name <your.email@example.com>
```

Set your identity once, if you have not already:

```bash
git config user.name  "Your Name"
git config user.email "your.email@example.com"
```

Forgot to sign off? Amend the last commit, or sign off a whole branch:

```bash
git commit --amend -s --no-edit                  # last commit
git rebase --signoff main                        # every commit on the branch
```

**Why DCO and not a CLA.** A CLA exists to let a project relicense or dual-license
contributed code later. OmniLink has no commercial ambition, so a CLA would buy
nothing while asking contributors to sign a legal document. The knowing trade-off:
once outside contributions are merged, OmniLink can never be relicensed without
every contributor's agreement. That is accepted deliberately.

### Developer Certificate of Origin, Version 1.1

The full text you are certifying to when you sign off:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

---

## Building OmniLink

### Prerequisites

**1. Node.js LTS and npm.**
Node 22 LTS or newer. CI builds on Node 22. Install from
[nodejs.org](https://nodejs.org/) or via a version manager (`nvm`, `fnm`, `volta`).

```bash
node --version   # v22.x or newer
npm --version
```

**2. Rust toolchain (stable).**
Only needed for the native desktop shell — frontend-only work does not require it.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustc --version   # 1.81 or newer (blackbox-log requires 1.81+)
```

**3. Tauri 2 system prerequisites.**
Follow the official guide at <https://tauri.app/start/prerequisites/> for your OS.
The essentials:

<details>
<summary><strong>Linux (Debian / Ubuntu)</strong></summary>

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev \
  build-essential curl wget file
```

This is exactly the set CI installs, so if it builds here it builds in CI.
Fedora, Arch and openSUSE equivalents are in the Tauri prerequisites page.
</details>

<details>
<summary><strong>Windows</strong></summary>

- **Microsoft C++ Build Tools** with the "Desktop development with C++" workload.
  Rust's default Windows toolchain is MSVC and it needs a linker; without this,
  `cargo build` fails at link time with a missing `link.exe`.
- **WebView2** — preinstalled on Windows 11 and current Windows 10; otherwise
  install the Evergreen Runtime from Microsoft.
- Nothing else. There is no apt-equivalent package list on Windows: WebView2 is the
  system web view, so the whole `libwebkit2gtk` / `libsoup` / `libgtk` list in the
  Linux block has **no Windows counterpart**.
- **If you develop in WSL, serial work needs a native Windows build.** WSL cannot see
  COM ports, so an app built inside WSL will never find a real device. Build and run
  natively on Windows for anything touching serial, flashing, or the CRSF handshake.
  Frontend-only work (`npm run dev`) is fine in WSL.
- The installers this project builds are **not Authenticode-signed**, so SmartScreen
  warns on first launch — expected, not a defect. See
  [`docs/SIGNING.md`](docs/SIGNING.md).
</details>

<details>
<summary><strong>macOS</strong></summary>

```bash
xcode-select --install
```

- That is the whole system-dependency story: WebKit is part of the OS, so — as on
  Windows — the Linux `apt` list has **no macOS counterpart**. No Homebrew packages
  are required.
- CI builds a universal binary, so both targets are useful locally:

  ```bash
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  ```

  You only need these to reproduce the CI bundle. A plain `npm run tauri dev` builds
  for your own architecture and needs neither.
- Builds are **not notarized or Developer-ID signed**, so Gatekeeper warns on first
  launch — expected. See [`docs/SIGNING.md`](docs/SIGNING.md).
- Serial devices appear as `/dev/tty.usbserial-*` or `/dev/tty.usbmodem*`. There is
  no permissions step: macOS needs no udev equivalent and no group membership.
</details>

> **What has actually been verified, and what has not.** The Linux block above was
> executed verbatim at v3.0.1 on a bare `ubuntu:24.04` image with nothing
> preinstalled — the apt list, `npm install`, all four frontend gates, and the Rust
> fmt/clippy/test gates. The **Windows and macOS blocks have not been executed**;
> they are derived from the
> [official Tauri prerequisites](https://tauri.app/start/prerequisites/) and from
> what this project's own CI installs on `windows-latest` and `macos-latest`, which
> do build successfully. If a step is missing on your platform, that is a
> documentation bug worth an issue.

### Install and run

```bash
git clone https://github.com/AbdulrahmanHR/OmniLink.git
cd OmniLink
npm install
```

```bash
# Frontend only — in a browser. Fastest loop for UI work.
# Every device/serial/WiFi/AI call rejects gracefully and the UI shows its
# honest empty state. No Rust toolchain needed.
npm run dev

# Full native desktop app. Required for serial, flashing, WiFi, and SQLite.
npm run tauri dev
```

### The Rust half does not rebuild itself

`npm run dev` serves the frontend live, so a JS change is on screen the moment you
save it. **Nothing does that for Rust.** Start the native app any way other than
`npm run tauri dev` — most easily by launching an already-built
`src-tauri/target/debug/omnilink` alongside a `npm run dev` server — and you are
driving a current frontend against whatever the Rust half was the last time it
compiled.

**What makes this expensive is that it does not look like a build problem.** A
stale backend presents as a *product* defect: a command that answers
"Unavailable", a toggle that never appears, a capability the UI reports as
unsupported. During `3.0.3` verification a `target/debug` eleven hours older than
the commits under test — predating the notification work entirely — was read as a
shipped bug for the length of a session.

`npm run tauri dev` compiles Rust first, every time, and is the right answer in
almost every case. When you want the compile without the window — before
re-verifying, or after switching branches:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
```

**Rebuild `src-tauri` before verifying any Rust-side change.** A
`#[tauri::command]`, an emitted event name, an entry in `src-tauri/capabilities/`,
anything under `src-tauri/src/` — none of it is in the binary you are running
until you do.

### Linux serial permissions

Opening `/dev/ttyUSB*` or `/dev/ttyACM*` needs permission, and "Permission denied"
on first connect is the most common first-run wall. OmniLink ships a udev rule at
`src-tauri/resources/linux/60-omnilink-elrs.rules`:

```bash
sudo cp src-tauri/resources/linux/60-omnilink-elrs.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
# then replug the device
```

Or, more bluntly, `sudo usermod -aG dialout "$USER"` and log back in. The `.deb`
package installs the rule for you. See `README.md` for the full explanation.

---

## Quality gates

Every gate must pass before a pull request is merged. CI runs all of them, but
running them locally first is much faster than a round-trip.

```bash
cd /path/to/OmniLink

npm run typecheck   # tsc --noEmit — strict mode, must be clean
npm run lint        # ESLint over src/ — zero warnings
npm run build       # tsc && vite build — full production build
npm test            # Vitest unit suite
```

```bash
cd src-tauri

cargo fmt --check                        # formatting
cargo clippy --all-targets -- -D warnings
cargo test                               # Rust unit tests
```

**End-to-end (Playwright)** — required only if you touched UI:

```bash
npm run e2e
```

### Worker counts are pinned

Both runners are fixed to **two workers** in their own configs —
`maxWorkers: 2` in `vitest.config.ts`, `workers: 2` in `playwright.config.ts`.
You do not need to pass a flag, and it applies however you start them: the npm
scripts, a bare `vitest`, `npx playwright test`, an IDE runner, or CI. Local and
CI results therefore agree by construction.

Two specs flake above that count: `tests/unit/ml/mlInferenceBudget.test.ts` and
`tests/unit/ml/v25PrivacyAudit.test.ts` assert timing budgets and fail
intermittently when the machine is oversubscribed. Playwright's specs contend for
the GPU through MapLibre, most visibly on WSL2. All of them pass reliably at two
workers and in isolation.

The pin is in the configs rather than in the npm scripts on purpose: a config
value can still be overridden from the command line, whereas a flag baked into
`npm test` collides with one you pass — vitest rejects a duplicated
`--maxWorkers` outright. So `npm run test -- --maxWorkers=4` works if you want it.

A "flaky" failure in one of those three places is usually an overloaded machine
rather than something you broke. Re-run it before assuming otherwise.

### The E2E suite is fully green

The expected result is **70 passed, 0 failed**. There is no known-failing test and
no expected-failure allowance: if something is red, it is either your change or an
overloaded machine.

**This section used to say otherwise, and the correction is worth reading once.**
Until `3.0.1`, `tests/e2e/notifications.spec.ts:58` failed on a clean checkout and
this file told you to expect *69 passed, 1 failed*. It was a real product defect —
carried as "pre-existing" since `2.5.0` and repeatedly written off as flake — and
it is fixed in `3.0.1`. The spec was never touched; the code was. See
`CHANGELOG.md [3.0.1]`.

If an E2E test fails, that one is yours.

### What each gate is protecting

| Gate | Protects |
|------|----------|
| `typecheck` | TypeScript strict mode, including `noUnusedLocals` / `noUnusedParameters`. Prefix a deliberately unused parameter with `_`. |
| `lint` | `typescript-eslint` + `react-hooks` + `react-refresh` rules. |
| `test` (Vitest) | Pure logic. Unit tests run in **Node, not jsdom** — keep them free of DOM assumptions. `tests/e2e/**` is excluded from Vitest so the two runners never collide. |
| `e2e` (Playwright) | Real app in headless Chromium, driven through a Tauri IPC/event mock seam (`tests/e2e/_helpers.ts`). Also asserts **zero serious/critical a11y violations** per page via `@axe-core/playwright`. |
| `cargo test` | The CRSF parser, flash guards, MSP framing, sanitisation, and the catalogue logic. |
| `cargo clippy -D warnings` | Warnings are errors in CI. |

New behaviour needs a test. A bug fix should come with the regression test that
would have caught it.

---

## Project conventions

[`AGENTS.md`](AGENTS.md) at the repository root is the project's detailed convention
guide — architecture, seams, design tokens, per-subsystem status, and the project
policies §1–§8. It is written for AI coding assistants but reads perfectly well for
humans, and it is the most complete description of how the codebase is organised.
Read it before a large change.

> **Which file is canonical: `AGENTS.md`.** It was `claude.md` until v3.0.1;
> `claude.md` is now a short pointer to `AGENTS.md`, not a second copy. The
> canonical file is the one at the cross-tool conventional path so that an AI
> assistant picks up the i18n rule, the seam pattern and the policies *unprompted*,
> whichever assistant a contributor uses — a pointer at that path would defeat the
> point. If you work through an AI assistant, letting it read `AGENTS.md` first will
> save you most of the review round-trips this document exists to prevent.

### The i18n rule — zero hardcoded user-facing strings

**This is the convention most likely to fail your PR, so it comes first.**

Every string a user can see goes through `react-i18next`. No exceptions —
not for buttons, not for error messages, not for `aria-label`s, not for a
"temporary" placeholder, not for tooltips or empty states.

```tsx
// ✗ Rejected
<button aria-label="Connect device">Connect</button>

// ✓ Correct
const { t } = useTranslation();
<button aria-label={t("device.connect.ariaLabel")}>{t("device.connect.label")}</button>
```

- Translation files: `src/locales/en/translation.json` and
  `src/locales/es/translation.json`.
- **`en` and `es` must stay at exact key parity.** Adding a key to one locale and
  not the other fails `tests/unit/translationStrings.test.ts`. If you do not speak
  Spanish, add the English string and copy the English text into `es` — a
  translator can improve it later, but the key must exist.
- Deleting a surface means deleting its keys from **both** locales.
- Numbers and dates format through the JavaScript `Intl` API, not hand-rolled
  formatting.

### The backend seam pattern

Every subsystem is reached through exactly one seam, so the UI never special-cases
transport and a mock can be swapped for a real backend without redesigning
components.

**All Rust ↔ JS traffic goes through `src/lib/tauri.ts`.** That file holds the typed
`invoke()` wrappers, the typed event listeners (`device://`, `flash://`,
`wifi://`, `tiles://`, `logs://`), and every DTO interface mirroring the Rust side.

When you add a Rust command:

1. Write the `#[tauri::command]` in the right file under `src-tauri/src/commands/`
   (one file per domain).
2. Register it in the `invoke_handler!` macro in `src-tauri/src/lib.rs`.
3. Add the typed wrapper **and** the DTO interfaces to `src/lib/tauri.ts`.
4. Call it from a store or hook — **never `invoke()` directly from a component.**

Long-running work (connection, flashing, telemetry, scanning) uses Tauri's **event
system**, not request/response: Rust spawns a worker thread and emits events; the
frontend subscribes through the typed helpers in `tauri.ts`.

Structured error events use a `{ category, summaryKey, detail }` shape so the
frontend can localise them via `t()`. Do not emit a raw English error string.

### State management (Zustand)

- One store per domain in `src/stores/`, re-exported from `src/stores/index.ts`.
- Flat, action-based — no reducers.
- Keep derived values as selectors, not duplicated state.
- Components read stores; stores call the `tauri.ts` seam.

### Rust backend conventions

- Commands live in `src-tauri/src/commands/`, one file per domain.
- Long-running work spawns `std::thread` and emits Tauri events (not async tasks).
- Managed state uses Tauri's `.manage()` pattern.
- Serial I/O uses the `serialport` crate directly, not `tauri-plugin-serialport`.
- API keys are stored backend-side in the OS keychain and **never returned to the
  frontend** — the frontend may only learn a boolean (`ai_has_api_key`).

---

## Safety rules that are not negotiable

OmniLink writes firmware to hardware. A defect here bricks somebody's radio or, at
the extreme, causes a mid-air failure. These rules are enforced by tests; changing
them requires an explicit discussion, not a PR.

1. **Flash safety.** A TX-target image can never be flashed to an RX device, or
   vice versa, and Backpack images cannot cross TX-Backpack/VRX-Backpack types. The
   guard runs *before* any erase or write. Config is backed up before every flash.
2. **AI privacy.** The assistant never receives binding phrases, GPS coordinates,
   MAC addresses, IP addresses, or email addresses. Context is scrubbed by
   `sanitize_context()` in `src-tauri/src/commands/ai.rs`. Do not weaken it, and do
   not add a field that bypasses it.
3. **The AI cannot suggest safety-critical changes.** RF power, failsafe, arming and
   binding-secret fields are deny-listed in a closed, deny-by-default validator. A
   crafted model response must not be able to write them.
4. **The controller bridge is read-only.** A Betaflight/iNav flight controller is a
   passthrough *endpoint*, never a managed device. The only write ever issued is
   `MSP_SET_PASSTHROUGH`. No FC settings editing, no FC firmware flashing.
5. **Offline-first.** Core workflows must function with zero network connectivity.

---

## Submitting a pull request

1. **Open an issue first** for anything larger than a bug fix, so scope can be
   agreed before you spend time on it.
2. **Branch from the current integration branch** (`v3`), not from a release tag.
3. **Commit with `git commit -s`** — the DCO sign-off is mandatory on every commit.
4. **Use [Conventional Commits](https://www.conventionalcommits.org/)** for the
   subject line: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`.
   Write the body in normal prose explaining *why*, not just what.
5. **Run the gates locally.** A PR that fails `typecheck` or `lint` will not be
   reviewed until it is green.
6. **Keep the PR focused.** One logical change. Unrelated reformatting makes review
   disproportionately expensive for a solo maintainer.
7. **Fill in the PR template**, including the DCO checkbox.
8. **Say whether you tested on real hardware**, and if so, exactly what hardware.
   "Not tested on hardware" is a perfectly acceptable answer — an unstated
   assumption is not.

Be patient with review. OmniLink has a single unpaid maintainer; see
[`SECURITY.md`](SECURITY.md) for honest response-time expectations.

---

## Reporting bugs and security issues

- **Bugs and feature ideas** — open an issue using the templates at
  <https://github.com/AbdulrahmanHR/OmniLink/issues/new/choose>. The bug template
  asks for OS, app version, radio/RX model, and connection mode; please fill them
  in, because almost every hardware bug is specific to one of those.
- **Hardware validation results** — use the **Hardware validation report** template
  after running a protocol from
  [`docs/HARDWARE_VALIDATION.md`](docs/HARDWARE_VALIDATION.md). A `FAIL` is more
  useful than a `PASS`, and `blocked` ("I don't have that gear") is genuinely useful
  too. Please do not report a pass you did not personally observe.
- **Security vulnerabilities** — **do not open a public issue.** Report privately
  via GitHub Security Advisories. See [`SECURITY.md`](SECURITY.md) for the process
  and for which classes of issue are treated as most severe (flash-path and
  binding-phrase issues top the list).

---

## Licensing of contributions

OmniLink is licensed under **GPL-3.0-or-later**; the full text is in
[`LICENSE`](LICENSE). By contributing under the DCO you agree that your
contribution is licensed under the same terms.

You retain copyright in your work. There is no copyright assignment.

Third-party dependency licences and their GPL-3.0 compatibility verdicts are
audited in [`docs/THIRD_PARTY_LICENSES.md`](docs/THIRD_PARTY_LICENSES.md). **If your
change adds, removes, or bumps a dependency across a licence change, update that
file in the same PR.** A dependency under a proprietary, SSPL, BUSL, or
non-commercial licence cannot be accepted — it would make OmniLink undistributable.
