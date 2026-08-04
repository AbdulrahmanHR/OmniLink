# Changelog

All notable changes to OmniLink are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

> **Editorial note, added at `[3.0.2]` — what this file refers to, and what it does
> not.** This repository is published as a fresh repository whose first commit is
> `3.0.2`. **Every entry below `[3.0.2]` describes development that happened before
> publication**, and the commits, tags and branches those entries name are not part
> of this repository — including `[3.0.0]`'s "It is still in git history, by
> decision", the decision `[3.0.2]` supersedes. Older entries also cite planning
> documents by a bare `docs/…` path: milestone plans, readiness audits, scope
> decisions. **Those documents are not in this repository and never were** — they
> are private maintainer working notes and are not published anywhere. Neither fact
> has been edited away below. A changelog quietly rewritten after the event is worth
> less than one that says what it said and is corrected in the open.

## [3.0.3] — 2026-08-01

**"The map paints."** The first release cut after this app was run under the
engine it actually ships in. Four defects surfaced that the chromium-only test
suite could not see — two of them present in Chromium as well, including a
headline feature that has been visibly broken in `3.0.2` and in every release
before it — and the notification work among them shipped a regression of its own
for exactly one commit. Both facts are written down below rather than folded
away.

### The flight map has painted nothing since the theme moved to OKLCH

**This shipped in `3.0.2` and every release before it, in every browser — not
just WebKit.** Load a session with GPS and the flight map drew a themed
rectangle and no track.

`resolveThemeColor` returned `getComputedStyle().backgroundColor` verbatim, and
its own comment asserted that the value "is always serialised as `rgb()` in
every engine even when the source token is OKLCH". That is false in every
current engine — WebKitGTK 2.52.3 and Chromium 149 both return `oklch(...)` —
and the MapLibre style spec rejects it:

```
layers[0].paint.background-color: color expected, "oklch(0.2 0.012 240)" found
```

So the style never loaded, so `load` never fired, so no source and no layer was
ever added, and `fitBounds` never ran. The map sat at zoom 1 over null island
with an empty style, drawing a themed backdrop and nothing else. **Nobody saw
the error, because `map.on("error", () => {})` discarded every one of them
unconditionally.**

`toMapLibreColor` (`src/components/map/map-style.ts`) now converts
`oklch()`/`oklab()` to `rgb()` through the CSS Color 4 matrices — pure and
DOM-free, therefore testable in this repo's node vitest environment. Values
already in a form the spec accepts pass through untouched, and anything
unrecognised falls back to the caller's hex rather than to a wrong colour. The
23 conversion cases were validated against ground truth — each string painted
into a canvas in Chromium and the pixel read back — not against the
implementation that produces them. A computed `rgba(0, 0, 0, 0)` from an
undefined `var()` is now treated as unresolved rather than painted transparent,
which is the same class of silent blanking. Error handling is selective now:
expected offline tile and source failures stay quiet, style and configuration
errors are reported.

Two latent crashes surfaced the moment the map could initialise at all. Map
cleanup runs `setStyle(null)`, so the layer children's cleanups called
`getLayer()` on a dead instance — guaranteed under StrictMode, which unmounts
the dashboard. And `resolveSignalRamp` feeds `hexToRgb`, which was
`#rrggbb`-only and threw on anything else. Both are guarded.

**The test suite could not see any of it, and that is the part worth
recording.** `tests/e2e/map.spec.ts` asserted `toBeAttached()` on the host and
the canvas — which passes on a zero-height clipped element — and one commit
later asserted visibility and a non-zero bounding box, which passes on a
completely blank canvas. It now asserts that the style loaded, that the four
expected layers exist, that the camera left its provisional zoom, and that the
canvas is not a single flat colour. Every assertion was confirmed failing
against the pre-fix code before it was accepted.

### Three more defects the chromium-only suite could not see

Every e2e test this project has ever run is headless Chromium. The first real
run under Tauri/WebKitGTK surfaced three further defects, one of which had been
shipping since `3.0.2`.

- **Native `<select>` was unreadable at all 12 sites.** WebKitGTK paints form
  controls with the GTK theme background while Tailwind preflight sets
  `color: inherit`, and `color-scheme` was declared nowhere in the codebase — so
  near-white text landed on a near-white widget. It is now declared per theme
  block, light on `:root` and dark on `.dark` and `.carbon`, so it tracks the
  resolved theme rather than hardcoding dark, which would have fixed one theme
  by breaking another. Verified against computed styles in all five theme
  states, including system-resolves-light while the OS prefers dark.
- **The map container was collapsed to height 0** whenever a GPS session
  loaded, in Chromium too. `maplibre-gl.css` was imported from JS and therefore
  unlayered, and in Tailwind v4 unlayered CSS beats layered utilities — so
  `.maplibregl-map { position: relative }` overrode the host's `absolute
  inset-0` and clipped a fully-initialised 460×300 canvas. It is imported into
  `layer(base)` from `index.css` now. Fixing it did not make the map render: it
  made the OKLCH defect above observable. The map was broken twice over, and
  only the outer break had a symptom anyone had looked at.
- **`Notification.requestPermission()` was called from a mount effect.** WebKit
  enforces the user-gesture requirement Chromium is lax about, so OS
  notification permission was ungrantable in production. The request now fires
  from an explicit opt-in button in Settings → Live alerts, synchronously in the
  click handler; already-decided states never re-prompt.

### The Google Fonts CDN is gone — and this release adds dependencies

An app that promises no account, no server and no telemetry was sending every
user's IP address to Google on launch, from a `<link>` in `index.html`, and the
fonts failed outright offline — which at a flying site is the normal case, not
the edge one. Inter, IBM Plex Mono and Space Grotesk are self-hosted now via
`@fontsource` at the same weights, OFL-1.1.

**So this release cannot claim "zero new dependencies", and earlier entries in
this file did.** Three runtime npm packages are added — `@fontsource/inter`,
`@fontsource/ibm-plex-mono`, `@fontsource/space-grotesk` — plus the notification
plugin pair described below: `@tauri-apps/plugin-notification` and the
`tauri-plugin-notification` crate, which locks three target-gated transitive
crates (`notify-rust` on Linux, `mac-notification-sys` on macOS,
`tauri-winrt-notification` on Windows). Every one is recorded with its licence
and its GPL-3.0 compatibility verdict in `docs/THIRD_PARTY_LICENSES.md`. None of
them calls the network: the font files are bundled into the build, and the
notification path is local IPC.

### Desktop notifications: unobtainable, then always on, then opt-in

Three commits, and **the middle state was a regression this release introduced
itself**. Recording it is cheaper than pretending the line went straight.

#### The web Notification API can never be granted in the app as it ships

The gesture fix above was correct and still insufficient. Verified live under
WebKitGTK 2.52.3: a real user gesture on the Settings opt-in button drives
`Notification.permission` from `"default"` to `"denied"` within 2.5 s with no
prompt window ever appearing, because wry 0.55.1 installs no handler for the
webview's permission-request signal and the default handler denies. WKWebView
and WebView2 have the same class of problem.

Both halves of `tauri-plugin-notification` are required, which is worth stating
because the JS half alone looks like a fix and is not:
`@tauri-apps/plugin-notification` is a thin shell over `window.Notification`, so
without the Rust half it walks straight back into the dead path.
`tauri_plugin_notification::init()` ships a `js_init_script` that **replaces**
`window.Notification` with a shim routing the constructor, the permission getter
and `requestPermission()` through `__TAURI_INTERNALS__.invoke`. The pair is the
fix. The capability grants three named permissions rather than
`notification:default`, which bundles sixteen — the plugin's `invoke_handler`
registers exactly `notify`, `request_permission` and `is_permission_granted`,
and the other thirteen are mobile-only scheduling, channel and listener commands
that do not exist on desktop. Outside Tauri the seam probes
`__TAURI_INTERNALS__` rather than `isTauri()`, because that is the exact object
the plugin's invoke dereferences; everything reports unsupported there, nothing
is called and nothing throws.

#### The plugin migration silently removed the opt-in

Moving OS notifications onto `tauri-plugin-notification` was correct. But the
"Enable" button, and the whole permission-driven UI around it, rested on an
assumption that turned out to be false: that the platform decides.

**It does not. On desktop, the plugin grants unconditionally.** Both
`permission_state()` and `request_permission()` are literally
`Ok(PermissionState::Granted)` in the crate's desktop backend
(`tauri-plugin-notification-2.3.3/src/desktop.rs:65-67`) — Linux, macOS and
Windows alike. No prompt window is ever shown, and there is nothing for a user
to refuse. So the "Enable" button never rendered (the app already read as
granted on first launch), and **for one commit every tripped alarm raised a real
system notification on a fresh install, with no opt-in anywhere and only the
master mute able to stop it.**

That is worse than it sounds, because the alarms do not need a radio. Three of
the four are enabled with zero configuration, and a replayed or *scrubbed* log
frame reaches the same evaluation path as live telemetry — so importing an old
flight log on a laptop with nothing plugged in was enough to raise system popups
over whatever the operator was actually doing.

#### The app owns the consent gate now

`osNotifyEnabled` is a persisted preference in the alerts store, **defaulting
OFF**, and it — not the OS — is what a tripped alarm is gated on
(`osNotifyAllowed(…)` in `src/lib/alertNotify.ts`, the single source of truth,
mirroring `maybePlayAlertSound`). The app owns this gate because the OS owns it
on no platform this ships to: freedesktop notifications have no permission model
at all, the macOS backend uses the legacy `NSUserNotification` path and never
touches `UNUserNotificationCenter`, and the Windows shim short-circuits before
the command is even called.

Settings → Live alerts now shows an on/off toggle shaped exactly like the
audio-alert row directly beneath it, whose comment has said since FR-TELEM-03
that it is *"opt-in — defaults OFF, because an unexpected beep is intrusive."* A
system popup paints over other applications and persists in the OS notification
centre after dismissal, so it cannot coherently default on where a 150 ms chirp
does not. Mute still overrides both — and always-on had in fact *removed* a
capability rather than adding one, since mute suppresses the toast, the
notification-centre entry and the beep together, so "in-app alerts but no
desktop popups" had become inexpressible. It is expressible again.

What is kept from the permission model is what is still real: the platform state
is mirrored so the row can render `unsupported` (a browser/dev build with no
native path) and a genuine `denied` from any platform that ever answers one, and
turning the toggle ON still calls `requestOsNotifyPermission()` un-awaited from
the user's gesture — the desktop backend ignores it, but the mobile backend and
any future desktop permission model will not, and asking on launch would be
wrong regardless of what the engine enforces.

Copy that the code had made false is gone rather than left standing: the hint no
longer promises "Your system asks for permission when you enable this", because
it never does. The dead Enable-button keys are removed symmetrically in both
locales.

`osNotifyEnabled` is a new defaulted-`false` field, which zustand's shallow merge
fills from the initializer for anyone's existing persisted state, so there is no
`persist` version bump and no migration — an operator upgrading into this release
starts OFF, which is the intended answer for a consent they were never asked for.

Four end-to-end tests hold the line where it actually matters: with the OS
reporting granted, importing the dropout fixture and scrubbing into it raises the
in-app alert and **sends nothing**; flipping the toggle makes the identical scrub
send exactly one, with the matching title and body; mute beats the opt-in; and
the opt-in survives a reload. Each was watched failing against a `true`
initializer before being kept.

#### Replayed telemetry raises no system notification at all

Replayed log frames are pushed into the same `useTelemetryStore.history` that
`LiveAlertHost` evaluates, and nothing on the OS-notification path told the two
apart — so a user who opted in and then scrubbed an old log got real system
popups, indoors, on a laptop, with no hardware attached, for alarms that happened
days ago. `osNotifyAllowed` gains an `isSimulating` term, keeping the whole rule
in one testable predicate rather than scattering a second condition through the
host.

The gate cannot suppress live telemetry, and the reason is structural rather than
incidental: `useTelemetryStream` registers its producer behind
`liveStreamActive(isConnected, isSimulating)`, so a live frame can only enter the
buffer while `isSimulating` is false. The existence of a live frame is itself
proof the term is open. There is no sampling window either — zustand notifies
synchronously, so the host reads the flag inside the same push that produced the
frames.

Only the OS channel carries the term. The toast, the notification-centre entry,
the beep and `recordFiredAlerts` stay mute-only: a toast while scrubbing is the
app telling you what happened in the recording, which is useful. A system popup
for a days-old event is not.

Three existing e2e tests turned out to be asserting the buggy behaviour — they
opted in, scrubbed, and expected a send. They are re-based onto a real live path
driven through the device store rather than weakened, which is why the live-path
test was mandatory rather than optional: one of them would otherwise have passed
after the fix for the wrong reason, and kept passing even if the opt-in gate were
deleted.

### CI: the signing key's job was running unpinned third-party code

An audit of the fork-PR path found the CI hardening itself sound — no
`pull_request_target`, no `workflow_run`, no artifact-consumption chain, no
script-injection surface — and two problems that reasoning had missed.

**Third-party actions were unpinned in the jobs that hold the signing key.**
`dtolnay/rust-toolchain@stable` is a mutable **branch** head, not a tag, and it
runs in the same job that later hands `TAURI_SIGNING_PRIVATE_KEY` to
`tauri-apps/tauri-action@v0`, itself a mutable major tag. A compromise upstream
would need no access to the secret at all: it runs earlier in the same job on the
same filesystem, so it can plant a shim on `PATH` or append to `$GITHUB_ENV`. With
`createUpdaterArtifacts` and a `releases/latest` endpoint, the result auto-installs
on every user. All three third-party actions — those two plus
`crowdin/github-action` — are pinned to full commit SHAs now.

**`tests/unit/ciForkSafety.test.ts` could not detect the single most dangerous
edit available here.** Its `PR_WORKFLOWS` regex matched `pull_request(_target)?`,
so switching `ci.yml` to `pull_request_target` — which would grant full secrets
and a write token to code from any fork — kept all 14 tests green. The string
`AbdulrahmanHR` appeared nowhere in the suite, so the three installer fork guards
could have been deleted just as silently. The suite is **14 → 31 tests**, and each
of the 17 new ones was verified non-vacuous by mutation.

Also: workflow-level `permissions:` on `release.yml` and `crowdin-sync.yml`, so a
future job inherits a reviewed default rather than a web-UI toggle; the
fork-reachable CI cache namespaced away from the four signing workflows, since
`~/.cargo/bin` is a `PATH` directory inside the cached paths; and the five
remaining `APPLE_*` secrets written to `$GITHUB_ENV` via the delimiter form,
closing an env-injection path into the step that holds the signing key.

### Verified on the real engine, not just Chromium

The defects above are what a chromium-only gate costs, so the fixes were checked
by hand in a real window under **WebKitGTK 2.52.3**:

- **The flight map paints a track.** `isStyleLoaded: true`, **4** layers in the
  loaded style (`background`, `omnitiles`, `flight-path-line`,
  `signal-heat-line`), and the camera framed on the data rather than parked at
  its provisional zoom over null island.
- **A live alert produces an actual desktop notification**, captured on the
  D-Bus session bus — observed at the OS, not inferred from a JS return value.
- **A replayed log scrubbed with the same opt-in enabled produces nothing on
  that bus.**

**Still not verified on hardware, and still no radio.** Every protocol in
`docs/HARDWARE_VALIDATION.md` remains a protocol for someone else to run.

### The self-hosted fonts ship `woff2` only — 866 KiB of dead weight removed

Every `@fontsource` `@font-face` rule declares each face twice: a `.woff2` and a
`.woff` fallback for browsers that predate 2016. Vite resolved both URLs and
emitted both files, so the fonts added above landed in `dist` as **130 files,
1,612 KiB — of which 65 files and 866 KiB were `.woff` that nothing this app runs
in can ever request.** OmniLink only ever runs inside a Tauri webview — WebKitGTK
on Linux, WKWebView on macOS, WebView2 on Windows — all three have supported
`woff2` for a decade, and there is no browser build to serve.

`omnilink:fontsource-woff2-only` in `vite.config.ts` strips the fallback `src`
entry from the third-party CSS **before** Vite rewrites its URLs. That seam is the
point: it is the only one where the file never enters the graph at all, whereas
deleting the emitted assets afterwards would leave the shipped CSS pointing at
404s. `node_modules` is not edited. The plugin runs in `vite dev` and `vite build`
alike, and if `@fontsource` ever reformats those rules the pattern stops matching
and the build **fails** rather than silently letting the weight back in.

`dist` now carries **65 font files, 746 KiB, all `woff2`** — total build output
4,289 KiB → 3,418 KiB, 167 files → 102. Verified against the production build in
**both** engines, Chromium and WebKitGTK 2.52.3: 65 `@font-face` rules declaring
65 URLs, every one fetched `200`, **zero `.woff` requested**, zero external
origins requested, zero `FontFace` left in `error` state, and each of Inter, IBM
Plex Mono and Space Grotesk measured as *actually applied* — rendered width
against a deliberately absent family — rather than assumed from a `@font-face`
rule that could have been silently falling back to a system face. Checked on
`/profiles`, which uses all three: display headings, sans body, 46 mono elements.
Rendering is unchanged and offline-first is unchanged; that was the entire point.

### Gates

Re-run in full on this tree at the version bump:

- Unit **1653 passed, 129 files** (1570 at `3.0.2`).
- `tsc --noEmit` clean, `eslint` clean, production build green.
- `cargo check` green — run because this release edits `Cargo.toml` and
  `Cargo.lock`, and it is what regenerated the latter.
- **E2E was deliberately not re-run for the version bump.** The suite moved
  **70 → 79** across the seven commits in this release and every count is
  recorded in the commit that produced it; a version-string change cannot move
  it. Rust tests are **367**, unchanged, last run in full at the
  notification-plugin commit — the only one here that touches Rust.

### Version

Bumped `3.0.2` → `3.0.3` in all five version-carrying files — `package.json`,
`package-lock.json` (both the top-level `version` and the root entry under
`packages`), `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and
`src-tauri/tauri.conf.json` — and in this file (project policy §5). The two
lockfiles were regenerated by their own tools (`npm install --package-lock-only`,
`cargo check`) rather than hand-edited; npm additionally normalised 66 lines of
bundled `@tailwindcss/oxide-wasm32-wasi` sub-dependency metadata into
`package-lock.json`, which it does on any install and which moves no resolved
version.

`tauri.conf.json` is the one a user can see. Settings → App Update reads the
running version through `getVersion()`, which resolves to that file, and until
this bump it reported `3.0.2` for a build that is not `3.0.2`.

A patch bump, but not a cosmetic one: a headline feature that never painted now
paints, and a notification channel that had no consent gate has one.
`release.yml`'s `create-release` guard fails fast unless the pushed tag equals
the version in **both** `package.json` and `tauri.conf.json` at the tagged
commit, which is why all five files move in one commit. The updater endpoint and
the minisign pubkey are untouched; `release.yml` itself changed only in the ways
described under CI above. Release feed = this CHANGELOG entry (project policy §5;
no dedicated announcements subsystem exists, and none was fabricated).

## [3.0.2] — 2026-07-30

**"Public."** The release that publishes OmniLink. **Text and metadata only — no
application code changed.** The diff against `3.0.1` touches nothing under `src/`,
`src-tauri/src/`, `data/` or `tests/`; the only non-prose edits are the version
string in five files.

Two things happened. The M73 publication audit ran, and came back clean on secrets
and not clean on content — its content findings are corrected here. And the shape
of the publication changed: this repository is published **fresh**, starting at
this release, rather than with its development history attached.

### The repository is published fresh, and D36 is superseded

**OmniLink is published as a new repository whose first commit is `3.0.2`.** The
development that produced everything before it — every earlier commit, tag and
branch across v1.x, v2.x and the earlier v3.0 line — is **retained privately and
is not published**. The repository name and its URL are unchanged; the history
behind them is not carried over.

**This supersedes decision D36**, recorded at `[3.0.0]` as "the history is **not**
rewritten". D36 was never a principle; it was a constraint resting on two named
reasons — that rewriting history would break published release tags, and that it
would break the minisign signature chain the in-app updater depends on for
installed clients. **Neither reason survives the facts.** The one published
release, `v2.4.10`, has **zero downloads on every installer asset**. There is no
installed client whose updater can be broken, because there is no installed
client, and the tags were protecting an audience of nobody.

What D36 bought in exchange was real, is now given up, and is worth naming
precisely rather than glossing: a reader could have pulled the deleted billing and
accounts mock stack out of history and checked `[3.0.0]`'s account of it against
the actual diff. **That is no longer possible.** What carries the claim instead is
this file, the code that is here, and the rules for changing it — `AGENTS.md`
policy §8 and `CONTRIBUTING.md`'s scope boundary, both of which decline accounts,
payments, entitlements and a hosted API on sight. That is thinner evidence than a
diff, and the honest response is to say so where a reader will see it rather than
let them find out: the editorial note above and the rewritten "Note on project
history" in `README.md` both tell a reader plainly that there is no archive to go
and dig through.

**Nothing forced this shape.** The scan below found nothing to hide from.

### The full-history secret scan is clean — three independent passes

Run over **every commit reachable from every ref**, not just HEAD, at the audited
commit and before the decision above was taken:

| Pass | Tool | Scope | Findings |
|---|---|---|---|
| 1 | `gitleaks` 8.30.1 | `detect --log-opts=--all` — **217** commits, 7.85 MB of diff | **0** |
| 2 | `trufflehog` 3.96.0 | `git file://.` — **4,149** chunks, 8.24 MB | **0** verified, **0** unverified |
| 3 | blob sweep, written for this audit | all **1,866** unique reachable blobs, 20 credential patterns | **0** |

The three passes are not redundant. `gitleaks` reads diffs, and `git log -p` emits
no diff for a merge commit, so a merge that introduced a blob present in neither
parent would be invisible to it. The blob sweep closes that gap by construction:
it walks `git rev-list --objects --all` and inspects object **content**. Patterns
covered minisign private keys, PEM / OpenSSH / PGP keys, GitHub PATs, provider API
keys (Anthropic, OpenAI, Google, AWS, Slack, Groq, OpenRouter, Stripe), JWTs and
generic `secret = "…"` assignments. **Zero credentials.** No `.env` file was ever
committed, no fixture carries a provider-shaped key, and the only key material in
the tree is the minisign **public** half in `tauri.conf.json`, which is public by
design.

The audit also verified, by execution rather than by reading: `LICENSE` is
byte-identical to the canonical GPL-3.0 text; `ci.yml` is the **only**
`pull_request`-triggered workflow and contains no `secrets.*` reference anywhere,
including inside `if:` guards; `pull_request_target` appears in **no** workflow;
every job runs on a standard GitHub-hosted runner, which is what keeps the
zero-cost premise in policy §8 true; and the updater's endpoint, minisign pubkey,
bundle identifier and artifact configuration are unchanged across the 2.x → 3.x
boundary.

**No fork pull request was executed before publication, and none could be.** M73's
fork-safety acceptance asks for a real pull request from a real fork; forking
requires the repository to already be visible, so the check is structurally
impossible before the flip. It is verified as far as it can be — mechanically, by
`tests/unit/ciForkSafety.test.ts`, which fails if a secret is named anywhere in a
PR-triggered workflow, and by GitHub's documented behaviour that fork pull requests
get a read-only `GITHUB_TOKEN` and no secrets. **Opening one fork pull request is
the first thing to do after publishing**, before announcing anywhere.

### The content findings, corrected

- **`README.md` told readers to go and find evidence that is not published.** The
  "Note on project history" block claimed the retired platform plans were "kept in
  the repository history and published as a record". They were not: the decision to
  publish the planning corpus was reversed on 2026-07-29, and now the history is not
  published either. The paragraph's own argument — *we prove the commitment by
  publishing the plan we abandoned* — made this worse than a stray inaccuracy, since
  a reader who went looking and found nothing would draw exactly the concealment
  conclusion the paragraph exists to prevent. It is rewritten to say what is true
  and checkable **in the published repository**: what was explored, that all of it
  was deleted at `3.0.0` before publication, that none of it was ever reachable by a
  user, and that the durable evidence is `[3.0.0]` in this file, one flag in
  `src/lib/featureFlags.ts`, and the standing policy in `AGENTS.md` §8 and
  `CONTRIBUTING.md`. Two tense errors in the same block are fixed: the platform code
  **was** deleted at `3.0.0`, not "is being deleted", and folder sync **shipped** at
  `3.0.1`, not "is being rebuilt".
- **`README.md` claimed source version `3.0.0` and `v2.4.10` as the latest published
  release.** Both are wrong for this repository, in which `3.0.2` is the first
  release and there is no earlier one. The Honest-status bullet now says so and
  points at the Releases page rather than asserting what is downloadable; the
  Project-history section states outright that none of the versions it summarises
  are in this repository.
