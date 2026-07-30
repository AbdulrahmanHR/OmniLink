<!--
Thanks for contributing to OmniLink.

Keep the PR focused on one logical change — unrelated reformatting makes review
disproportionately expensive for a solo maintainer.

Conventional Commits in the title, please: feat: / fix: / docs: / refactor: /
test: / chore: / ci:
-->

## What does this change?

<!-- A short prose description. What behaviour is different after this merges? -->

## Why?

<!--
The reasoning, not just the mechanics. Link the issue this closes:
  Closes #123
If there is no issue and this is more than a bug fix, please open one first —
see CONTRIBUTING.md.
-->

## How was it tested?

<!--
Be specific. "Added tests" is less useful than "added
tests/unit/foo.test.ts covering the empty-catalogue case".
-->

## Hardware testing

<!--
The maintainer owns no ELRS hardware, so this section carries real weight.
"Not tested on hardware" is a completely acceptable answer — an unstated
assumption is not.
-->

- [ ] Tested on real hardware
- [ ] Not tested on hardware (mock/unit coverage only)

**If tested on hardware, what exactly?**
<!-- Radio/RX brand + model, ExpressLRS firmware version, connection mode
     (serial / WiFi / Backpack), and your OS. -->

---

## Developer Certificate of Origin

- [ ] **Every commit in this PR is signed off** (`git commit -s`), and I certify
      my contribution under the [DCO 1.1](../CONTRIBUTING.md#developer-certificate-of-origin-dco--required).

<!--
Forgot? Fix it without redoing your work:
  git commit --amend -s --no-edit     # just the last commit
  git rebase --signoff v3             # every commit on the branch
-->

## Checklist

- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md).
- [ ] This change introduces **no server, no account, no payment, and no
      telemetry**, and does not make an offline workflow require a network.
      (See [Scope boundary](../CONTRIBUTING.md#scope-boundary--what-will-not-be-accepted).)
- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes with zero warnings.
- [ ] `npm run build` passes.
- [ ] `npm test` passes.
- [ ] `cargo test`, `cargo clippy --all-targets -- -D warnings` and
      `cargo fmt --check` pass — *or* this PR touches no Rust.
- [ ] `npm run e2e` passes — *or* this PR touches no UI.
      *(On WSL2, run it as `npx playwright test --workers=2`.)*

### If this PR touches user-facing strings

- [ ] Every visible string goes through `t()` — **zero hardcoded user-facing
      strings**, including `aria-label`s, error text, and empty states.
- [ ] Keys were added to **both** `src/locales/en/translation.json` and
      `src/locales/es/translation.json`, at exact parity.

### If this PR touches dependencies

- [ ] `docs/THIRD_PARTY_LICENSES.md` is updated, and every added dependency is
      GPL-3.0-compatible. (Proprietary, SSPL, BUSL, or non-commercial licences
      cannot be accepted — they would make OmniLink undistributable.)

### If this PR touches the flash path, MSP, or anything handling secrets

- [ ] The TX/RX and Backpack cross-type guards still run **before** any erase or
      write, and I have not weakened them.
- [ ] No binding phrase, API key, GPS coordinate, MAC address, IP address, or
      email address can reach a log, an export, or an AI prompt.
      `sanitize_context()` is intact.
- [ ] The controller bridge remains read-only — `MSP_SET_PASSTHROUGH` is still the
      only write issued.

<!--
These safety rules are enforced by tests and are not negotiable in a PR. If you
believe one needs to change, please open an issue to discuss it first.
See CONTRIBUTING.md → "Safety rules that are not negotiable".
-->

## Screenshots

<!-- For UI changes. Before/after is ideal. Please check for a visible binding
     phrase or API key before uploading. -->
