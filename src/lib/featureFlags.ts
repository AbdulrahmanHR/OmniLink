/**
 * Runtime feature flags (v2.4 / M51; reduced to one flag in v3.0 / M69).
 *
 * A tiny, dependency-free flag registry so parts of the app that are built but
 * not yet ready to ship can land behind an OFF-by-default switch with their own
 * acceptance path — mirroring the two-phase "real seam, gated transport" pattern
 * used across v2.x.
 *
 * v3.0 (M69, decision D35) deleted the five platform flags — the managed AI
 * answer path, cloud profile sync, the Pro subscription surface, sponsor cards
 * and hosted presets — along with every surface they gated. What they gated was
 * a mock built ahead of a backend that was retired rather than deferred, so the
 * flags had nothing left to govern.
 * {@link FeatureFlags.mlLab} is the only flag, and the dev-override mechanism
 * below is kept in full because it still serves it.
 *
 * Pure JS: no persistence, no Tauri, no network. `setFeatureFlag` exists so a
 * test (or a future in-app toggle) can flip a flag deterministically; it is a
 * process-lifetime override, never written to disk.
 */

/** The set of runtime feature flags. */
export interface FeatureFlags {
  /**
   * v2.5 **ML lab** (M56c): the local session-labeling tool and the data-readiness
   * report. OFF by default, and it is not a "coming soon" surface — it is a
   * *laboratory instrument*. The D21 bar is 300 labeled sessions per class and the
   * whole corpus is 36 sessions across 5 classes, so no model this line can train
   * is fit to reach a user; the lab exists to make that shortfall visible and
   * measurable, not to ship a model.
   *
   * **The free local core must never consult this flag.** Flashing, profiles,
   * telemetry, diagnostics, BYOK chat and RAG behave identically whatever its
   * value; a normal user sees zero change from this release. Everything it gates is
   * gated at the *render boundary* — flag OFF means the surface does not exist in
   * the tree, not that it renders disabled.
   *
   * Asserted by `tests/unit/ml/mlLabFlag.test.ts`.
   */
  mlLab: boolean;
}

/** Ship defaults — every gated capability starts OFF. */
const DEFAULT_FLAGS: FeatureFlags = {
  mlLab: false,
};

const flags: FeatureFlags = { ...DEFAULT_FLAGS };

/** Read a feature flag's current value. */
export function getFeatureFlag<K extends keyof FeatureFlags>(key: K): FeatureFlags[K] {
  return flags[key];
}

/** Override a feature flag for the current process (tests / future in-app toggle). */
export function setFeatureFlag<K extends keyof FeatureFlags>(
  key: K,
  value: FeatureFlags[K],
): void {
  flags[key] = value;
}

/** Reset every flag to its ship default (test seam). */
export function resetFeatureFlags(): void {
  Object.assign(flags, DEFAULT_FLAGS);
}

/**
 * Whether the v2.5 **ML lab** (session labeling + the data-readiness report) should
 * be shown. The single gate for that surface — nothing else in the app, and nothing
 * in the free local core, consults `mlLab`.
 */
export function isMlLabEnabled(): boolean {
  return flags.mlLab === true;
}

// ---------------------------------------------------------------------------
// Dev-only override (additive; production + Node are untouched)
// ---------------------------------------------------------------------------
//
// A DEV-ONLY convenience so the flag-gated surfaces are reachable for QA/demos
// and e2e WITHOUT editing this file: a `?ff=` URL param and a
// `localStorage` blob can flip flags ON — but ONLY in a Vite **dev** build
// (`import.meta.env.DEV`) and ONLY in a browser (`typeof window`). In a shipped
// production build both the URL param and the stored blob are inert (the applier
// short-circuits), so flags stay OFF + code-only. In Node/vitest there is no
// `window`, so the module-load init below is a no-op and existing flag tests —
// which drive `setFeatureFlag`/`resetFeatureFlags` directly — are unaffected.

/** localStorage key holding the dev flag-override blob (`{key:boolean}` map). */
export const DEV_FLAGS_STORAGE_KEY = "omnilink-dev-flags";