- **18 in-repo markdown references resolved to nothing** — `CHANGELOG.md` ×12,
  `docs/RELEASING.md` ×3, `docs/THIRD_PARTY_LICENSES.md` ×2,
  `docs/OMNIA_ASSISTANT.md` ×1. Every one pointed at a private planning document
  using a bare `docs/…` prefix, which `AGENTS.md` defines as meaning *in this
  repository and public*. They are fixed **per reference, not by one rule.**
  `docs/RELEASING.md` and `docs/THIRD_PARTY_LICENSES.md` are live documents, so
  their sentences are rewritten not to depend on a file that is not there.
  `docs/OMNIA_ASSISTANT.md`'s stale `projectomni/…` prefixes — a survival of a
  repository layout `AGENTS.md` says never matched reality — become
  repository-root-relative paths. **The twelve in this file are left exactly as
  they were written**, because they are historical text and a past release does not
  get retroactively edited to look tidier; the editorial note at the top of this
  file is what tells a reader those documents are not here. A link check over every
  tracked `.md` file now reports **zero** broken in-repository path references
  outside those twelve, down from eighteen.
- **The maintainer's home directory appeared in tracked prose** — an absolute
  `/home/<user>/…` path, `AGENTS.md` ×3 and `docs/THIRD_PARTY_LICENSES.md` ×1. Each
  was deliberate rather than a stray artefact, but what would publish is a Linux
  username and a signpost to a private directory, and neither serves a reader. They
  are replaced with machine-independent wording (`../docs/`, "a sibling directory
  beside the repository root", "from the repository root") that keeps the meaning
  that matters: **a `docs/*_MILESTONES.md` lookup inside this repository correctly
  finds nothing.** A `git grep` for the path now returns no hit anywhere in the
  tree. The remaining `/home/` matches are fictional test users (`/home/pilot`,
  `/home/user`) in fixtures and assertions.
- **`AGENTS.md` carried two claims that publication falsified.** Its v3.0.0 entry
  said the deleted platform code "remains in git history by decision D36" — it does
  not, and the entry now records D36's supersession. Its `docs/` inventory said
  `git ls-files docs/` returns exactly seven files, which the audit directory had
  made stale; the directory is gone, the count is true again, and the sentence now
  says it is an assertion to re-check rather than a guarantee. Entries for `3.0.1`
  and `3.0.2` are added to the milestone list, which previously topped out at
  `3.0.0` and therefore read as though the repository were still private.

### `docs/audit/` is removed rather than published

The audit directory held the M73 publication audit, two scanner reports, a run log
and a draft announcement. **None of it is published**, and the reasoning is the
same reasoning the `README.md` rewrite above rests on.

A published audit is only evidence if a reader can check it, and **a reader of this
repository cannot check any of it**: the 217 commits, the 1,866 blobs, the remote
branch inventory and the per-identity commit counts all describe objects that are
not here. Publishing an unverifiable "we looked, it was clean" report is
reassurance wearing the costume of evidence — which is the exact failure the C2
rewrite exists to correct. The scan results belong in this entry, as a claim the
project makes in its own voice and labels as such, and that is where they are.

The specifics reinforce it. The audit's verdict is **NO-GO**, against findings this
release fixes, so publishing it as-written would be stale on arrival — and editing
an audit after the fact to describe a decision taken after it was written would
misrepresent what the auditor actually found. It tabulates the maintainer's two
email addresses and per-commit identity counts. Its §1 verdict, "D36's bar on
history rewriting is untouched", is superseded by this release. The two scanner
artefacts are a 3-byte `[]` and an empty file. And `ANNOUNCEMENT-DRAFT.md` is
unpublished marketing copy that carries the very paragraph corrected above —
"it remains in git history … because rewriting history would break published
release tags" — alongside a note that the latest published release is `v2.4.10`.
It is working material, and working material stays with the rest of the private
corpus.

`git ls-files docs/` returns the seven public-bound documents and nothing else.

### Gates

Re-run in full on this tree; worker counts came from `vitest.config.ts` and
`playwright.config.ts`, and no flag was passed.

- typecheck / lint / build clean.
- Unit **1570 passed, 127 files** — unchanged from `3.0.1`, as it must be for a
  text-only release.
- Rust **367 passed**, 0 failed, 1 ignored — unchanged. `cargo test` was run because
  this release edits `Cargo.toml` and `Cargo.lock`.
- E2E **70 passed / 70**, 0 failed.
- **Still not verified on hardware**, and still no radio. Every protocol in
  `docs/HARDWARE_VALIDATION.md` is a protocol for someone else to run.

### Version

Bumped `3.0.1` → `3.0.2` in all five version-carrying files — `package.json`,
`package-lock.json` (both the top-level `version` and the root entry under
`packages`), `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and
`src-tauri/tauri.conf.json` — and in this file (project policy §5).
`package-lock.json` was explicitly re-checked, because it had been missed at two
consecutive bumps before `3.0.1` caught it.

A patch bump: no behaviour changes, no dependency changes, and nothing an existing
user could observe except the version string. `release.yml`'s `create-release`
guard fails fast unless the pushed tag equals the version in **both**
`package.json` and `tauri.conf.json` at the tagged commit, which is why all five
move in one commit. The updater endpoint, the minisign pubkey and `release.yml`
itself are untouched.

## [3.0.1] — 2026-07-30

**Two milestones and one real bug.** **M71** replaces the cloud profile sync that
`3.0.0` deleted, with a folder the user already owns and no infrastructure at all.
**M74** makes this repository safe for a stranger to fork, and hands someone who
owns a radio an executable way to close the hardware gap the maintainer cannot.
And a failure that had been carried as "pre-existing" since `2.5.0` and repeatedly
assumed to be flake turned out to be a genuine defect: **live alerts were
under-reported on every scrubber jump.**

**Zero new dependencies, npm or cargo.** Every dependency declaration in
`package.json`, `package-lock.json`, `src-tauri/Cargo.toml` and
`src-tauri/Cargo.lock` is byte-identical to `3.0.0`; the only edits to any of the
four are the version number itself. The folder picker reuses
`tauri-plugin-dialog`, already a dependency since M25.

**The repository is still private.** The visibility flip is **M73** alone, and M74
was the milestone blocking it. Nothing here flips it, and no tag is pushed.

### M72 (funding surfaces) is deferred out of this release, not retired

M72 was scoped into `3.0.1` and is not in it. Its first deliverable requires real
GitHub Sponsors / Ko-fi handles, the implementing agent is explicitly barred from
inventing them, and **neither account exists.** The alternative on offer was a
`.github/FUNDING.yml` carrying a `TODO` plus an in-app Settings link pointing at a
placeholder, and on 2026-07-30 the maintainer **rejected that as worse than
shipping without it** — a donation link that goes nowhere is a broken promise on
the one page whose entire argument is that this project asks for nothing.

The milestone keeps its ID and its scope and can land in any later `3.0.x` once the
accounts exist. **M73's stated dependency on M72 is void**: M73 depends on M71 and
M74. Nothing in M72 was ever a launch blocker — by its own acceptance criteria
funding surfaces are decoration ("the app is fully functional and visually complete
with the link removed"). **No funding or sponsorship copy appears anywhere in this
release**, which is the deferral being real rather than partial.

### Sync your profiles through a folder you already own (M71)

`3.0.0` deleted cloud profile sync along with the rest of the platform stack, and
deleted the reason for it too — there is no server and there will not be one
(policy §8). What the feature was *for* survives, and decision **D37** is the
answer: **the user picks one directory; OmniLink mirrors its profile set into it as
plain `.elrsp` files.** If that directory happens to sit inside Dropbox, Drive,
OneDrive, Syncthing or a git checkout, they get multi-device sync from a tool they
already run — and the project pays nothing, hosts nothing and stores nothing.

One file per profile, named after the profile, pretty-printed and hand-editable.
**No index, no manifest, no database.** A user can open the folder in a file
manager and understand it immediately, and that legibility is the feature rather
than a side effect of it. New **Profiles → Folder** tab.

**Six commands, and they are this application's entire filesystem surface.**
`grant`, `revoke`, `list`, `read`, `write` and `delete` are declared in
`src-tauri/build.rs` as an **inlined Tauri plugin** — not as ordinary app commands
— because Tauri's access-control list only gates plugin and core commands unless an
app opts its whole command surface into an app manifest. Declaring them this way is
what makes each one reachable *only* because `capabilities/default.json` names its
`folder-sync:allow-*` permission, one at a time. **`tauri-plugin-fs` is deliberately
not a dependency**, so no other filesystem reach exists in the ACL at all. A Rust
test pins both halves — that the capability grants exactly those six and contains no
`"fs:` entry, and that `Cargo.toml` contains no `tauri-plugin-fs`.

**The granted directory is a canonicalised root in managed state, not a Tauri
`CommandScope`.** A runtime scope accumulates and offers no revoke, so a re-grant
would silently leave the previous folder reachable forever — the opposite of what
"I moved my sync folder" means. `FolderSyncState` holds one `Option<PathBuf>`, set
only by `grant` and cleared by `revoke`, and re-granting **replaces** it;
`granting_replaces_the_previous_folder_it_never_accumulates` is the test.

**The path guard refuses far more than `..`.** `validate_file_name` rejects, in
order: empty names; anything over 128 bytes; any `..` substring; any of
`/ \ : < > " | ? *`; control characters; a leading dot; anything not ending
`.elrsp`; an empty stem; a stem ending in a dot or a space; the 22 Windows reserved
device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, matched
case-insensitively against the pre-first-dot head); absolute paths; and finally
anything that is not exactly one normal path component. `resolve_in_root` then
canonicalises, requires the parent to be the canonical root, and calls
`fs::symlink_metadata` **before any read** — a symlink is refused outright rather
than followed. Reads and writes are capped at 256 KB and validated as UTF-8 with no
lossy decode. Failures surface as eight stable codes (`not-granted`,
`not-a-directory`, `invalid-name`, `outside-root`, `too-large`, `not-a-file`,
`not-utf8`, `io`) that the frontend parses — never as a silent no-op.

**The diff is pure.** `src/lib/folderSync.ts` imports exactly one module
(`./elrsp`) and does no I/O, no clock, no `invoke` and no network. Each entry lands
in one of four states — `local-only`, `folder-only`, `same`, `conflict` — and
`same` versus `conflict` is decided on **content, not timestamps**:
`contentFingerprint` re-serialises the document with `updatedAt` zeroed and
compares the bytes. Two machines that saved the same profile at different moments
are therefore *in sync*, not in conflict; the timestamps are still shown for a
conflict the user genuinely has.

**Manual, and honestly so.** Push / Pull / Skip per entry. There is no watcher, no
timer, no debounce and no auto-sync — `FolderSync.tsx` contains no `useEffect` at
all, and Skip is session-local React state that writes nothing. **One automatic
call does exist and is worth naming rather than hiding:** on launch, if a folder
path was persisted, the store re-grants that path and lists it, so the tab opens
showing a current diff. It reads nothing the user did not already point the app at,
and it is the only automatic folder call in the feature.

**Conflicts never silently overwrite.** Both sides are shown side by side with a
choice: keep this machine's, keep the folder's, or **keep both** — which renames
your copy to the next free number, `Race.elrsp` → `Race (2).elrsp`. No machine
name, no timestamp, no id; just the next number, which is what a person would do by
hand.

**Zero network is proved structurally, not asserted.**
`tests/unit/v24OfflineRegression.test.ts` walks the *runtime* import closure of
`lib/folderSync.ts`, `stores/profiles.ts`, `components/config/FolderSync.tsx` and
`lib/tauri.ts` — type-only edges are skipped, because a type edge cannot carry a
call — strips comments first so prose in a docblock cannot fabricate a hit, and
scans for `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` and
literal URLs. The reachable `@tauri-apps` package set must equal exactly
`api/core`, `api/event` and `plugin-dialog`. **Both anti-tautology controls are
real:** one case runs the same scanner over `lib/aiContext.ts` and asserts it
*trips* (if it ever stops tripping, every negative result in the file is
worthless), and another asserts the closure actually reaches the seam and the
`.elrsp` model rather than terminating early. The Rust twin assembles its search
needles at runtime from string fragments so the test file's own text cannot satisfy
the search. As the header puts it: a behavioural test could only show that no call
happened on the paths it drove; this shows there is no call to make.

**Also:** `omnilink-profiles` joins the erase-all-data inventory (18 → 19 keys), so
"delete all my data" forgets **where the folder was** — the `.elrsp` files in it are
the user's, in the user's directory, and are deliberately left alone. New
`folderSync` i18n namespace: **+52 keys in each of `en` and `es`** (1,262 → 1,314,
identical key sets, zero removals), of which 51 are in `folderSync` and the 52nd is
`profiles.tabs.folder`. The `sync` namespace was **not** resurrected — its keys
described a cloud service that no longer exists.

### Fork-safe CI, and a way in for people who own radios (M74)

M74 is the milestone that blocks the public launch, and it is not feature code. It
is everything a stranger needs in order to contribute usefully that was not in the
tree.

**The CI pipeline would have greeted its first fork PR with a red X.** All four
workflows carried an artifact-prune step that calls `gh api -X DELETE` on the
repository's own artifacts. A pull request from a fork receives a **read-only**
`GITHUB_TOKEN`, so that call returns **403** — the step would have failed on every
fork PR, and it was the first thing a contributor would have seen. It also existed
for a reason that expires at M73: it defended an **account-level Actions storage
quota** that public repositories do not consume at all. **All four prune steps are
deleted and every `actions: write` grant is gone** — `grep -rn "actions:"
.github/workflows/` now returns only prose in comments. Retention takes over
instead: **30 days** for the Playwright report, **14** for the installers, sized in
proportion to the artifacts.

**Least privilege, and the fork guard.** Every branch-triggered workflow now
declares `permissions: contents: read` at workflow level, so a new job inherits
read-only unless it deliberately overrides. (`release.yml` and `crowdin-sync.yml`
keep job-level `contents: write` — the former creates the Release and uploads
bundles, and neither is on the pull-request path.) The three installer builds are
gated at job level with `if: github.repository == 'AbdulrahmanHR/OmniLink'`: they
need `TAURI_SIGNING_PRIVATE_KEY` because `createUpdaterArtifacts` is on, so in a
fork they would be a guaranteed-red job burning the contributor's own
minutes — at 10× the Linux rate on macOS and 2× on Windows.

**The no-secret claim is enumerated, not assumed.** `ci.yml` is the only
`pull_request`-triggered workflow in the repository, there is no
`pull_request_target` anywhere, and `grep -n "secrets\." .github/workflows/ci.yml`
returns nothing. `crowdin-sync.yml` holds `CROWDIN_PERSONAL_TOKEN` and is
`workflow_dispatch`-only, with its own test asserting it matches neither `push` nor
`pull_request` nor `schedule`.

**The hardware flywheel.** This project's single structural blocker is that its
author owns no ELRS hardware, so on-device acceptance is deferred for M6, M7, M8,
M11, M13, M18, M29 and M67. **`docs/HARDWARE_VALIDATION.md` (827 lines) is eight
self-contained protocols, HW-1 through HW-8**, each with Steps / What to observe /
Report: serial connection and CRSF handshake; live telemetry and session
persistence; firmware flashing and the safety guards; GPS readout; the live
flight-path map; WiFi and Backpack discovery; session recording to CSV round-trip;
and the read-only flight-controller bridge. A coverage map ties every one of those
eight deferred milestones to a protocol. **It is written so a stranger with a radio
and thirty minutes can complete one without access to the private planning
corpus** — which they cannot read, and which is not going to be published.
Alongside it: `.github/ISSUE_TEMPLATE/hardware_report.yml`, and a compatibility
matrix in `README.md` seeded with a single `_no reports yet_` row under the
sentence "**This table is empty because nobody has filled it in yet, and that is
the honest state of the project.**"

**The catalogue gate found a defect on its first run.** `data/CONTRIBUTING.md`
documents each catalogue's schema with a worked add-a-radio example, and
`tests/unit/dataCatalogueSchema.test.ts` enforces it so a malformed contribution
fails in CI in seconds rather than in review, days later, in a solo maintainer's
spare time. It discovers files — `data/presets/` is read with `readdirSync`, so a
*new* preset is validated the moment it is added, without anyone remembering to
register it. And it caught this: **`parseBackpackTargets` silently discards
malformed entries and never throws.** A `kind` typo in `data/targets/backpack.json`
would have passed every test this project had while the target quietly vanished
from the picker. That leniency is correct for the running app — one bad catalogue
row should not take down flashing — and useless for review, so the gate is now a
count comparison: the number of declared entries must equal the number that survive
the parser. `data/` itself is byte-identical; the gate was verified by deliberately
breaking three entries (a Backpack `kind` typo, a preset packet rate of `333`, an
unregistered pack file) and reverting.

**`AGENTS.md` is now the canonical project guide**, moved with `git mv` so
`git log --follow` still walks its full history. It is the emerging cross-tool
location, which matters because contributors increasingly work through an AI
assistant and a guide only one tool looks for is a guide most tools miss.
`claude.md` stays as a 35-line pointer that maintains nothing of its own, for two
reasons: `CHANGELOG.md` cites it by name **seven times across six historical
release entries** — two of them policy-section citations — and that record is not
rewritten; and Claude-specific tooling looks there by convention.

**`CONTRIBUTING.md` now states the boundary out loud**, under *Maintainer capacity
— read this before you start*: one unpaid maintainer, no ELRS hardware on hand, a
first response usually within one to two weeks, and a list of what is declined on
sight — *"Not 'deprioritised' — declined, however well written, because the
architecture forbids it… anything requiring a server, an account, telemetry or
analytics, or a paid tier."* Stating it once, publicly and in advance, is what
prevents both wasted contributor effort and the obligation-creep that ends solo
projects.

**Worker counts moved into the configs**, `maxWorkers: 2` in `vitest.config.ts` and
`workers: 2` in `playwright.config.ts`, so every invocation path agrees — `npm
test`, a bare `vitest`, `npx playwright test`, an IDE runner and CI. They are
**not** in the npm scripts, on purpose: vitest rejects a duplicated flag outright
(*"Expected a single value for option `--maxWorkers`, received [2, 2]"*), so a flag
baked into `npm test` would break this project's own documented gate command,
`npm run test -- --maxWorkers=2`. **The Playwright config had been lying about
this**: it carried the comment "One headless Chromium worker keeps the shared dev
server contention-free" next to `fullyParallel: true` and **no `workers` setting at
all**, so the suite had been running at Playwright's default the whole time — which
is exactly the contention that made the MapLibre specs flake on WSL2.

**Two honest limitations.** First, **the fork-PR verification was reasoned, not
observed.** M74's acceptance asks for a pull request from a fork running the full
suite green; no real fork PR was opened. The argument is solid and mechanical — the
403 source is deleted, no `actions: write` remains, `ci.yml` is the only PR trigger
and references no secret — but an argument is not an observation, and **M73's launch
gate should confirm it against a real fork before the visibility flip.** Second,
`tests/unit/ciForkSafety.test.ts` is narrower than it looks: its least-privilege
case iterates only the `pull_request`-triggered workflows, which is `ci.yml` alone,
so the workflow-level `permissions:` blocks added to the three installer builds and
the `github.repository ==` fork guards are **asserted by no test** and could be
deleted without reddening CI. Only `actions: write` and `-X DELETE` are checked
across all workflows. The scanner is also deliberately not a YAML parser — it strips
`#` comments textually, which is what lets it tolerate those exact strings appearing
in the new explanatory comments, and would truncate a value containing a literal `#`.

### Live alerts were under-reported on every scrubber jump

**This is a real defect that has been carried as "pre-existing" since `2.5.0`, and
it is not flake.** `tests/e2e/notifications.spec.ts:58` was first recorded as a
known failure at `2.5.0` — where it was verified as failing identically on the
*pre*-`2.5.0` base commit, so it predates that release too — and was then carried
forward in `[2.5.1]`, `[2.5.2]` and `[3.0.0]`, each time verified against a clean
base and each time labelled **PRE-EXISTING**. That verification was sound and
proved exactly one thing: the release in hand had not caused it. It was allowed to
imply something it never established — that nothing had. The spec was describing
something true the whole time, and saying so plainly is the point of this section.

`LiveAlertHost` subscribed to `store.latest` and called `evaluateFrame` — singular —
so it evaluated **exactly one frame per store change**. But the shared telemetry
buffer does not only grow one frame at a time: `session.ts::seek` appends every
newly-passed frame in a **single** `setHistory()`, and `telemetry.ts::setHistory`
sets `latest` to the last of them. So any scrubber jump evaluated one frame where N
had elapsed, and every alarm with hysteresis never accumulated its counter —
`signalLoss` needs **three consecutive recovered frames** to clear, so jumping the
scrubber past a recovery left its toast standing forever. That is what line 58
asserts: scrub to the end, the link recovers, the transient toast should be gone.

The host now watches `history` rather than `latest` and folds the existing,
already-tested `evaluateFrames` batch helper over the newly appended frames — the
same state machine the live path had always run frame by frame, so no second
detector and no new evaluation semantics. The diff is **reference-anchored**:
`windowDelta` locates the last evaluated frame by identity inside the *new* array,
which distinguishes an append from a wholesale replacement (a new session, a
`clear()`, a backward or over-cap seek) and handles `TELEMETRY_HISTORY_CAP`
eviction for free — whatever fell off the front merely shifts the anchor's index.
A missing anchor means a different window, so its frames are not "newly elapsed"
and are **not** replayed; only the newest is evaluated, from a fresh state, to
re-baseline. `reconcileToasts` then lets the batch's final phase decide what stands,
because one batch can legitimately trip and clear the same alarm.

Both functions are exported and unit-tested pure — no DOM, no store, no i18n — in
`tests/unit/liveAlertBatch.test.ts` (14 cases). **The spec was fixed by the code,
not by editing the spec:** `tests/e2e/notifications.spec.ts` is byte-identical to
its `3.0.0` form. The E2E suite is now **70 passed, 0 failed** — no
expected-failure allowance, for the first time since one was first recorded at
`2.5.0`.

### Two documentation defects this branch introduced, and corrected before release

Recorded rather than quietly amended, because both were created by the ordering of
work inside this very branch.

- **`CONTRIBUTING.md` and `README.md` told contributors to expect a failing test
  that this release fixes.** M74 documented `notifications.spec.ts:58` as a known
  product defect and stated the expected E2E result as *69 passed, 1 failed*, asking
  that the assertion not be skipped or deleted. That was accurate when written and
  false four commits later. Both now state **70 passed, 0 failed** with no
  expected-failure allowance, and keep a short note of what the failure was, so a
  contributor on an older checkout still understands what they are seeing.
- **`CONTRIBUTING.md`'s table of contents carried a broken anchor** —
  `#worker-counts-are-pinned--use-the-npm-scripts` pointing at a heading M74 had
  renamed to *Worker counts are pinned*. This is the same class of bug commit
  `37de213` fixed in `docs/HARDWARE_VALIDATION.md`; it was simply missed in the
  other file.

### Gates

- typecheck / lint / build clean.
- Unit **1474 → 1570** (123 → **127** files), and the arithmetic closes exactly:
  **+43** from M71 (`folderSync.test.ts` 38, plus 5 added to
  `v24OfflineRegression`), **+39** from M74 (`dataCatalogueSchema.test.ts` 25,
  `ciForkSafety.test.ts` 14), **+14** from `liveAlertBatch.test.ts`. No test was
  dropped or weakened.
- Rust **348 → 367**. All **+19** are in `folder_sync::tests` in
  `src-tauri/src/commands/config.rs` (6 → 25 tests in that file), covering
  traversal, absolute paths, Windows-normalising and reserved names, symlink escape
  on read/write/delete, a symlinked root, oversize and non-UTF-8 payloads, a missing
  folder, calls before any grant, grant replacement, error-code stability, and the
  capability/`build.rs` agreement check.
- E2E **66 pass + 1 fail → 70 pass, 0 fail** (+3 `folder-sync.spec.ts`, +1 from the
  live-alert fix flipping `notifications.spec.ts:58`). Worker counts came from the
  configs; no flag was passed.
- **Not verified on hardware, and not verified from a real fork.** Everything in
  `docs/HARDWARE_VALIDATION.md` is a protocol for someone else to run — no protocol
  in it has been executed, because there is still no radio. The fork-safety
  reasoning is above.

### Version

Bumped `3.0.0` → `3.0.1` in `package.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json` and this file, in one commit
(project policy §1/§5). A patch bump: M71 adds an opt-in surface that is inert
until a folder is chosen, and nothing else changes behaviour for an existing user
except that live alerts now report correctly.

**A fifth file carries the version and had been missed twice.**
`package-lock.json` declares `version` in two places and still read **`2.5.2`** —
it was not bumped at `3.0.0`, and it was not bumped at `2.5.2`'s successor either.
It is corrected to `3.0.1` here. Nothing else in the lockfile changed: the
dependency tree is untouched, and the field is metadata that `npm ci` had been
tolerating, which is exactly why the drift survived two releases without anyone
noticing. It belongs in the same one-commit rule as the other four.

