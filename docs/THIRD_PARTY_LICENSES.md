# Third-Party Licences — GPL-3.0 Compatibility Audit

**Audit date:** 2026-07-29
**Audited at:** OmniLink `2.5.2` (branch `3.0.0`)
**Milestone:** M68 (v3.0 open-source pivot), deliverable 1
**Purpose:** establish, before `LICENSE` is written, that OmniLink may lawfully be
distributed under **GPL-3.0-or-later** (decision **D33**).

---

## Verdict

> **PASS — no dependency is GPL-3.0-incompatible.**
>
> No proprietary, SSPL, BUSL, CC-NC, "source-available", or field-of-use-restricted
> licence appears anywhere in either dependency tree, at any depth. Every licence
> encountered is either permissive, weak-copyleft-compatible-with-GPL, or a public-domain
> dedication. **D33 (GPL-3.0-or-later) may proceed.**

### D33 is **ELECTIVE**, not compelled

The v3.0 milestone plan — a private maintainer working document, not part of this
repository — stated in its §3 D33 reason 2 that `blackbox-log 0.4.3` "is
**believed** to be copyleft-licensed" and that if it is GPL or LGPL, "a permissive
licence for OmniLink was never available and D33 is compelled rather than chosen."

**That belief is incorrect.** `blackbox-log 0.4.3` is dual-licensed **`MIT OR
Apache-2.0`** — permissive on both arms. See the verbatim record below.

**Consequence:** no dependency forces copyleft on OmniLink. A permissive licence
(MIT / Apache-2.0) *was* available. **D33 therefore stands on its own reasoning —
ecosystem match with ExpressLRS and Betaflight, and preserving the "a vendor must
ask" option — not on compulsion.** This does not change the decision; it changes
the *justification*, and the record should say so plainly.

GPL-3.0-or-later remains legally available: MIT, Apache-2.0, BSD, ISC, MPL-2.0,
Zlib, BSL-1.0, 0BSD, Unlicense, CC0-1.0 and Unicode-3.0 are all one-way compatible
*into* GPLv3. (Apache-2.0 is compatible with GPL**v3** but not GPLv2 — irrelevant
here, since OmniLink licenses at v3-or-later.)

---

## `blackbox-log 0.4.3` — resolved verbatim

This crate is statically linked into the shipped Tauri binary
(`src-tauri/src/commands/logs.rs`, in-process `.bbl` decode), so its terms bind the
distributed executable. It was resolved from the **actual vendored crate source**,
not inferred.

**Source of record:** `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/blackbox-log-0.4.3/`
**Lockfile checksum:** `d4536b25c4dbc5883af8946974541846b5decf7f3a8d27d79ee6122cfa0f4750`
**Upstream VCS commit:** `816f4adc822d4187bbaf31210b21c61e5abee076`
**Repository:** <https://github.com/blackbox-log/blackbox-log>

Verbatim from the crate's own `Cargo.toml.orig` (`[workspace.package]`, inherited by
the package via `license.workspace = true`):

```toml
[workspace.package]
edition = "2021"
license = "MIT OR Apache-2.0"
rust-version = "1.81"
```

Verbatim from the crate's bundled `README.md`, section `## License`:

```
## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE] or <http://www.apache.org/licenses/LICENSE-2.0>)
- MIT license ([LICENSE-MIT] or <http://opensource.org/licenses/MIT>)

at your option.
```

**Licence: `MIT OR Apache-2.0`. Permissive, dual-licensed, at the user's option.**
**GPL-3.0 verdict: COMPATIBLE** (both arms are one-way compatible into GPLv3).

