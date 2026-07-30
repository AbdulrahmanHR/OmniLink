import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  getFeatureFlag,
  isMlLabEnabled,
  parseDevFlagOverrides,
  resetFeatureFlags,
  setFeatureFlag,
} from "@/lib/featureFlags";

/**
 * Release invariant #1 (M56c): **`mlLab` is OFF by default, and the free local core
 * never consults it.**
 *
 * Two halves, both asserted here:
 *  - the *value* — a fresh process reads `mlLab` as `false`, so a shipped build
 *    renders no lab surface (the e2e `ml-lab.spec.ts` proves the DOM half: with the
 *    flag off the panel does not exist, not merely disabled);
 *  - the *blast radius* — a source sweep proves `isMlLabEnabled()` is called from
 *    exactly ONE render boundary and from nothing in `src/lib`, `src/stores`, or
 *    `src/hooks`. Flashing, profiles, telemetry, diagnostics, BYOK chat and RAG
 *    cannot branch on this flag, because they never ask about it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../../../src");

afterEach(() => {
  resetFeatureFlags();
});

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("mlLab — the ship default", () => {
  it("is OFF in DEFAULT_FLAGS", () => {
    expect(getFeatureFlag("mlLab")).toBe(false);
    expect(isMlLabEnabled()).toBe(false);
  });

  it("returns to OFF after a reset (the flag registry's ship default is false)", () => {
    setFeatureFlag("mlLab", true);
    expect(isMlLabEnabled()).toBe(true);
    resetFeatureFlags();
    expect(isMlLabEnabled()).toBe(false);
  });

  it("is a known dev-override key (so QA/e2e can reach the lab without a source edit)", () => {
    expect(parseDevFlagOverrides("?ff=mlLab", null)).toEqual({ mlLab: true });
  });
});

describe("mlLab — the free local core never consults it", () => {
  const files = sourceFiles(SRC);

  it("`isMlLabEnabled()` is called from exactly one render boundary", () => {
    const callers = files
      .filter((f) => readFileSync(f, "utf8").includes("isMlLabEnabled()"))
      .map((f) => path.relative(SRC, f))
      // The accessor's own definition is not a call site.
      .filter((f) => f !== "lib/featureFlags.ts")
      .sort();

    expect(callers).toEqual(["pages/SettingsPage.tsx"]);
  });

  it("no library, store, or hook in the free core references the flag at all", () => {
    const offenders = files
      .filter((f) => /^(lib|stores|hooks)\//.test(path.relative(SRC, f)))
      .filter((f) => path.relative(SRC, f) !== "lib/featureFlags.ts")
      .filter((f) => /\bmlLab\b/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));

    expect(offenders).toEqual([]);
  });

  it("the lab panel is mounted behind the flag guard, never unconditionally", () => {
    const page = readFileSync(path.join(SRC, "pages/SettingsPage.tsx"), "utf8");
    // The ONLY JSX mount of the panel sits inside the `isMlLabEnabled() && (…)`
    // guard, so an OFF flag means the surface is absent from the tree — not
    // rendered-but-disabled (which would still expose it to screen readers, to
    // the DOM, and to anyone who deletes a `disabled` attribute).
    const mounts = page.match(/<MlLabPanel\b/g) ?? [];
    expect(mounts).toHaveLength(1);
    expect(page).toMatch(/isMlLabEnabled\(\) && \([\s\S]{0,400}<MlLabPanel /);
  });
});