No tag is pushed at this version and the repository stays private. `release.yml` is
tag-triggered and untouched; the updater feed and its minisign configuration are
unchanged. Publishing is **M73**'s alone.

## [3.0.0] — 2026-07-29

**"Free and Open."** OmniLink is now **GPL-3.0-or-later open source**, and the
v2 platform ambition is retired rather than deferred. Three milestones landed
together: **M68** (licence, contributor docs, CI restored), **M69** (the
platform excision), **M70** (roadmap reconciliation). M70's second half — moving
the planning corpus into this repository — **was cancelled by decision before
this release was cut**; the corpus stays private and outside the repository, and
only the `dev-harness/` came in. See *The roadmap was reconciled* below.

**The repository is still private at this version, deliberately.** This is the
honest-record release, not the launch. The visibility flip is a separate,
one-way milestone (**M73**) gated behind fork-safe CI (**M74**), and it has not
happened. Everything here is preparation, done while it can still be corrected.

**A user upgrading from `2.5.2` loses nothing.** Every surface deleted below was
flag-gated `false` and unreachable outside a Vite dev build. The free local core
— device connect, CRSF telemetry, firmware flashing, Backpack, WiFi discovery,
`.elrsp` profiles, blackbox import, offline maps, replay, v2.0 diagnostics, the
v2.2 controller bridge, the v2.4 local RAG knowledge base and **BYOK AI** — is
untouched.

### Licensed — GPL-3.0-or-later (M68)

`LICENSE` carries the verbatim, unmodified GPL-3.0 text. `package.json` drops
`"private": true` and declares the licence, author, repository, homepage and
bug tracker; `src-tauri/Cargo.toml` replaces its `authors = ["you"]` /
`description = "A Tauri App"` scaffold placeholders and declares the same
licence. SPDX identifiers go on exactly three files — `src/main.tsx`,
`src-tauri/src/main.rs`, `src-tauri/src/lib.rs` — and deliberately not on the
other 671, because LICENSE and the manifests carry the legal weight and headers
everywhere would be churn.

**The licence audit disproved one of the reasons for choosing it, and the
correction is on the record.** The plan asserted that `blackbox-log 0.4.3` —
statically linked into the Tauri binary — was "believed to be copyleft-licensed"
and that a GPL licence might therefore be *compelled*. It is not: the crate
declares `license = "MIT OR Apache-2.0"`, dual-permissive on both arms. **A
permissive licence for OmniLink was available, and was not taken.** GPL-3.0-or-later
is an **elective** choice, resting on ecosystem match with ExpressLRS and
Betaflight (both GPL-3.0) and on the fact that under copyleft a vendor wanting a
closed derivative has to ask, where under MIT they never would. No dependency in
the tree is GPL-incompatible; `docs/THIRD_PARTY_LICENSES.md` records every direct
dependency with a compatibility verdict.

Also landed: `CONTRIBUTING.md` (build prerequisites, every gate, the i18n rule,
the seam pattern, the DCO 1.1 text and the `git commit -s` requirement, and the
explicit statement that no feature requiring a server, an account or a payment
is accepted), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`
(private advisory reporting, and the note that OmniLink writes firmware to
hardware, so flash-path and binding-phrase issues are the highest-severity
class), issue and pull-request templates, and a repositioned `README.md`.

**CI was switched off and is back on.** `ci.yml` had its `push:` and
`pull_request:` triggers commented out and all three `*-build.yml` workflows had
their `push:` triggers commented out, every one of them left
`workflow_dispatch`-only under a "paused until app rollout" note. All four are
restored on `[main, v3]`, with `ci.yml` additionally running on `pull_request`
to those branches. Nothing was being verified automatically before this.

**The v2 platform stack is deleted, not deferred.** Accounts, billing,
entitlements, cloud profile sync, sponsor/announcement surfaces, hosted presets
and the Managed AI answer path are gone from HEAD. Every one of them was a mock
built ahead of a v2.1 backend (M30–M35) that was never built in this repository,
and that backend is now retired rather than deferred — so the mocks were code
with nothing behind them and no plan to put anything behind them.

**Nothing a `2.5.2` user could reach was removed.** All six surfaces were gated
`false` in `src/lib/featureFlags.ts` and unreachable outside a Vite dev build.
The one exception is the pre-send *credit estimate* in the chat privacy preview,
which did render for everyone — it estimated the cost of a transport no user
could use, so it went with the transport.

### Removed — 31 source files, ~7,020 lines

**Libraries.** `billing`, `entitlement`, `managedAi`, `cloudSync`,
`syncConflict`, `syncErrors`, `syncSanitize`, `announcements`,
`announcementPlacement`, `plans`, `upgradeContext`, `presetSubmission`,
`presetValidation`, `aiCost`. The shared redaction primitives that lived
inside `syncSanitize` were **relocated, not deleted** — see below.

**Stores.** `account`, `billing`, `cloudMock`, `sync`, `announcements`,
`presetLibrary`, and their re-exports from the stores barrel.

**Components.** `src/components/subscription/`, `src/components/sync/` and
`src/components/announcements/` are removed as whole directories — they emptied
out entirely — along with `src/components/config/HostedPresets.tsx`.

**Rust.** The `managed_ai` cargo feature (which leaves `src-tauri/Cargo.toml`
with no `[features]` section at all), and from `commands/ai.rs` the
`ManagedAdapter`, `managed_request_body`, `mock_managed_proxy`, the
`MANAGED_INPUT_CAP` / `CHARS_PER_TOKEN` / `TOKENS_PER_CREDIT` cost constants,
the `"managed"` arms of `default_base_url` and `make_adapter`, the `"managed"`
entry in the `honors_base_url_override` deny list, and the `provider ==
"managed"` branch of the send path. Also gone: the cloud-sync redaction gate
`sanitize_sync_profile`, its `SyncProfileInput` DTO, its `is_sync_dropped_key`
and `scrub_setting_value` helpers, the `sanitize_sync_profile_payload`
`#[tauri::command]`, and its registration in `lib.rs` (both the `use` import and
the `invoke_handler!` entry) — with the matching TS wrapper
`lib/ai.ts::sanitizeSyncProfilePayload`. **`sanitize_context()` and
`sanitize_bridge` are untouched**, as are `scrub_value`, `cap_and_neutralize`,
`looks_like_identifier` and `is_sensitive_key`, which the surviving AI and
bridge paths are built on.

**Translations.** 260 keys from **each** of `en` and `es` — the `announcements`,
`subscription` and `sync` namespaces, the `profiles.hosted.*` subtree,
`profiles.tabs.hosted`, `ai.cost.*`, `ai.managed.*`,
`settings.sections.platform`, the five removed `settings.devFlags.flag.*`
entries and `wizard.ai.fallback.outOfCredits`. Both locales go 1,522 → **1,262**
keys with identical key sets, checked mechanically rather than by eye.
`profiles.presets.*` (bundled local presets) and the general `settings.*` keys
survive untouched.

**Fabricated data.** The invented `omnilink.test` checkout URLs and the invented
sponsor brands are gone. `grep -rn "omnilink\.test" src/ tests/ src-tauri/`
returns nothing.

### Removed — 25 test files

24 unit specs and `tests/e2e/hosted-moderation.spec.ts`. Two files were
**trimmed rather than deleted**, because the rest of their coverage is
load-bearing: `v24OfflineRegression` keeps its offline BYOK / static-wizard /
local-RAG assertions (12 → 9), and `ragAnswers` keeps its BYOK acceptance
(8 → 6). Two more shed cases that no longer have a subject: `wizardModeFallback`
(10 → 5, the Managed and out-of-credits branches) and `featureFlagsDevOverride`
(11 → 10 — "merges disjoint URL + stored keys" needed two flags to assert
anything).

### It is still in git history, by decision

Decision **D36**: the history is **not** rewritten. Rewriting would break ten
published tags and the minisign signature chain the live updater feed depends
on, and the deleted code is mock, not secret. Everything above remains reachable
in this repository's history at `2.5.2` and earlier. HEAD does not carry it;
history does. That is a deliberate choice, recorded here rather than left for
someone to discover in a fork.

### Changed

- `src/lib/featureFlags.ts` declares **exactly one** flag, `mlLab`. The whole
  dev-override mechanism — the `?ff=` query parser, the `localStorage` blob,
  `initDevFlagOverrides` / `persistDevFlag` / `clearDevFlags` — is **kept**,
  because `mlLab` still needs a way in for QA and e2e. The `DevFeatureFlags`
  panel is kept for the same reason and now lists that one flag.
- `SettingsPage` loses the entire Platform section, not just its contents — no
  empty section, no orphaned divider. `ProfilesPage` loses the Hosted tab and
  the `hosted` member of `ProfilesTab`; Saved and Community are untouched.
- The chat controls lose the Managed transport picker, and the privacy preview
  loses its credit estimate. The **retrieved-context** half of that preview is
  v2.4 local RAG and stays.
- `stores/assistant.ts` loses `managedActive`, `setManagedActive`, the persisted
  Managed toggle and the `viaManaged` branch of `sendMessage` — which collapses
  the no-key gate back to an unconditional check.
- `evaluateWizardAiAvailability` now takes a single BYOK/local transport and has
  no `outOfCredits` reason. A billing failure mode has no meaning in a build
  with no billing.
- `commands/ai.rs`'s module header no longer promises "a future Managed adapter
  slots in here." BYOK-only is permanent project policy now, not a v1.0 phase.

### The redaction primitives moved rather than died

The excision inventory contained a contradiction, and resolving it is the one
place this milestone did not simply delete what it was told to.

`src/lib/syncSanitize.ts` was on the delete list. But three of its exports —
`REDACTED`, `looksLikeIdentifier` and `scrubText` — were never sync-specific:

- `src/lib/knowledge/retrievalSanitize.ts` imports `scrubText`. That is the v2.4
  RAG redaction gate, which the **same inventory separately marks do-not-touch**.
- `tests/unit/_privacy.ts` imports `looksLikeIdentifier`. That is the shared
  privacy-audit harness behind `v24PrivacyAudit`, `v25PrivacyAudit` and the
  `assertZeroIdentifiers` guarantee.

Deleting the file outright would have taken load-bearing privacy code with it;
keeping it whole would have left a cloud-sync-named module at HEAD in a build
with no cloud sync. **Resolution: extract the shared trio, delete the rest.**

- **New `src/lib/redact.ts`** holds `REDACTED`, `looksLikeIdentifier` and
  `scrubText` plus their private helpers, **moved verbatim** — every code unit
  is byte-identical to its previous form, mechanically verified rather than
  eyeballed, because this mirrors Rust `scrub_value` / `looks_like_identifier` /
  `cap_and_neutralize` and the two must emit the same bytes for the same input.
  (That includes the `[\s\u0085]` tokenizer split: `\s` alone omits U+0085 NEL,
  which Rust's `split_whitespace()` treats as whitespace.) The module doc no
  longer describes a sync gate; it describes the general primitives and names
  `sanitize_context()` as their authoritative counterpart.
- **Deleted with the rest of the file:** `sanitizeSyncProfile`,
  `SanitizedSyncSettings`, `SanitizedSyncProfile`, `SyncProfileSource`, and the
  `isDroppedSettingKey` / dropped-key tables only it used.
- **`tests/unit/syncSanitize.test.ts` → `tests/unit/redact.test.ts`** (17 → 11).
  Every case covering the three primitives is carried over unchanged, including
  the C1/NEL lockstep case, which was nested under the `sanitizeSyncProfile`
  describe but only ever exercised `scrubText`. The seven genuinely
  sync-specific cases are gone. **Coverage was not weakened:** the dropped tag
  case was the only one asserting the `[redacted]` marker *positively* rather
  than merely asserting an identifier was absent, so a replacement case now
  asserts that directly against `scrubText` — a scrubber that silently deleted
  tokens would satisfy every `not.toContain` in the file.

### Kept deliberately

- **`USER_DATA_LOCAL_KEYS` in `src/lib/userData.ts` keeps the six platform
  `localStorage` keys** (`omnilink-account`, `-announcements`, `-billing`,
  `-cloud-mock`, `-preset-library`, `-sync`). Nothing writes them any more, but
  a user upgrading from `2.5.2` still has them on disk, and "delete all my data"
  should still erase them. The file already documents this precedent for
  `omnilink-notes`.

### The roadmap was reconciled; the plans did NOT move into the repository (M70)

**M70 was two halves. The first landed. The second was performed and then
cancelled by a decision taken before this release was cut, and it is recorded
here rather than quietly dropped.**

**The planning corpus stays private and stays out of this repository.** It lives
one directory above, at `../docs/`, in no git repository at all — ~30 documents,
75 specified milestones and 43 recorded decisions. Decision **D39** originally
kept it private; on 2026-07-29 D39 was revised to publish it, the whole corpus
was moved in, and **later the same day that revision was itself reversed by the
maintainer.** The import commit was dropped, the corpus was restored to its own
directory with the reconciliation work intact, and branch `3.0.0` was never
pushed — **nothing was ever exposed.** D39 returns to its original resolution:
**the planning documents are not published, permanently.**

**`dev-harness/` is the one exception, and it is in this repository** (decision
**D42**). Five Python files, standard library only, that let a contributor with
no ELRS radio exercise the real serial and CRSF path through a `socat` PTY pair.
`.gitignore` gains `dev-harness/__pycache__/` and `*.pyc`; no `.pyc` is tracked.
For a project whose single structural blocker is that its author has no radio,
that harness is the highest-leverage thing outside `src/` — and it is
contributor tooling, not a planning document, which is why it is the exception.

**What the reversal costs, since a changelog that only records wins is not
worth reading.** The case for publishing was that a fully-specified backlog is
the best contributor on-ramp a solo maintainer without hardware can offer, and
that publishing the *abandoned* monetisation plan — the credit-pack pricing, the
Pro tier, the sponsor cards — **together with the dated decision to delete all
of it** — proves the no-paid-tier commitment in a way no README promise can.
That proof is not being offered. **What now carries that commitment is this
changelog entry and the deletion itself.** Both are real and both are checkable
against the diff. They are also thinner than what they replace, in one specific
way worth naming: this entry is the project describing itself, where the retired
plans would have been the project handing over the evidence against itself. The
deleted mock billing stack remains reachable in git history at `2.5.2` and
earlier (decision **D36**), so it can still surface from a clone or a fork —
now without those documents standing beside it. That is the trade, stated
plainly.

**The reconciliation itself — part (a) — is complete and is what this release
carries.** All of it is prepends, appends and `Progress:` lines. **No milestone
body text was edited and no milestone ID was renumbered.**

- **`history/`** was created for what is superseded, under **one** directory
  preamble rather than a banner per file: the v2.1 accounts/billing line, the
  v2.3 cloud/Pro/community line, the accounts-readiness options analysis, the
  strategy analysis, and the monetization and vendor-partnership sections cut
  out of the SRS. Record, never a roadmap.
- **v2.1 and v2.3 are marked RETIRED at v3.0.0** — retired, not deferred, with
  their milestone bodies and IDs untouched. M42/M43's *intent* survives as
  **M71**, which does **not** inherit M42's ID.
- **A third reconciliation note on v2.5** records that M60/M61/M62 are
  **deferred out of the version line into the backlog, unscheduled** — not
  retired, because their blocker is the D21 data bar and never was a decision —
  and that this is the **third consecutive v2.5 slot to go to non-research
  work**.
- **`ACCOUNTS_READINESS.md` resolved as Option C**, extended past the document's
  own framing because it deletes the mocks rather than leaving them switched off.
- **`deferred_features_backlog.md`** is now three buckets — RETIRED, DEFERRED
  (still live), NEW to v3 (empty) — with a disposition table mapping all 32
  pre-v3.0.0 entries to exactly one destination, so the restructure can be
  audited rather than trusted. Because the corpus stays private, **the labelled
  GitHub issues at M75 are now the only public form that backlog will take.**
- **One carve-out applied (decision D43):** the specific vendor annual-licensing
  fee range and per-unit royalty range were removed from every document while
  publication was still the plan. The removals stand even though publication was
  cancelled — re-inserting a figure the project decided to stop quoting would be
  motion for its own sake. Nothing else was cut.
- **`claude.md`'s Repository Layout never matched the real git root** — it
  described an `OmniLink/` parent with `projectomni/` as a child. `projectomni/`
  *is* the repository, and the corpus is **outside** it and untracked. Corrected
  to that, along with every cross-reference, verified mechanically rather than by
  spot check: **69 relative references checked, 0 unresolved.**
- **`docs/` in this repository holds six documents and no planning material** —
  `RELEASING.md`, `SIGNING.md`, `TRANSLATIONS.md`, `OMNIA_ASSISTANT.md`,
  `v1.6.4_HW_VALIDATION.md`, `THIRD_PARTY_LICENSES.md`. `git ls-files docs/`
  returns exactly those six.
- **One risk moved the wrong way and is recorded as such.** The plan's §12 had
  downgraded *"this plan file is untracked and could be lost"* to resolved **on
  the strength of this import**. With the import cancelled it is **unresolved
  again**: the entire corpus, including the plan of record, sits in no version
  control. A separate **private** repository is recommended there; it is not
  implemented, and it is the maintainer's call.

### Gates

- typecheck / lint / build clean, with no unused-import or unreachable-branch
  warning introduced.
- Unit **1777 → 1474**, and the arithmetic closes exactly: −301 from 24 deleted
  spec files, −3 `v24OfflineRegression`, −2 `ragAnswers`, −5
  `wizardModeFallback`, −1 `featureFlagsDevOverride`, −6 from
  `syncSanitize.test.ts` → `redact.test.ts` (17 → 11: seven sync cases dropped,
  one marker case added), **+15** from the new
  `tests/unit/v30CoreIntact.test.ts`. No test was silently dropped.
- Rust **354 → 348** — the three `managed_ai` tests that compiled in a default
  build (two more were `#[cfg(feature = "managed_ai")]` and never compiled
  without the feature, so they never counted), plus the three
  `sync_profile_*` tests that exercised only the deleted cloud-sync sanitizer.
  `cargo fmt --check` and `clippy --all-targets -D warnings` clean.
- e2e **68 pass, 1 fail** — `notifications.spec.ts:58`, verified failing
  identically on a clean checkout before this work began. Pre-existing,
  untouched.
- **`tests/unit/v30CoreIntact.test.ts` is new and was written and run green
  BEFORE any deletion.** It pins the free core — profiles load/save/apply,
  `.elrsp` round-trip, a complete BYOK provider list with no `managed` entry,
  the local diagnostic engine, the local knowledge index, and
  `getFeatureFlag("mlLab")` — and passes identically on both sides of the
  excision. A guard that only passes afterwards would not be a guard.
- **The required manual smoke was NOT performed visually, and is recorded as
  substituted rather than passed.** M69's acceptance calls for launching
  `npm run tauri dev` and confirming *by eye* that Settings renders with no empty
  section or orphaned divider, Profiles shows no Hosted tab, and the AI panel
  offers BYOK and local only. The app did launch under WSLg, but the host has no
  screenshot or window-inspection tooling, so nothing was actually looked at. A
  headless Playwright equivalent ran and passed — Settings renders four
  non-empty sections with no Platform block, the Profiles tabs are exactly
  `["Saved", "Community"]`, and the chat provider list contains no `managed`
  entry. That is good evidence and it is not the check the acceptance names: a
  headless assertion cannot see an orphaned divider or a mis-sized gap. **The
  visual smoke remains outstanding.**

### Version

Bumped `2.5.2` → `3.0.0` in `package.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json` and this file, in one commit
(project policy §5).
**A major bump rather than `2.6` for two structural reasons**, neither of which
semver's user-facing-break test captures: `v2.5_MILESTONES.md` declares itself
the last line in the v2 program, so a `2.6` line would contradict that document
rather than succeed it; and a private, all-rights-reserved repository becoming a
public copyleft one, with ~11.7k lines of built product surface deleted, is the
largest change a codebase can undergo short of a rewrite.

No tag is pushed at this version and the repository stays private. `release.yml`
is tag-triggered and untouched; the updater feed and its minisign configuration
are unchanged. Publishing is **M73**'s alone.

## [2.5.2] — 2026-07-28

**A hardening release for the device-connection, firmware-identity and
firmware-delivery paths. No new features.** Three independent audits of those
paths — and then a review of the fixes themselves — found **32 defects**, one of
which could write the wrong firmware to a flight controller and one of which put
a Betaflight FC into ESC 4-way mode (driving motor outputs) instead of serial
passthrough. All 32 are fixed here.

**This release consumes the version number the v2.5 plan had reserved for M60 +
M61.** The research line's milestones are unaffected in content and keep their
IDs; only their version placement moves (M60/M61 → `2.5.3`, M62 → `2.5.4`). See
`../docs/v2.5_MILESTONES.md`. This is the second time a v2.5 slot has been
consumed by non-research work (`2.5.0` was "Signal Lab Refined"), and it is
recorded rather than absorbed.

### Wrong firmware could reach hardware

- **`targets_align` accepted a substring match**, so `BETAFPV_2400_TX` aliased
  `BETAFPV_2400_TX_MICRO_1W` — two different radios, both in this repo's own
  catalogue — and a 1 W image passed the alignment gate for 250 mW hardware.
  Alignment is now exact: overlapping-but-unequal is positive proof of a
  *different* target, not a pass. Abstention on an unextractable name is
  preserved.
- **The device's own CRSF target name never guarded the flash.** Every
  compatibility decision compared the image against the *wizard-selected*
  target, so selecting a different model wrote a Ranger image to a Nano TX.
  `FlashRequest` now carries `connectedTargetName`. Because the CRSF name is a
  *display* name, it is resolved against the catalogue frontend-side (exact
  match only) before it crosses the seam; an unresolvable name means "no
  evidence" and the guard abstains rather than refusing a legitimate flash.
- **The guard then evaporated on retry.** The flash tears the CRSF connection
  down before the guard runs, so its refusal — and the second Start Flash click
  the refusal invites — arrived with `connectedDeviceType` and
  `connectedTargetName` both null, and both identity guards abstained. The
  device store now retains the last handshake identity per port and a refusal is
  sticky for that `(port, selected target)` pair until the user reconnects or
  changes the selection.
- **`check_backpack_compatibility` was structurally dead** — gated on fields no
  code in `src/` ever populated — so a WiFi ExpressLRS Backpack could be chosen
  as the OTA destination for a main-ELRS flash with no guard running at all
  (`connectedDeviceType` is null over WiFi, so the TX/RX guard abstained too).
  The family check now runs unconditionally, and Backpack rows are
  non-selectable for a non-Backpack model.
- **A WiFi OTA wiped the connected device's identity** on *every* outcome —
  including `cancelled`, where nothing was written — leaving `status:
  "connected", device: null` and silently disarming both guards above for the
  next flash. It now invalidates only what a completed OTA actually changed, and
  only when the OTA addressed the connected device.

### MSP passthrough asked for the wrong mode

- **`MSP_SET_PASSTHROUGH` was sent as `[0xFF, 0x00]`.** Verified against
  Betaflight `src/main/msp/msp.c` and `io/serial_4way.c`: `0xFF` is
  `MSP_PASSTHROUGH_ESC_4WAY`, whose handler calls `esc4wayInit()` — it disables
  the motors and then drives each enabled motor pin — and *still acks*, so the
  app read it as success and esptool talked to the ESC bus instead of the RX
  UART. The request is now `[0xFE, 6]` (`MSP_PASSTHROUGH_SERIAL_FUNCTION_ID`
  with the bit index for `FUNCTION_RX_SERIAL = 1 << 6`), built by one shared
  helper so the guided diagnostic and the flash cannot diverge.
- Betaflight answers "no passthrough-capable UART" with an ack whose payload
  byte is `0`. That was read as success; it is now a refusal
  (`passthroughUnavailable`) with flight-controller-configuration recovery
  steps, alongside the `$M!` error form.
- `parse_reply` locked onto the first `$M>` in the accumulator and never
  resynced, so a corrupt leading frame masked a real ack; it now shares the
  resyncing collector `bridge.rs` already had.

### Serial port ownership

- **Three bridge commands opened the port with no `DeviceManager` claim.** The
  app raced itself: Connect reported the self-inflicted `EBUSY` as "close the
  ExpressLRS Configurator", and Start Flash passed the cancel point of no return
  before esptool failed to open the port — whose "could not open" was
  categorised as a *wiring* fault, telling the user to re-cable a device that
  was never touched. `DeviceManager` now owns a per-port RAII claim that every
  opener routes through; a second claimer gets a message naming OmniLink, and
  the UI disables Connect and Start Flash while a bridge operation holds the
  port.
- **`connect_device`'s take/spawn/store sequence was not atomic** and the store
  was a blind overwrite, so a Cancel interleaving a connect left a reader thread
  nothing held a handle to — owning the port until the process died. The
  sequence is one critical section, install stops and joins any occupant instead
  of dropping it, and a disconnect epoch (sampled at command entry) makes a
  cancel that arrives while a connect is queued open nothing at all. Connections
  carry a generation, mirrored onto `device://*` events, so the frontend drops
  events from a superseded reader.
- **The flash lockout had a re-entry window**: `startFlash` read its guard at the
  top but set `running` only after an IPC round trip, so a double-click ran the
  settle for a losing call — resetting the device store, and re-enabling the port
  controls, while esptool was writing. The lockout is claimed synchronously and
  the settle is keyed on a per-flash token.
- **Synchronous `#[tauri::command(async)]` bodies ran on tokio workers** rather
  than `spawn_blocking`, so an offline release fetch plus a passthrough check
  could starve every device command for tens of seconds.

### Device state truthfulness

- The hotplug poller **re-pointed `selectedPort` at `ports[0]`** whenever the
  selection was momentarily absent — including while the just-flashed board
  re-enumerated — so "Flash another" could write ELRS firmware to a flight
  controller. A user-made selection is pinned and never silently substituted,
  with an explicit "auto-select first port" option to return to auto-follow.
- `settleDeviceAfterFlash` **restored a status snapshot** without checking the
  connection survived, which could leave a permanent "Connecting…" spinner with
  no reader thread and every port control disabled, or a green "connected" state
  with no device. It recomputes from liveness and retains the error message the
  flashing guard used to discard — and that message is now cleared when the
  flash starts, so it can only ever describe *this* flash.
- `onDeviceConnected` was **the only lifecycle handler without the "flashing"
  guard**, so a connected event landing mid-write re-exposed Disconnect and from
  there the whole port-claiming UI, over a port esptool was writing.
- **An absent firmware version was fabricated as `"0.0.0"`.** Betaflight answers
  `DEVICE_PING` with an all-zero triple on exactly the UART the probe-failure
  text tells the user to wire up, so the UI stated `v0.0.0` as fact, backups
  recorded it, and `firmwareCompat` returned `"warn"` forever instead of
  `"unknown"`. It is `Option<String>` / `string | null` now.
- **`probe_baud` returned on the first `DeviceInfo` from any responder.** On the
  shared CRSF bus both the FC and the receiver answer, and an FC that won the
  race supplied a concrete-but-wrong `deviceType` the flash guard treated as
  evidence. Replies are filtered by destination and ELRS endpoints outrank the
  flight controller — and a reply rejected by that filter is now *reported*,
  because the filter is new and unverified against real ELRS firmware, so it must
  fail loudly rather than silently produce "no device answered".
- `probe_baud` **swallowed port loss**, so unplugging mid-handshake produced
  "check wiring and power" (and could render an empty baud list).
- `ensureFlashListeners` **cached a rejected promise forever**: one `listen()`
  failure made every later Start Flash an unhandled rejection and a silent no-op
  for the rest of the session.

### Firmware download and release discovery

- The download **reserved `Vec::with_capacity(Content-Length)` before reading a
  byte** and only checked `MAX_FIRMWARE_BYTES` once the body was in RAM: a large
  declared length aborted the process rather than returning an error, and a
  chunked stream had no cap at all.
- **Redirects followed reqwest's default policy** — any host, https→http — while
  firmware assets carry no digest, so a redirect off artifactory was followed in
  plaintext and only heuristics stood between the response and the radio. The
  firmware and GitHub clients pin scheme, domain and hop count; the WiFi-OTA
  client (which posts to a user-supplied LAN address, where a domain pin is
  meaningless) now refuses redirects outright and reads a capped body, because
  an endpoint that redirects could otherwise supply the body that decides whether
  the flash is reported as successful.
- A successful fetch **parsing to an empty list overwrote a good cache** and was
  served fresh for the full TTL, destroying the offline fallback.
- A GitHub **403 rate-limit rendered as "Offline"**, telling the user their
  network was down when the remedy was to wait. `github.rs` also read its body
  under a single total deadline via `resp.text()`; it now reads incrementally and
  capped, so a slow but progressing transfer is not killed.
- A firmware version **picked from the bundled list while the live fetch was in
  flight was never reconciled**; the reconcile now lives in a store rather than in
  a step component that unmounts when the user navigates away.
- `updater.ts`'s unavailability signatures **did not match the strings the pinned
  plugin emits**, and two were broad enough to present an actionable failure as
  "unavailable in this build".

### Known — the flash path cannot reach real ExpressLRS 3.x firmware

Measured during this work, **not fixed here**, and stated rather than left
implicit. These are pre-existing and predate the audit:

- `artifactory.expresslrs.org/ExpressLRS/{version}/{target}/firmware.bin`
  **404s**. The real layout is `ExpressLRS/index.json` (tag → git commit SHA),
  then `ExpressLRS/{sha}/firmware.zip` with members at
  `firmware/{FCC|LBT}/{TARGET}/firmware.bin`. The archive is ~22 MB, above the
  16 MiB `MAX_FIRMWARE_BYTES` ceiling.
- **No firmware binary is published as a GitHub release asset** (releases carry
  only `elrs.lua`), and no `.sha256`/`.sig`/checksums sidecar exists next to the
  archive — so there is no digest to verify against. `index.json`'s tag→SHA map
  *is* independently confirmable against GitHub's git-ref API, which would make
  the artifact path corroborable by two origins.
- `OPTIONS_DELIMITER` is `BE EF CA FE BA BE F0 0D`, which appears in **0 of 63**
  real 3.5.3 images; the ordering that does appear (36 of 63) is
  `BE EF BA BE CA FE F0 0D`, and the ESP32-C3/S3 unified targets carry neither.
- The catalogue holds 2.x-era target names (`BETAFPV_2400_TX`); upstream 3.x
  ships `Unified_ESP32_2400_TX` and friends plus a hardware-layout JSON.
- `extract_target_name` returns the longest `[A-Z0-9_]` run, which on a real
  ESP32 image is an esp-idf error constant, not a target.

All of the hardening above is correct and worth having, but it currently guards
a download path no user can complete. Fixing it is a delivery-layer rework, not
a patch, and is not attempted in a fix release.

### Gates

- typecheck / lint clean; unit **1661 → 1777**; Rust **303 → 354**; clippy and
  `cargo fmt --check` clean.
- e2e **68 pass, 1 fail** — `notifications.spec.ts:58`, verified failing
  identically on a clean checkout of the previous commit. Pre-existing,
  untouched by this release.

## [2.5.1] — 2026-07-13

**A lab/internal slice. No user-facing model feature is enabled.** This is the
v2.5 research line's first real slice — M56 (data-readiness + evaluation
framework), M58 (local anomaly-model prototype), and M59 (predictive
failsafe-warning experiment). The `mlLab` flag in `src/lib/featureFlags.ts` is
**OFF by default**; a normal user sees zero change, and — after the lazy-load fix
below — downloads zero bytes of it either. Nothing here is a release gate pass,
and nothing here is presented as one.