*Note:* the crate's published `.crate` archive sets `include = ["/src/**/*", …,
"/README.md"]`, so the upstream `LICENSE-APACHE` / `LICENSE-MIT` files are not
packaged. The licence grant is carried by the `license` field and the README section
quoted above, both reproduced here verbatim.

---

## Method

| Tree | Tool | Scope |
|------|------|-------|
| Cargo | `cargo-license` (installed for this audit) | `cargo license --avoid-dev-deps` — **659** crates in the resolved graph |
| npm | `license-checker` | full production + dev tree — **351** packages (350 third-party + OmniLink itself) |

The milestone plan named `license-checker-rspack`; that package **does not exist on
the npm registry** (`E404`). The functionally equivalent and long-established
`license-checker` was used instead, as the milestone's "or equivalent npm licence
tool" permits.

Every direct dependency is enumerated below. Transitive licences were audited in
aggregate (full-tree summaries in the appendix); each distinct licence expression
found at any depth is given a verdict.

---

## Direct dependencies — Cargo (`src-tauri/Cargo.toml`)

| Crate | Version | Licence | GPL-3.0 verdict |
|-------|---------|---------|-----------------|
| `tauri` | 2.11.3 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `tauri-build` (build-dep) | 2.6.3 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `tauri-plugin-opener` | 2.5.4 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `tauri-plugin-updater` | 2.10.1 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `tauri-plugin-process` | 2.3.1 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `tauri-plugin-dialog` | 2.7.1 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `tauri-plugin-notification` | 2.3.3 | `Apache-2.0 OR MIT` | ✅ Compatible — see **[C]** |
| `tauri-plugin-sql` | 2.4.0 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `serde` | 1.0.228 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `serde_json` | 1.0.150 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `serialport` | 4.9.0 | `MPL-2.0` | ✅ Compatible — see note **[A]** |
| `reqwest` | 0.13.4 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `md-5` | 0.10.6 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `tempfile` | 3.27.0 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `tokio` | 1.52.3 | `MIT` | ✅ Compatible |
| `mdns-sd` | 0.20.0 | `Apache-2.0 OR MIT` | ✅ Compatible |
| **`blackbox-log`** | **0.4.3** | **`MIT OR Apache-2.0`** | ✅ **Compatible** — resolved verbatim above |
| `tracing` | 0.1.44 | `MIT` | ✅ Compatible |
| `tracing-subscriber` | 0.3.23 | `MIT` | ✅ Compatible |
| `tracing-appender` | 0.2.5 | `MIT` | ✅ Compatible |
| `keyring` (per-OS target dep) | 3.6.3 | `Apache-2.0 OR MIT` | ✅ Compatible |

**[A] `serialport` — MPL-2.0.** Mozilla Public License 2.0 is a *file-level* weak
copyleft and is **explicitly GPL-compatible** via MPL-2.0 §3.3 ("Distribution of a
Larger Work"), unless the work carries the Exhibit B notice *"Incompatible With
Secondary Licenses"*. The vendored crate's `LICENSE.txt`
(`~/.cargo/registry/src/…/serialport-4.9.0/LICENSE.txt`) contains only the standard
MPL-2.0 header notice and **no Exhibit B**. Verified by direct grep. Obligation
inherited: MPL-covered source files must remain available under MPL — satisfied
automatically, since the crate is consumed unmodified from crates.io.

## Direct dependencies — npm `dependencies` (shipped in the app bundle)

| Package | Version | Licence | GPL-3.0 verdict |
|---------|---------|---------|-----------------|
| `@fontsource/ibm-plex-mono` | 5.3.0 | `OFL-1.1` | ✅ Compatible — see **[B]** |
| `@fontsource/inter` | 5.3.0 | `OFL-1.1` | ✅ Compatible — see **[B]** |
| `@fontsource/space-grotesk` | 5.3.0 | `OFL-1.1` | ✅ Compatible — see **[B]** |
| `@radix-ui/react-slot` | 1.3.0 | `MIT` | ✅ Compatible |
| `@tauri-apps/api` | 2.11.1 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `@tauri-apps/plugin-dialog` | 2.7.1 | `MIT OR Apache-2.0` | ✅ Compatible |
| `@tauri-apps/plugin-notification` | 2.3.3 | `MIT OR Apache-2.0` | ✅ Compatible — see **[C]** |
| `@tauri-apps/plugin-opener` | 2.5.4 | `MIT OR Apache-2.0` | ✅ Compatible |
| `@tauri-apps/plugin-process` | 2.3.1 | `MIT OR Apache-2.0` | ✅ Compatible |
| `@tauri-apps/plugin-sql` | 2.4.0 | `MIT OR Apache-2.0` | ✅ Compatible |
| `@tauri-apps/plugin-updater` | 2.10.1 | `MIT OR Apache-2.0` | ✅ Compatible |
| `class-variance-authority` | 0.7.1 | `Apache-2.0` | ✅ Compatible (GPLv3+ only) |
| `clsx` | 2.1.1 | `MIT` | ✅ Compatible |
| `d3` | 7.9.0 | `ISC` | ✅ Compatible |
| `i18next` | 26.3.1 | `MIT` | ✅ Compatible |
| `lucide-react` | 1.21.0 | `ISC` | ✅ Compatible |
| `maplibre-gl` | 5.24.0 | `BSD-3-Clause` | ✅ Compatible |
| `react` | 19.2.7 | `MIT` | ✅ Compatible |
| `react-dom` | 19.2.7 | `MIT` | ✅ Compatible |
| `react-i18next` | 17.0.8 | `MIT` | ✅ Compatible |
| `react-router-dom` | 7.18.0 | `MIT` | ✅ Compatible |
| `recharts` | 3.8.1 | `MIT` | ✅ Compatible |
| `tailwind-merge` | 3.6.0 | `MIT` | ✅ Compatible |
| `tw-animate-css` | 1.4.0 | `MIT` | ✅ Compatible |
| `zustand` | 5.0.14 | `MIT` | ✅ Compatible |

**[B] `@fontsource/*` — SIL Open Font License 1.1 (added after the 2026-07-29 audit
date, at `3.0.3`).** These three packages carry the Inter, IBM Plex Mono and Space
Grotesk font files, which are bundled into the app so it renders correctly with no
network — they replace the `fonts.googleapis.com` `<link>` that `3.0.2` shipped in
`index.html`. OFL-1.1 is a free copyleft licence *for fonts*; its only unusual term
is that the fonts may not be sold on their own, which is satisfied trivially here
(they are redistributed as part of a program, at no charge). The fonts are **data
consumed at runtime, not code linked into the program**, so OFL imposes nothing on
OmniLink's own licence; the reserved font names are unchanged and the files are
redistributed unmodified, so the OFL's rename obligation is not triggered either.
The upstream licence text ships inside each package (`node_modules/@fontsource/*/
LICENSE`). **Verdict: compatible; no obligation beyond retaining those notices.**

**[C] `tauri-plugin-notification` / `@tauri-apps/plugin-notification` — the two
halves of one dependency (added after the 2026-07-29 audit date, at `3.0.3`).**
The crate is registered in `src-tauri/src/lib.rs` and statically linked into the
shipped binary; the npm package is imported by `src/lib/alertNotify.ts` and bundled.
They replace the Web Notifications API for OS alert toasts, which cannot be granted
in any webview the app ships in. Both are published by the Tauri project under the
same permissive dual grant as every other Tauri dependency already listed
(`Apache-2.0 OR MIT`; the npm tarball writes the same expression as `MIT OR
Apache-2.0`), so the MIT arm is available and each arm is one-way compatible into
GPL-3.0.

Adding them locks **three** new transitive crates, all target-gated notification
backends and all permissively dual-licensed — verified from each vendored
`Cargo.toml`:

| Crate | Version | Licence | Reaches the build on | Verdict |
|-------|---------|---------|----------------------|---------|
| `notify-rust` | 4.18.0 | `MIT OR Apache-2.0` | Linux (D-Bus / XDG notifications) | ✅ |
| `mac-notification-sys` | 0.6.15 | `MIT/Apache-2.0` | macOS | ✅ |
| `tauri-winrt-notification` | 0.7.3 | `MIT OR Apache-2.0` | Windows | ✅ |

`mac-notification-sys` declares the deprecated slash form `MIT/Apache-2.0` rather
than a valid SPDX expression; it is the same dual `MIT OR Apache-2.0` grant, and the
crate ships both licence texts. **Verdict: compatible on every platform; no new
licence expression enters either tree that is not already resolved above, and the
appendix counts below (taken at the audit date) are correspondingly four crates and
one npm package short.**

## Direct dependencies — npm `devDependencies` (build/test only, not distributed)

| Package | Version | Licence | GPL-3.0 verdict |
|---------|---------|---------|-----------------|
| `@axe-core/playwright` | 4.11.3 | `MPL-2.0` | ✅ Compatible — see **[A]**; test-only, not linked |
| `@eslint/js` | 10.0.1 | `MIT` | ✅ Compatible |
| `@playwright/test` | 1.61.0 | `Apache-2.0` | ✅ Compatible |
| `@tailwindcss/vite` | 4.3.1 | `MIT` | ✅ Compatible |
| `@tauri-apps/cli` | 2.11.3 | `Apache-2.0 OR MIT` | ✅ Compatible |
| `@types/d3` | 7.4.3 | `MIT` | ✅ Compatible |
| `@types/node` | 26.0.0 | `MIT` | ✅ Compatible |
| `@types/react` | 19.2.17 | `MIT` | ✅ Compatible |
| `@types/react-dom` | 19.2.3 | `MIT` | ✅ Compatible |
| `@vitejs/plugin-react` | 4.7.0 | `MIT` | ✅ Compatible |
| `eslint` | 10.5.0 | `MIT` | ✅ Compatible |
| `eslint-plugin-react-hooks` | 7.1.1 | `MIT` | ✅ Compatible |
| `eslint-plugin-react-refresh` | 0.5.3 | `MIT` | ✅ Compatible |
| `tailwindcss` | 4.3.1 | `MIT` | ✅ Compatible |
| `typescript` | 5.8.3 | `Apache-2.0` | ✅ Compatible |
| `typescript-eslint` | 8.61.1 | `MIT` | ✅ Compatible |
| `vite` | 7.3.5 | `MIT` | ✅ Compatible |
| `vitest` | 3.2.6 | `MIT` | ✅ Compatible |

---

## Items that required individual resolution

Five entries in the raw tool output were not self-evidently compatible and were run
down individually. None is a blocker.

### 1. `unescaper` — `GPL-3.0 OR MIT` (Cargo, transitive)

The only crate in either tree carrying a GPL arm. It is **dual-licensed**, so the MIT
arm is available; and the GPL-3.0 arm is trivially compatible with a GPL-3.0-or-later
work in any case. **No action, no obligation beyond attribution.** ✅

### 2. `caniuse-lite` — `CC-BY-4.0` (npm, transitive, build-time only)

A browser-support **data** package pulled in by `browserslist`/`vite`. Used at build
time to target CSS/JS output; **no part of it is emitted into the shipped bundle**.
CC-BY-4.0 is declared by Creative Commons to be one-way compatible with GPLv3, and
the attribution requirement is satisfied by this file. ✅

### 3. `webpki-root-certs` — `CDLA-Permissive-2.0` (Cargo, transitive)

The Mozilla CA root-certificate bundle, carried under the Community Data License
Agreement – Permissive 2.0. CDLA-Permissive-2.0 imposes **no copyleft, no
field-of-use restriction, and no reciprocal obligation** on the receiving work — it
is a permissive *data* licence. Compatible with redistribution inside a GPL-3.0
work. ✅

### 4. `@mapbox/jsonlint-lines-primitives 2.0.2` — licence field absent (npm, transitive)

Pulled in by `maplibre-gl` (via `@maplibre/maplibre-gl-style-spec`) and therefore
present in the shipped bundle. Its published `package.json` **declares no `license`
or `licenses` field**, so `license-checker` reports it as `Custom:
https://github.com/tmcw/jsonlint`.

