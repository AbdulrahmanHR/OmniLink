import { describe, expect, it } from "vitest";
import { Color } from "@maplibre/maplibre-gl-style-spec";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  buildOfflineStyle,
  isExpectedTileError,
  isMapAlive,
  resolveSignalRamp,
  resolveThemeColor,
  toMapLibreColor,
} from "@/components/map/map-style";

/**
 * Regression suite for the 3.0.3 blank-map defect.
 *
 * The theme tokens in `src/index.css` are authored in `oklch()`, and current
 * engines return the *computed* value of `background-color` in the same colour
 * space. MapLibre's style spec cannot parse `oklch()`, so every paint colour the
 * map resolved from a token invalidated the style; the style then never loaded,
 * `load` never fired, no layer was ever added and the canvas stayed blank in
 * every engine.
 *
 * The expected RGB values below are **ground truth measured from Chromium 149**:
 * each `oklch()`/`oklab()` string was painted into a 1×1 canvas via
 * `ctx.fillStyle` and read back with `getImageData`. All 23 cases match this
 * implementation byte-for-byte, so these assertions pin the conversion to what a
 * real engine does rather than to our own arithmetic.
 */
describe("toMapLibreColor — OKLCH/OKLab → sRGB", () => {
  it("reproduces the two fixed points the OKLab matrices must hit exactly", () => {
    expect(toMapLibreColor("oklch(0 0 0)", "#fallback")).toBe("rgb(0, 0, 0)");
    expect(toMapLibreColor("oklch(1 0 0)", "#fallback")).toBe(
      "rgb(255, 255, 255)"
    );
  });

  it("matches Chromium for the real Signal Lab theme tokens", () => {
    // Values lifted verbatim from src/index.css.
    const cases: ReadonlyArray<[string, string]> = [
      ["oklch(0.12 0.015 240)", "rgb(2, 6, 10)"], // dark  --background
      ["oklch(0.94 0.008 240)", "rgb(231, 236, 240)"], // light --muted
      ["oklch(0.50 0.015 240)", "rgb(92, 101, 107)"], // light --muted-foreground
      ["oklch(0.65 0.2 145)", "rgb(17, 173, 50)"], // --status-good
      ["oklch(0.47 0.13 70)", "rgb(135, 74, 0)"], // --status-warning
      ["oklch(0.55 0.22 25)", "rgb(212, 9, 36)"], // --status-critical
      ["oklch(0.50 0.17 160)", "rgb(0, 126, 63)"], // --primary
    ];
    for (const [input, expected] of cases) {
      expect(toMapLibreColor(input, "#fallback"), input).toBe(expected);
    }
  });

  it("reproduces the exact strings that invalidated the shipped style", () => {
    // Verbatim from the live map's MapLibre errors:
    //   layers[0].paint.background-color: color expected, "oklch(0.2 0.012 240)" found
    //   layers.flight-path-line.paint.line-color: color expected, "oklch(0.7 0.01 240)" found
    expect(toMapLibreColor("oklch(0.2 0.012 240)", "#0b1220")).toBe(
      "rgb(17, 23, 27)"
    );
    expect(toMapLibreColor("oklch(0.7 0.01 240)", "#7a8699")).toBe(
      "rgb(153, 159, 164)"
    );
  });

  it("accepts a percentage lightness and a percentage chroma", () => {
    // 100% chroma is 0.4 in oklch() (CSS Color 4 §7.3).
    expect(toMapLibreColor("oklch(62.8% 0.25768 29.234)", "#f")).toBe(
      "rgb(255, 0, 0)"
    );
    expect(toMapLibreColor("oklch(0.6 50% 180)", "#f")).toBe(
      "rgb(0, 163, 133)"
    );
  });

  it("accepts every CSS hue unit and unitless degrees identically", () => {
    const expected = "rgb(0, 156, 132)";
    for (const hue of ["180", "180deg", "0.5turn", "200grad", "3.14159rad"]) {
      expect(toMapLibreColor(`oklch(0.6 0.15 ${hue})`, "#f"), hue).toBe(
        expected
      );
    }
  });

  it("treats `none` components as zero, per CSS Color 4", () => {
    expect(toMapLibreColor("oklch(0.5 none 240)", "#f")).toBe(
      "rgb(99, 99, 99)"
    );
    expect(toMapLibreColor("oklch(none 0.1 240)", "#f")).toBe("rgb(0, 0, 9)");
  });

  it("carries the `/ alpha` form through as rgba()", () => {
    // --signal-glow: oklch(0.65 0.22 155 / 0.3)
    expect(toMapLibreColor("oklch(0.65 0.22 155 / 0.3)", "#f")).toBe(
      "rgba(0, 179, 76, 0.3)"
    );
    expect(toMapLibreColor("oklch(0.65 0.22 155 / 30%)", "#f")).toBe(
      "rgba(0, 179, 76, 0.3)"
    );
    // Alpha 1 collapses back to the shorter rgb() form.
    expect(toMapLibreColor("oklch(0.65 0.22 155 / 1)", "#f")).toBe(
      "rgb(0, 179, 76)"
    );
  });

  it("converts oklab() as well as oklch()", () => {
    expect(toMapLibreColor("oklab(0.5 0.1 -0.1)", "#f")).toBe(
      "rgb(129, 69, 154)"
    );
    expect(toMapLibreColor("oklab(0.65 -0.1 0.05)", "#f")).toBe(
      "rgb(83, 163, 111)"
    );
  });

  it("clips out-of-gamut results to a real colour instead of NaN", () => {
    // Absurd chroma drives channels far outside [0,1]; the sign-preserving
    // transfer function must not produce NaN via Math.pow of a negative base.
    const out = toMapLibreColor("oklch(0.6 0.9 30)", "#f");
    expect(out).toMatch(/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/);
    expect(out).not.toContain("NaN");
  });
});

