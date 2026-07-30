/**
 * On-device flight-log range summarisation for the AI assistant (M14,
 * FR-AI-06/07/11, FR-LOG-06).
 *
 * FR-AI-11 caps a managed-AI query at 4,000 input tokens, so a selected window
 * of a flight log can never be sent raw. {@link summarizeLogRange} reduces an
 * index window of a {@link ParsedLog} to compact per-channel aggregate
 * statistics (min/max/mean/last/delta) plus window metadata. Aggregates, never
 * rows, keep the output a few hundred tokens regardless of window size.
 *
 * ## Safety (FR-AI-06/07) — defense in depth
 * The output must never contain a GPS coordinate, binding phrase, UID, MAC, IP,
 * or email. This module enforces that two ways:
 *  1. It reads **only** `log.channels` — it never touches `log.gps`, and the
 *     result type ({@link LogRangeSummary}) has no GPS field, so coordinates are
 *     structurally absent.
 *  2. {@link stripSensitiveChannels} drops any channel whose key/label looks
 *     like a coordinate or identifier (gps/coord/lat/lon/uid/mac/ip/email/…)
 *     before stats are computed — covering hypothetical future channels.
 *
 * The Rust `sanitize_context()` is the authoritative backstop; this client-side
 * filtering is defense-in-depth. All logic is deterministic (pure arithmetic,
 * no `Date.now`/`Math.random`).
 */

import type { LogChannel, LogSource, ParsedLog } from "@/lib/blackbox";

/** Tokens that mark a channel as sensitive (coordinate or personal identifier). */
const SENSITIVE_TOKENS: ReadonlySet<string> = new Set([
  "gps",
  "geo",
  "coord",
  "coords",
  "coordinate",
  "coordinates",
  "lat",
  "latitude",
  "lon",
  "lng",
  "long",
  "longitude",
  "uid",
  "mac",
  "ip",
  "email",
  "mail",
  "binding",
  "phrase",
]);

/**
 * True when a channel's key or label looks like a GPS coordinate or a personal
 * identifier and so must be excluded from anything sent to the AI.
 *
 * Matching is token-based (splitting on non-alphanumeric), so single-word
 * headers like `vbatLatest` are not falsely flagged by the `lat` token, while
 * `GPS_coord[0]`, `gps altitude`, or `gpsCoord` (→ `gps…` prefix) are caught.
 */
export function isSensitiveChannel(channel: Pick<LogChannel, "key" | "label">): boolean {
  const tokens = `${channel.key} ${channel.label}`.toLowerCase().split(/[^a-z0-9]+/);
  return tokens.some((t) => t !== "" && (SENSITIVE_TOKENS.has(t) || t.startsWith("gps")));
}

/**
 * Filter out every {@link isSensitiveChannel} channel. The first line of defense
 * for keeping coordinates/identifiers out of AI context.
 */
export function stripSensitiveChannels(channels: readonly LogChannel[]): LogChannel[] {
  return channels.filter((c) => !isSensitiveChannel(c));
}

/** Aggregate statistics for one channel over the selected window. */
export interface ChannelRangeStat {
  key: string;
  label: string;
  unit?: string;
  /** Minimum finite sample in the window. */
  min: number;
  /** Maximum finite sample in the window. */
  max: number;
  /** Arithmetic mean of finite samples in the window. */
  mean: number;
  /** Last finite sample in the window. */
  last: number;
  /** `last finite − first finite` over the window. */
  delta: number;
  /** Count of finite (non-NaN) samples used. */
  samples: number;
}

/**
 * Structured, GPS-free summary of a selected index window. Has no GPS field by
 * construction, so it cannot carry coordinates.
 */
export interface LogRangeSummary {
  source: LogSource;
  /** Clamped inclusive start index of the window. */
  startIndex: number;
  /** Clamped inclusive end index of the window. */
  endIndex: number;
  /** Number of time samples in the window (`endIndex - startIndex + 1`). */
  sampleCount: number;
  /** Window duration in ms (`time[endIndex] - time[startIndex]`). */
  durationMs: number;
  /** Per-channel aggregate stats, sensitive channels already excluded. */
  channels: ChannelRangeStat[];
}

