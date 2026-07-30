import { afterEach, describe, expect, it } from "vitest";
import { parseDevFlagOverrides, resetFeatureFlags } from "@/lib/featureFlags";

/**
 * Dev-only flag override (punch-list item 8) — the PURE `parseDevFlagOverrides`
 * parser. Env-free by design: no `import.meta.env.DEV`, no `window`, no
 * `localStorage`. The DEV-gated applier/persistence (`initDevFlagOverrides`,
 * `persistDevFlag`, `clearDevFlags`) is a browser-only no-op under vitest
 * (node-env: no `window`), so we exercise the parser directly here.
 *
 * The module-load dev-init is likewise inert in node, so importing the module
 * leaves the shared flag registry at its ship defaults; `resetFeatureFlags()` in
 * teardown mirrors the existing flag suites and keeps cross-suite state pristine.
 *
 * v3.0 (M69): the mechanism is unchanged and deliberately kept — it still serves
 * `mlLab`, the one surviving flag — so these cases were repointed at `mlLab`
 * rather than deleted. The one case that dropped out ("merges disjoint URL +
 * stored keys") needed two flags to say anything and cannot be expressed against
 * a single-flag registry.
 */

afterEach(() => {
  resetFeatureFlags();
});

describe("parseDevFlagOverrides — URL query (?ff=)", () => {
  it("turns each listed known flag ON", () => {
    expect(parseDevFlagOverrides("?ff=mlLab", null)).toEqual({ mlLab: true });
  });

  it("accepts a query without the leading '?'", () => {
    expect(parseDevFlagOverrides("ff=mlLab", null)).toEqual({ mlLab: true });
  });

  it("ignores unknown keys", () => {
    expect(parseDevFlagOverrides("?ff=mlLab,bogus,sponsors", null)).toEqual({
      mlLab: true,
    });
  });

  it("trims whitespace around keys", () => {
    expect(parseDevFlagOverrides("?ff= mlLab , bogus ", null)).toEqual({
      mlLab: true,
    });
  });
});

describe("parseDevFlagOverrides — stored blob", () => {
  it("applies a stored {key:boolean} map (both true and false kept)", () => {
    expect(parseDevFlagOverrides("", JSON.stringify({ mlLab: true }))).toEqual({
      mlLab: true,
    });
    // An explicit `false` is preserved, not dropped as a falsy value.
    expect(parseDevFlagOverrides("", JSON.stringify({ mlLab: false }))).toEqual({
      mlLab: false,
    });
  });

  it("keeps only known keys with boolean values", () => {
    expect(
      parseDevFlagOverrides(
        "",
        JSON.stringify({ mlLab: true, bogus: true, hostedPresets: true }),
      ),
    ).toEqual({ mlLab: true });
    // A known key with a non-boolean value is discarded too.
    expect(parseDevFlagOverrides("", JSON.stringify({ mlLab: "yes" }))).toEqual(
      {},
    );
  });

  it("returns {} for malformed JSON", () => {
    expect(parseDevFlagOverrides("", "{not json")).toEqual({});
  });

  it("returns {} for a non-object JSON value", () => {
    expect(parseDevFlagOverrides("", "42")).toEqual({});
    expect(parseDevFlagOverrides("", "null")).toEqual({});
    expect(parseDevFlagOverrides("", '"mlLab"')).toEqual({});
  });
});

describe("parseDevFlagOverrides — precedence + empties", () => {
  it("URL wins over the stored blob on conflict", () => {
    // Stored says mlLab:false; the explicit ?ff= in the current load is the
    // stronger signal and flips it back ON.
    expect(
      parseDevFlagOverrides("?ff=mlLab", JSON.stringify({ mlLab: false })),
    ).toEqual({ mlLab: true });
  });

  it("empty inputs ⇒ {}", () => {
    expect(parseDevFlagOverrides("", null)).toEqual({});
    expect(parseDevFlagOverrides("", "")).toEqual({});
    expect(parseDevFlagOverrides("?foo=bar", null)).toEqual({});
  });
});