Resolution: the package's own source repository, `mapbox/jsonlint`, reports SPDX
licence **`MIT`** via the GitHub API (`gh api repos/mapbox/jsonlint --jq
.license.spdx_id` → `MIT`). The package is a fork of `tmcw/jsonlint`, itself a fork
of `zaach/jsonlint`, and the package source was inspected directly for any
restrictive header — **none is present**.

**Verdict: MIT, GPL-3.0-compatible ✅ — with a recorded caveat.** This is a metadata
omission in the published npm tarball, not a restrictive grant. It is *not* a
blocker under the M68 stop rule (proprietary / SSPL / BUSL / CC-NC or similar), but
it is the single weakest attribution link in the tree and is logged here so it is
not rediscovered as a surprise. **Follow-up (non-blocking):** an upstream PR adding
`"license": "MIT"` to that package's `package.json` would close it permanently.

### 5. `omnilink` — reported `UNLICENSED` (npm)

This is **OmniLink itself**, not a third party. `license-checker` reports
`UNLICENSED` because at audit time `package.json` carried `"private": true` and no
`license` field. **Fixed by M68 deliverable 4**, which removes `"private": true` and
adds `"license": "GPL-3.0-or-later"`. Re-running the tool after that change reports
OmniLink as `GPL-3.0-or-later`. ✅

