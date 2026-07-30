import { beforeAll, describe, expect, it } from "vitest";
import i18next, { type TFunction } from "i18next";
import en from "@/locales/en/translation.json";
import es from "@/locales/es/translation.json";

/**
 * Regression coverage for two i18n copy defects (fix group 9):
 *  - `simulator.source.loaded` must pluralize so a single-row session reads
 *    "Loaded 1 frame", not the grammatically wrong "Loaded 1 frames".
 *  - `profiles.firmwareWarn.description` must be version-agnostic, because
 *    firmwareCompat() also returns "warn" on a major-version mismatch — where
 *    the old "by more than one minor version" wording was factually wrong.
 *
 * Uses an isolated i18next instance with the production config (default JSON v4
 * plural rules) so the assertions exercise the real `_one`/`_other` resolution.
 */
describe("en translation strings", () => {
  let t: TFunction;

  beforeAll(async () => {
    const instance = i18next.createInstance();
    await instance.init({
      resources: { en: { translation: en } },
      lng: "en",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
    });
    t = instance.t.bind(instance);
  });

  describe("simulator.source.loaded plural", () => {
    it("uses the singular form for a one-frame session", () => {
      expect(t("simulator.source.loaded", { count: 1 })).toBe("Loaded 1 frame");
    });

    it("uses the plural form for other counts", () => {
      expect(t("simulator.source.loaded", { count: 0 })).toBe("Loaded 0 frames");
      expect(t("simulator.source.loaded", { count: 42 })).toBe("Loaded 42 frames");
    });
  });

  describe("settings.update auto-update copy (M22)", () => {
    it("provides distinct not-configured strings for the dev/unsigned state", () => {
      // The `notConfigured` phase must read as a calm "unavailable here" notice,
      // separate from the red `errorTitle`, and must resolve (not echo the key).
      const title = t("settings.update.notConfiguredTitle");
      const body = t("settings.update.notConfigured");
      expect(title).not.toBe("settings.update.notConfiguredTitle");
      expect(body).not.toBe("settings.update.notConfigured");
      expect(title.length).toBeGreaterThan(0);
      expect(body.length).toBeGreaterThan(0);
      expect(title).not.toBe(t("settings.update.errorTitle"));
    });
  });

  describe("profiles.firmwareWarn.description", () => {
    it("is version-agnostic and interpolates both firmware versions", () => {
      // 2.9.0 vs 3.0.0 is a MAJOR-version mismatch that firmwareCompat() warns on;
      // the copy must not claim a minor-version difference for it.
      const msg = t("profiles.firmwareWarn.description", {
        profileFw: "2.9.0",
        deviceFw: "3.0.0",
      });
      expect(msg).toContain("2.9.0");
      expect(msg).toContain("3.0.0");
      expect(msg).not.toMatch(/minor version/i);
    });
  });
});

/**
 * i18n key-parity gate (M27, NFR-I18N): the zero-hardcoded-strings policy is
 * only enforceable if every shipped locale mirrors the English source exactly.
 * This block holds each non-`en` locale to that contract:
 *  - the deep set of leaf key paths is *exactly* equal to `en` — no missing key
 *    (a string would silently fall back to English) and no extra key (dead copy
 *    or a typo'd path), so adding a key to `en` without translating it FAILS,
 *    and vice-versa;
 *  - no leaf is an empty string (which would render as blank UI); and
 *  - the `{{interpolation}}` placeholders of every shared key match `en` exactly
 *    (a dropped/renamed `{{count}}`/`{{profileFw}}` would break at runtime).
 *
 * It is data-driven over {@link LOCALES}: registering a 3rd locale there extends
 * the gate to it with no new test code. The assertions compare two
 * independently-authored JSON files, so they are not tautological — they go red
 * the moment the locales drift.
 */
const LOCALES: Record<string, unknown> = { en, es };

/** Flatten a nested translation object into a `dotted.path -> string` leaf map. */
function flattenLeaves(
  obj: unknown,
  prefix = "",
  out: Record<string, string> = {}
): Record<string, string> {
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flattenLeaves(value, path, out);
    } else {
      out[path] = String(value);
    }
  }
  return out;
}

/** The sorted set of `{{placeholder}}` tokens used in a string. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)]
    .map((m) => m[1])
    .sort();
}

const EN_LEAVES = flattenLeaves(en);
const EN_PATHS = Object.keys(EN_LEAVES).sort();

describe.each(Object.keys(LOCALES).filter((code) => code !== "en"))(
  "locale '%s' key-parity with en",
  (code) => {
    const leaves = flattenLeaves(LOCALES[code]);
    const paths = Object.keys(leaves).sort();

    it("has exactly the same leaf keys as en (no missing, no extra)", () => {
      const missing = EN_PATHS.filter((p) => !(p in leaves));
      const extra = paths.filter((p) => !(p in EN_LEAVES));
      // Surface the offending paths in the failure message, then assert exact
      // set-equality both ways.
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      expect(paths).toEqual(EN_PATHS);
    });

    it("has no empty-string values", () => {
      const empties = paths.filter((p) => leaves[p].trim() === "");
      expect(empties).toEqual([]);
    });

    it("preserves the en interpolation placeholders for every key", () => {
      const mismatches = EN_PATHS.filter((p) => p in leaves).filter(
        (p) =>
          placeholders(EN_LEAVES[p]).join("|") !==
          placeholders(leaves[p]).join("|")
      );
      expect(mismatches).toEqual([]);
    });
  }
);
