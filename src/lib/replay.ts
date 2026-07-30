/**
 * Pure, deterministic telemetry replay engine (M16).
 *
 * Two concerns live here, both side-effect-free:
 *
 *  1. **Conversion** — the canonical `TelemetrySessionCsvRow` → `TelemetryFrame`
 *     mapping ({@link csvRowToTelemetryFrame}), shared by the replay simulator
 *     and any other consumer that feeds recorded rows through the live pipeline.
 *  2. **Clock** — a deterministic mapping from session-relative elapsed time to a
 *     row index ({@link indexAtSessionElapsed}), plus the helpers that build the
 *     relative-time table ({@link toRelativeTimes}) and report its span
 *     ({@link sessionDurationMs}).
 *
 * This module never reads wall time: no `Date.now`, `performance.now`, or
 * `Math.random`. Elapsed time is always supplied by the caller, so every output
 * is a pure function of its inputs and trivially testable.
 */

import type { TelemetrySessionCsvRow } from "./telemetry-session-csv";
import type { ParsedLog } from "./blackbox";
import type { TelemetryFrame } from "../stores/telemetry";

/**
 * Convert one recorded CSV row into a live-pipeline {@link TelemetryFrame}.
 *
 * Scalar link fields are copied through verbatim. The two antennas are
 * synthesised from `rssi1`/`rssi2` with a deterministic active-path rule:
 * antenna 1 is active when its RSSI is greater-than-or-equal-to antenna 2's
 * (so ties resolve to antenna 1), and antenna 2 is active only when its RSSI is
 * strictly greater — guaranteeing exactly one active antenna. GPS is `null`
 * whenever either latitude or longitude is missing; otherwise the nullable GPS
 * fields default to `0`.
 */
export function csvRowToTelemetryFrame(row: TelemetrySessionCsvRow): TelemetryFrame {
  return {
    t: row.ts,
    rssi1: row.rssi1,
    rssi2: row.rssi2,
    linkQuality: row.linkQuality,
    snr: row.snr,
    txPower: row.txPower,
    packetRate: row.packetRate,
    antennas: [
      { id: 1, rssi: row.rssi1, active: row.rssi1 >= row.rssi2 },
      { id: 2, rssi: row.rssi2, active: row.rssi2 > row.rssi1 },
    ],
    gps:
      row.lat === null || row.lon === null
        ? null
        : {
            latitude: row.lat,
            longitude: row.lon,
            altitude: row.alt ?? 0,
            satellites: row.sats ?? 0,
            groundSpeed: row.groundSpeed ?? 0,
            heading: row.heading ?? 0,
          },
  };
}

/**
 * Convert one sample of a {@link ParsedLog} into a live-pipeline
 * {@link TelemetryFrame} (v1.7.0 unified Session Analysis).
 *
 * The merged Session Analysis surface holds a **single** loaded session as one
 * {@link ParsedLog}; replay derives the dashboard's live frames from that one
 * model (rather than a parallel `TelemetrySessionCsvRow[]`), so there is one
 * parse path, not two. Link channels are looked up by their canonical OmniLink
 * keys ({@link import("./omnilog").OMNILOG_CHANNEL_KEYS}); a missing/`NaN`
 * channel reads as `0`, exactly as {@link csvRowToTelemetryFrame} treats a null
 * scalar. GPS comes from the log's separate `gps` track (`null` at no-fix rows).
 *
 * For an OmniLink-sourced log this is byte-equivalent to running the original
 * rows through {@link csvRowToTelemetryFrame}; a Betaflight-blackbox log (which
 * carries no link channels) degrades to zeroed link metrics plus its GPS track.
 */
export function telemetryFrameFromLog(log: ParsedLog, index: number): TelemetryFrame {
  const channel = (key: string): number => {
    const ch = log.channels.find((c) => c.key === key);
    const v = ch?.values[index];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const rssi1 = channel("rssi1");
  const rssi2 = channel("rssi2");
  const fix = log.gps?.[index] ?? null;
  return {
    t: log.time[index] ?? 0,
    rssi1,
    rssi2,
    linkQuality: channel("link_quality"),
    snr: channel("snr"),
    txPower: channel("tx_power"),
    packetRate: channel("packet_rate"),
    antennas: [
      { id: 1, rssi: rssi1, active: rssi1 >= rssi2 },
      { id: 2, rssi: rssi2, active: rssi2 > rssi1 },
    ],
    gps:
      fix === null
        ? null
        : {
            latitude: fix.lat,
            longitude: fix.lon,
            altitude: channel("alt"),
            satellites: channel("sats"),
            groundSpeed: channel("ground_speed"),
            heading: channel("heading"),
          },
  };
}

/**
 * Session-relative time table (ms) for a {@link ParsedLog}: `time[i] - time[0]`.
 * Mirrors {@link toRelativeTimes} for the log-based replay path. Returns `[]` for
 * an empty log.
 */
export function logRelativeTimes(log: ParsedLog): number[] {
  if (log.sampleCount === 0) return [];
  const base = log.time[0] ?? 0;
  return log.time.map((t) => t - base);
}

/**
 * Build the session-relative time table from recorded rows.
 *
 * Each entry is `row.ts - rows[0].ts`, so the result is ascending (assuming the
 * source rows are time-ordered) with `relTimes[0] === 0`. Returns `[]` for empty
 * input.
 */
export function toRelativeTimes(rows: readonly TelemetrySessionCsvRow[]): number[] {
  if (rows.length === 0) return [];
  const base = rows[0].ts;
  return rows.map((row) => row.ts - base);
}

/**
 * Map a session-relative elapsed time (ms) to the index of the row that should
 * be showing.
 *
 * Returns the largest `i` with `relTimes[i] <= sessionElapsedMs`, found via
 * binary search since `relTimes` is ascending (O(log n)). The result is clamped
 * to `[0, len - 1]`. An empty table yields `0`; a negative elapsed time yields
 * `0` (the first row).
 *
 * @param relTimes Ascending relative-time table from {@link toRelativeTimes}.
 * @param sessionElapsedMs Elapsed session time in milliseconds.
 */
export function indexAtSessionElapsed(relTimes: number[], sessionElapsedMs: number): number {
  const len = relTimes.length;
  if (len === 0) return 0;
  if (sessionElapsedMs < 0) return 0;

  // Binary search for the rightmost index whose relative time is <= elapsed.
  let lo = 0;
  let hi = len - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (relTimes[mid] <= sessionElapsedMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/**
 * Total span of the session in milliseconds: `last - first` relative time.
 * Returns `0` when fewer than two rows are present.
 */
export function sessionDurationMs(relTimes: number[]): number {
  if (relTimes.length < 2) return 0;
  return relTimes[relTimes.length - 1] - relTimes[0];
}