**The result is a negative one, and that is the deliverable.** The evaluation
framework is real, tested production code and it did its job: it measured the
model, and the model lost. The isolation forest is **worse than the v2.0 rules on
every axis** and worse than the 2015-era heuristic too. The predictive warner
**warned before 0 of 17 failsafe onsets**. We are shipping the framework, the
frozen baseline, the labeling surface, and the two prototypes behind a lab flag —
together with the numbers that say they do not work yet.

### Scope reconciliation — what 2.5.0 actually was

The shipped `2.5.0` (tag `v2.5.0`, commit `905b9ec`) was **"Signal Lab Refined," a
UI-only refactor**. The v2.5 plan had `2.5.0 = M56 + M57`; **M56 and M57 were
never built.** So `2.5.1` carries **M56 (pulled forward) + M58 + M59**.

M56 moves *first within the slice*, not merely earlier, because **M58 and M59 have
no acceptance criteria without it**: M58 is graded "on the frozen M56 evaluation
set" against "the M56 gate," and M59 against "the M56 early-warning lead-time
target" at "the M56 FP ceiling." Every bar they can be held to is a bar M56
defines. Building them without it would have meant grading them against a bar that
does not exist.

**M57 (privacy-preserving opt-in dataset) is deferred out of the line.** Per D22/
D24 the active track is **local-history-only** — nothing leaves the device in
`2.5.1`, so there is no contribution to consent to, nothing to preview before
upload, and nothing to withdraw. Its deliverables answer questions this slice does
not ask. Separately, its centralized ingestion path hard-depends on the **v2.1 M30
platform backend, which does not exist in this repository** (documented sequencing
debt: v2.3 and v2.4-Managed were built ahead of v2.1 on isolated local/mock
seams). M57 keeps its number and its scope; it is not deleted.

Authoritative plan: `../docs/v2.5_MILESTONES.md` §M56/M58/M59.

### The honest data-bar status

**D21 requires ≥ 300 labeled sessions per class before any model work. The corpus
is 36 fixtures total** — healthy 12 / warning 7 / failsafe 7 / wiring 5 / antenna 5
— i.e. **2.4% of the bar**, and that is the *total*, not the per-class figure.
**Every model number in this release is indicative, not a gate pass**, and every
artifact under `data/ml/` says so in its own `honesty` block.

Read strictly, M56's own acceptance says that when the bar is unmet the recorded
output is "not enough data — no model work," and the line stops. We ran M58 and
M59 anyway, and the reconciliation is stated rather than defined away: **they run
as lab-flagged prototypes explicitly and knowingly below the bar, not as
gate-passing model work.** The bar exists to stop under-evidenced model output
from reaching a *user*; that protection is fully intact, because **no model output
reaches a user in `2.5.1`**. What M56 forbids is shipping model work on thin data.
What this slice does is build the pipeline and *measure how thin the data is*.

### Baselines (M56) — and why 1.00/1.00/0.00 is a ceiling, not a triumph

Frozen, byte-reproducible, in `data/ml/baseline-v20.json` (corpus fingerprint
`9b0a0e76e376d11c`; regenerate with `npm run build:ml-baseline`):

- **Baseline A — the v2.0 rule engine, per-session (n=36):** precision **1.000**,
  recall **1.000**, FP rate **0.000** (0 of 12 healthy sessions flagged).
  Per-finding: **67/67** expected findings matched, zero spurious.
- **Baseline B — the M15 `src/lib/anomaly.ts` heuristic (n=36):** precision
  **1.000**, recall **0.833** (20/24), FP **0.000**. Its 4 misses are all `warning`
  sessions: it has **no SNR detector and no packet-rate detector**.

**Baseline A's perfect score is not evidence that the rules are good. It is
evidence that the corpus cannot falsify them.** The 36 fixtures were authored
alongside the v2.0 rules, and `tests/unit/diagnostics/manifest-acceptance.test.ts`
asserts the engine reproduces them. The measurement is therefore a **CEILING taken
on the rules' own training data** — it quantifies rule *stability*, not rule
*quality*, and it says nothing about field performance. Recorded permanently as
`honesty.baselineHeldOutFromCorpus: false`.

### THE STRUCTURAL FINDING — the M56 gate is mathematically unclearable

D25 says a model may not ship unless its FP rate on the frozen set is **strictly
below** the v2.0 baseline's. **The measured baseline FP rate is 0.000**, and the
tolerance band is zero. **Nothing is strictly below zero.** Therefore **no model
can ever pass this gate on this corpus — not a better model, not a perfect model,
not a flawless oracle.**

This is a fact about the corpus, not a fault in the gate, and it is recorded
rather than patched around: `gateBaseline.fpCeilingClearable: false` in
`data/ml/baseline-v20.json`, with a test in `tests/unit/ml/m58Gate.test.ts`
asserting that **even a perfect oracle fails**. The FP denominator is 12 healthy
sessions, so the FP rate can only take 13 values and one flipped session moves it
by **8.3 points** — any FP comparison finer than that is noise regardless. The gate
was frozen *before* any model code, exactly as M56 demands, and it is left frozen
and failing rather than loosened to let our own model through.

### M58 — local anomaly model: FAILED the gate

A hand-rolled isolation forest (100 trees, ψ=7, seed 2551, **zero dependencies**),
`src/lib/ml/anomalyModel.ts`, evaluated in `data/ml/model-eval-m58.json`.
**`clearsM56Gate()` returned `false`.**

- **Held-out test split (n=9: 3 healthy / 6 faulty):** precision **0.750**, recall
  **0.500**, FP **0.333**. With 3 healthy sessions the **FP quantum is 33.3
  percentage points** — a single session is the entire difference between 0.000 and
  0.333.
- **Whole corpus (n=36):** precision **0.889**, recall **0.667**, FP **0.167**.

**It is worse than the v2.0 rules on every axis, and worse than the M15 heuristic
too.** It was trained on **7 healthy sessions in 43 dimensions**, which is not a
training set; it is a rounding error with a feature vector. A checked-in
sensitivity probe makes the point unarguable: at **1000 trees** — a strictly *more
accurate* estimator of the same quantity — AUC **drops from 0.870 to 0.815**. A
model whose score improves when you estimate it *worse* is reporting Monte-Carlo
noise, not signal.

### M59 — predictive failsafe warning: the real corpus contains NO predictive signal

This is the headline finding of the release. `src/lib/ml/predictive.ts`, evaluated
in `data/ml/model-eval-m59.json`.

- **Median lead: `null`.** The predictor warned before **0 of the 17** frozen
  failsafe onsets. `null` is a *stronger* null than 0 ms would be: 0 ms would mean
  "it warned, with no lead"; `null` means **it never warned in time at all**.
- **The ORACLE ceiling — with no model involved at all — is a median of 0 ms and a
  maximum of 80 ms**, against a **2000 ms** target. **9 of the 17 onsets give
  literally zero warning**: link quality goes from healthy to 0 in a single sample.
  There is nothing there to predict *from*. The 80 ms independently reproduces
  `MEASURED_MAX_FIXTURE_LEAD_MS = 80`, frozen in `src/lib/ml/mlConsts.ts` before
  this evaluation existed — two derivations, one number.
- The null **does not depend on our definitions.** Under a maximally generous
  "any downward movement in LQ at all" reading — including single-point noise no
  detector could act on — the ceiling rises only to 40 ms median / 120 ms max, still
  ~17× short. Re-scoring the creditability horizon at 2000 ms, 10000 ms, and
  **unbounded** does not move it either. Both sweeps are checked in.

**M59's acceptance is UNMET and unmeetable on this data.** The experiment stays
research-only. The milestone's job was to find out whether the app can warn before
a failsafe; on the data we have the answer is **no, and here is the number that
proves it**. The follow-on data task is now explicit: collect real failsafe
fixtures containing a genuine degradation ramp, and add a `failsafeOnsetIndex`
field to the manifest so lead time becomes ground truth rather than inferred from
`LQ == 0`.

### M59 synthetic corpus — INDICATIVE ONLY, NOT FIELD EVIDENCE

72 seeded sessions in `data/fixtures/ml-synthetic/` (30 failure ramps / 30
near-miss negatives / 12 steady), with their **own** manifest and fingerprint,
kept **separate** from the real corpus so the two can never be pooled. A corpus
authored alongside the model measures **"can the detector find a ramp we drew"** —
**never field performance**. No number here is an M59 acceptance pass.

And it still fails: lead-time median **2200 ms** with 30/30 coverage — but it
**false-alarms on 25 of the 30 near-miss negatives, including 10 of 10 (100%) of
the deep near-misses**. **So even on data drawn to be findable, the concept fails
the FP ceiling.** The reason is structural, not a tuning bug: **before the bottom
of a ramp, a link that will die and a link that will recover are the same signal.**
Turning the threshold down to silence the false alarms silences the true ones with
them.

### Traps hit (named, not buried)

- **Two separate "wins" were produced and correctly disbelieved.** An M58
  unbounded-horizon result claiming a **median lead of 4920 ms** was crediting a
  **standing wiring fault** — a link that was already broken at t=0 — as a
  successful *prediction* of a failsafe. An M59 result claiming **median lead 3520
  ms / `meetsTarget: true`** was crediting a **withdrawn** warning:
  `failsafe-after-warning-05`'s LQ dips to 40, **recovers to 91**, and only then
  dies ~4 s later — and the identical dip appears in the 7 `warning` fixtures that
  **never failsafe**. A timestamp-only scorer credits the dip and calls it
  foresight. Both artifacts are **published next to their own disproofs** rather
  than deleted (`realCorpus.leadTimeNaive` sits beside the oracle ceiling that
  makes it impossible), because a number that looks like a win is exactly the one
  that needs to stay visible. The fix: only warnings the predictor **still stood
  behind at the moment of the event** are creditable.
- **The lab panel shipped to every flag-off user.** `MlLabPanel` was **statically
  imported** into `src/pages/SettingsPage.tsx`, so ~36 KB of ML library rode into
  the bundle for users who have the flag OFF and can never see the panel. Caught by
  the safety audit, not by a test. Fixed with `React.lazy()` inside the
  `isMlLabEnabled()` guard: the `SettingsPage` chunk drops **109.22 kB → 73.45 kB**.
  "Zero change for normal users" now holds in **bytes**, not just in behaviour.
- **The existing GPS-exclusion privacy test was weak.** Its synthetic GPS track
  never made `gps-area-degradation` fire, so the code path it claimed to guard was
  never exercised — it would have passed against a build that leaked coordinates.
  The **product code was correct; the test was not.** Hardened in `v25PrivacyAudit`
  against a hostile session flying a real GPS loop that makes the rule fire at
  confidence 1.0.
- **`cargo fmt --check` was already red on the base branch** — 22 whitespace diffs
  in `ai.rs` / `flash.rs` / `logs.rs` / `secret_store.rs`, pre-existing and
  unrelated. `cargo fmt` was run, so those four files carry rustfmt-only,
  semantically inert changes in this release's diff.

### Added

- **M56 evaluation framework — real, tested production code.**
  `src/lib/ml/mlConsts.ts` (the frozen D21 bar + D25 gate + lead-time target),
  `dataset.ts` (feature extraction + corpus fingerprinting), `evalHarness.ts`
  (precision/recall/FP, per-session and per-finding), `baseline.ts` (both
  baselines), `rng.ts` (seeded, deterministic), `stats.ts`, `readiness.ts`.
  Metrics with fewer than 20 ground-truth instances are reported as **raw counts,
  not rates** — a rate computed from 2 instances is a lie with a decimal point.
- **The frozen baseline artifact** `data/ml/baseline-v20.json` — byte-reproducible
  from `scripts/build-ml-baseline.ts`.
- **SQLite migration v6** (`src-tauri/src/db/mod.rs`) — a `session_labels` table
  that is **append-only** (`(session_id, revision)`) with a `CHECK` constraint
  pinning `label` to the six canonical v2.0 values, so **a label column physically
  cannot store free text**. The privacy property is enforced by the schema, not by
  a convention someone has to remember.
- **Local labeling + data-readiness surface** — `src/lib/session-labels.ts` and the
  readiness report, showing the user how far the corpus is from the D21 bar.
- **Lab-flagged prototypes, invisible to users** — M58's model
  (`src/lib/ml/anomalyModel.ts`), M59's predictor (`src/lib/ml/predictive.ts`), and
  `src/components/ml/MlLabPanel.tsx` + `PredictiveWarningPanel.tsx`, all behind
  `featureFlags.mlLab` (OFF).
- **Safety / privacy / offline audits:**
  - `tests/unit/ml/v25SafetyAudit.test.ts` — **model output cannot reach a hardware
    write**, proven *structurally* rather than by enumeration: the runtime import
    closure of `src/lib/ml/**` contains **zero `@tauri-apps` packages**, so there is
    no `invoke` for a model to call even if it wanted to. A future import that
    breaks this fails the test.
  - `tests/unit/ml/v25PrivacyAudit.test.ts` — zero identifiers in features, model
    outputs, labels, or artifacts, proven against a hostile session (see the trap
    above).
  - `tests/unit/ml/v25OfflineRegression.test.ts` — nothing in the ML path touches
    the network.

### Changed

- **Version bumped to `2.5.1`** across `package.json`, `src-tauri/Cargo.toml`,
  `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json` (was `2.5.0`).
- **`assertZeroIdentifiers` was extracted to a shared `tests/unit/_privacy.ts`** —
  it had been copy-pasted **twice** (v2.3, v2.4), which is how two copies drift.
  The shared `FORBIDDEN_KEYS` is now the **union** of the v2.3 and v2.4 lists, so
  every existing audit is now checked against a **strictly stronger** list than the
  one it shipped with.
- **Zero new dependencies.** The seeded RNG, the isolation forest, the metrics, the
  feature extraction, and the corpus fingerprinting are all hand-rolled plain
  TypeScript.

### Fixed

- **`MlLabPanel` no longer ships to flag-off users** — `React.lazy()` in
  `SettingsPage`; chunk **109.22 kB → 73.45 kB**. (See the traps section.)
- **The v2.5 GPS-exclusion privacy test now exercises the path it guards.**

### Testing

- Unit **1284 → 1609** (+325). Rust **251 → 255**. E2E **61 → 66 pass**.
- One **PRE-EXISTING** e2e failure (`tests/e2e/notifications.spec.ts:58`), verified
  failing **identically on a clean base commit** — unrelated to this release and not
  introduced by it.

### Honest scope

- **`mlLab` is OFF by default. No model output reaches any user.** The D21 data bar
  is **not met** (36 sessions vs ≥ 300 per class). The M56 gate is **unclearable on
  this corpus** and is recorded as such. M58 **failed** it. M59's acceptance is
  **unmet and unmeetable** on this data. Synthetic numbers are **indicative only and
  are not, and may not be promoted to, an acceptance pass**.
- **Nothing tagged, nothing pushed, no release published.** The release pipeline
  (`.github/workflows/release.yml`) and the in-app updater config in
  `src-tauri/tauri.conf.json` (`endpoints` / minisign `pubkey` /
  `createUpdaterArtifacts`) are left **UNCHANGED**, per the standing pattern from
  `[2.4.0]` and `[2.3.0]`.

### Release feed — a deliberate, recorded policy exception

**This CHANGELOG entry is the entire release record. There is no in-app
announcement, and that is a knowing exception to a stated policy.**

`claude.md` policy §5 requires that a version bump be accompanied by a changelog
entry **and** a notification. `../docs/v2.5_MILESTONES.md` **M62** states the
narrower rule that **research / lab-only slices are recorded in the changelog as
internal/lab and are NOT announced**. The two conflict, directly, on this release.

**Resolution: M62 governs, and no announcement ships.** `2.5.1` is a lab/internal
slice with **zero user-facing change** — announcing "we shipped a model" to users
who cannot see, reach, or benefit from any model would be **the single most
misleading thing this release could do**, and it would advertise a prototype that
**failed its own gate**. A release note nobody can act on is not transparency; it
is marketing for a negative result. Additionally, `AnnouncementFeed` was unmounted
in `[2.5.0]` (it was a mock with a dead empty state) and is **not remounted here** —
resurrecting a mock surface to satisfy a policy checkbox would be worse than the
omission it fixes.

`claude.md` §5 is **left unedited**. The conflict is recorded here rather than
silently resolved, so the exception is auditable: a future reader can see that the
policy was read, that it was knowingly not followed, and exactly why.

## [2.5.0] — 2026-07-12

UI-only refactoring release — "Signal Lab Refined." No new features and no
backend changes: the existing interface is elevated with proper visual
hierarchy, an entrance animation, signal-glow effects, and structural cleanup.
Nothing tagged or pushed as a release.

### Changed

- **Design-system tokens (`index.css`).** Added the `--surface-inset` /
  `--surface-elevated` depth steps across all three themes, and a Signal Lab
  animation system (`signal-rise`, `signal-glow-pulse`) plus card hover-lift and
  accent-top utilities — all gated behind `motion-safe:`.

  The utilities are declared with Tailwind v4's **`@utility` directive, not
  `@layer utilities`**. Only registered utilities compose with variants in v4, so
  under `@layer utilities` the class `motion-safe:animate-signal-rise` emits *no
  CSS at all* and the animation silently does not exist. Verified against the
  built stylesheet. They also use animation **longhands** rather than the
  `animation` shorthand, which would reset the `animation-delay` that `stagger-*`
  sets and leave the stagger inert.

- **Card entrance animation.** Every `<Card>` now rises 8px into place on mount
  (`motion-safe:animate-signal-rise`).

  It animates **transform only — deliberately no opacity fade**. Fading a card in
  leaves its text below WCAG AA contrast for the duration of the animation (axe
  measures 1.24–1.44:1 on the device-status copy mid-fade, a serious violation),
  so the entrance reads as motion alone and never dims a word of text.

  The keyframe settles on `transform: none` with a `backwards` fill, so **no
  transform survives the animation**. This is load-bearing: a settled transform of
  any kind — even the identity matrix — makes an element the containing block for
  its `position: fixed` descendants, and this app renders Dialog/Sheet inside
  Cards without portalling them. A forwards fill would have confined the
  erase-all-data confirm, the diagnostics sheet, and the session-delete confirm to
  their card's box, each with a focus trap still active.

- **Button signal-glow hover.** The primary variant gains a signal-glow shadow on
  hover and a subtle active scale; the base transition widens to `transition-all`
  so both animate.