---

## Appendix — full-tree licence distribution

Every distinct licence expression appearing at **any** depth, with its verdict.
Counts are packages, not lines.

### Cargo — 659 crates, 31 distinct expressions

| Licence expression | Count | Verdict |
|--------------------|-------|---------|
| `Apache-2.0 OR MIT` | 406 | ✅ |
| `MIT` | 157 | ✅ |
| `Apache-2.0 OR MIT OR Zlib` | 22 | ✅ |
| `Unicode-3.0` | 18 | ✅ (permissive, OSI-approved) |
| `MIT OR Unlicense` | 6 | ✅ |
| `MPL-2.0` | 6 | ✅ (see **[A]**) |
| `Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT` | 5 | ✅ |
| `Apache-2.0` | 3 | ✅ (GPLv3+) |
| `Apache-2.0 OR BSD-2-Clause OR MIT` | 3 | ✅ |
| `Apache-2.0 OR ISC OR MIT` | 3 | ✅ |
| `BSD-3-Clause` | 3 | ✅ |
| `ISC` | 3 | ✅ |
| `Apache-2.0 OR BSD-3-Clause OR MIT` | 2 | ✅ |
| `Apache-2.0 OR BSL-1.0 OR MIT` | 2 | ✅ |
| `Apache-2.0 OR LGPL-2.1-or-later OR MIT` | 2 | ✅ (dual; MIT/Apache arm taken) |
| `BSD-3-Clause OR MIT` | 2 | ✅ |
| `Zlib` | 2 | ✅ |
| `0BSD OR Apache-2.0 OR MIT` | 1 | ✅ |
| `Apache-2.0 AND ISC` | 1 | ✅ |
| `Apache-2.0 AND MIT` | 1 | ✅ |
| `Apache-2.0 OR BSL-1.0` | 1 | ✅ |
| `Apache-2.0 OR CC0-1.0 OR MIT-0` | 1 | ✅ |
| `Apache-2.0 WITH LLVM-exception` | 1 | ✅ |
| `Apache-2.0 AND BSD-3-Clause` (via `encoding_rs`) | 1 | ✅ |
| `BSD-3-Clause AND MIT` | 1 | ✅ |
| `CDLA-Permissive-2.0` | 1 | ✅ (item 3) |
| `GPL-3.0 OR MIT` | 1 | ✅ (item 1) |
| `(Apache-2.0 OR ISC OR MIT) AND … AND MIT` (`aws-lc-sys`) | 1 | ✅ |
| `(Apache-2.0 OR ISC) AND ISC` (`aws-lc-rs`) | 1 | ✅ |
| `(Apache-2.0 OR MIT) AND Unicode-3.0` | 1 | ✅ |
| `N/A` (`omnilink` itself) | 1 | — not third-party |

