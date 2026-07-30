/**
 * Signal → colour mapping for the flight-path heatmap overlay (M12, FR-TELEM-07).
 *
 * `SignalHeatLayer` colours each path segment by its link health so a pilot can
 * *see where* signal dropped. The mapping is a pure function so it is unit-
 * testable in Node (no MapLibre/DOM) and so the same ramp drives both the map
 * and any legend.
 *
 * Two metrics are supported:
 *   - `"rssi"` — uplink RSSI in dBm (negative; higher/less-negative is better),
 *   - `"lq"`   — uplink link quality, 0–100 % (higher is better).
 *
 * Each value is first normalised to a **quality fraction** in `[0, 1]`
 * (`0` = worst, `1` = best), then mapped through a 5-stop colour ramp by linear
 * interpolation in sRGB. The ramp defaults to fixed hexes approximating the
 * Signal Lab status tokens (critical → good); `FlightMap` reads the live
 * `--status-*` / `--chart-*` CSS custom properties at runtime and passes a
 * theme-resolved ramp so the heatmap matches dark/light/carbon.
 */

/** Which telemetry metric drives the heatmap colour. */
export type SignalMetric = "rssi" | "lq";

/**
 * RSSI normalisation domain (dBm). `-50 dBm` and above reads as a perfect link;
 * `-110 dBm` (the polar plot's floor, {@link RSSI_FLOOR_DBM}) reads as signal
 * loss. Values outside the range are clamped.
 */
export const RSSI_DOMAIN_DBM = { worst: -110, best: -50 } as const;

/** Link-quality normalisation domain (%). */
export const LQ_DOMAIN_PCT = { worst: 0, best: 100 } as const;

/**
 * Default 5-stop ramp, ordered worst → best (fraction `0` → `1`):
 * critical red, orange, amber, lime, signal green. Approximates the
 * `--status-critical` → `--status-good` tokens for environments without a DOM
 * (tests) and as a fallback before the theme ramp is resolved.
 */
export const DEFAULT_SIGNAL_RAMP: readonly string[] = [
  "#d4382f", // critical
  "#e2702a", // poor
  "#e0b341", // fair
  "#8cc63f", // good
  "#33a852", // excellent
];

/** Clamp `x` to `[0, 1]`. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Normalise a raw metric value to a quality fraction in `[0, 1]`
 * (`0` = worst link, `1` = best link), clamped to the metric's domain.
 */
export function signalQualityFraction(
  value: number,
  metric: SignalMetric
): number {
  const domain = metric === "rssi" ? RSSI_DOMAIN_DBM : LQ_DOMAIN_PCT;
  return clamp01((value - domain.worst) / (domain.best - domain.worst));
}

/** Parse a `#rrggbb` hex colour into `[r, g, b]` (0–255). */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) {
    throw new Error(`signal-color: expected a #rrggbb colour, got "${hex}"`);
  }
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Format `[r, g, b]` (0–255, rounded) back to `#rrggbb`. */
function rgbToHex(rgb: [number, number, number]): string {
  return (
    "#" +
    rgb
      .map((c) => Math.round(c).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Linear interpolation between two `#rrggbb` colours (`t` in `[0, 1]`). */
export function interpolateHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp01(t);
  return rgbToHex([
    ca[0] + (cb[0] - ca[0]) * k,
    ca[1] + (cb[1] - ca[1]) * k,
    ca[2] + (cb[2] - ca[2]) * k,
  ]);
}

/**
 * Map a quality fraction in `[0, 1]` to a colour by interpolating across the
 * ramp's stops. `0` → first stop, `1` → last stop.
 */
export function rampColor(
  fraction: number,
  ramp: readonly string[] = DEFAULT_SIGNAL_RAMP
): string {
  if (ramp.length === 0) {
    throw new Error("signal-color: ramp must have at least one stop");
  }
  if (ramp.length === 1) return ramp[0];
  const f = clamp01(fraction);
  const scaled = f * (ramp.length - 1);
  const lo = Math.min(Math.floor(scaled), ramp.length - 2);
  const t = scaled - lo;
  return interpolateHex(ramp[lo], ramp[lo + 1], t);
}

/**
 * Full mapping: a raw RSSI/LQ value → a heatmap colour via the (optionally
 * theme-resolved) ramp. This is what `SignalHeatLayer` calls per path segment.
 */
export function signalColor(
  value: number,
  metric: SignalMetric,
  ramp: readonly string[] = DEFAULT_SIGNAL_RAMP
): string {
  return rampColor(signalQualityFraction(value, metric), ramp);
}
