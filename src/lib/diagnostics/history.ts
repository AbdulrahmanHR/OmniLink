/**
 * Pure per-session history summary (M40, v2.0.2).
 *
 * The bridge between one analyzed session (its M36 {@link DiagnosticReport} + M38
 * {@link SessionPatternReport} + the raw {@link ParsedLog}) and the persisted
 * diagnostic-history record the /trends surface aggregates over. Everything here
 * is **pure/deterministic** — no `Date.now`, no `Math.random`, no I/O, no
 * `log.gps`: the impure layer (the history store + the analysis page) supplies
 * the `recordedAt` timestamp and the device origin, never this module.
 *
 * ## Safety
 * A {@link SessionHistorySummary} carries only non-identifying rollups — a
 * content signature, sample/duration counts, a health score, per-severity /
 * per-rule tallies, pattern ids, and a single median packet rate. No coordinate,
 * UID, MAC, IP, or serial is ever read or emitted (same contract as `export.ts`).
 */

import type { ParsedLog } from "@/lib/blackbox";
import type { DiagnosticReport, SessionPatternReport } from "./types";
import { CHANNEL_CANDIDATES, isFiniteNumber, resolveChannelValues, round2 } from "./util";

/** Samples folded into the content checksum (evenly strided across a channel). */
const CHECKSUM_SAMPLES = 64;

/**
 * FNV-1a 32-bit hash of a string — pure, deterministic, and overflow-safe via
 * `Math.imul` (32-bit multiply) + `>>> 0` (unsigned coercion), so it never relies
 * on IEEE-754 rounding of a large product. Returned as an unsigned int.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Downsample a channel to ≤{@link CHECKSUM_SAMPLES} rounded tokens (gaps → `n`). */
function sampleTokens(values: readonly number[]): string {
  const n = values.length;
  if (n === 0) return "";
  const step = Math.max(1, Math.floor(n / CHECKSUM_SAMPLES));
  const tokens: string[] = [];
  for (let i = 0; i < n; i += step) {
    const v = values[i];
    tokens.push(isFiniteNumber(v) ? String(Math.round(v)) : "n");
  }
  return tokens.join(",");
}

/**
 * A pure content checksum of the session's key channels (`link_quality` + `rssi1`),
 * downsampled + rounded then FNV-1a-hashed. Two flights with the same shape but
 * different channel values hash differently. Absent channels contribute a fixed
 * `x` token so their absence is itself part of the checksum.
 */
function contentChecksum(log: ParsedLog): string {
  const lq = resolveChannelValues(log, CHANNEL_CANDIDATES.linkQuality);
  const rssi = resolveChannelValues(log, CHANNEL_CANDIDATES.rssi1);
  const payload = `${lq ? sampleTokens(lq) : "x"}|${rssi ? sampleTokens(rssi) : "x"}`;
  return fnv1a32(payload).toString(16);
}

/**
 * A stable content signature for a parsed session, used to dedupe history
 * records so re-analyzing (a config tweak) or re-importing the same content
 * updates the existing record in place rather than piling up duplicates.
 *
 * Combines the time/shape axis — `${source}|${sampleCount}|${durationMs}|
 * ${time[0]}|${time[last]}` — with a pure content checksum of the `link_quality`
 * and `rssi1` channels. The checksum is essential: imported CSV/`.bbl` logs use
 * RELATIVE time (start `0`), so the shape prefix alone collapses to
 * `source|sampleCount|durationMs` and two genuinely different flights with the same
 * frame count + duration would COLLIDE (dedupe would silently drop one). Folding in
 * the channel content makes two same-shape-but-different-content flights sign
 * distinctly, while the same loaded log always signs identically. Empty logs coerce
 * their endpoints to `0`.
 */
