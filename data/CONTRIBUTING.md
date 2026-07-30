# Contributing to the OmniLink catalogues (`data/`)

**This is the easiest useful pull request OmniLink has, and it needs no
hardware to submit.**

Everything in this directory is reference data: which radios exist, what their
build targets are called, which config presets ship, and which documentation the
assistant is allowed to quote. Until now only the maintainer could add a radio.
That was the bottleneck, and it is removed — the schema of every catalogue is
written down below, and a malformed entry fails CI in seconds with a message
naming the offending file.

Read [`../CONTRIBUTING.md`](../CONTRIBUTING.md) first for the DCO sign-off
(`git commit -s`), the scope boundary, and how to run the gates. This file covers
only the data.

> **Submitting is not verifying.** A catalogue entry is a claim about real
> hardware. Anyone can write it; only somebody holding the device can confirm it.
> Say in the pull request whether you own the hardware, and if you do, please also
> add a row to the compatibility matrix in [`../README.md`](../README.md#hardware-compatibility-matrix)
> and run the relevant protocol in
> [`../docs/HARDWARE_VALIDATION.md`](../docs/HARDWARE_VALIDATION.md). "Copied from
> the ExpressLRS target list, not tested" is a perfectly good answer — an
> unstated assumption is not.

---

## Contents

- [Run the gate first](#run-the-gate-first)
- [Worked example — adding a radio, end to end](#worked-example--adding-a-radio-end-to-end)
- [Catalogue reference](#catalogue-reference)
  - [The brand / model catalogue — `src/lib/elrsTargets.ts`](#the-brand--model-catalogue--srclibelrstargetsts)
  - [`data/targets/backpack.json` — Backpack flash targets](#datatargetsbackpackjson--backpack-flash-targets)
  - [`data/presets/*.json` — config presets](#datapresetsjson--config-presets)
  - [`data/knowledge/` — documentation the assistant may quote](#dataknowledge--documentation-the-assistant-may-quote)
  - [`data/elrs_options_schema.json` — device-config options](#dataelrs_options_schemajson--device-config-options)
  - [`data/prompts/` — the assistant's system prompt](#dataprompts--the-assistants-system-prompt)
  - [`data/fixtures/` and `data/ml/` — corpora and frozen artifacts](#datafixtures-and-dataml--corpora-and-frozen-artifacts)
- [What will be declined](#what-will-be-declined)

---

## Run the gate first

One command validates every catalogue in this directory:

```bash
npm test -- tests/unit/dataCatalogueSchema.test.ts
```

That file is the executable version of this document. CI runs it on every pull
request as part of `npm test`, so a malformed entry never reaches review. If you
change a rule here, change it there in the same pull request — and vice versa.

Each assertion names the file and the entry it rejected, for example:

```
× data/targets/backpack.json > every declared target survives parseBackpackTargets — nothing is dropped
  → a declared Backpack target was dropped as malformed: expected 9 to be 10

× data/presets/*.json > every file parses, migrates to the current .elrsp schema, and is complete
  → racing-pro-500.json: packetRate 333: expected [ 50, 150, 250, 500, 1000 ] to include 333
```

The first of those two is worth understanding, because it is the one failure mode
you cannot see by eye. `parseBackpackTargets` is deliberately lenient at
runtime — it **discards** a malformed entry and never throws, so a typo makes
your target quietly vanish from the picker instead of crashing the app. Good for
users, useless for review. The gate therefore counts entries in and entries out
and fails if they differ.

---

## Worked example — adding a radio, end to end

Say you own a **Jumper Aion Nano TX**, a 2.4 GHz ESP32 transmitter whose
ExpressLRS build target is `JUMPER_AION_NANO_TX`, and it is not in OmniLink's
picker. Here is the whole change.

### 1. Find the real build target name

Do not invent it. Take it verbatim from ExpressLRS itself — the
[`targets/*.ini`](https://github.com/ExpressLRS/ExpressLRS/tree/master/src) files
in the firmware repository, or the target shown in the ExpressLRS Configurator
for your device. Build targets are compared **literally** by OmniLink's pre-flash
guard, because `BETAFPV_2400_TX` and `BETAFPV_2400_TX_MICRO_1W` are different
radios with different power amplifiers, and a substring match once let a 1 W
image through the gate for 250 mW hardware. A wrong target name here is a
hardware-damage bug, not a cosmetic one.

Record while you are there:

- **Device type** — `TX` (transmitter/module) or `RX` (receiver).
- **MCU family** — `ESP32`, `ESP8285`, `STM32`, …
- **Regulatory domains** — `ISM2400` for 2.4 GHz, or the sub-GHz set
  (`FCC915` / `EU868` / `AU915` / `EU433` / `IN866`). One radio is either 2.4 GHz
  (SX128x) or sub-GHz (SX127x), never both.
- **Flash methods** — `uart` (USB), `wifi` (self-AP OTA), `betaflight` (MSP
  passthrough through a flight controller).

### 2. Add the model to the brand catalogue

The brand/model catalogue lives in **`src/lib/elrsTargets.ts`**, not in a JSON
file — it is typed TypeScript so the compiler rejects an unknown domain or flash
method before any test runs. Adding to it is still a data edit, and the type
annotations tell you every field you need.

If the brand already exists, add a model to its `models` array. If not, add a
brand:

```ts
{
  id: "jumper",
  name: "Jumper",
  models: [
    {
      id: "jumper-aion-nano-tx-2400",   // lower-kebab, unique across the catalogue
      name: "Aion Nano TX",             // proper noun — NOT translated
      deviceType: "TX",
      target: "JUMPER_AION_NANO_TX",    // UPPER_SNAKE, exactly as ExpressLRS spells it
      mcu: "ESP32",
      domains: ["ISM2400"],
      firmwareVersions: FW_24,          // reuse the shared offline-fallback list
      flashMethods: ["wifi", "uart"],
    },
  ],
},
```

Notes that will save you a round-trip:

- `firmwareVersions` is only the **offline fallback**. The version list a user
  actually sees is fetched live from ExpressLRS GitHub Releases at runtime. Reuse
  the existing `FW_24` / `FW_900` constants rather than inventing a list.
- Model names are literal product names and are **not** run through i18n. This is
  the one deliberate exception to the zero-hardcoded-strings rule, and it applies
  to brand and model names only — never to labels, help text or errors.
- `id` is a stable key. Do not rename one once it has shipped; a saved profile
  may reference it.

### 3. Run the gate

```bash
npm test -- tests/unit/dataCatalogueSchema.test.ts
npm run typecheck
```

The gate checks your entry for a duplicate id, a duplicate build target, a
non-`UPPER_SNAKE` target, an unknown domain or flash method, a 2.4 GHz model that
also claims a sub-GHz domain, and a firmware string that is not `X.Y.Z`.

### 4. Say what you actually know

In the pull request body:

> Added the Jumper Aion Nano TX (`JUMPER_AION_NANO_TX`, ESP32, 2.4 GHz, UART +
> WiFi). Target name taken from the ExpressLRS target list. **I own this radio
> and flashed it over UART successfully** — matrix row added.

or, equally welcome:

> Target name taken from the ExpressLRS target list. **I do not own this radio**
> and have not flashed it; needs someone with the hardware to confirm.

That is the whole change: one catalogue entry, one test run, one honest sentence.

---

## Catalogue reference

### The brand / model catalogue — `src/lib/elrsTargets.ts`

Where "add my radio" happens. Typed TypeScript rather than JSON, deliberately:
`domains` and `flashMethods` are closed unions, so a typo is a compile error
instead of a silently-ignored value.

| Field | Type | Rule |
|-------|------|------|
| `id` | `string` | Unique across all brands. `^[a-z0-9-]+$`. Stable once shipped. |
| `name` | `string` | Product name, literal, not translated. |
| `deviceType` | `"TX" \| "RX"` | Drives the TX/RX flash guard. |
| `target` | `string` | ExpressLRS build target, `^[A-Z0-9_]+$`, unique, **verbatim from upstream**. |
| `mcu` | `string` | `ESP32`, `ESP8285`, `STM32`, … |
| `domains` | `RegulatoryDomain[]` | Non-empty. `ISM2400` may not be mixed with a sub-GHz domain. |
| `firmwareVersions` | `string[]` | Non-empty, each `X.Y.Z`. Offline fallback only. |
| `flashMethods` | `FlashMethod[]` | Non-empty subset of `wifi`, `uart`, `betaflight`. |

### `data/targets/backpack.json` — Backpack flash targets

ExpressLRS **Backpack** companion hardware (the ESP module that carries VTX /
DVR / head-tracker control), flashed over WiFi OTA.

```json
{
  "targets": [
    {
      "id": "tx-backpack-radiomaster-ranger",
      "name": "RadioMaster Ranger TX Backpack",
      "kind": "tx-backpack",
      "repoAsset": "RadioMaster_Ranger_TX_Backpack_via_WIFI.bin"
    }
  ]
}
```

| Field | Rule |
|-------|------|
| `id` | Unique, non-empty. Conventionally prefixed `tx-backpack-` / `vrx-backpack-`. |
| `name` | Non-empty display label. |
| `kind` | **Exactly** `"tx-backpack"` or `"vrx-backpack"`. Nothing else. |
| `repoAsset` | Firmware asset filename from the [ExpressLRS/Backpack](https://github.com/ExpressLRS/Backpack) releases. Must end `.bin`. |

`kind` is load-bearing: the cross-type guard refuses a TX-Backpack image on a
VRX-Backpack device by comparing that exact string. A third value would bypass
the guard rather than fail closed, which is why the gate pins the vocabulary to
two values.

> **Known limitation, stated honestly:** the Backpack firmware binary OmniLink
> ships is a **bundled placeholder**, not a real image. The per-target fetch from
> the ExpressLRS Backpack releases is an unimplemented seam. Adding a target here
> is still worthwhile — it is the catalogue half of the work — but the flash will
> not produce working firmware until that seam lands.

### `data/presets/*.json` — config presets

Read-only starting points a user can import and diff against their device. One
file per preset; the file is an `.elrsp` document plus catalogue metadata.

```json
{
  "schemaVersion": 1,
  "id": "preset-racing-pro-500",
  "name": "Racing Pro 500Hz",
  "description": "Low-latency 5\" race quad setup for close-proximity tracks.",
  "category": "racing",
  "tags": ["racing", "5-inch", "low-latency", "500hz"],
  "firmwareVersion": "3.4.1",
  "settings": {
    "packetRate": 500,
    "telemetryRatio": "1:128",
    "switchMode": "Wide",
    "txPower": 250,
    "dynamicPower": false,
    "modelMatch": true,
    "modelId": 1,
    "bindingPhrase": "race-pro-quad",
    "antennaMode": "Diversity",
    "fanThreshold": 100
  }
}
```

| Field | Rule |
|-------|------|
| `id` | Unique. The **filename must match**: `preset-racing-pro-500` ↔ `racing-pro-500.json`. |
| `name` / `description` | Non-empty strings. Describe the flying, not the numbers. |
| `category` | `racing`, `long-range`, `freestyle`, `cinematic`. |
| `tags` | Optional array of search keywords. |
| `firmwareVersion` | Optional, `X.Y.Z`. Drives the compatibility warning on import. |
| `settings.packetRate` | One of `50, 150, 250, 500, 1000`. |
| `settings.txPower` | One of `10, 25, 50, 100, 250, 500, 1000` (mW). |
| `settings.modelId` | `0`–`63`. |
| `settings.bindingPhrase` | An **example** phrase. ≤ 32 chars, no `@`. |

New files are picked up automatically — there is no index to register them in,
and the gate reads the directory from disk, so a new preset is validated the
moment you add it.

**Do not put a real binding phrase in a preset.** It is a shared secret: a real
one leaks yours, and anyone importing the preset would bind their gear to your
link. The gate rejects anything containing `@` or longer than 32 characters, but
that is a floor, not a substitute for judgement.

### `data/knowledge/` — documentation the assistant may quote

The local BM25 index behind the assistant's cited answers. No cloud retrieval;
this is the whole corpus.

```
data/knowledge/
├── registry.json   source metadata (id, title, licence, trust level, freshness)
├── packs/*.md      the actual document text
├── index.json      GENERATED — never hand-edit
└── eval/golden.json  retrieval eval set
```

Adding a source is **three coupled steps**, and the gate fails if you do two of
them:

1. Add the Markdown pack under `packs/`.
2. Register it in `registry.json` with `id`, `title`, `version`, `path`,
   optional `url`, `freshnessDate` (`YYYY-MM-DD`), `license`, and `trustLevel`
   (`official` or `omnilink-notes`).
3. Add the same `id` to the allowlist in `src/lib/knowledge/allowlist.ts` with a
   **matching** licence and trust level, then regenerate the index:

   ```bash
   npm run build:knowledge-index
   ```

The allowlist is a closed, deny-by-default licence gate: a source not on it is
rejected outright, and an allowlisted source whose declared licence or trust
level disagrees with the recorded entry is also rejected — a source cannot
re-license or promote itself. Only two classes ship by default: official
ExpressLRS documentation (GPL-3.0-or-later, matching the ExpressLRS project) and
OmniLink's own curated notes (CC-BY-4.0).

**Only contribute text you have the right to redistribute under a compatible
licence.** Pasting a vendor manual or a forum post is a licensing problem, not a
formatting one, and it will be declined. Summarising in your own words is fine.

`index.json` is a build artifact and must be byte-identical to a fresh build from
the packs — a separate test enforces that, so if you edit a pack and forget
`build:knowledge-index`, CI tells you.

### `data/elrs_options_schema.json` — device-config options

The data-driven source for the structured config form and the plain-English
wizard, derived from the ExpressLRS firmware's own
`binary_configurator.py` / `build_flags.py`.

Each field lives under `groups.<group>.fields.<field>` and declares:

| Key | Rule |
|-----|------|
| `type` | `string`, `int`, `bool`, `enum`, `uint8[6]`, … |
| `mechanism` | `binary_patch` (patched into a pre-built image, no compile) or `compile_flag` (needs PlatformIO). |
| `label` | Short display label. |
| `help` | Plain-English explanation, > 20 characters. This is OmniLink's actual value-add over the raw firmware options — extend it freely. |
| `choices` | Required for `enum`, forbidden otherwise. |
| `sensitive` | `true` keeps the value out of every AI payload and export. Boolean, never `"true"`. |
| `safety_critical` | `true` bars the assistant from ever suggesting the field. Boolean. |

Two flags are safety machinery rather than metadata. `sensitive` is what keeps a
binding phrase out of the AI payload; `safety_critical` is what stops the
assistant proposing an RF-power, failsafe or arming change. A string `"false"`
would be truthy in some checks and not others, so the gate pins both to real
booleans and asserts `binding.binding_phrase` is still `sensitive: true`.

A Rust-side drift guard cross-checks this file against the suggestion validator,
so adding a field is safe but *renaming* one may need a matching Rust change.

### `data/prompts/` — the assistant's system prompt

`system_assistant.md` is Omnia's persona and safety stance, loaded at runtime by
the Rust AI command. Editing it changes assistant behaviour for everyone, so
treat it as code: bump the `version:` in its header comment, and expect review to
be slower than for a catalogue entry. Anything that loosens a safety instruction
will be declined.

### `data/fixtures/` and `data/ml/` — corpora and frozen artifacts

- **`data/fixtures/diagnostics/`** — labelled telemetry-session CSVs with a
  manifest declaring each fixture's class and the findings the rules must
  produce. New fixtures are welcome, and **real recorded sessions are far more
  valuable than synthetic ones** — but they must contain no identifiers: blank
  `lat`/`lon`, no MACs, no binding phrases. A manifest entry whose expectations do
  not match the rules' actual output fails its own acceptance test.
- **`data/fixtures/ml-synthetic/`** — drawn, not recorded. Clearly separated from
  the real corpus and labelled indicative-only.
- **`data/ml/*.json`** — frozen, generated evaluation artifacts (a baseline and
  two model evaluations) produced by the `build:ml-*` scripts and byte-checked by
  tests. **Do not hand-edit them.** They exist so a published number cannot
  silently drift from the code that produced it.

---

## What will be declined

- **A build target you have not verified against upstream ExpressLRS.** Wrong
  target names are how a flash reaches the wrong hardware.
- **A device entry invented from a product page** where the ExpressLRS target is
  guessed. Say "I could not find the target name" and open an issue instead.
- **Documentation packs you do not have redistribution rights to** — vendor
  manuals, forum posts, copied wiki text under an incompatible licence.
- **A real binding phrase, GPS coordinates, MAC address, or email** anywhere in
  this directory. Fixtures and presets are published; treat them as public.
- **Hand-edited generated artifacts** — `data/knowledge/index.json`,
  `data/ml/*.json`. Rerun the build script instead.
- **A catalogue "improvement" that widens a safety vocabulary** — a third
  Backpack `kind`, a `safety_critical: false` on a field that is one, a new
  regulatory domain with no hardware behind it. These fail closed today; keep
  them that way.
- Anything in [`../CONTRIBUTING.md`](../CONTRIBUTING.md#scope-boundary--what-will-not-be-accepted)'s
  scope boundary — a server, an account, telemetry, or a paid tier. Data
  contributions rarely bump into that, but a catalogue that has to be *fetched*
  from somewhere would.