- **Empty-state redesign.** The dashed border becomes a recessed
  `bg-surface-inset/50` well, retaining a hairline border (the fill alone measures
  ~1.05:1 against the card in the light theme — no visible boundary without it).
  Gains an optional `action` slot for a CTA. The icon medallion does **not** pulse:
  an infinite opacity throb is the loading-skeleton idiom on a state that is idle
  rather than loading, and auto-starting motion running >5s with no pause/stop/hide
  trips WCAG 2.2.2.

- **Sidebar overhaul.** The flat nav is grouped into three sections (core /
  analysis / system) separated by hairlines. The active item carries a
  signal-green left-edge trace with an inset glow; the inactive item reserves the
  same 2px with a transparent border, so nothing shifts on navigation. The generic
  `Radio` icon logo is replaced with the real OmniLink oscilloscope waveform.

- **DeviceBar breathing room.** Height `h-12` → `h-14` (48px → 56px). The
  connected-state dot gains a `signal-glow-pulse`.

- **HomePage streamlined.** The hero uses the real waveform logo. Removed the
  `AnnouncementFeed` (a dead empty state — sponsors are flag-gated OFF and the seed
  announcements are mocks) and the Quick Actions grid (four cards duplicating
  sidebar links). The page is now the device-status card and the active-profile
  glance.

- **SettingsPage section grouping.** The 12+ flat cards are grouped under five
  labelled `<section aria-labelledby>` regions (Application / Telemetry & Maps /
  AI Assistant / Platform / Data & Privacy). The Platform section is omitted
  entirely when its three flags are all off, rather than left as an empty heading.

- **MetricCard signal glow.** Healthy metrics get a border glow and an
  oscilloscope grid backdrop. The readout is `relative` so it paints above the
  grid overlay rather than under it.

- **Page-title typography.** All seven pages now share `text-2xl font-bold` (was
  `text-xl font-semibold`). Upgrading only the two pages this release touched
  would have left the app with two competing h1 styles.

### Fixed

- **`RetrievalDebugPanel` leaked into production.** The RAG retrieval debug panel
  in Settings is now gated behind `import.meta.env.DEV`.

### Removed

- **`AnnouncementFeed` on HomePage** (its only mount) and the **Quick Actions
  grid**. The announcement components, store, and placement lib are retained,
  unmounted, for when real announcements land; the three doc blocks that still
  claimed the feed mounts on HomePage were corrected to say so.
- The dead `home.quickActions.*` i18n keys, in both locales.

### Testing

- **`tests/e2e/motion-containing-block.spec.ts`** — a new gate asserting that no
  settled Card retains a transform and that a Card-nested modal anchors to the
  viewport. It runs with `reducedMotion: "no-preference"`; **every other e2e spec
  forces `"reduce"`**, where `motion-safe:` never matches and the transform never
  applies — which is exactly why the suite was structurally blind to the modal bug
  above. Do not "fix" a failure there by switching it to `reduce`.

## [2.4.10] — 2026-07-03

Readiness-hardening batch: the offline-buildable gaps surfaced by the
`docs/2.4.9.md` re-audit, worked one at a time. Versioning follows the same
rule the v2.0 backfill used — the audit-doc number is skipped as a release, so
this batch lands on the next free number: **2.4.9 is the audit doc, this is
2.4.10**. No backend/hardware-gated work is included (those stay parked per the
audit's §4). This batch was then tagged **`v2.4.10`** and published as
OmniLink's first release (see **Released** below).

### Released

- **First published release — `v2.4.10` (2026-07-03).** OmniLink's first-ever
  tagged and published GitHub release, covering Windows + Linux + macOS. Updater
  artifacts are minisign-signed (pubkey `1F941C509DAAD29A`) and the in-app
  updater feed (`latest.json`) resolves for real users. The installers
  themselves are **not** OS-code-signed (no Authenticode / Apple Developer cert),
  so SmartScreen and Gatekeeper warn on first launch — expected, not a bug. Full
  release report in `docs/2.4.10-final.md`.
- **ci(release): gate Apple code-signing so absent certs don't fail the macOS
  build (`8bc0007`).** The first tag run's macOS job failed at Apple codesign,
  not compilation: `release.yml` passed `APPLE_*` straight from `secrets.*`, and
  GitHub resolves an absent secret to an empty string, so tauri's bundler treated
  the empty-but-present cert as "sign this" and failed importing an empty
  keychain certificate. Fixed by exporting the `APPLE_*` vars into `$GITHUB_ENV`
  only when a real `APPLE_CERTIFICATE` secret is non-empty ⇒ **no cert ⇒ macOS
  builds unsigned** (dmg + updater `.sig` still produced); **cert present later ⇒
  Developer-ID signing/notarization auto-engages**. Retagged `v2.4.10` on the fix
  (version-guard still passes — only the workflow changed); all four jobs
  succeeded and the draft was published.

### Changed

- **Honest map-tile disclosure + fixed a fabricated size (audit §2.1).** The
  offline flight-path map ships solid-colour *placeholder* tiles today (both the
  bundled world base map and all four regional packs are generated by
  `make_placeholder_base.py` / `make_placeholder_packs.py`), but the Settings
  copy claimed a real "worldwide low-zoom base map." Reworded
  `settings.tiles.description` and added an explicit dashed-border **"Placeholder
  tiles"** notice inside the Offline Map Tiles settings card
  (`SettingsPage.tsx`), mirroring the existing honest-mock notice on the mock
  subscription panel — so a flat-coloured map behind a flight path reads as
  expected, not broken. Also fixed the manifest's fabricated base-pack size:
  `tile-packs.json` declared `sizeBytes: 52428800` (50 MB) for a file that is
  actually **12 381 bytes** — a ~4 235× overstatement shown verbatim in the
  Settings UI; it now shows the honest size. Full en/es parity. Disclosure only —
  no map-rendering, flag-gating, or generator/`.ompack` changes. (Sourcing a real
  ~50 MB licensed OSM raster set stays parked per audit §4.)

### Documentation

- **Rewrote `README.md` to match 2.4.x reality (audit §2.3).** The status banner
  was five minor versions stale (`v1.7.3`); it now reflects **v2.4.10** and
  honestly summarizes what ships: core hardware/telemetry/flashing/BYOK paths
  real (HW acceptance pending, no radio), the v2.0 local-diagnostics line
  complete, v2.2's read-only controller bridge, v2.4's live BYOK RAG/AI-wizard,
  the v2.3 + v2.4-Managed platform surfaces **built but flag-gated OFF** pending
  the not-started-by-design v2.1 backend, and that **no signed release has been
  published yet**. Fixed the route table (removed the nonexistent `/wizard`;
  added the real `/analysis` + `/trends`; documented `/logs`→`/analysis` and
  `/simulator`→`/analysis` as redirects, not live pages). Removed the false
  "not yet wired" claim about the `telemetry_sessions` writer + DB→CSV session
  export (both are fully wired — `src/lib/telemetry-db.ts`, `SessionPicker`).
  Corrected the stale `.bbl` "bundled sidecar" wording to the real in-process
  `blackbox-log` decoder, disclosed the placeholder map tiles in the Features
  table (carryover from the §2.1 disclosure), and added a milestone summary for
  **v1.6 → v2.5** (the README previously documented only v1.0/v1.5). Docs-only.
- **Reconciled the milestone source-of-truth docs with the shipped app (audit
  §3).** `docs/v2.3_MILESTONES.md` no longer banners "GATED CONCEPT, hard-blocked
  on v2.1" / "Progress: Gated" — M42–M48 are documented as **built + tested +
  flag-gated-OFF mocks** (with the honest residuals: needs the v2.1 backend to be
  real, D10 encryption-at-rest still unimplemented, no signed release published).
  `docs/v1.5_MILESTONES.md` dropped its false "M6/M7/M8 hardware-accepted, M10
  hardening shipped" claim (hardware acceptance is still unexecuted; M10 was
  deferred and only closed in this 2.4.10 batch). `docs/v1.6_MILESTONES.md` marks
  M21–M28 shipped across `[1.6.0]`–`[1.6.3]` (M21's pipeline shipped but has never
  run / no release published; M22 shipped but inert; M29 hardware-acceptance still
  pending). `docs/v1.0_MILESTONES.md` + `claude.md` now record M10 as closed in
  2.4.10. Every status was verified against the CHANGELOG + code; genuinely-open
  items are kept honestly open. Docs-only.

### Fixed

- **Reconciled the self-contradicting Home announcement feed (audit §3).** Two
  permanent v2.3-era feed entries ("Welcome to OmniLink v2.3" and the v2.3
  release note) asserted in the present tense that cloud sync, Pro, and community
  presets "are here"/"ships" — while the newer 2.4.4 entry correctly says those
  surfaces are flag-gated off by default until their backend is ready (and all
  `announcement`-kind entries render unconditionally in production, so the stale
  claims really were visible). Reworded the `welcome` and `releaseV23` bodies (en
  + es) to frame cloud sync / Pro / community-preset **sharing** / sponsor cards
  as previews that are built but flag-gated OFF until their backend lands,
  consistent with the 2.4.4 anchor. Carefully preserved the truth that the
  **bundled community-preset browse + import** (`<CommunityPresets>`, always-on,
  not flag-gated) and the local core stay available today — an over-correction
  that briefly denied that live capability was caught in review and fixed. No
  entries deleted (the feed stays a chronological record); text-only.
- **The Knowledge "Update"/"Update all" button no longer fakes a refresh (audit
  §3).** The D17 pack-update seam performs no real network fetch yet (bundled
  packs ship current per release; the real fetch is deferred), but every
  "Update" click stamped a "Refreshed {today}" label as if a remote check had
  happened. Now a timestamp is recorded **only** on a genuine content refresh
  (`status === "updated"`, reserved for the future fetch); an "up-to-date" result
  records nothing, so the panel honestly shows "Bundled with this release" + the
  real content-freshness date. "Update all" now reports an honest, accessible
  transient status ("already current — bundled with OmniLink; no newer pack was
  available"). A persist migration (`omnilink-knowledge` v0→v1) clears any
  fabricated timestamps left in an upgrader's `localStorage` by the old code, and
  a rendering bug the honesty change exposed (a missing "·" separator) was fixed.

### Security

- **Backpack flash now fails closed instead of ever writing a placeholder image
  to hardware (audit §3).** The bundled Backpack firmware is a self-stamped
  placeholder (`OMNILINK-BACKPACK-PLACEHOLDER`); its only legitimate use is the
  offline `MockBackend` test path (NFR-TEST-02). The production
  `RealBackend::acquire_firmware` previously returned that placeholder for a
  Backpack target, so — if the (currently UI-unwired) Backpack firmware-flash
  path were ever reached — fabricated bytes could be written to a real device
  over WiFi-OTA. It now **fails closed**: a Backpack target returns a categorized
  `backpackFirmwareUnavailable` error (nothing is erased or written) rather than
  the placeholder. The real per-target fetch from the ExpressLRS/Backpack
  releases (mirroring the main-ELRS `flash::github` path) remains a documented
  hardware-pending TODO — it can't be verified without a radio, so it's
  deliberately out of this slice. The TX↔VRX cross-type guard, the WiFi-OTA
  upload path, and the offline mock/test path are unchanged. New en/es error
  string; new fail-closed unit test.

### Added

- **Closed v1.0 Milestone M10: structured logging, crash capture, and a Linux
  udev rule (audit §3 — NFR-LOG-01/02/03, NFR-PLAT-04).** M10 hardening was
  never actually shipped (still marked pending in `claude.md`); it is now done,
  offline-buildable:
  - **Structured logging (NFR-LOG-01):** a `tracing` subscriber replaces the ~24
    scattered `eprintln!`s across `src-tauri/src` (now `tracing::{error,warn,
    info,debug}!` with per-subsystem targets). Level defaults to `info`,
    overridable via `RUST_LOG`. New `src-tauri/src/logging.rs`.
  - **Log rotation + retention (NFR-LOG-02):** a non-blocking, **daily-rotating**
    file writer (`tracing-appender`) in the app log dir, capped at
    `max_log_files(14)` so logs don't grow unbounded. The `WorkerGuard` is parked
    in a process-lifetime `static` so file logging never silently stops.
  - **Crash capture (NFR-LOG-03):** a `std::panic` hook records every panic
    (thread name, location, payload, backtrace) **synchronously** to a dedicated
    `omnilink-crash.log` (survives a fatal exit — no async worker in the path;
    deliberately named clear of the rotating-log prune prefix so retention can
    never delete a crash dump) and to stderr via a broken-pipe-safe guarded
    write.
  - **Linux udev rule (NFR-PLAT-04):** ships `resources/linux/60-omnilink-elrs.rules`
    (CP210x `10c4:ea60`, CH340/CH341 `1a86:7523`/`5523`, FTDI `0403:6001`/`6014`/
    `6015`, Espressif native-USB `303a`; `MODE=0660`, `GROUP=dialout`,
    `TAG+="uaccess"`). The `.deb` installs it to `/usr/lib/udev/rules.d/`
    automatically; README documents the manual AppImage install. No more
    hand-running `usermod -aG dialout` as the only option.
- **Export My Data / Delete All My Data in Settings (audit §3 — NFR-PRIV-02).** A
  GDPR-style **Privacy / Your data** card, 100% local (no server). **Export**
  downloads a single versioned JSON bundle of all local user data — the 4 SQLite
  tables (`telemetry`, `telemetry_sessions`, `conversations`, `messages`), all 18
  `omnilink-*` localStorage stores, and config profiles — with **API-key values
  never included** (only a `provider → has-key` boolean map + a note). **Delete**
  irreversibly erases everything behind a type-the-word confirm: the 4 SQLite
  tables, all 18 stores, every profile, every BYOK key (a new
  `delete_all_api_keys` deletes `ai_keys.json` wholesale + clears known keychain
  slots, so orphaned legacy slots are cleared too), and the `.elrsp`
  device-config backups (new `delete_all_backups`), then reloads clean —
  localStorage is cleared **last** (after the backend erase) so no live store can
  resurrect a key. A single `src/lib/userData.ts` inventory drives both export
  and erase so they can't drift. Full en/es; unit + e2e coverage.
- **Optional audio alert for telemetry thresholds (audit §3 — FR-TELEM-03).** A
  "Play a sound on alert" toggle (default OFF, opt-in) in Alerts settings, plus a
  Test button. On a threshold **trip** (not on recovery), a short guarded
  Web-Audio beep fires alongside the existing toast + OS notification, respecting
  mute. Zero-dependency, no bundled audio asset, fully guarded so it never throws
  in a headless/test env (`src/lib/alertSound.ts`).
- **Knowledge/Import/RAG-citation e2e (audit §3).** Added `tests/e2e/knowledge.spec.ts`
  — the one major v2.4 surface that previously had only unit/store coverage — driving
  the Knowledge sources panel, user-doc import (+ error path), live-chat RAG citation
  cards, the honest "no trusted source found" state, and the per-chat sources control,
  all axe-clean in a real browser.
- **Community-translation scaffolding (audit §3 — NFR-I18N-04).** Added an inert,
  honestly-labeled Crowdin scaffold — `crowdin.yml`, a manual-only
  `.github/workflows/crowdin-sync.yml`, and `docs/TRANSLATIONS.md` — so
  community translation becomes a "create a project + add two secrets" step, not a
  code change (same exists-but-inert shape as `release.yml`). The existing full
  en/es parity + the key-parity test remain the completeness gate.

### Changed

- **Knowledge-source enable/disable is now scoped per conversation (audit §3 —
  M52 spec alignment).** The imported/trusted-source toggle was a single global
  switch; it is now **per chat** — a new "Sources for this chat" control in the
  assistant panel writes to the active conversation's set, and retrieval grounds
  each answer over that conversation's enabled sources. Disabling a source in one
  chat no longer affects another. Persist migration (`omnilink-knowledge` v1→v2)
  drops the old global disabled map (a fresh per-chat model starts clean). Full
  en/es; unit + e2e coverage.
- **Swapped the default Vite scaffold favicon (audit §3)** — `index.html` now
  points at the teal-oscilloscope OmniLink brand mark (`public/omnilink.svg`,
  matching the desktop app icon) instead of `/vite.svg`.

### Fixed

- **Chat message log is now keyboard-scrollable (WCAG 2.1.1).** The `role="log"`
  message list scrolls but wasn't keyboard-focusable (`axe`
  `scrollable-region-focusable`) — added `tabIndex={0}` (it already had an
  accessible name). Surfaced by the new knowledge e2e's full-page axe scan on a
  populated chat.
- **Corrected a stale `SourceCitations.tsx` doc-comment (audit §3)** that claimed
  citations were "NOT yet wired into live chat — that is M51"; M51 wired them
  (they render on assistant answers via `MessageBubble`).

## [2.4.8] — 2026-07-02

Post-v2.0 maintenance batch: housekeeping and deferred-deliverable backfills
surfaced by the `docs/2.4.6.md` readiness audit, landed on top of the now-complete
v2.0 diagnostics line. No v2.0 milestone code changed here.

### Added

- **Dev-only feature-flag toggle.** A "Preview features (dev)" Settings panel —
  rendered ONLY in dev builds (`import.meta.env.DEV`) — plus a `?ff=` URL param
  and a `localStorage` override (`omnilink-dev-flags`), so the flag-gated
  v2.3/v2.4 surfaces (`managedAi`, `cloudSync`, `subscription`, `sponsors`,
  `hostedPresets` + M46 moderation) are reachable for QA/demos and e2e without
  editing `featureFlags.ts`. **Production is unchanged** — flags stay OFF and
  code-only; the override applier and the panel are both `import.meta.env.DEV`-
  gated (and browser/`localStorage`-guarded, so Node/vitest is a no-op), so
  neither ever runs in a shipped build. The override lives in a pure, unit-tested
  `parseDevFlagOverrides` parser (`?ff=` wins over the stored blob; unknown keys
  and malformed JSON are ignored). This also enables the M46 hosted-preset
  moderation e2e (`tests/e2e/hosted-moderation.spec.ts`: report → reviewer
  surfaces it → archive → drops from browse) — the coverage item 6 deferred
  because the flag couldn't be flipped in-browser. Note: the audit posed this as
  a decision; the dev-only form was chosen (over a shippable preview panel that
  would expose backend-less surfaces to end users).
- **Real in-process `.bbl` blackbox decode.** Replaced the placeholder,
  sidecar-based `blackbox_decode` path (which needed an external CLI that was
  never bundled, so `.bbl` import produced nothing) with an **in-process
  pure-Rust decoder** (`blackbox-log` v0.4.3 + `uom`; no C toolchain, no external
  binary, decodes fully offline). `src-tauri/src/commands/logs.rs` reads the
  `.bbl` bytes and emits the same `blackbox_decode`-compatible CSV the importer
  already parses — `parseBlackboxCsv` (`src/lib/blackbox.ts`), the `logs://*`
  event / `DoneDto { csvPath, csv }` contract, the 64 MiB inline cap, and cancel
  are all **unchanged**. Columns/units are matched exactly to what the importer
  keys on: `time (us)` (µs axis), unit-tagged headers via the crate's unit-aware
  quantities (`vbatLatest (V)`, `amperageLatest (A)`, `gyroADC[n] (deg/s)`, …),
  and *bare* `GPS_coord[0]`/`[1]` (degrees) with the last GPS frame merged onto
  each main row. Robustness/honesty: a corrupt/unsupported log — **including one
  crafted to trip a `panic!`/assert deep in the decoder** — is caught
  (`catch_unwind`) and mapped to a clean structured `logs://error`, so the worker
  always emits a terminal event and the import never hangs; a header-only log
  (no decodable flight-data frames) errors cleanly instead of producing an empty
  "successful" import; and a multi-log `.bbl` (a flash-chip download of several
  flights) decodes the first and surfaces a `logs://log` notice for the rest
  rather than dropping them silently. Error details are generic — no raw `.bbl`
  bytes are ever placed in an error or log line. Added a **real vendored `.bbl`
  fixture** — Betaflight 4.2.11 `error-recovery.bbl` from the `blackbox-log`
  crate's own MIT/Apache test corpus (see `data/fixtures/logs/ATTRIBUTION.md`;
  not fabricated) — plus a Rust decode test
  (`decodes_real_bbl_fixture_to_expected_csv`, asserting the expected
  columns/units + ≥1 plausible row **and byte-for-byte equality with the
  committed golden** so mapping drift fails the test), tests for the
  panic-catch / header-only / multi-log / cancel paths, and a golden Rust-decode
  → TS-parse round-trip (`data/fixtures/logs/error-recovery.decoded.csv` fed back
  through `parseBlackboxCsv` in `tests/unit/blackbox.test.ts`). The now-dead sidecar
  subprocess, its `resolve_blackbox_decode`/`spawn_error` helpers and the
  `blackboxDecodeNotFound` summary key were removed; nothing else referenced them
  (no `externalBin` entry existed in `tauri.conf.json` and no i18n key needed
  changing, so en/es parity is untouched).

### Fixed

- **Backfilled the missing v2.2 controller-bridge in-app announcement feed
  entry.** The v2.2 "Controller Bridge Mode" line (M63–M67) shipped under
  `[2.2.0]` but skipped its required announcement-feed entry — the v2.2 doc
  mandates "every patch release must update the changelog and the in-app
  announcement feed" (an M67 deliverable). Added `ann:release-2.2.0` to
  `SEED_ANNOUNCEMENTS` in its correct historical slot: a `ts` below the entire
  v2.3 cluster, so it sorts as the oldest release notice rather than
  masquerading as new. Full en/es copy describes the read-only bridge
  (probe/label, guided passthrough diagnostics, read-only context, redacted
  support export) — never a flight-controller configurator.
- **Finished M46 community-preset moderation.** The reviewer panel now surfaces
  flagged (reported) presets in a new "Reported presets" section — each with its
  scrubbed report reasons and report count — and a wired **Archive** action
  (`archivePreset`) that removes an approved preset from the public browse list
  (and from the reported queue) once a trusted reviewer archives it. Reports were
  already being stored (scrubbed) by the browse "Flag" button, but nothing
  surfaced them and `archivePreset` had no call site; both gaps are now closed
  and the stale "DEFERRED" note in `presetSubmission.ts` is retired. Added a
  `selectReportedPresets` selector (approved + ≥1 report, newest-report-first)
  and full en/es copy (`profiles.hosted.review.{archive,archived,reportedTitle,
  reportedEmpty,reportCount_one/_other}`). This is LOCAL mock moderation and stays
  **flag-gated OFF** (`hostedPresets`); the store/selector logic is unit-tested
  (`tests/unit/presetLibrary.test.ts`) — the rendered/e2e coverage of the gated
  surface lands with item 8's dev flag toggle (the flag can't be enabled
  in-browser yet, and vitest runs node-env with no jsdom).

### Security

- **BYOK API keys now use the OS keychain.** Keys move from the plaintext `0600`
  `ai_keys.json` to the OS secret store (`keyring`: pure-Rust Secret Service on
  Linux via zbus, macOS Keychain, Windows Credential Manager) via a keychain-first
  `SecretStore` with a `0600`-file fallback for headless/no-daemon (CI/WSL)
  environments — no plaintext-at-rest on real desktops, no regression elsewhere.
  Legacy `ai_keys.json` keys migrate into the keychain on startup when one is
  available; keys remain backend-only and are never returned to the webview.
  Closes the PHASE-2 keychain TODO (doc M30).

### Parked (honest — no fabricated data)

The `docs/2.4.6.md` audit's item 9 asked to "replace placeholder artifacts where
possible offline". The `.bbl` decode was replaced with a real decoder (see
**Added**). The remaining two artifacts are **not producible/verifiable offline**
and stay self-evident placeholders — no fake data was generated for either:

- **Map tile base pack** — a real base pack needs a rendered ~50 MB OpenStreetMap
  raster set plus ODbL sourcing/attribution decisions that cannot be made or
  produced offline. The `.ompack` container format, the resource serve path, and
  the blank-tile fallback are already real and honest (they never present fake
  geography), so the placeholder cannot masquerade as real map data. Parked until
  a licensed raster set can be sourced.
- **Backpack firmware image** — a real ESP8266/ESP32 Backpack firmware image is
  hardware-flash-only and unverifiable without a radio to flash and observe. The
  bundled image stays a self-stamped placeholder that cannot pass as real
  firmware. Parked pending hardware.
- **v1.6.4 hardware-acceptance run** — the `docs/v1.6.4_HW_VALIDATION.md`
  checklist stays unexecuted; it requires a physical radio. Parked/scheduled for
  when hardware is available.

### Version

- Version bumped to `2.4.8` across `package.json`, `src-tauri/tauri.conf.json`,
  and `src-tauri/Cargo.toml` (was `2.4.7`).

### Release feed