### npm — 351 packages, 15 distinct expressions

| Licence expression | Count | Verdict |
|--------------------|-------|---------|
| `MIT` | 239 | ✅ |
| `ISC` | 54 | ✅ |
| `Apache-2.0` | 20 | ✅ (GPLv3+) |
| `BSD-2-Clause` | 9 | ✅ |
| `BSD-3-Clause` | 8 | ✅ |
| `MPL-2.0` | 5 | ✅ (see **[A]**) |
| `MIT OR Apache-2.0` | 5 | ✅ |
| `Apache-2.0 OR MIT` | 4 | ✅ |
| `(MIT OR Apache-2.0)` | 1 | ✅ |
| `MIT AND ISC` | 1 | ✅ |
| `BlueOak-1.0.0` | 1 | ✅ (permissive) |
| `Unlicense` | 1 | ✅ (public-domain dedication) |
| `CC-BY-4.0` | 1 | ✅ (item 2) |
| `Custom: https://github.com/tmcw/jsonlint` | 1 | ✅ (item 4 — resolves to MIT) |
| `UNLICENSED` | 1 | — OmniLink itself (item 5) |

**Licences NOT present anywhere in either tree** (the M68 stop list, verified absent):
proprietary / all-rights-reserved third-party code, SSPL, BUSL / Business Source
License, Elastic License, Commons Clause, any CC `NonCommercial` (`-NC-`) or
`NoDerivatives` (`-ND-`) variant, JSON License ("shall be used for Good, not Evil"),
and AGPL.