export function computeSessionSignature(log: ParsedLog): string {
  const first = log.time[0] ?? 0;
  const last = log.time.length > 0 ? log.time[log.time.length - 1] : 0;
  return `${log.source}|${log.sampleCount}|${log.durationMs}|${first}|${last}|${contentChecksum(
    log
  )}`;
}

/**
 * The pure, device-agnostic summary of one analyzed session. Holds everything
 * the trends engine needs EXCEPT the impure axes (`recordedAt`, device origin),
 * which the store layers on when it forms a {@link DiagnosticHistoryRecord}.
 */
export interface SessionHistorySummary {
  /** Content signature (dedupe key); see {@link computeSessionSignature}. */
  signature: string;
  /** Which parser produced the session. */
  source: "blackbox" | "omnilog";
  /** Number of time samples analysed. */
  sampleCount: number;
  /** Session duration in ms. */
  durationMs: number;
  /** Overall session health, 0–100. */
  healthScore: number;
  /** Finding counts per severity. */
  countsBySeverity: { info: number; warning: number; critical: number };
  /** ruleId → number of findings of that rule in this session. */
  ruleCounts: Record<string, number>;
  /** Distinct pattern ids detected this session (deduped + sorted). */
  patternIds: string[];
  /** Median finite packet_rate (Hz) over the session, or `null` when absent. */
  packetRate: number | null;
}

/**
 * One persisted diagnostic-history record: a {@link SessionHistorySummary} plus
 * the impure axes the store supplies — the record timestamp (the trend ordering
 * axis) and the device origin (for per-device grouping; `null` = unknown device,
 * e.g. an imported CSV that carries no device metadata).
 *
 * Defined here in the pure layer (rather than the store) so the trends engine can
 * consume it without importing the store — keeping `@/lib/diagnostics` free of a
 * store dependency. The store re-exports it.
 */
export interface DiagnosticHistoryRecord extends SessionHistorySummary {
  /** `Date.now()` at record time (the trend ordering axis). */
  recordedAt: number;
  /** Device grouping key (`${targetName}|${firmware}` / `targetName`), or `null`. */
  deviceKey: string | null;
  /** Human device label (`targetName`), or `null` for an unknown device. */
  deviceLabel: string | null;
}

/** Median of the finite entries of `values` (round-2), or `null` when none. */
function medianFinite(values: readonly number[]): number | null {
  const finite = values.filter(isFiniteNumber).slice().sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const mid = Math.floor(finite.length / 2);
  const med =
    finite.length % 2 === 1 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
  return round2(med);
}

/**
 * Summarize one analyzed session into a pure {@link SessionHistorySummary}.
 *
 * `ruleCounts` tallies `report.findings` by `ruleId`; `patternIds` is the deduped,
 * sorted set of `patternReport.patterns[].patternId`; `packetRate` is the median
 * finite `packet_rate` reading (or `null`). Deterministic: the same inputs always
 * yield a deep-equal summary.
 */
export function summarizeSessionForHistory(
  report: DiagnosticReport,
  patternReport: SessionPatternReport,
  log: ParsedLog
): SessionHistorySummary {
  const ruleCounts: Record<string, number> = {};
  for (const finding of report.findings) {
    ruleCounts[finding.ruleId] = (ruleCounts[finding.ruleId] ?? 0) + 1;
  }

  const patternIds = Array.from(
    new Set(patternReport.patterns.map((p) => p.patternId))
  ).sort();

  const packetSeries = resolveChannelValues(log, CHANNEL_CANDIDATES.packetRate);
  const packetRate = packetSeries ? medianFinite(packetSeries) : null;

  const counts = report.sessionSummary.countsBySeverity;

  return {
    signature: computeSessionSignature(log),
    source: log.source,
    sampleCount: log.sampleCount,
    durationMs: log.durationMs,
    healthScore: report.healthScore,
    countsBySeverity: {
      info: counts.info,
      warning: counts.warning,
      critical: counts.critical,
    },
    ruleCounts,
    patternIds,
    packetRate,
  };
}