describe("toMapLibreColor — passthrough", () => {
  it("returns already-parseable colours verbatim (no double conversion)", () => {
    for (const value of [
      "#0b1220",
      "#FFF",
      "#0b1220ff",
      "rgb(11, 18, 32)",
      "rgb(11 18 32)",
      "rgba(11, 18, 32, 0.5)",
      "rgb(11 18 32 / 0.5)",
      "hsl(240 10% 20%)",
      "hsla(240, 10%, 20%, 0.4)",
    ]) {
      expect(toMapLibreColor(value, "#fallback"), value).toBe(value);
    }
  });

  it("trims but does not otherwise rewrite passthrough values", () => {
    expect(toMapLibreColor("  #0b1220  ", "#fallback")).toBe("#0b1220");
  });
});

describe("toMapLibreColor — fallback", () => {
  it("falls back instead of throwing on anything unusable", () => {
    for (const value of [
      "",
      "   ",
      null,
      undefined,
      "not a colour",
      "oklch()",
      "oklch(0.5 0.1)", // too few components
      "oklch(0.5 0.1 240 30)", // too many components
      "oklch(abc def ghi)",
      "oklch(0.5 0.1 240 / 0.5 / 0.2)", // two alpha separators
      "oklch(0.5 0.1 240 / bogus)",
      "lab(50 20 30)", // real CSS, but MapLibre cannot parse it either
      "color(srgb 0.1 0.2 0.3)",
      "hwb(0 0% 0%)",
    ]) {
      expect(toMapLibreColor(value, "#fallback"), String(value)).toBe(
        "#fallback"
      );
    }
  });
});

describe("toMapLibreColor — MapLibre actually parses the output", () => {
  it("every conversion round-trips through the real style-spec parser", () => {
    const inputs = [
      "oklch(0.12 0.015 240)",
      "oklch(0.94 0.008 240)",
      "oklch(0.65 0.2 145)",
      "oklch(0.65 0.22 155 / 0.3)",
      "oklab(0.5 0.1 -0.1)",
      "#0b1220",
      "rgb(11, 18, 32)",
    ];
    for (const input of inputs) {
      const out = toMapLibreColor(input, "#0b1220");
      // `Color.parse` returning undefined is exactly what makes a style
      // invalid, which is the whole defect.
      expect(Color.parse(out), `${input} -> ${out}`).toBeDefined();
    }
  });

  it("proves the pre-fix behaviour: raw oklch() is unparseable by MapLibre", () => {
    expect(Color.parse("oklch(0.2 0.012 240)")).toBeUndefined();
    expect(Color.parse("oklch(0.7 0.01 240)")).toBeUndefined();
  });
});