/** Every known flag key — the allow-list the override parser filters against. */
const FLAG_KEYS: readonly (keyof FeatureFlags)[] = ["mlLab"];

/** Narrow an arbitrary string to a known flag key. */
function isKnownFlag(key: string): key is keyof FeatureFlags {
  return (FLAG_KEYS as readonly string[]).includes(key);
}

/**
 * Parse dev flag overrides from a URL query string + a stored JSON blob. **Pure**
 * — no env, no `window`, no side effects — so it is fully unit-testable.
 *
 * - `search` (`window.location.search`): `?ff=mlLab` turns each listed KNOWN
 *   flag ON (unknown keys are ignored).
 * - `storedJson`: `JSON.parse`-able `Partial<FeatureFlags>` (`{key:boolean}`);
 *   only known keys with boolean values are kept. Malformed JSON ⇒ `{}`.
 * - The URL wins over the stored blob on conflict — an explicit `?ff=` in the
 *   current load is the strongest signal.
 */
export function parseDevFlagOverrides(
  search: string,
  storedJson: string | null,
): Partial<FeatureFlags> {
  const overrides: Partial<FeatureFlags> = {};

  // 1. Stored blob (weaker signal): a persisted `{key:boolean}` map.
  if (storedJson) {
    try {
      const parsed: unknown = JSON.parse(storedJson);
      if (parsed !== null && typeof parsed === "object") {
        for (const [key, value] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          if (isKnownFlag(key) && typeof value === "boolean") {
            overrides[key] = value;
          }
        }
      }
    } catch {
      // Malformed JSON ⇒ ignore it entirely (leaves the URL layer intact).
    }
  }

  // 2. URL query (stronger signal): each listed known flag → true; URL wins.
  const ff = new URLSearchParams(search).get("ff");
  if (ff) {
    for (const raw of ff.split(",")) {
      const key = raw.trim();
      if (isKnownFlag(key)) overrides[key] = true;
    }
  }

  return overrides;
}

/** True only in a Vite dev build running in a browser. Gates every writer below. */
function devBrowser(): boolean {
  return import.meta.env.DEV && typeof window !== "undefined";
}

/**
 * DEV builds only: apply overrides from `?ff=` + `localStorage` at startup.
 * No-op in production and in Node (no `window`) — so it never affects a shipped
 * build or vitest. Called once at module load (bottom of this file).
 */
export function initDevFlagOverrides(): void {
  if (!devBrowser()) return;
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(DEV_FLAGS_STORAGE_KEY);
  } catch {
    stored = null;
  }
  const overrides = parseDevFlagOverrides(window.location.search, stored);
  for (const [key, value] of Object.entries(overrides) as [
    keyof FeatureFlags,
    boolean,
  ][]) {
    setFeatureFlag(key, value);
  }
}

/**
 * DEV builds only: persist a single flag into the localStorage override blob so
 * the choice survives a reload. No-op in production / Node.
 */
export function persistDevFlag(key: keyof FeatureFlags, value: boolean): void {
  if (!devBrowser()) return;
  let current: Partial<FeatureFlags> = {};
  try {
    const raw = window.localStorage.getItem(DEV_FLAGS_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        current = parsed as Partial<FeatureFlags>;
      }
    }
  } catch {
    current = {};
  }
  current[key] = value;
  try {
    window.localStorage.setItem(DEV_FLAGS_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // A storage quota / security error is non-fatal for a dev convenience.
  }
}

/**
 * DEV builds only: drop the localStorage override blob and reset every flag to
 * its ship default (all OFF). No-op in production / Node.
 */
export function clearDevFlags(): void {
  if (!devBrowser()) return;
  try {
    window.localStorage.removeItem(DEV_FLAGS_STORAGE_KEY);
  } catch {
    // Ignore — the reset below still restores in-memory defaults.
  }
  resetFeatureFlags();
}

// Hydrate flag overrides from `?ff=` + localStorage once, at module load. The
// guard inside `initDevFlagOverrides` makes this inert in production and in Node
// (vitest), so it changes nothing outside a browser dev build.
initDevFlagOverrides();
