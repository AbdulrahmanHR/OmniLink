# Releasing OmniLink

This is the maintainer runbook for cutting a real, signed, downloadable OmniLink
release. **`3.0.2` is the first release published from this repository** — the work
that earlier version numbers refer to predates publication and is described in
`CHANGELOG.md` rather than stored here.

The procedure below is not theoretical. It was executed end to end during that
earlier development: this same tag-triggered pipeline built and uploaded Windows,
macOS and Linux installers plus a minisign-signed `latest.json`, and the in-app
updater resolved against it. The signing secrets are in place and the pipeline has
run green. Cutting and pushing tags is still a per-release maintainer action, and
this document is the exact procedure.

---

## What already exists (verified)

- **`.github/workflows/release.yml`** — a tag-triggered (`push` of `v*`) +
  manual (`workflow_dispatch`) pipeline that builds Windows/macOS/Linux
  installers + updater artifacts and uploads them to a **draft** GitHub Release.
- **The in-app updater is fully wired** (`src-tauri/tauri.conf.json` →
  `plugins.updater`):
  - endpoint: `https://github.com/AbdulrahmanHR/OmniLink/releases/latest/download/latest.json`
  - a real minisign **public key** is already committed (`pubkey`, fingerprint
    `B97BAECF776B41BF` — decode the `pubkey` value to read it back; the earlier
    `1F941C509DAAD29A` was rotated out at `2ced4d1`, before publication, and is
    current only for releases up to `2.5.0`).
- **A version-guard** (`release.yml` job `create-release`): the pushed tag
  `vX.Y.Z` must EXACTLY equal both `package.json.version` and
  `tauri.conf.json.version` **at the tagged commit**, or the run fails fast. This
  is why you can't tag an arbitrary commit — the commit's files must already
  declare that version.

## Prerequisites

1. **The two required repo secrets must be present** (the build FAILS without them,
   because `createUpdaterArtifacts: true` forces updater signing):
   - `TAURI_SIGNING_PRIVATE_KEY` — the minisign **private** key
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password

   Both are configured on this repository. They are the only *required* secrets;
   the OS code-signing secrets are optional and currently absent (see Step 1).
2. **The commit you tag must already declare the target version.** That is the
   version-guard above, and it is a property of the commit, not of the tag — so
   the version bump and the tag are two halves of one operation (Step 2, then
   Step 3).

---

## Step 0 — Signing key (one-time)

The signing secrets are already in the repo and match the committed `pubkey`
(`B97BAECF776B41BF`) — **for a normal release you skip this whole step**. You
only revisit it to rotate the key.

**A. Keep the existing key** (normal case): nothing to do — the secrets already
match the committed `pubkey`, so every client installed from a release signed with
it keeps verifying updates.

**B. Rotate to a fresh key** — regenerate the pair. ⚠️ **Not consequence-free:**
**any already-installed client will reject an update signed by a new key** — each
client's updater verifies against the `pubkey` baked into its own build. Rotate
only if the current private key is lost or compromised, and expect those users to
need a manual reinstall of the first release cut under the new key:

```bash
# from projectomni/
npm run tauri signer generate -- -w ~/.omnilink/omnilink.key
#   → prints the PUBLIC key and writes the PRIVATE key to the -w path
```

Then:
- Put the printed **public** key into `src-tauri/tauri.conf.json` →
  `plugins.updater.pubkey` (replacing the current value), and commit that change
  as part of the release commit (Step 2).
- Use the private key file's contents + the password you chose as the two secrets
  (Step 1).

## Step 1 — Add the repo secrets

GitHub → repo **Settings → Secrets and variables → Actions → New repository
secret**:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of the minisign private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the private key's password |

(Optional, for OS code-signing — absent ⇒ installers still build but are
unsigned / show SmartScreen/Gatekeeper warnings; see the header of
`release.yml`: `APPLE_*` for macOS notarization, and the Windows Authenticode
note.)

---

## Which versions can actually be tagged

**Only a version some commit in this repository actually declares.** The guard
compares the pushed tag against `package.json.version` **and**
`tauri.conf.json.version` at the tagged commit; if either differs the run fails
fast, by design, rather than building the wrong thing. There are no earlier
releases in this repository to back-tag — its published history starts at
`3.0.2` — so in practice every tag is cut on the version-declaring commit you
have just made in Step 2.

Do not try to force a tag past the guard. Bump the version, commit, then tag.

---

## Cutting a release

The goal is a version-declaring commit whose tag the guard will accept, which also
gives the updater a fresh `latest.json`. Substitute the new version number
throughout.

### Step 2 — Commit the version-declaring batch

Bump the version in **all five** files — `package.json`, `package-lock.json`
(two places: the top-level `"version"` and the root package entry under
`"packages"`), `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (the `omnilink`
package entry) and `src-tauri/tauri.conf.json` — to the target `X.Y.Z`, add the
matching `CHANGELOG.md` entry, then commit on the release branch (include an
updated `pubkey` only if you rotated the key in Step 0-B):

```bash
# from the repository root
git add -A
git commit -s   # message describing the release batch for X.Y.Z
git push origin HEAD
```

Push the branch before tagging: `release.yml` triggers on a pushed tag, and a tag
pointing at an object the remote does not have cannot be pushed.

### Step 3 — Tag it and push the tag

```bash
git tag vX.Y.Z          # must equal package.json + tauri.conf.json version
git push origin vX.Y.Z  # this is what triggers release.yml
```

### Step 4 — Watch the pipeline, review the DRAFT, publish

- `gh run watch` (or the Actions tab) — three platform builds upload their
  installers + `latest.json` + `*.sig` to a single **draft** Release.
- Review the draft (`gh release view vX.Y.Z` / the Releases page): confirm the
  `.msi`/`.exe`, `.dmg`, `.deb`/`.AppImage`, and `latest.json` + signatures are
  attached.
- **Diff the generated `latest.json` against the previous release's** before
  publishing. Its asset-URL shape is emitted by `tauri-apps/tauri-action`, so it
  changes whenever that pin is bumped — it is pinned to a full commit SHA since
  `479d34f`, which makes the change deliberate rather than silent, but the shape
  still moves under you the release after a bump. This is the cheapest check that
  protects the whole updater feed.
- **Publish** the draft. Publishing is required — a draft's assets are NOT served
  at `/releases/latest/download/latest.json`, so the in-app updater only resolves
  once you publish.

---

## Verification after publishing

- `gh api repos/AbdulrahmanHR/OmniLink/releases` lists the new release.
- `curl -sL https://github.com/AbdulrahmanHR/OmniLink/releases/latest/download/latest.json`
  returns the manifest the in-app updater checks.
- A fresh install → **Settings → App Update** finds and verifies the release.

If a build fails on signing, the two secrets in Step 1 are the first thing to
check.
