/**
 * Live flight-path derivation + decimation (M13, FR-TELEM-04/07/08).
 *
 * Turns the telemetry store's rolling history buffer into the
 * {@link FlightPathPoint} array {@link FlightMap} consumes, and caps the vertex
 * count so the rendered GeoJSON can never bloat MapLibre.
 *
 * Design note:
 * The live path derives from the telemetry store's rolling history buffer
 * (TELEMETRY_HISTORY_CAP frames) — the same window every other dashboard widget
 * (LinkChart, sparklines) reads, so the map stays consistent with them rather
 * than diverging into a parallel unbounded buffer. decimatePath caps the GeoJSON
 * vertex count to LIVE_PATH_MAX_POINTS so the path can never bloat MapLibre even
 * if that window is later widened or a full-session view reuses this helper.
 *
 * Decimation algorithm (uniform stride):
 * When a path exceeds the cap, {@link decimatePath} samples it down by walking
 * `max` evenly-spaced positions across the inclusive index range `[0, n-1]`.
 * Index `i` of the output maps to source index `round(i * (n-1) / (max-1))`, so
 * both endpoints (`0` and `n-1`) are always selected and the path stays
 * anchored. Resulting indices are deduped (rounding can collide) and kept in
 * ascending order, yielding at most `max` points. The mapping is purely a
 * function of the input length and `max` — no Date, no randomness — so it is
 * deterministic and stable across renders.
 */

import { gpsHasFix } from "@/lib/telemetry-crsf";
import type { TelemetryFrame } from "@/stores/telemetry";
import type { FlightPathPoint } from "@/components/map";

/**
 * Maximum number of vertices the live flight path is decimated down to before
 * being handed to {@link FlightMap}. Bounds the MapLibre GeoJSON regardless of
 * how large the source history window grows.
 */
export const LIVE_PATH_MAX_POINTS = 500;

/**
 * Derive an ordered flight path from a telemetry history buffer.
 *
 * Each frame contributes a point **only** when it carries a real GPS fix
 * (per {@link gpsHasFix}); non-fix frames are skipped entirely rather than
 * pushed as `(0,0)` placeholders. Points are returned in history order.
 *
 * @param history Rolling telemetry frames (oldest → newest).
 * @returns Path points for frames with a usable GPS fix, in order.
 */
export function deriveFlightPath(
  history: readonly TelemetryFrame[]
): FlightPathPoint[] {
  const points: FlightPathPoint[] = [];
  for (const frame of history) {
    const gps = frame.gps;
    // gpsHasFix already rules out a missing/no-fix reading; the explicit null
    // check re-narrows the type for TS since gpsHasFix returns a plain boolean.
    if (!gps || !gpsHasFix(gps)) continue;
    points.push({
      lat: gps.latitude,
      lon: gps.longitude,
      rssi: frame.rssi1,
      lq: frame.linkQuality,
    });
  }
  return points;
}

/**
 * Uniformly decimate a path to at most `max` points, always keeping the first
 * and last so the endpoints stay anchored.
 *
 * If `max <= 0` the input is returned as a shallow copy (no cap). If the path
 * already fits within `max`, a shallow copy is returned unchanged. Otherwise
 * `max` evenly-spaced source indices across `[0, n-1]` are selected, deduped,
 * and kept in order — see the module-level "Decimation algorithm" note.
 *
 * @param points Source path points, in order.
 * @param max Maximum number of points to keep.
 * @returns A new array of at most `max` points, preserving order.
 */
export function decimatePath(
  points: readonly FlightPathPoint[],
  max: number
): FlightPathPoint[] {
  if (max <= 0) return [...points];
  const n = points.length;
  if (n <= max) return [...points];
  // `max === 1` would divide by zero in the stride below; a single-point cap
  // can't anchor both ends, so keep the first sample.
  if (max === 1) return [points[0]];

  const result: FlightPathPoint[] = [];
  let prevIndex = -1;
  for (let i = 0; i < max; i++) {
    const index = Math.round((i * (n - 1)) / (max - 1));
    // Rounding can map adjacent output slots to the same source index; dedupe
    // while preserving ascending order.
    if (index === prevIndex) continue;
    prevIndex = index;
    result.push(points[index]);
  }
  return result;
}