describe("resolveThemeColor / buildOfflineStyle without a DOM", () => {
  it("returns the caller's fallback when there is no document", () => {
    expect(typeof document).toBe("undefined");
    expect(resolveThemeColor("--muted", "#0b1220")).toBe("#0b1220");
  });

  it("builds a style whose every paint colour MapLibre can parse", () => {
    const style = buildOfflineStyle(12);
    const background = style.layers[0] as {
      paint: { "background-color": string };
    };
    expect(Color.parse(background.paint["background-color"])).toBeDefined();
  });

  it("yields a ramp whose stops are all MapLibre-parseable", () => {
    for (const stop of resolveSignalRamp()) {
      expect(Color.parse(stop), stop).toBeDefined();
    }
  });
});

/**
 * `Map.remove()` runs `setStyle(null)`, after which `map.getLayer(...)` is
 * `this.style.getLayer(...)` on an undefined `style` and throws. `FlightMap`
 * removes the map *before* clearing the context, so the overlays' effect
 * cleanups always run against a dead instance — which crashed the whole
 * telemetry dashboard the moment the blank-map fix let `ready` become true.
 */
describe("isMapAlive", () => {
  const asMap = (o: unknown) => o as MapLibreMap;

  it("accepts a live map", () => {
    expect(isMapAlive(asMap({ _removed: false, style: {} }))).toBe(true);
  });

  it("rejects a removed map, a style-less map and nothing at all", () => {
    expect(isMapAlive(asMap({ _removed: true, style: {} }))).toBe(false);
    expect(isMapAlive(asMap({ _removed: false, style: undefined }))).toBe(false);
    expect(isMapAlive(null)).toBe(false);
    expect(isMapAlive(undefined)).toBe(false);
  });
});

describe("isExpectedTileError", () => {
  it("stays quiet for source/tile failures (expected offline)", () => {
    expect(isExpectedTileError({ sourceId: "omnitiles", error: {} })).toBe(true);
    expect(isExpectedTileError({ tile: { x: 1, y: 2, z: 3 }, error: {} })).toBe(
      true
    );
    expect(isExpectedTileError({ error: { status: 404, message: "x" } })).toBe(
      true
    );
    expect(
      isExpectedTileError({
        error: { url: "omnitiles://tiles/1/2/3.png", message: "x" },
      })
    ).toBe(true);
    expect(
      isExpectedTileError({ error: { message: "Failed to fetch" } })
    ).toBe(true);
    expect(
      isExpectedTileError({
        error: { message: "net::ERR_UNKNOWN_URL_SCHEME" },
      })
    ).toBe(true);
  });

  it("surfaces style/configuration errors — the 3.0.3 blind spot", () => {
    // Verbatim messages captured from the live, broken map.
    expect(
      isExpectedTileError({
        error: {
          message:
            'layers[0].paint.background-color: color expected, "oklch(0.2 0.012 240)" found',
        },
      })
    ).toBe(false);
    expect(
      isExpectedTileError({
        error: {
          message:
            'layers.flight-path-line.paint.line-color: color expected, "oklch(0.7 0.01 240)" found',
        },
      })
    ).toBe(false);
    expect(isExpectedTileError({ error: new Error("boom") })).toBe(false);
    expect(isExpectedTileError(null)).toBe(false);
    expect(isExpectedTileError(undefined)).toBe(false);
    expect(isExpectedTileError("string")).toBe(false);
    // An empty sourceId must not be treated as attribution to a source.
    expect(isExpectedTileError({ sourceId: "", error: new Error("boom") })).toBe(
      false
    );
  });
});
