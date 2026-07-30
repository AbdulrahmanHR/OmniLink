# Translating OmniLink (NFR-I18N-04)

OmniLink is fully localized through [react-i18next](https://react.i18next.com/).
Every user-facing string goes through `t()` — there is a **zero hardcoded
user-facing strings** policy — and each locale is kept at full key parity by an
automated test, so a partial translation can never ship silently.

## Where translations live

```
src/locales/
  en/translation.json   ← source of truth (English)
  es/translation.json   ← Spanish, at full parity
  <lang>/translation.json  ← add a new community locale here
```

`src/locales/en/translation.json` is authoritative. Every other locale is a
translation of it with an **identical set of keys** (same nesting, same
interpolation placeholders like `{{count}}`, same i18next plural suffixes such as
`_one` / `_other`).

## Contributing a translation manually

1. Copy `src/locales/en/translation.json` to `src/locales/<lang>/translation.json`
   (e.g. `fr`, `de`).
2. Translate the string **values** only — never rename a key, and keep every
   `{{placeholder}}` and plural key exactly as in English.
3. Register the locale with i18next (see `src/lib/i18n.ts`) so it can be selected.
4. Run the checks below; the key-parity test must pass.

```bash
npm run test        # includes tests/unit/translationStrings.test.ts (key parity)
npm run typecheck
npm run lint
```

The **`translationStrings`** unit test fails if any locale is missing a key the
source has (or carries an extra one), so an incomplete or drifted translation is
caught before merge.

## Community translation via Crowdin (maintainer activation)

The repo ships **inert** Crowdin scaffolding so a community-translation workflow
can be turned on without any code changes:

- `crowdin.yml` — maps the English source to per-locale translation files.
- `.github/workflows/crowdin-sync.yml` — a **manual** (`workflow_dispatch`)
  action that uploads sources to Crowdin and opens a PR with finished
  translations pulled back down.

Neither does anything until a maintainer:

1. Creates a Crowdin project for OmniLink.
2. Adds two repo secrets (Settings → Secrets and variables → Actions):
   - `CROWDIN_PROJECT_ID` — the numeric Crowdin project id
   - `CROWDIN_PERSONAL_TOKEN` — a Crowdin personal access token
3. Runs **Crowdin sync** from the Actions tab.

The download PR must keep the `translationStrings` key-parity test green before
merge. Until this is activated, all translation happens by hand as above — the
scaffolding just makes the community-translation path a config + secrets step,
not a code change. (Same "exists but inert until secrets are wired" shape as the
signed-release pipeline in `.github/workflows/release.yml`.)