/** Clamp `v` into the inclusive integer range `[lo, hi]`. */
function clampIndex(v: number, lo: number, hi: number): number {
  const i = Math.trunc(v);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

/** Compute window stats for one channel, or `null` if it has no finite samples. */
function statForChannel(
  channel: LogChannel,
  start: number,
  end: number
): ChannelRangeStat | null {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  let first = NaN;
  let last = NaN;
  for (let i = start; i <= end; i++) {
    const v = channel.values[i];
    if (!Number.isFinite(v)) continue;
    if (count === 0) first = v;
    last = v;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  }
  if (count === 0) return null;
  return {
    key: channel.key,
    label: channel.label,
    unit: channel.unit,
    min,
    max,
    mean: sum / count,
    last,
    delta: last - first,
    samples: count,
  };
}

/**
 * Summarise the inclusive index window `[startIndex, endIndex]` of `log` into
 * compact, GPS-free aggregate statistics ready to send to the AI assistant.
 *
 * Indices are clamped to the log's bounds and ordered, so out-of-range or
 * reversed inputs are handled safely. Sensitive channels are stripped before
 * any stats are computed, and `log.gps` is never read.
 */
export function summarizeLogRange(
  log: ParsedLog,
  startIndex: number,
  endIndex: number
): LogRangeSummary {
  const last = log.sampleCount - 1;
  if (last < 0) {
    return {
      source: log.source,
      startIndex: 0,
      endIndex: 0,
      sampleCount: 0,
      durationMs: 0,
      channels: [],
    };
  }
  let start = clampIndex(startIndex, 0, last);
  let end = clampIndex(endIndex, 0, last);
  if (start > end) [start, end] = [end, start];

  const safeChannels = stripSensitiveChannels(log.channels);
  const channels: ChannelRangeStat[] = [];
  for (const channel of safeChannels) {
    const stat = statForChannel(channel, start, end);
    if (stat) channels.push(stat);
  }

  const t0 = log.time[start];
  const t1 = log.time[end];
  const durationMs =
    Number.isFinite(t0) && Number.isFinite(t1) ? t1 - t0 : 0;

  return {
    source: log.source,
    startIndex: start,
    endIndex: end,
    sampleCount: end - start + 1,
    durationMs,
    channels,
  };
}

/** Round to at most 3 decimals, dropping a trailing `.0`, for compact output. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  const rounded = Math.round(n * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/**
 * Render a {@link LogRangeSummary} as a deterministic plain-text block suitable
 * for `assistant.sendMessage`. Contains only aggregate stats and window
 * metadata — no coordinates, no raw rows — and stays well under the FR-AI-11
 * 4,000-token cap.
 */
export function logRangeSummaryToPromptString(summary: LogRangeSummary): string {
  const lines: string[] = [];
  lines.push(`Flight log range summary (source=${summary.source})`);
  lines.push(
    `Window: samples ${summary.startIndex}..${summary.endIndex} ` +
      `(${summary.sampleCount} samples, ${fmt(summary.durationMs / 1000)}s)`
  );
  if (summary.channels.length === 0) {
    lines.push("No channel data in the selected window.");
    return lines.join("\n");
  }
  lines.push("Channels (per-channel stats over the window):");
  for (const c of summary.channels) {
    const unit = c.unit ? ` ${c.unit}` : "";
    lines.push(
      `- ${c.label} [${c.key}]: min=${fmt(c.min)}${unit} max=${fmt(c.max)}${unit} ` +
        `mean=${fmt(c.mean)}${unit} last=${fmt(c.last)}${unit} ` +
        `delta=${fmt(c.delta)}${unit} n=${c.samples}`
    );
  }
  return lines.join("\n");
}

/**
 * Convenience: summarise a window and render it to a prompt string in one call.
 */
export function summarizeLogRangeToPromptString(
  log: ParsedLog,
  startIndex: number,
  endIndex: number
): string {
  return logRangeSummaryToPromptString(summarizeLogRange(log, startIndex, endIndex));
}