---

## Obligations OmniLink inherits

Distributing OmniLink under GPL-3.0-or-later does not discharge upstream terms.
Concretely:

1. **Attribution.** MIT, BSD-2/3-Clause, ISC, Apache-2.0 and Zlib all require their
   copyright and permission notices to travel with binary distributions. **This file
   is that notice** and must ship in the source tree; it is referenced from
   `README.md` and `CONTRIBUTING.md`.
2. **Apache-2.0 §4(b)/(c)/(d).** Modified Apache-2.0 files must be marked, and any
   `NOTICE` file content must be reproduced. OmniLink modifies no Apache-2.0
   dependency — all are consumed unmodified from crates.io / npm.
3. **MPL-2.0 §3.** `serialport`, `lightningcss` and `axe-core` source files remain
   available under MPL-2.0. Satisfied by consuming them unmodified from their public
   registries; if any is ever patched in-tree, the patched files must be published
   under MPL-2.0.
4. **CC-BY-4.0.** `caniuse-lite` requires attribution — given in item 2 above.
5. **This file must be regenerated** whenever a dependency is added, removed, or
   bumped across a licence change. M73 (public launch gate) re-verifies it, and M71
   must refresh it if it changes any dependency.

## Reproducing this audit

```bash
# from the repository root

# Cargo
cargo install cargo-license          # one-off
cd src-tauri && cargo license --avoid-dev-deps
cd ..

# npm
npx license-checker --summary
npx license-checker --json           # per-package detail

# blackbox-log, verbatim from the vendored source
BB=~/.cargo/registry/src/index.crates.io-*/blackbox-log-0.4.3
grep -E '^license' "$BB"/Cargo.toml.orig
sed -n '/^## License/,/at your option./p' "$BB"/README.md
```

The `LICENSE` file at the repository root is the canonical FSF GPL-3.0 text,
installed byte-identically from `/usr/share/common-licenses/GPL-3`
(674 lines, 35 149 bytes,
sha256 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`),
including the "How to Apply These Terms to Your New Programs" appendix.