- New in-app announcement `ann:release-2.4.8` (project policy §5) leads the feed,
  highlighting the two user-facing wins — offline in-process `.bbl` decode and
  BYOK keys in the OS keychain. (The dev-flag toggle and M46 moderation are
  developer/gated surfaces; the backfilled v2.2 notice sits in its historical
  slot.)

## [2.4.7] — 2026-07-02

**v2.0.2 backfill (M40 + M41).** The v2.0 milestone doc slots M40 + M41 into a
**v2.0.2** slice. Following the same rule the 2.4.5 entry set (a shipped 2.4.x line
can't retroactively tag a 2.0.x number), this work lands under the next release
number — but **2.4.6 is skipped**: `docs/2.4.6.md` is the reserved readiness-audit
**document**, not a release, so the tag would collide with it. M40 therefore lands
as **2.4.7**; the **M41 launch gate then closed 2.4.7 in place** (no version bump) —
formalizing the large-log scan budget, running the consolidated per-preset FP/recall
audit against the DL2 corpus, and adding the offline + a11y regressions (see the M41
section at the end of this entry). Everything here is **additive** — the frozen M36
engine and the M38 patterns/export are untouched; a new persisted store and a single
additive recording call are the only wiring changes — and stays **local + offline**:
the trend/suggestion engine is pure (`Date.now`/`Math.random`/I/O-free), and no
identifier (coordinate/UID/MAC/IP/serial) is read or emitted.

### Added

- **Local trends & setup suggestions (`src/lib/diagnostics/trends.ts` +
  `suggestions.ts`, M40):** as you analyze sessions, each one's diagnostic summary
  accumulates into a new persisted history store
  (`src/stores/diagnosticsHistory.ts`, deduped by a pure content signature). Three
  pure engine modules turn that history into insight:
  - `history.ts` — `summarizeSessionForHistory` reduces a session's M36 report +
    M38 patterns to a non-identifying rollup (health, per-severity/per-rule tallies,
    pattern ids, median packet rate);
  - `trends.ts` — `summarizeTrends` groups records **per device** (using the picked
    session's `targetName`/`firmware`; imported CSVs fall into an "unknown device"
    bucket) and surfaces signal health over time, event types recurring in ≥2
    sessions, and weak packet rates;
  - `suggestions.ts` — `deriveSuggestions` maps those trend signals onto five
    conservative rules (antenna check, telemetry interval review, packet-rate
    reconsideration, power setting review, wiring/power suspicion), each labeled
    **measured** (recurs in ≥⅔ of sessions), **likely** (≥½), or **worth checking**
    (the bare ≥2 minimum).
- **Trends surface (`src/pages/TrendsPage.tsx` + `DeviceTrendCard` /
  `SuggestionCard`, M40):** a new `/trends` page + sidebar entry that renders the
  per-device trend cards (health-over-time sparkline reused from the signal-health
  panel, repeated events, weak RF modes) and the confidence-chipped suggestion
  list, plus a **reset-history** control behind a destructive confirm dialog that
  genuinely clears the store (M40 acceptance: resetting removes the trend state).
- **Honest empty states (never fabricated):** trends come ONLY from real analyzed
  sessions. A fresh install shows an honest empty state; below
  `MIN_SESSIONS_FOR_TRENDS` (3) recorded sessions it shows a distinct "not enough
  recorded sessions yet" note; nothing is ever seeded or invented.

### Tests

- **`tests/unit/diagnostics/history.test.ts`**: signature stability + distinction,
  rule/pattern/packet-rate rollups off the real engine, determinism.
- **`tests/unit/diagnostics/trends.test.ts`**: per-device grouping (incl. the
  unknown bucket), oldest→newest health series, ≥2-session recurrence, weak RF
  modes, the `hasEnoughHistory` boundary at the minimum, determinism, empty input.
- **`tests/unit/diagnostics/suggestions.test.ts`**: each rule fires on its signal
  and stays silent otherwise, the measured/likely/worth-checking buckets at their
  thresholds, nothing below the 2-session minimum, deterministic order.
- **`tests/unit/diagnosticsHistory-store.test.ts`**: signature dedupe (update in
  place), newest-first cap eviction, `clear()`/`reset()`.
- **`tests/e2e/trends.spec.ts`**: honest empty state, seeded per-device trends +
  suggestions + reset round-trip, the real import pipeline accumulating history,
  and an axe pass over the populated page.

### Version

- **Version bumped to `2.4.7`** across `package.json`, `src-tauri/tauri.conf.json`,
  and `src-tauri/Cargo.toml` (was `2.4.5`; **2.4.6 skipped** — it is the reserved
  audit document `docs/2.4.6.md`, not a release).

### Release feed

- The in-app announcement feed's **v2.4.7 release notice**
  (`announcements.seed.releaseV247.*`, en + es) now covers the whole v2.0.2 slice:
  the local per-device trends + conservative setup suggestions **and** that the v2.0
  Smart Diagnostics line is complete + hardened (the M41 launch gate closed) — all
  local, offline, and account-free, nothing uploaded. Strings stay at full en/es
  parity (M27 gate).

### v2.0 launch gate (M41)

The M41 hardening + false-positive audit closes the v2.0 diagnostics line **in place
at 2.4.7 (no version bump)**, scoring it against the ratified DL3 targets
(`docs/v2.0_MILESTONES.md` §DL3). All numbers below are **measured on the DL2
corpus**, then pinned as frozen constants so a regression trips the gate.

- **Formalized scan budget (`src/lib/diagnostics/perf.ts` +
  `tests/unit/diagnostics/scan-budget.test.ts`):** the loose 2000 ms M36 smoke is
  retired and replaced by a real budget over the **full** v2.0 scan
  (`evaluateSession` + `detectSessionPatterns`). A frozen p95 ceiling
  `DIAGNOSTICS_SCAN_P95_BUDGET_MS = 750` (deliberately generous — a 50k-sample full
  scan measures ~70 ms median / ~85 ms p95 on the WSL2 reference machine) plus a
  deterministic complexity guard `t(2N) < 3·t(N)` (measured ratio ≈ 2.0, i.e.
  linear) that catches an O(n²) regression without a flaky absolute bound. The
  shared deterministic `buildLargeSessionLog` lives in the same module.
- **Consolidated per-preset FP/recall audit
  (`tests/unit/diagnostics/v20-launch-audit.test.ts`):** the single gate spanning
  M36 findings + M38 patterns across all three sensitivity presets.
  - **False positives = 0** on every preset: **0/12** healthy fixtures raise any
    warning-or-higher M36 finding, **and 0/12** raise any M38 session pattern (well
    under the ratified ≤ 5% ceiling).
  - **Recall** against the 67 labelled expected findings: **intermediate (default)
    67/67 = 100%** and **advanced 67/67 = 100%** — both clear the ratified ≥ 90%
    floor; **beginner 59/67 = 88.1%**. Beginner sits just below 90% **by design**:
    its higher thresholds trade recall for caution (it still holds FP = 0), so the 8
    briefest/shallowest windows it misses are an accepted, documented trade-off — its
    measured floor is pinned, not chased. Recall is asserted **monotonic**
    (`beginner ≤ intermediate ≤ advanced`), confirming the sensitivity ladder is
    correctly ordered. **No preset threshold was tuned** — the audit found all three
    presets FP-clean and correctly ordered, so `config.ts` is unchanged.
- **Offline regression (`tests/unit/v20DiagnosticsOfflineRegression.test.ts` +
  `tests/e2e/offline.spec.ts`):** with the Tauri IPC seam mocked OFF (unit) and the
  external network aborted (e2e), the full M36 → M38 → M40 pipeline still produces
  real findings, a pattern, and a trend + suggestion — the unit suite asserts the
  mocked `invoke` is **never called** (free + local, no account, no upload), and the
  e2e anchors the health panel + findings list + M38 patterns rendering offline.
- **Accessibility (`tests/e2e/diagnostics.spec.ts`, `src/components/ui/badge.tsx`,
  `src/components/diagnostics/*`, `src/index.css`):** the axe pass now also scans the
  **M38 pattern cards + `diagnostics-pattern-marker`** on a pattern-producing fixture
  and the honest "not enough evidence" short-session state, and adds **light-theme
  scans** (the prior scans all ran in the default dark theme, hiding light-only
  contrast bugs). Those scans surfaced — and this gate FIXES — two genuine **WCAG AA
  status-text fails on diagnostic panels**, each with a new **per-theme text token**
  (text only; the solid status fills — chart markers, the NotificationBell count —
  are untouched):
  - **Critical severity text** (`--status-critical-strong`): `text-status-critical`
    on its faint `/15` tint was only ~3.7–4.0:1 across themes (and ~4.4:1 as a direct
    Signal-Health label on the dark card). Now **DARKENED on light (L 0.45 → 5.1:1)**
    and **LIGHTENED on dark/carbon (L 0.72 → 6.3–6.6:1)**, applied to the severity
    Badge (app-wide) and the diagnostics critical readouts.
  - **Good/nominal text** (`--status-good-strong`): the Signal-Health factor
    readout's green values were only ~2.67:1 on the near-white light card (green is
    high-luminance). Now **DARKENED on light (L 0.46 → ~5.8:1 on the card, ~5.0:1 on
    a `/15` tint)**; the dark/carbon good green already clears AA (~6.4–6.6:1) so the
    token aliases the base there. Applied to the `SignalHealthPanel` factor readout +
    `SignalHealthGauge` band text. Warning text already clears AA on every theme, so
    it is unchanged.
  Verified across failsafe / warning / multi-drop / healthy fixtures: **every
  diagnostic panel + chart marker now passes axe (zero serious/critical) in BOTH the
  light and dark themes.** Two **new light-theme e2e tests** guard the critical badge
  (patterns surface) and the good factor readout (health panel) going forward.
  *Known follow-up (out of the diagnostic-panel remit):* the shared status color as
  text on NON-diagnostics surfaces in the light theme (e.g. the `good`/`warning`
  Badge variants in `ProfileDiff` / subscription / knowledge panels) can still fall
  below AA; a later app-wide light-theme status-text pass is tracked separately.
- **Release artifacts:** the release is finalized at **2.4.7 in the tree**;
  **signing/publishing of the artifacts is out of scope in this environment** (no
  tag/push here). The doc's "signed v2.0.2 release" step remains for a release
  engineer — this entry does not claim a signed artifact.

## [2.4.5] — 2026-07-02

**v2.0.1 diagnostics backfill (M38 + M39a).** The v2.0 milestone doc slots M38 and
M39a into a **v2.0.1** slice, but the app has already shipped at 2.4.x, so 2.0.1
cannot be retroactively tagged. Instead this work lands under the next unused release
number — **2.4.5** — which carries the whole v2.0 diagnostics backfill: **M38**
post-flight pattern detection **and M39a** BYOK AI explanations that consume the
export schema below. Everything here is **additive** — the frozen M36 engine and the
M38 export are untouched, the new AI-context field is optional, and the Managed path
is not touched — and stays **local + offline**: the pattern engine is pure
(`Date.now`/`Math.random`/I/O-free), and no identifier (coordinate/UID/MAC/IP/serial)
ever leaves the detector, the export, or the AI payload.

### Added

- **Post-flight pattern detection (`src/lib/diagnostics/patterns.ts`, M38):** a
  pure `detectSessionPatterns(log, report)` that reads the M36 findings plus the
  raw channels + GPS track and surfaces the recurring/correlated stories that are
  hard to see from raw charts — four detectors:
  - `repeated-lq-drops` (link): the link collapses ≥3 separate times;
  - `heading-degradation` (signal): a **direction**-correlated null — weak only in
    one 45° heading sector, guarded by a sector-spread threshold so a uniformly
    weak link (M36's job) never fires;
  - `gps-area-degradation` (signal): a **location**-correlated weak spot the flight
    passes through ≥2 times (coordinates are grid-bucketed **internally** to find
    recurring passes — a cell key / lat / lon is never emitted); and
  - `power-packet-link-events` (power): TX power / packet-rate shifting around the
    link events (edge-of-link-budget behaviour).
  Each pattern carries a severity, confidence, ascending evidence windows, three
  plain-language i18n keys (most-likely-issue / evidence / what-to-check-first),
  and a `detail` bag of **non-identifying numbers only** (asserted in tests). The
  detector is a no-op (`hasEnoughEvidence: false`) below `MIN_SAMPLES_FOR_PATTERNS`.
- **Summary cards (`src/components/diagnostics/SessionPatternCards.tsx`, M38):** the
  most-likely issue rendered as three labelled blocks — **Most likely issue /
  Evidence / What to check first** — plus a compact secondary-pattern list, each
  click-to-scrub to its first evidence window. Honest empty states: a **"not enough
  evidence"** note for short sessions and a **"no recurring patterns"** note when
  the detector ran clean. Mounted near the top of the Session Analysis page.
- **Pattern chart markers (`buildPatternMarkers` in `DiagnosticChartMarkers.tsx`,
  M38):** the patterns' evidence windows as **dashed, fainter** reference bands +
  clickable dots on the timeline charts, visually distinct from the M37 finding
  markers.
- **Deterministic findings export schema (`src/lib/diagnostics/export.ts`, M38):** a
  stable, versioned (`DIAGNOSTIC_EXPORT_SCHEMA_VERSION = "1.0.0"`)
  `buildDiagnosticExport(report, patternReport, log)` — findings + patterns with
  sample windows **and** relative seconds, health score, severity counts — that
  JSON-round-trips exactly and carries **zero identifiers**. This is the cross-line
  artifact **M39** and the **v2.5 ML** line consume.
- **Store + i18n:** `sessionPatternReport` on the diagnostics store (runtime-only,
  set alongside `sessionReport`), and full en/es strings for all new UI (M27 parity
  gate).
- **GPS pattern fixtures (`data/fixtures/diagnostics/patterns/`, M38):** synthetic,
  static, no real location — `gps-area-recurring-01.csv` (a loop flown twice with a
  recurring weak cell → `gps-area-degradation`) + a `gps-clean-01.csv` negative
  control, with a provenance `patterns-manifest.json`. The M36 corpus and its
  `fixtures-manifest.json` are untouched.
- **BYOK AI explanations for diagnostics (M39a):** two BYOK-only actions —
  **"Explain this finding"** on each finding card and **"Ask Omnia about this
  session"** on the findings header — let a user ask Omnia to explain a local
  diagnostic in plain language using their **own** API key. The diagnostic evidence
  rides as a new **sanitized aggregate context block** (`AiContextInput.diagnostics`,
  built by the pure `diagnosticsContextFromExport` / `diagnosticsContextFromFinding`
  from the M38 export / an M36 finding), so the existing **preview-before-send**
  discloses exactly the sanitized aggregate and the extended Rust `sanitize_context()`
  redacts it (whitelisted `scope`/`category`/`severity` enums, clamped numbers,
  `detail` bags scrubbed through the SAME baseline as `user_defines`, capped rows).
  The actions **prefill the composer** and open the assistant (never auto-send), and
  they **do not touch** `featureFlags.managedAi` or the Managed path. Graceful
  degradation is preserved: with no key the honest `ai.noKeyConfigured` bubble posts
  and the local finding stays fully visible. The new `diagnostics` field is
  **optional** — absent, `sanitize_context` / `selectAiContext` / `buildAiContext` /
  `sendMessage` / the preview behave exactly as before. New en/es strings
  (`diagnostics.finding.explain(Aria)`, `diagnostics.findings.ask(Aria)`,
  `diagnostics.ai.*`) at full M27 parity.

### Tests

- **`tests/unit/diagnostics/patterns.test.ts`** (mechanics + DL2 corpus): each
  detector fires on a positive case and stays silent on a negative case; the
  short-session guard; determinism; the no-identifier safety contract; sort +
  `mostLikely` invariants; antenna fixtures raise `heading-degradation`;
  recurring/multi-drop fixtures raise `repeated-lq-drops`; the synthetic GPS
  fixture raises `gps-area-degradation`; and — the critical false-positive guard —
  **every healthy fixture stays entirely pattern-free**.
- **`tests/unit/diagnostics/export.test.ts`**: schema version, determinism, JSON
  round-trip, relative-seconds correctness, length fidelity, and a recursive
  no-identifier / finite-number assertion.
- **`tests/unit/diagnostics-store.test.ts`** extended for `sessionPatternReport`;
  **`tests/e2e/diagnostics.spec.ts`** extended with the pattern summary + markers +
  honest empty-state flow (a11y kept clean).
- **M39a — Rust `diagnostics_context_strips_identifiers`** (in `commands/ai.rs`): an
  aggregate diagnostic context stuffing a binding phrase + serial under a sensitive
  key and GPS/MAC/IP/email string values under benign keys, plus a bogus
  `scope`/`category`/`severity`, leaks **zero** identifiers through
  `sanitize_context()` (sensitive-keyed entry dropped whole, identifier shapes
  `[redacted]`, out-of-whitelist enums dropped) while the legitimate numeric
  aggregates survive — and the block is embedded end-to-end in the assembled system
  prompt. Plus `diagnostics_absent_leaves_payload_unchanged` (the optional field is a
  true no-op when absent).
- **`tests/unit/diagnosticsAiContext.test.ts`** (new): the pure builders are
  deterministic + identifier-free (recursive scan, incl. a `gps-area-degradation`
  session), with the right `scope`/shape per builder and row caps.
  **`tests/unit/selectAiContext.test.ts`** extended: the diagnostics aggregate
  threads through in every mode incl. offline, without changing the offline
  no-device-data contract. **`tests/unit/assistantPendingDiagnostics.test.ts`** (new):
  the one-shot `pendingDiagnostics` is folded into the sent context then cleared, and
  the no-key path still posts the honest bubble + clears it.
  **`tests/e2e/diagnostics.spec.ts`** extended with the Explain/Ask flows (key present
  → panel opens with the drafted question, finding stays visible; key absent → no-key
  bubble + finding stays visible; a11y kept clean).

### Version

- **Version bumped to `2.4.5`** across `package.json`, `src-tauri/tauri.conf.json`,
  and `src-tauri/Cargo.toml` (was `2.4.4`).

### Release feed

- The in-app announcement feed seeds a **v2.4.5 release notice**
  (`announcements.seed.releaseV245.*`, en + es) as the newest feed item, describing
  the full v2.0.1 slice — post-flight pattern detection **and** optional BYOK AI
  explanations of local findings — all local, offline, and account-free, nothing
  uploaded. New strings are at full en/es parity (M27 gate).

## [2.4.4] — 2026-07-01

v2.4.4 is a **polish/patch release** that ships the app lean. Several surfaces
were built ahead of the **v2.1 platform backend that is not present in this
repo**, riding on honest local mocks; this release **flag-gates them OFF by
default** so the shipped app only exposes what is actually real, while keeping
all the code in the tree to switch back on once the backend lands. **No free
local behavior changed** — flashing, telemetry, profiles, BYOK chat, and local
knowledge/RAG are untouched.

### Changed

- **v2.3 cloud/subscription/community/sponsor surfaces flag-gated OFF by
  default** via `src/lib/featureFlags.ts` (`cloudSync`, `subscription`,
  `sponsors`, `hostedPresets`). The `CloudSyncSettings`, `SubscriptionSettings`,
  `SponsorSettings`, and Profiles "Hosted" preset surfaces stay in the codebase
  but are hidden until the real v2.1 backend exists. The local Saved and bundled
  Community preset tabs are unaffected.
- **v2.4 Managed AI answer path gated OFF** behind both the existing
  `featureFlags.managedAi` switch and a new Rust `managed_ai` cargo feature: when
  the feature is off, the `ManagedAdapter` refuses cleanly rather than serving the
  local mock proxy. BYOK (Anthropic / OpenAI-compatible) and the local RAG core
  remain real and account-free.
- **Settings decluttered** so only shipping surfaces are shown; the gated preview
  panels no longer appear.

### Removed

- **Fabricated sponsor cards removed from the Home landing page.** The seed
  sponsor/partner cards were obviously-mock `omnilink.test` brands; with the
  `sponsors` flag OFF they no longer render on Home. Genuine (non-sponsor)
  announcements still show, and the local v2.4 RAG / knowledge / import panels
  remain visible.

### Version

- **Version bumped to `2.4.4`** across `package.json`,
  `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (was `2.4.0`).

### Release feed

- The in-app announcement feed seeds a **v2.4.4 release notice**
  (`announcements.seed.releaseV244.*`, en + es) as the newest feed item, so the
  release is surfaced alongside this CHANGELOG (project policy §5). New strings
  are at full en/es parity (M27 gate).

## [2.4.0] — 2026-07-01

v2.4.0 "Smarter help with verifiable sources" ships the whole v2.4 RAG /
AI-assisted-wizard line (M49–M55). Omnia can now answer grounded in **trusted
ExpressLRS documentation with visible citations**, retrieved by a **local BM25
index** (no cloud retrieval, offline-first — D15), and the flashing wizard gains
an **optional AI-assisted mode** that always falls back to the static wizard.
**Honest scope:** RAG answers run over your own **BYOK** key (Anthropic /
OpenAI-compatible, real); the **Managed AI** answer path is a **flag-gated,
OFF-by-default LOCAL mock proxy** (no external Managed server, no account, no
credit ledger) standing in for the v2.1 platform line (M31/M33) that **is not
present in this repo** — exactly the two-phase "real seam, mock transport"
pattern the v1.x/v2.3 lines used. The AI is **assistive, not authoritative**:
every firmware/config change still passes the deterministic field allowlist and
the review/diff screen before apply, and the assistant never receives binding
phrases, GPS, MAC/serial, IP, or email — the assembled RAG payload passes
`sanitize_context()`. M55 is the launch gate: it adds the evaluation/safety/
privacy/offline audits, bumps the version, and prepares — but does NOT publish —
the signed release.

### Added

- **Trusted knowledge source model (M49, D16/D17):** a source registry
  (`src/lib/knowledge/registry.ts` + `data/knowledge/registry.json`) with title /
  version / license / freshness / trust metadata, a **closed license/allowlist
  gate** (`src/lib/knowledge/allowlist.ts` — only official ELRS docs +
  OmniLink's own notes ship by default), an unsafe-content exclusion list, and a
  D17 on-demand pack-update seam; cached packs stay usable offline. The store
  (`src/stores/knowledge.ts`) lists sources and drives updates.
- **Local retrieval pipeline + citation cards (M50, D15/D19):** a pure BM25 index
  over chunked trusted packs (`src/lib/knowledge/{chunk,bm25,retrieve}.ts`), a
  **frozen relevance threshold (`RELEVANCE_THRESHOLD = 0.18`) and eval pass-bar**
  (`EVAL_PASS_BAR = { inCorpusTopSource: 0.90, outOfCorpusNoSource: 1.0 }` in
  `retrievalConsts.ts`), a golden evaluation harness (`eval.ts` +
  `data/knowledge/eval/golden.json`), and citation cards. Retrieval returns a
  bounded excerpt per chunk or the **D19 "no source found"** state — never a
  fabricated citation. A TS redaction mirror (`retrievalSanitize.ts`) matches the
  Rust `sanitize_context()` retrieved-docs scrub.
- **RAG-enabled Omnia answers (M51, D19/D20):** the chat turn (and the pre-send
  preview) call `retrieveForChat` (`src/lib/ragRetrieval.ts`), scoped to the
  enabled sources, and the Rust `assemble_system_prompt()` wraps the sanitized
  retrieved docs in a SEPARATE `<retrieved_docs untrusted>` anti-injection fence
  alongside the `<device_context>` fence. **BYOK is real; Managed is a flag-gated
  mock proxy** (`src/lib/managedAi.ts` ↔ Rust `ManagedAdapter` / `mock_managed_proxy`)
  with a matching pre-send cost/credit estimate (`src/lib/aiCost.ts`,
  `MANAGED_INPUT_CAP`).
- **User-imported docs (M52, D18):** a **free, local** import of `.txt`/`.md`
  notes (`src/lib/knowledge/import.ts`) — stamped `user-imported` (untrusted) by
  construction, joined to the SAME BM25 index and prompt-fence as trusted packs
  (there is no weaker path), per-source enable/disable (a global toggle in
  Settings), and delete-and-reindex. Imported content is **local only** — never
  uploaded.
- **AI-assisted wizard mode (M53, D20):** an optional adaptive mode
  (`src/lib/wizardAssist.ts`) that turns a small structured intent (device role /
  use-case / region) into a **catalogue-valid** suggestion built entirely from the
  real ELRS target catalogue, applied through the EXISTING wizard setters +
  `goToStep("review")`. It **never flashes** and **never skips review**; when AI
  is disabled/offline/out-of-credits it degrades to the static wizard with no
  dead-end.
- **Suggestion validation + review hardening (M54):** a schema-derived, **closed
  deny-by-default** validator (`src/lib/aiSuggestionSchema.ts` ↔ Rust
  `suggestable_rule` / `validate_suggestion`, both driven by
  `data/elrs_options_schema.json`) that rejects unknown / blocked safety-critical
  / sensitive / malformed suggestions **before** app state, maps only validated
  suggestions into a `ProfileSettings` patch for the diff screen, and can never
  write a blocked field (RF power, failsafe/arming, binding secret) even via a
  crafted payload. A Rust drift guard (`suggestable_rules_match_schema`) pins the
  rules to the schema.
- **v2.4 evaluation / safety / privacy / offline launch-gate audits (M55):** five
  pure-logic audit suites under `tests/unit/` plus Rust counterparts:
  - `v24RetrievalEval.test.ts` — re-audits the golden eval (widened with edge-case
    in-corpus paraphrases + clearly-out-of-corpus questions) over the app's
    bundled index against the **frozen D19 threshold + pass-bar**: 20/20 in-corpus
    top-source accuracy (≥ 0.90) and 12/12 out-of-corpus no-source rate (= 1.0);
  - `v24PromptInjection.test.ts` (+ Rust `m55_injection_matrix_stays_inside_the_fences`
    / `m55_injection_cannot_widen_the_suggestion_allowlist`) — an injection MATRIX
    (instruction override, fake fence tags, trust-escalation / safety-widening
    claims, script markup, control chars, oversized) injected into retrieved docs,
    imported docs, device strings/`user_defines`, and log text: none escapes the
    fence, escalates trust, or widens the allowlist;
  - `v24WizardSafety.test.ts` — the AI wizard always lands on `review` and never
    calls `startFlash`, a crafted suggestion can't write a blocked field, and the
    static wizard stays reachable/functional;
  - `v24PrivacyAudit.test.ts` (+ Rust `m55_rag_payload_carries_zero_identifiers`) —
    the v2.3 `assertZeroIdentifiers` harness on the assembled RAG payload laced
    with binding phrase + MAC / IPv4 / IPv6 / email / GPS: **zero identifiers
    survive**;
  - `v24OfflineRegression.test.ts` — static wizard + local RAG + imported-doc
    import/retrieve/delete + BYOK reachability all work offline and account-free;
    Managed OFF is unavailable without disturbing the free core; Managed mock ON
    has estimate == burn and a graceful out-of-credit fallback.

### Changed

- **Version bumped to `2.4.0`** across `package.json`,
  `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (was `2.3.0`).
- **In-app announcement feed** seeds a **v2.4.0 release notice**
  (`announcements.seed.releaseV24.*`, en + es) as the newest feed item, so the
  release is surfaced alongside this CHANGELOG (project policy §5 — every patch
  release updates the changelog AND the in-app feed). New strings are at full
  en/es parity (M27 gate).

### Honest scope (BYOK real / Managed mock / local-only / no external server)

- **Managed AI is a LOCAL mock**, OFF by default behind `featureFlags.managedAi`.
  The Rust `ManagedAdapter` + `mock_managed_proxy` and the TS `managedAi.ts` are
  the request/parse **parity seam** a real v2.1 Managed proxy (M31/M33) slots
  behind unchanged — but **no external Managed server, account, JWT, or credit
  ledger exists in this repo**. BYOK (Anthropic / OpenAI-compatible) and the local
  RAG core are real and account-free.
- **Retrieval is local (D15).** The BM25 index is built from bundled packs at
  first use (memoized) and matches the committed offline artifact; there is **no
  live cloud retrieval**. Imported docs are **local only** (no cloud doc sync).
- **Signed release: PREPARED, publish DEFERRED.** The signed `2.4.0` desktop
  artifacts would be produced by the existing pipeline, but **publishing is
  deferred to a tagged run with signing secrets** (M29 precedent). The release
  pipeline (`.github/workflows/release.yml`) and the in-app updater
  (`src-tauri/tauri.conf.json` endpoints / minisign `pubkey` /
  `createUpdaterArtifacts`) were left **UNCHANGED**; no tag is pushed and no
  secrets are present, so no signed Release is published in this slice.

### Release feed

- This CHANGELOG entry plus the new in-app `announcements.seed.releaseV24` item
  are the canonical v2.4.0 release announcement (project policy §5).

## [2.3.0] — 2026-06-30

v2.3.0 "Cloud, Pro, and Community" ships the whole v2.3 line (M42–M48) as a
**MOCK / LOCAL SLICE** — opt-in cloud profile sync, conflict/restore UX, a
Pro/subscription entitlement model + mock billing, community preset upload with
moderation, and respectful sponsor/partner cards. **Honest scope (M29
precedent):** there is **no real backend server, no real payments, and no real
cloud** in this slice. The "cloud" is an in-app, account-partitioned blob store
(`src/stores/cloudMock.ts`); "billing" is a pure LemonSqueezy-shaped reducer
with obviously-stub `omnilink.test` URLs (`src/lib/billing.ts`); the
`free/supporter/pro` entitlement enum mocks the v2.1 **M32** seam. The line is
deliberately additive and **paid CONVENIENCE, never paid core**: local flashing,
profiles, and telemetry stay free, offline, and account-free.

The whole line normally hard-depends on the **v2.1 platform line (M30 identity /
M32 ledger + entitlement enum)**, which **is NOT present** — so every surface
here runs on **local mock seams** standing in for that backend. The **parity
seam for the eventual backend is the Rust + TS redaction gate**:
`sanitize_sync_profile()` in `src-tauri/src/commands/ai.rs` and its mirror
`src/lib/syncSanitize.ts` (the same `lib/aiContext.ts` ↔ `sanitize_context()`
precedent) — a profile is run through it before anything is "uploaded", so the
**central privacy guarantee** holds: **zero identifiers in any stored payload**
(no binding phrase, UID/modelId, GPS, MAC/serial, IP, or email). M48 is the
hardening/release gate; it adds the audit suites that prove the guarantee and
the line's safety properties, bumps the version, and prepares — but does NOT
publish — the signed release.

### Added

- **Cloud profile sync foundation (M42):** an opt-in, default-OFF sync of
  `.elrsp` profiles. `src/lib/cloudSync.ts` builds a sanitized, checksummed
  upload payload (schema version + target metadata + deterministic FNV-1a
  checksum), enforces the **tiered storage caps (D11): free 10 / supporter 100 /
  pro unlimited**, and runs one-way backup/restore against a generic blob seam.
  Over-cap uploads are a typed `quota-exceeded` **refusal, never a silent drop**.
  The mock cloud (`src/stores/cloudMock.ts`) is a persisted, account-partitioned
  `put/get/list/delete` blob store (the M42-class storage M46 reuses); the opt-in
  toggle + orchestration live in `src/stores/sync.ts`.
- **Conflict handling + restore UX (M43):** `src/lib/syncConflict.ts` classifies
  a local/cloud pair (in-sync / local-newer / cloud-newer / diverged /
  schema-mismatch / local-only / cloud-only) and resolves only on an **explicit**
  user choice (keep local / keep cloud / duplicate both / merge safe fields) — a
  newer/diverged cloud copy is **never overwritten silently**, and the local
  binding secret is never wiped (the cloud never held it — D10). A restore
  **dry-run preview** classifies each profile (new / overwrite / conflict /
  identical) without mutating local; `confirmRestore` applies only the safe
  entries. The typed sync error taxonomy (`src/lib/syncErrors.ts`) maps offline /
  auth-expired / quota / schema-mismatch / not-signed-in / sync-disabled to a
  localized message + recovery affordance — **no path loses local data**.
- **Pro / subscription entitlement model (M44):** `src/lib/entitlement.ts` is the
  single source of truth for the reserved `free/supporter/pro` enum, the per-tier
  feature flags (storage cap, version history, Managed-AI allowance), and the
  effective-tier resolver. **Pro and one-time, NON-expiring credits coexist
  (D7)** — credits ride independently of the subscription and are untouched by an
  expiry; an **expired/canceled Pro account falls back to free-tier caps with NO
  data loss and NO local lockout**. The account/entitlement store
  (`src/stores/account.ts`) is itself the **offline entitlement cache**.
- **Subscription UX + mock billing (M45):** `src/lib/billing.ts` is a pure,
  LemonSqueezy-shaped webhook reducer with **exactly-once idempotency** (a
  replayed event id is a no-op), plan-comparison data that is **i18n-keys-only**
  (`src/lib/plans.ts`), and conservative, in-context upgrade prompts
  (`src/lib/upgradeContext.ts`) that **never nag the free local core**. The
  billing store (`src/stores/billing.ts`) reflects events onto the account store
  via its existing actions; checkout/portal are obviously-stub external links.
- **Community preset upload + moderation (M46):** `src/lib/presetValidation.ts`
  is the **automated gate (D12)** — a submission must be a well-formed `.elrsp`
  (reusing `parseElrsp`) AND firmware-compatible with a supported line (reusing
  `firmwareCompat`); `src/lib/presetSubmission.ts` owns the moderation state
  machine (draft → submitted → approved/rejected → archived) where **a failing
  preset can never reach `approved`** and approval requires the trusted-reviewer
  capability. Submissions are stored as **sanitized blobs** in the M42-class blob
  store under a public namespace (`src/stores/presetLibrary.ts`); **only approved
  presets are publicly browsable**, and import reuses the **existing
  diff/review/apply flow** (no new apply path). Curated metadata only (D13).
- **Sponsor / partner announcement cards (M47):** a sponsor card `kind` added to
  the announcement feed (`src/lib/announcements.ts`) — clearly labeled, **no
  tracking by default** (the click effect type has nowhere to put a beacon), and
  gated by a **default-deny placement allowlist** (`src/lib/announcementPlacement.ts`)
  so sponsor cards **never render on flashing/recovery/error/safety surfaces**. A
  **hide-sponsors setting available to ALL users (D14)** lives on the
  announcements store — not Pro-gated.
- **v2.3 privacy / sync / billing / preset / offline hardening audits (M48):**
  five pure-logic audit suites under `tests/unit/` (42 tests):
  - `v23PrivacyAudit.test.ts` — seeds a profile / preset / billing record /
    sponsor card laced with a binding phrase + injected MAC / IPv4 / IPv6 / email
    / GPS and asserts **zero identifiers survive** into the stored blob (literal,
    identifier-shape, and forbidden-key scans);
  - `v23SyncDrills.test.ts` — **no silent-overwrite path**, a full
    backup → wipe-local → restore round-trip, **cap-exceeded drops no profile**,
    and an aborted/offline sync leaves local intact;
  - `v23EntitlementAudit.test.ts` — caps/features per tier, **Pro + credits
    coexist**, expired/canceled Pro → free caps with no loss/lockout, and
    **webhook idempotency**;
  - `v23PresetSafety.test.ts` — a schema/fw-failing preset **cannot reach
    approved**, browse is approved-only, the state machine rejects illegal/
    non-reviewer transitions, and the submitted blob is sanitized;
  - `v23OfflineRegression.test.ts` — signed-out + offline, free local
    save/apply still work and the free core is unblocked across the full
    entitlement/connectivity matrix; sync is cleanly unavailable; entitlement
    reads from the offline cache; and the **sponsor placement + hide-by-all**
    restriction audit.

### Changed

- **Version bumped to `2.3.0`** across `package.json`,
  `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (was `2.2.0`). The
  Rust build is unaffected by the bump (no `src-tauri` logic changed in M48; the
  sync redaction gate `sanitize_sync_profile` was added in M42–M43).
- **In-app announcement feed** seeds a **v2.3.0 release notice**
  (`announcements.seed.releaseV23.*`, en + es) so the feed surfaces the release
  alongside this CHANGELOG (project policy §5 — every patch release updates the
  changelog AND the in-app feed). New strings are at full en/es parity (M27 gate).

### Honest scope (no real backend / no real payment / no real cloud)

- This is a **MOCK / LOCAL slice**. The "cloud" is `stores/cloudMock.ts`, billing
  is the pure `lib/billing.ts` reducer with `omnilink.test` stub URLs, and the
  entitlement enum mocks the v2.1 **M32** seam. The **v2.1 platform line (M30/M32)
  this line would normally depend on is NOT present**; these surfaces run on local
  mock seams, and the **Rust + TS redaction gate is the parity seam** the eventual
  backend slots behind.
- **Signed release: PREPARED, publish DEFERRED.** The signed `2.3.0` desktop
  artifacts are prepared by the existing pipeline, but **publishing is deferred to
  a tagged run with signing secrets** (M29-style honesty). The release pipeline
  (`.github/workflows/release.yml`, tag-triggered `on: push: tags: ['v*']` +
  `workflow_dispatch`) and the in-app updater (`src-tauri/tauri.conf.json`: real
  GitHub `endpoints`, real base64 minisign `pubkey`, `createUpdaterArtifacts:
  true`) were confirmed REAL and left **UNCHANGED**; no tag is pushed and no
  secrets are present, so no signed Release is published in this slice.

### Release feed

- This CHANGELOG entry plus the new in-app `announcements.seed.releaseV23` item
  are the canonical v2.3.0 release announcement (project policy §5). Unlike the
  v2.2 line, the v2.3 line **does** have a dedicated announcement feed (M47), so
  the release is surfaced both in the changelog and in-app.

## [2.2.0] — 2026-06-30

v2.2.0 "Controller Bridge Mode" ships M63–M67: OmniLink can now treat a
Betaflight/iNav **flight controller as a passthrough bridge** to reach an ELRS
receiver — better detection, guided passthrough diagnostics, read-only context,
and an exportable support report — **without ever becoming a flight-controller
configurator**. The controller is a bridge ENDPOINT, never a managed device:
**no settings editing, no FC firmware flashing, no board catalog, and no
"Controllers" app section** (`docs/Controller_Scope_Decision.md`). Every bridge
interaction is read-only by construction — the only write the line ever issues is
the in-scope `MSP_SET_PASSTHROUGH` transport command — and it is **fully local and
fully free**: no account, backend, AI, or payment is required. The work extends
the shipped `flash/msp.rs` MSP framing + `FakeFc` test double rather than building
MSP from scratch, and reuses the existing `sanitize_context()` redaction baseline
for anything that could leave the machine. M67 is the validation/boundary-audit +
release milestone; **on-device hardware acceptance with real Betaflight/iNav
controllers is DEFERRED** (no hardware attached) — consistent with the prior
[HW]-pending entries, the line is code-complete and mock/`FakeFc`-hardened.

### Added

- **Controller-bridge discovery + labeling (M63):** a read-only MSP handshake
  probe (`src-tauri/src/flash/bridge.rs`, `src-tauri/src/commands/bridge.rs`
  `probe_bridge`) that classifies a connected FC as a Betaflight/iNav **bridge
  candidate**, an **unsupported bridge** (any non-BTFL/INAV variant — never
  misclassified, D28), or **not a controller** (an ELRS RX speaking CRSF — the
  zero-false-positive outcome). Surfaced in the DeviceBar
  (`src/components/layout/DeviceBar.tsx`) as an UNMISTAKABLY distinct
  `CircuitBoard`/violet **"Flight Controller Bridge"** chip
  (`src/components/bridge/BridgeLabel.tsx`), separate from the ELRS TX/RX, WiFi and
  Backpack chips, with recovery copy for wrong-port / busy-port / wrong-baud /
  no-MSP-response. State lives in the non-persisted `src/stores/bridge.ts` ↔
  `commands/bridge.rs`; the pure labeling model is `src/lib/bridge.ts`.
- **Passthrough diagnostics + wiring checks (M64):** a guided check
  (`src/components/bridge/PassthroughCheck.tsx`, store `src/stores/passthrough.ts`
  ↔ `run_passthrough_check`) — controller handshake → UART passthrough → receiver
  response → CRSF response — that maps a failure to a SPECIFIC, actionable category
  (`PassthroughFailure`: controller-not-responding / passthrough-unavailable /
  RX-not-powered / RX-not-wired / CRSF-timeout) instead of a generic flash error.
  Includes a **manual baud override** (`BaudOverride.tsx`) wired to the existing
  baud-fallback loop (which still exhausts every candidate before declaring
  failure), **generic** RX↔FC wiring guidance (D29), and a bounded **diagnostic
  event log** (`PassthroughLog.tsx`).
- **Read-only controller context (M65):** a DISPLAY-ONLY surface
  (`src/components/bridge/BridgeContext.tsx` ↔ `fetch_bridge_context`) showing only
  FC family/firmware/API version + coarse serial-port metadata over read-only MSP
  GETs, with a "Not enough controller context" empty state. Optional inclusion in
  Omnia payloads passes through the existing `sanitize_context()` baseline
  (`src-tauri/src/commands/ai.rs` `sanitize_bridge`, `src/lib/aiContext.ts`) — only
  fw family/version + coarse port functions survive; identifiers are stripped.
- **Support-report export (M66):** a one-click, paste-friendly Markdown bridge
  failure report (`src/components/bridge/BridgeExport.tsx`,
  `src/lib/bridgeExport.ts`) — app version, OS, port, detected bridge, baud
  attempts, failure category, sanitized handshake summary — reusing the v2.0
  diagnostics "Copy Summary" shape and routing context through `sanitize_context()`
  so no binding phrase / UID / GPS / MAC / IP / email / serial leaks.
- **v2.2 validation + boundary audit (M67):** regression guards proving the free
  flashing core is undisturbed by the bridge work —
  `guard_aborts_before_the_backup_is_written` and
  `backpack_cross_type_guard_aborts_run_flash_before_upload`
  (`src-tauri/src/flash/engine.rs`) pin the direct-ELRS and WiFi/Backpack flash
  orchestration order + safety guards through `run_flash`; and
  `captured_failure_fixture_set_covers_every_passthrough_failure`
  (`src-tauri/src/flash/bridge.rs`) makes the `FakeFc` passthrough fixtures the
  canonical, exhaustive capture of every failure variant
  (`src-tauri/src/flash/msp.rs`). Full **en + es** parity across the `bridge.*`
  namespace (`src/locales/{en,es}/translation.json`, enforced by
  `translationStrings.test.ts`) and an accessible label on every bridge interactive
  element; a hardware-safety warning (`BridgeSafetyWarning.tsx`) renders BEFORE
  every energizing action (M63 probe, M64 passthrough).

### Changed

- **Version bumped to `2.2.0`** across `package.json`, `src-tauri/tauri.conf.json`,
  and `src-tauri/Cargo.toml` (was `2.0.0`).
- **`FakeFc` test double extended** (`src-tauri/src/flash/msp.rs`) with
  bridge-candidate, non-controller, read-only-context, and the five passthrough
  failure-category fixtures — the reusable substrate for the bridge classification,
  context, and passthrough-diagnostics tests (no real hardware required).
- **Release feed:** this CHANGELOG entry is the canonical v2.2 release announcement
  (project policy §5). OmniLink has no dedicated announcements data source — the
  in-app notification center (`src/stores/notifications.ts`) is a live
  telemetry-alert feed, not a release feed — so no announcements subsystem was
  fabricated for this line.

## [2.0.0] — 2026-06-29

v2.0.0 "Local link diagnostics" ships M36 + M37: a **deterministic, on-device
diagnostic engine** that reads a session's link telemetry and explains *why* the
link struggled — in plain language, with the evidence, and **without an account,
a cloud call, or an AI**. Everything runs locally over the existing
`ParsedLog` model; the engine is pure TypeScript and there are **no Rust
changes** (the release pipeline, updater config, and `src-tauri/` are untouched).
Same `(log, config)` always yields the same report — no `Date.now`, no
`Math.random`, no I/O, and `log.gps` is never read. The work splits cleanly:
**M36** is the engine + the labelled fixture corpus + the DL3 acceptance numbers;
**M37** is the UI that renders the engine's already-computed results and feeds them
into the v1.7.1 notification center.

### Added

- **Local deterministic diagnostic engine (`src/lib/diagnostics/`, M36):** five
  pure rules over the shared `ParsedLog` —
  - `lq-collapse` (link): a sharp link-quality fall through the floor, graded
    `critical` when it bottoms at/near zero;
  - `rssi-floor` (signal): the **primary** antenna (`rssi1`) pinned at/below the
    −100 dBm sensitivity floor (a weak diversity antenna is deliberately ignored);
  - `snr-noise` (signal): a sustained span of high rolling-stddev SNR;
  - `packet-instability` (stability): a sustained span of jittery packet-rate
    changes; and
  - `tx-power-saturation` (power): TX pinned at the top step while RSSI/LQ stay
    poor (no headroom left to push).
  Each finding carries a severity, a confidence, an inclusive evidence window, an
  i18n explanation key, and a `detail` bag of **non-identifying numbers only** —
  never a coordinate, UID, MAC, or IP (asserted in tests). `evaluateSession`
  concatenates the enabled rules, sorts critical→warning→info then by window, and
  pairs them with the health score in a `DiagnosticReport`.
- **DL1 signal-health score (`health-score.ts`):** a transparent, LQ-dominant 0–100
  composite (link quality + best-antenna RSSI margin + SNR + packet stability + TX
  headroom + RF-mode robustness) with a per-window track for the gauge trend.
- **DL2 labelled fixture corpus (`data/fixtures/diagnostics/`, 36 CSVs +
  `fixtures-manifest.json`):** canonical telemetry-session logs grouped by
  link-health class (12 healthy / 7 warning / 7 failsafe / 5 wiring / 5 antenna),
  every `lat`/`lon` blank and no identifiers anywhere, each with its expected
  findings (ruleId + severity + window).
- **DL3 acceptance results on the corpus** (intermediate default preset, recorded
  in `tests/unit/diagnostics/dl3-validation.test.ts`): **false-positive rate 0%**
  (0/12 healthy fixtures raise any warning-or-higher finding) and **recall 100%**
  (67/67 labelled expected findings reproduced within ±8 samples) — per-class
  warning 11/11, failsafe 18/18, wiring 21/21, antenna 17/17. All three sensitivity
  presets keep the healthy false-positive rate at zero. A large-log scan-budget
  smoke evaluated a synthetic 50k-sample session against an accidental O(n²)
  regression (since **superseded** by the formalized M41 scan budget — see the
  M41 launch-gate note under `[2.4.7]`).
- **Sensitivity presets (`config.ts`):** `beginner` / `intermediate` (default) /
  `advanced` trade recall against caution by re-tuning thresholds only — all three
  hold the healthy FP rate at zero.
- **Diagnostics store (`src/stores/diagnostics.ts`):** the single impure bridge —
  a thin Zustand layer that calls the pure engine (`evaluateSession`,
  `evaluateFrame`) and holds the loaded-session report, the rolling live-evaluator
  state, and the operator-tunable config. Only a minimal forward-compatible config
  slice (`{ sensitivity, enabledCategories }`) is persisted, so a future re-tune is
  never pinned to today's thresholds.
- **Diagnostics UI (`src/components/diagnostics/`, M37):** a **Signal Health gauge
  panel** (radial 0–100 gauge + per-window trend sparkline + the transparent
  LQ/RSSI/SNR/packet-rate/TX factor breakdown), a **findings list** with a
  severity filter, **click-to-scrub** finding cards (each seeks the one shared
  session cursor to its evidence window) and a **"Copy Diagnostic Summary"** action
  that writes an identifier-free plain-text report (health score + one line per
  finding, no GPS/ids), **timeline chart markers** (translucent evidence bands +
  clickable dots layered alongside the anomaly markers), and a **settings sheet**
  (preset picker, per-category switches, advanced threshold overrides). Mounted on
  the **Telemetry** page (compact live panel) and the **Session Analysis** page
  (full session report), and fed into the **notification center** on import. Full
  **en + es** i18n parity; **zero serious/critical** axe violations.

### Changed

- **Session Analysis re-analyzes on a sensitivity change:** the diagnostics
  settings sheet is mounted on `/analysis`, so changing the preset / categories /
  thresholds now re-runs the pure `analyzeSession` over the loaded session and the
  findings list + chart markers update live (previously the loaded report was fixed
  at import time, making the sheet a dead control there). Notifications are still
  recorded exactly once per loaded session, never per tweak.

### Tests

- **Explicit DL3 gate (`tests/unit/diagnostics/dl3-validation.test.ts`):** the
  self-documenting record of the false-positive rate and the per-class recall
  breakdown (the large-log scan-budget smoke it once carried was retired into the
  formalized M41 budget — see `[2.4.7]`).
- **E2E diagnostics suite (`tests/e2e/diagnostics.spec.ts`):** drives `/analysis`
  fully headlessly through the Tauri mock seam + the real CSV import — imports a
  failsafe fixture and asserts the health panel + a [0,100] score + critical
  findings + chart markers; a warning fixture yields warning-only findings; the
  Copy-Summary clipboard round-trip is readable and identifier-free; a sensitivity
  preset switch re-analyzes and changes the rendered finding count; and the
  populated panels + open settings sheet are axe-clean.
- **`notifications.spec.ts`** now reflects the M37 integration: importing the
  dropout session surfaces its critical `rssi-floor` finding in the center
  immediately (an import-time "Signal diagnostic" notification), and scrubbing into
  the dropout additionally fires the M26 live `signalLoss` alert — both persist,
  decrement the badge per item, and clear. Counts: unit 518 → 521, e2e 25 → 30,
  Rust unchanged.

## [1.7.3] — 2026-06-29

v1.7.3 "Flashing verification & discoverability" is a **confirm-first** slice. The
three flashing concerns a user raised — flashing from a local file, "real"
firmware updates, and whether firmware safety actually works — were all
**already implemented and tested in v1.6** (M25 + `github.rs` + `guard.rs` /
`validate.rs`). This slice **confirmed each is real by reading**, **surfaced them
better in the wizard**, and **closed genuine test gaps** — without rebuilding
anything real (`guard.rs` / `engine.rs` are byte-identical; `github.rs` /
`validate.rs` gained tests only). No new dependency; the release pipeline and
updater config are untouched. Independent adversarial verifier: **SHIP**; a
follow-up workflow-backed code review tightened seven copy/test-quality items.

### Added

- **Firmware-source provenance in the wizard (`StepFrequency.tsx`):** the live
  ExpressLRS release list now carries a "Live from ExpressLRS GitHub" indicator,
  and the offline state reads "couldn't reach ExpressLRS GitHub; showing bundled
  versions" — so the user can tell live GitHub data from the bundled fallback
  catalogue. A lead-in label now introduces the local-`.bin` flash option as a
  clear alternative. All strings via `t()` (en/es full parity).
- **Genuine-gap tests (non-duplicate):** `validate.rs` — a local TX image is
  blocked against a selected RX target even with **no device connected** (the
  selected-target class fallback); `github.rs` — a populated release cache is
  served by `fetch_releases` (the cache-serving path, previously untested); an
  e2e (`flash-discoverability.spec.ts`) pinning the live/offline provenance and
  the local-file option on the frequency step. Counts: Rust 157 → 159,
  e2e 23 → 25, unit 406 unchanged.

### Changed

- **Clearer localized guard rejection:** the cross-class flash-block messages
  (`txRxMismatch` / `targetMismatch` / `backpackCrossType`) now state the safety
  block and the TX-vs-RX (and TX-vs-VRX) reason. This reuses the single existing
  pre-flash guard (`guard.rs` → `engine.rs`, before any erase/write, already
  surfaced via `FlashError`); no second detector was added and no guard logic
  changed.

### Confirmed (by reading/test, not on hardware)

- The local-`.bin` flash (`validate.rs` → `engine.rs`), the live ExpressLRS
  release fetch with a 30-minute cache + offline fallback (`github.rs`,
  `commands/flash.rs`), and the pre-flash TX/RX guard (`guard.rs`, run as step 1
  of `engine.rs` before any erase/write) are **real**, not stubbed. On-device
  flash/guard acceptance with real hardware stays deferred to
  `docs/v1.6.4_HW_VALIDATION.md` §(b) (no ELRS hardware attached).

## [1.7.2] — 2026-06-28

v1.7.2 re-shapes the BYOK AI UX to its intended split (completes M23):
**Settings stores per-provider credentials only**, and the **chat** is where the
user picks an available provider and then a model — a choice that is now
**remembered across restarts**. The backend key storage and the `LlmAdapter`
seam are unchanged (v2.1's Managed adapter still slots into the same seam), and
every existing saved key survives a one-time migration. Still BYOK AI only — no
backend, no payments, no cloud sync. No new dependency; the release pipeline and
updater config are untouched. Independent adversarial verifier: **SHIP** (zero
functional defects).

### Added

- **Per-provider credentials + a remembered selection (`stores/assistant.ts`):**
  the multi-config model (`configs` / `configOrder` / `activeConfigId`) is
  replaced by per-provider `credentials` (`{ keyId?, baseUrl? }`) plus a
  persisted `selection` (`{ provider, model }`) and a runtime `keyed`
  availability map. New actions `setApiKey` / `clearApiKey` / `setSelection` /
  `refreshKeyedProviders`; the pure `activeSend` selector derives the send target
  (its `keyId` defaults to the provider slot — the unchanged LlmAdapter key seam),
  and `availableProviders` gates the chat picker.
- **Two-step provider→model chat picker (`components/ai/ChatControls.tsx`):**
  offers only providers that have a stored key (key-less Ollama always), then a
  model list fetched live from `aiListModels` with the static registry as the
  fallback; the pick persists and is restored on restart.
- **e2e:** assign a key in Settings (no model field there) → pick provider + model
  in chat → the selection survives a full reload.

### Changed

- **Settings = credentials only (`SettingsPage` BYOK card):** one credential row
  per provider — API-key entry, stored-key status, and an optional base URL for
  OpenAI-compatible providers. The model picker is removed (model selection lives
  in chat). Keys still persist backend-side via `ai_set_api_key`, read at request
  time and never returned to the UI.
- **Lossless, idempotent migration (`migrateByokState`):** folds BOTH legacy
  shapes — pre-v1.6.3 flat and v1.6.3 multi-config — into `{ credentials,
  selection }`, preserving each provider's non-default key-slot id so no stored
  key is orphaned, and deriving a sensible default selection (active config, else
  the first saved config). A blank Save never clears a stored key (only Remove
  does, which keeps a custom base-URL override). The send path probes the
  selected provider's key fresh, so a just-switched provider is never wrongly
  reported keyless. Store/migration unit tests prove key-preservation,
  idempotency, gating, and the blank-Save guard. Counts: unit 398 → 406,
  e2e 22 → 23, Rust 157 unchanged.
- **Post-merge code-review hardening:** a workflow-backed code review caught that
  the migration's idempotency guard keyed on `selection` (which the store
  initializer always seeds), so the one-time upgrade would have been skipped on a
  real rehydrate and orphaned non-default-slot keys; the guard now keys on the
  presence of legacy fields, with a regression test feeding the real merged
  shape. Also corrected: the chat provider `<select>` no longer diverges from the
  remembered selection, and the redundant `hasKey`/`refreshKeyStatus` pair was
  removed in favor of the single `keyed` probe.

### Removed

- The multi-config BYOK editor (named configs, in-Settings model picker, the
  config swap in chat). No i18n key was removed; `en`/`es` stay at full parity
  (some now-unused legacy keys are retained to keep the M27 parity gate green).

## [1.7.1] — 2026-06-28

v1.7.1 turns the dead header notification bell into a working **notification
center** fed by the v1.6 M26 live-alert layer, so alarms finally have a
persistent, browsable home with an unread indicator. It is ADDITIVE: it reuses
the single M26 evaluation path (`LiveAlertHost` → `evaluateFrame`) and adds NO
second detector — one fired alarm enqueues exactly one notification, inheriting
M26's hysteresis + debounce, and the existing "alarms muted" toggle suppresses
new entries. The queue is bounded so it can never grow without limit. Still
BYOK AI only — no backend, no payments, no cloud sync. No new dependency; the
release pipeline and updater config are untouched. Independent adversarial
verifier: **SHIP** (zero defects).

### Added

- **Notifications store (`stores/notifications.ts`):** a persisted, BOUNDED
  Zustand queue (`{ id, type, severity, ts, read, body, params }`) capped at
  `NOTIFICATION_CAP = 100` (oldest evicted on overflow), with `enqueue`
  (dedups by id), `markRead`, `markAllRead`, `clear`, and a derived
  `selectUnreadCount`. Only `items` is persisted (the open/close state is
  runtime-only), matching the house `zustand/persist` convention
  (`omnilink-notifications`).
- **Notification bell + center (`components/notifications/NotificationBell.tsx`):**
  the `DeviceBar` placeholder becomes a live bell with an unread badge and a
  focus-trapped dropdown listing notifications newest-first — per-item
  mark-read, a mark-all-read and a clear-all control, and an empty state.
  Keyboard-operable (reuses `useFocusTrap`; Escape + click-outside close; focus
  restores to the bell), an `aria-live` region announces new arrivals even
  while the panel is closed, the list is a `role="log"` region, and the entry
  animation respects `prefers-reduced-motion`.
- **Pure + e2e tests:** store unit tests (dedup, cap eviction, unread math,
  mark-read/clear) and a feed wiring test that runs the REAL `evaluateFrames`
  over a sustained-dropout fixture; an e2e that scrubs that fixture through
  Session Analysis so a live alert fires, raises the badge, **persists across
  recovery** (the transient toast clears, the notification stays), lists in the
  panel, decrements on mark-read, and empties on clear-all — axe-clean while
  open. New `notifications.*` i18n keys in both `en` and `es`.

### Changed

- **Alerts gain a persistent home from the SAME evaluation:** `LiveAlertHost`
  now calls `recordFiredAlerts(firedAlerts, muted)` (`lib/notificationFeed.ts`)
  alongside its existing `osNotify`, inside the one telemetry subscription — no
  second detector, mute honoured, and the non-Tauri host degrades silently (the
  store is pure JS). Per-notification copy reuses the existing `alerts.type.*` /
  `alerts.message.*` keys, so it stays translatable rather than frozen at
  enqueue time.
- **Test-suite genuineness pass (e2e):** an adversarial audit of the e2e suite
  strengthened four specs that passed for the wrong reasons — the offline
  "simulator replays" spec now asserts the transport actually engaged, and the
  offline + wifi "graceful empty" specs and two a11y scans now anchor a positive
  surface marker — so each pins the behavior it names. Counts: unit 384 → 398,
  e2e 21 → 22, Rust 157 unchanged.

### Removed

- Nothing. No i18n key was removed; `en`/`es` stay at full parity.

## [1.7.0] — 2026-06-28

v1.7.0 opens the v1.7 line ("consolidate & finish the seams") by merging the
two overlapping analysis surfaces — the time-driven replay **Simulator** and
the position-driven forensic **Logs** page — into one **Session Analysis**
page. It is a CONSOLIDATION, not a rewrite: every capability of both pages is
preserved; what is removed is only the duplicated import + parse + store
plumbing (three stores → two, two parse flows → one, two sidebar entries →
one). The page is driven by a single loaded session and a single shared
position index that can be **scrubbed** (forensic, the former Logs behavior)
**or played forward at a selectable speed** (replay, the former Simulator
behavior); the timeline charts, flight-path map, and anomaly list all follow
that one index in both modes. Still BYOK AI only — no backend, no payments, no
cloud sync. No new dependency; the release pipeline and updater config are
untouched. Independent adversarial verifier: **SHIP**.

### Added

- **Unified Session Analysis page (1.7.0):** one `SessionAnalysisPage` mounted
  at `/analysis` replaces `SimulatorPage` + `LogsPage`. A single
  `SessionTransport` bar merges the former replay transport (play/pause, stop,
  0.5/1/2/4× speed) and the Logs scrubber (scrub slider + mark-range) into one
  control over the single position index.
- **One source-of-truth store (`stores/session.ts`):** `useSessionStore` holds
  the one `ParsedLog`, the shared `positionIndex`, `mode` (`scrub`|`play`) +
  `speed`, the detected `anomalies`, and the analysis selection. Replay is
  literally "animate `positionIndex` forward" at `speed`; scrub is the user
  dragging the same index. It folds the former `useLogsStore` and absorbs the
  wall-clock replay driver from `useSimulatorStore`.
- **Capability unlocked in replay:** anomaly markers and the "analyze selected
  range" AI action — previously Logs-only — now work during replay too, because
  both modes read the one index.
- **Old-route redirects:** `/logs` and `/simulator` redirect (`replace`) to
  `/analysis` so existing deep links do not 404.
- **State-machine + round-trip tests:** pure coverage for the single position
  index (scrub↔play transitions, bounds, seek, speed ordering, selection,
  anomaly-seek, frame-derivation parity, and the page-unmount `suspend` that
  keeps the simulated feed while stopping the replay timer). New
  `sessionAnalysis.*` + `nav.analysis` i18n keys in both `en` and `es`.

### Changed

- **One import on-ramp, one parse:** `ImportDropzone` (CSV/`.bbl`) and
  `SessionPicker` (a prior SQLite session) converge on a single
  `loadLog(ParsedLog)`. The dashboard's replay frames are now DERIVED on demand
  from that one `ParsedLog` (`lib/replay.ts` `telemetryFrameFromLog`) instead
  of a parallel `TelemetrySessionCsvRow[]` / `TelemetryFrame[]` buffer, so a
  CSV import and a clicked session are indistinguishable downstream.
- **Shared-dashboard ownership preserved from the Simulator model:** loading a
  session feeds the shared `useTelemetryStore` and sets the persistent
  SIMULATED badge; the live stream stays suppressed (FR-SIM-02: the badge never
  sits over live data) until **Stop** / **Load another** clears the session.
  The loaded session survives a client-side route change to the live
  `/telemetry` dashboard (proven by the migrated `map`/`offline` e2e specs).
- **Specs migrated, none dropped:** the simulator unit suite became
  `tests/unit/session.test.ts`; the `simulator`/`logs`/`a11y`/`map`/`offline`
  e2e specs were repointed to `/analysis` (a new redirect test was added).
  Counts: unit 376 → 384, e2e 20 → 21, Rust 157 unchanged.
- **Honest milestone progress:** the `claude.md` Milestone Status section
  records v1.7.0 as agentic-scope-complete and SHIP-verified, and the sibling
  `../docs/v1.7_MILESTONES.md` §v1.7.0 **Progress** line is updated.

### Removed

- **Duplicated plumbing:** `SimulatorPage`, `LogsPage`, `SimulatorSource`,
  `TransportControls`, `LogScrubber`, the `useSimulatorStore`
  (`stores/simulator.ts`) and `useLogsStore` (`stores/logs.ts`) stores, and the
  redundant simulator unit spec — all retired in favor of the merged surface.
  No i18n key was removed; `en`/`es` stay at full parity.

[1.7.3]: https://github.com/AbdulrahmanHR/OmniLink/releases/tag/v1.7.3

[1.7.2]: https://github.com/AbdulrahmanHR/OmniLink/releases/tag/v1.7.2

[1.7.1]: https://github.com/AbdulrahmanHR/OmniLink/releases/tag/v1.7.1

[1.7.0]: https://github.com/AbdulrahmanHR/OmniLink/releases/tag/v1.7.0

## [1.6.4] — 2026-06-25

v1.6.4 (M29 — hardware validation & v1.6 hardening, `[HW]`) closes the v1.6
line. It ships no new product feature: it hardens the v1.5/v1.6 `[HW]`-adjacent
code paths with non-tautological mock/pure tests and adds a reproducible
on-device acceptance checklist. This release is honest about hardware — **none
of the `[HW]` acceptances have been executed on a device** (no ExpressLRS
TX/RX, GPS module or Backpack was available). Each path stays code-complete and
mock-hardened with hardware-acceptance **pending, not accepted**; the on-device
runs and the published signed Release are deferred (the tag is not pushed). The
already-real release pipeline (`release.yml`, tag-triggered) and in-app updater
were confirmed and left unchanged. Still BYOK AI only — no backend, no
payments, no cloud sync. No new dependency.

### Added

- **Hardening tests for the `[HW]`-adjacent paths (M29):** +8 frontend and +13
  Rust pure/mockable tests that pin real behavior at the edges (each exercises
  the actual module, not a re-implementation, and fails on regression). GPS:
  full ±lat/±lon coordinate range and the wire-`0` → `−1000 m` altitude-bias
  decode, plus device-side `stats_payload` verbatim forwarding and a GPS frame
  held across a read tick and attached to a later link-stats frame via the real
  CRSF `Parser`. Flash: MSP resync past leading noise / partial-buffer / ack-
  after-noise, options-region exact-fit and one-byte-over (no-mutation)
  boundaries, local-`.bin` longest-run and interrupted-header target inference,
  a failed upload still leaving the recovery backup, and a WiFi-OTA flash with
  no connected-device context correctly allowing an RX target. WiFi: malformed-
  probe-JSON falling back to the body ELRS marker, mDNS instance-name collision
  / duplicate dedup / multi-IPv4 preference, and whole-word TX/RX role matching
  that rejects `TXT`/`RXD`/`TX1` noise. CSV/session: GPS `0,0` (acquiring)
  vs empty-cell vs null coercion, CRLF/LF tolerance, and 13-digit ms +
  fractional-value precision round-trips.
- **On-hardware validation checklist (M29):** `docs/v1.6.4_HW_VALIDATION.md`, a
  reproducible manual acceptance script a human runs with real gear — one
  section per `[HW]` acceptance (GPS readout + live map track M11/M13; firmware
  flash incl. Backpack M8/M19; WiFi/Backpack discovery + probe M18/M19;
  record → session browse → CSV export round-trip M11) — each with exact
  preconditions, numbered steps, expected result, a PASS/FAIL/blocked box, and
  `file:line` cross-references to the code under test and its HARDWARE-PENDING
  markers. This is the artifact that lets the deferred on-device scope be
  executed later without re-deriving it.

### Changed

- **Honest milestone progress (M29):** the `claude.md` Milestone Status section
  records M29 as agentic-scope-complete with on-hardware acceptance + published
  Release explicitly deferred, and annotates the affected `[HW]` rows
  (telemetry-sessions/CSV, firmware flashing, flight-path map, WiFi discovery,
  Backpack) as "M29 mock-hardened; on-device acceptance:
  `docs/v1.6.4_HW_VALIDATION.md`" — nothing is marked accepted/passed on
  hardware. A note records that the referenced `docs/*_MILESTONES.md` paths are
  absent on disk and that this section is the authoritative tracker.

[1.6.4]: https://github.com/AbdulrahmanHR/OmniLink/releases/tag/v1.6.4

## [1.6.3] — 2026-06-24

v1.6.3 makes OmniLink speak a second language and clears an accessibility bar,
on the v1.6.0 distribution base. Still BYOK AI only — no backend, no payments,
no cloud sync.

### Added

- **Internationalization — Spanish locale (M27):** a complete second language
  (`es`) end-to-end, proving the i18n infrastructure and locking in the
  zero-hardcoded-strings policy. A new persisted language store
  (`omnilink-language`) and a Settings selector switch the entire UI instantly
  and remember the choice across reloads; the active language is initialized
  from the store (no hardcoded `lng`), and `i18n.language` propagates to the
  `Intl` date/number formatters. The translation regression test became a
  data-driven, non-tautological key-parity gate that asserts exact leaf-key set
  equality, no empty values, and matching `{{placeholder}}` sets across every
  locale — so a key added to `en` but not `es` (or vice-versa) fails the build.
- **Accessibility pass (M28):** a focused a11y audit + fixes taking the main
  routes from pre-existing serious/critical axe violations to clean. A dep-free
  focus trap gives the custom Dialog/Sheet `role="dialog"` + `aria-modal`, an
  accessible name, focus trapping, and focus restore on close; a skip-to-content
  link and named landmarks aid keyboard navigation; the PolarPlot SVG, the map,
  and icon-only controls get meaningful roles/labels via `t()`; and theme tokens
  were tuned to meet WCAG AA contrast across dark/light/carbon. A new Playwright
  spec (`tests/e2e/a11y.spec.ts`) runs axe over connect/telemetry, the flash
  wizard, profiles (incl. an open modal and the AI config editor), logs import +
  session browse, and settings, asserting no serious/critical violations.

### Changed

- **Multiple AI API configurations:** the BYOK section, previously a single
  confusing slot that allowed only one config per provider, is now a proper
  collection of named configurations with add/edit/delete, an active picker, and
  a **per-config API key** (so two configs of the same provider can hold
  different keys). An old single-config install migrates losslessly — one config
  per provider with `id === provider`, so existing keys keep resolving — and no
  stored key value is ever rendered. ChatControls became an active-config picker.

### Fixed

- **Offline regional map packs now download.** The bundled manifest pointed the
  regional packs at a non-existent host, so every download failed at the HTTP
  GET and nothing persisted. v1.6 ships no tile CDN, so the regional packs are
  now sourced from small bundled placeholder `.ompack` files via a `bundled:`
  scheme that reuses the exact streaming pipeline (progress, cancel, `OMPACK01`
  magic validation, atomic rename, error classification); a downloaded pack is
  served over `omnitiles://` like the base map.
- **Live alerts master-mute toggle no longer reads inverted.** The toggle bound
  its "on" visual to the `muted` flag, so the active state rendered as outline +
  X (reading as off) and the muted state looked on. It now reads on = Active /
  off = Muted, with the aria state aligned to the visual.

[1.6.3]: https://github.com/AbdulrahmanHR/OmniLink/releases/tag/v1.6.3

## [1.6.2] — 2026-06-24

v1.6.2 hardens flashing and makes the live link self-watching, on the v1.6.0
distribution base. Still BYOK AI only — no backend, no payments, no cloud sync.

### Added

- **Local firmware file flashing & pre-flash safety validation (M25):** pick a
  local firmware `.bin` through the flashing wizard (via the native
  `@tauri-apps/plugin-dialog` file dialog) and flash it, with a clear "local
  file" badge carried through review and flash. A pure, unit-tested Rust
  validator (`flash/validate.rs`) inspects the binary (header / size /
  integrity) and verifies it matches the connected target — TX-vs-RX class and
  target-name alignment — and rejects a mismatched or corrupt file with a
  structured, localized safety error (`summaryKey` `targetMismatch`, etc.).
  Validation runs and returns **before** any erase/write, so a wrong file can
  never reach the device (proven by the
  `local_file_mismatch_aborts_before_any_upload` test). A best-effort
  config-profile backup is taken before a local-file flash so the user can
  recover, surfacing a warning if it could not be captured.
- **Live telemetry alerts & thresholds (M26):** configurable live alarms over
  the telemetry stream (low RSSI, LQ collapse, link loss, optional GPS
  distance), building on the M15 anomaly engine. A pure, unit-tested evaluator
  (`lib/liveAlerts.ts`) reuses the M15 anomaly primitives and adds hysteresis
  (distinct trip vs clear thresholds) plus debounce (N consecutive frames), so a
  value hovering at a threshold raises **exactly one** alarm, clears on
  sustained recovery, and never fires on a healthy link. A persisted thresholds
  store with per-alarm enable/tune and an "alarms muted" toggle is configured
  from a Settings card; an in-app toast (respecting `prefers-reduced-motion` and
  mute) is the reliable channel, with a best-effort zero-dependency OS
  notification on top — mute suppresses both. No heavyweight dependency added.

[1.6.2]: https://github.com/AbdulrahmanHR/OmniLink/releases/tag/v1.6.2

## [1.6.1] — 2026-06-24

v1.6.1 sharpens the in-app experience on the v1.6.0 distribution base: a
transparent Omnia chat command center and full management of recorded telemetry
sessions. Still BYOK AI only — no backend, no payments, no cloud sync.

### Added

- **Omnia chatbox refactor & command center (M23):** inline provider/model
  selectors and an explicit device/target context picker
  (`auto` / `device` / `wizard` / `offline`) directly in the chat panel; a
  power-user composer with slash commands (`/explain`, `/troubleshoot`,
  `/telemetry`), file/log attachments, a generating-state indicator and a
  prominent Stop control; category-grouped empty-state goal chips, copy buttons
  on fenced code blocks, and a per-message context citation card. The privacy
  payload preview and the send path route through one `selectAiContext()`, so
  the preview can never diverge from what is actually sent (`offline` sends no
  device/telemetry/wizard data).
- **Session management — delete / rename / retention (M24):** recorded
  telemetry sessions can be renamed (new nullable `name` column, schema
  migration v4) and deleted in-app — the parent row and all of its frames are
  removed transactionally. A configurable retention policy (keep newest N /
  prune older than D days) bounds `omnilink.db` growth, with a Settings card and
  a per-list session storage summary. All seams stay best-effort and degrade
  silently outside Tauri.

[1.6.1]: https://github.com/AbdulrahmanHR/OmniLink/releases/tag/v1.6.1

## [1.6.0] — 2026-06-24

v1.6.0 opens the **ship & sustain** line: turning the feature-complete v1.5 app
into something distributable and self-updating. Still BYOK AI only — no backend,
no payments, no cloud sync.

### Added

- **Cross-platform signed release pipeline (M21):** a tag-triggered
  `.github/workflows/release.yml` builds Windows (`.msi`/`.exe`), macOS
  (universal `.dmg`) and Linux (`.deb`/`.AppImage`) installers plus updater
  artifacts (`latest.json` + `.sig`) and uploads them to a single GitHub Release
  per `vX.Y.Z` tag (two-phase: create the draft release, then the platform
  matrix uploads to it). A version guard aborts the release unless the tag
  matches the app version, so assets are always named for the exact version;
  stale bundles are purged so no older-version installer can leak. Code signing
  (macOS Developer-ID + notarization, Windows Authenticode) is secrets-gated and
  optional — builds still succeed unsigned when secrets are absent.
- **In-app auto-update channel (M22):** Settings → App Update checks the signed
  GitHub Releases `latest.json` feed, downloads + verifies a newer release, and
  relaunches into it. The flow is centralized in a pure, testable controller
  (`src/lib/updater.ts`) and exposes a distinct "auto-update unavailable in this
  build" state for dev/unsigned hosts, kept separate from genuine errors.

### Changed

- CI and the installer build workflows now target the main branches
  (`main`, `v1.6`); stale `V1.5`/`V1` triggers were dropped.

[1.6.0]: https://github.com/AbdulrahmanHR/OmniLink/releases/tag/v1.6.0
