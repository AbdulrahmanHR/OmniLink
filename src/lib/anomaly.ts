/**
 * Flight-log anomaly detection over the shared {@link ParsedLog} model (M15,
 * FR-ANOM-01..04).
 *
 * This module scans a parsed flight log (from `blackbox.ts` or `omnilog.ts`) for
 * a small, fixed set of link-health anomalies and returns them as a sorted list
 * of {@link AnomalyEvent}s. Each event carries the time-axis index it points at
 * (for the chart cursor/marker), the index window it spans (so a user can
 * "send this event to the AI"), an i18n {@link AnomalyEvent.messageKey}, and an
 * optional {@link AnomalyEvent.detail} bag of interpolation values.
 *
 * ## Detectors
 *  1. **signalLoss** — over the resolved RSSI channel, every maximal run of
 *     consecutive finite samples at-or-below `signalLoss.rssiFloorDbm` whose
 *     length is `>= signalLoss.minSamples`. One event per run, pointing at the
 *     run's minimum RSSI; severity `critical`.
 *  2. **failsafe** — from a dedicated failsafe channel when present (each
 *     inactive→active transition), otherwise inferred from a run of link-quality
 *     `=== 0` of length `>= failsafe.lqZeroSamples`. The two sources are mutually
 *     exclusive (the inferred path only runs when no failsafe channel exists), so
 *     a moment is never double-emitted. Severity `critical`.
 *  3. **lqDrop** — over the link-quality channel, a fall of `>= lqDrop.slopeDrop`
 *     within a sliding `lqDrop.window`, or a crossing below `lqDrop.absThreshold`
 *     from above it. Debounced: at most one event per drop until LQ recovers back
 *     above `absThreshold`. Severity `critical` when the bottom is
 *     `<= lqDrop.criticalTo`, else `warning`. A drop bottoming at `0` is ceded to
 *     the failsafe detector **only when failsafe will actually own it** (a
 *     dedicated failsafe channel exists, or the zero-touch lasts
 *     `>= failsafe.lqZeroSamples` consecutive samples); a briefer zero-dip is
 *     still emitted here, so the moment is never lost by both detectors.
 *  4. **txPowerChange** — over the TX-power channel, every pair of consecutive
 *     finite samples whose absolute difference is `>= txPowerChange.minDeltaMw`.
 *     Severity `info`.
 *
 * ## Determinism
 * All logic is pure arithmetic over the log's arrays — no `Date.now`, no
 * `Math.random`. `NaN` samples are treated strictly as gaps (never as a value),
 * so detectors never fire on missing data.
 *
 * ## Safety — no GPS / no identifiers in `detail`
 * Detectors read **only** `log.channels` (RSSI, link quality, TX power, and a
 * failsafe flag); they never touch `log.gps`. Every `detail` value is a
 * non-identifying physical quantity — an RSSI in dBm, a link-quality percentage,
 * or a TX-power level in mW — never a coordinate, UID, MAC, IP, email, or any
 * other identifier. This keeps an event safe to interpolate into a UI string and
 * safe to forward to the AI assistant.
 */

import type { LogChannel, ParsedLog } from "@/lib/blackbox";

// ---------------------------------------------------------------------------
// Public contract (consumed by the M15 UI + send-to-AI agents)
// ---------------------------------------------------------------------------

/** The kinds of anomaly this module can detect. */
export type AnomalyType = "signalLoss" | "failsafe" | "lqDrop" | "txPowerChange";

/** How serious a detected anomaly is, for badge colour and sorting. */
export type AnomalySeverity = "info" | "warning" | "critical";

/**
 * One detected anomaly, anchored to a single sample on the log's `time` axis.
 *
 * `index` is the marker/cursor position; `startIndex`..`endIndex` is the
 * inclusive sample window the event covers (used when sending the event to the
 * AI). `messageKey` is always one of the four pinned i18n keys — never a
 * hardcoded sentence — and `detail` carries only non-identifying interpolation
 * values (RSSI / link quality / TX power); never GPS, coordinates, or any
 * identifier.
 */
export interface AnomalyEvent {
  type: AnomalyType;
  severity: AnomalySeverity;
  /** Sample index into `log.time` (the marker/cursor position). */
  index: number;
  /** `log.time[index]`, in milliseconds. */
  t: number;
  /** Event window start (inclusive) — for send-to-AI. */
  startIndex: number;
  /** Event window end (inclusive). */
  endIndex: number;
  /** i18n key (one of the four `anomaly.message.*` keys). */
  messageKey: string;
  /** Interpolation values for the i18n string — only non-identifying numbers. */
  detail?: Record<string, number | string>;
}

/** Tunable thresholds for each detector. */
export interface AnomalyConfig {
  signalLoss: { rssiFloorDbm: number; minSamples: number };
  failsafe: { lqZeroSamples: number };
  lqDrop: { absThreshold: number; slopeDrop: number; window: number; criticalTo: number };
  txPowerChange: { minDeltaMw: number };
}

/** Default detector thresholds (pinned across the M15 build). */
export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  signalLoss: { rssiFloorDbm: -100, minSamples: 3 },
  failsafe: { lqZeroSamples: 2 },
  lqDrop: { absThreshold: 50, slopeDrop: 30, window: 5, criticalTo: 20 },
  txPowerChange: { minDeltaMw: 1 },
};

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Round to at most two decimals (keeps `detail` values tidy for the UI/AI). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Clamp a sample index into the valid `[0, max]` range. */
function clampIndex(i: number, max: number): number {
  return i < 0 ? 0 : i > max ? max : i;
}

/**
 * Resolve a channel by trying `candidates` in priority order, matching each
 * candidate case-insensitively against `channel.key`. Returns the first hit, so
 * earlier candidates win (e.g. `rssi1` is preferred over a bare `rssi`).
 */
function findChannelByKeys(log: ParsedLog, candidates: readonly string[]): LogChannel | undefined {
  for (const cand of candidates) {
    const want = cand.toLowerCase();
    const found = log.channels.find((c) => c.key.toLowerCase() === want);
    if (found) return found;
  }
  return undefined;
}

/** First channel whose key OR label contains `"failsafe"` (case-insensitive). */
function findFailsafeChannel(log: ParsedLog): LogChannel | undefined {
  return log.channels.find((c) => `${c.key} ${c.label}`.toLowerCase().includes("failsafe"));
}

/**
 * Build a fully-formed {@link AnomalyEvent}, resolving `t` from the time axis and
 * clamping all indices into `[0, sampleCount - 1]`.
 */
function makeEvent(
  log: ParsedLog,
  type: AnomalyType,
  severity: AnomalySeverity,
  index: number,
  startIndex: number,
  endIndex: number,
  messageKey: string,
  detail: Record<string, number | string>
): AnomalyEvent {
  const max = log.sampleCount - 1;
  const i = clampIndex(index, max);
  return {
    type,
    severity,
    index: i,
    t: log.time[i],
    startIndex: clampIndex(startIndex, max),
    endIndex: clampIndex(endIndex, max),
    messageKey,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Detector 1 — signal loss
// ---------------------------------------------------------------------------

/**
 * Maximal runs of consecutive finite RSSI samples at-or-below `rssiFloorDbm`
 * whose length reaches `minSamples`. One event per run, anchored to the run's
 * minimum RSSI; `detail.rssi` is that minimum. Emits nothing when there is no
 * RSSI channel.
 */
function detectSignalLoss(log: ParsedLog, cfg: AnomalyConfig): AnomalyEvent[] {
  const ch = findChannelByKeys(log, ["rssi1", "rssi", "RSSI"]);
  if (!ch) return [];

  const { rssiFloorDbm, minSamples } = cfg.signalLoss;
  const out: AnomalyEvent[] = [];
  let runStart = -1;
  let minVal = Infinity;
  let minIdx = -1;

  const flush = (endExclusive: number): void => {
    if (runStart !== -1) {
      if (endExclusive - runStart >= minSamples) {
        out.push(
          makeEvent(log, "signalLoss", "critical", minIdx, runStart, endExclusive - 1, "anomaly.message.signalLoss", {
            rssi: round2(minVal),
          })
        );
      }
      runStart = -1;
      minVal = Infinity;
      minIdx = -1;
    }
  };

  for (let i = 0; i < log.sampleCount; i++) {
    const v = ch.values[i];
    if (Number.isFinite(v) && v <= rssiFloorDbm) {
      if (runStart === -1) runStart = i;
      if (v < minVal) {
        minVal = v;
        minIdx = i;
      }
    } else {
      flush(i); // a non-finite sample or one above the floor ends the run
    }
  }
  flush(log.sampleCount);
  return out;
}

// ---------------------------------------------------------------------------
// Detector 2 — failsafe
// ---------------------------------------------------------------------------

/**
 * Failsafe entry, from whichever source the log provides:
 *  - a dedicated failsafe channel → every inactive(`<= 0` / `NaN`)→active(`> 0`)
 *    transition becomes an event spanning the contiguous active run, with
 *    `detail.lq` taken from the link-quality channel at the entry sample (or `0`);
 *  - otherwise → maximal runs of finite link-quality `=== 0` of length
 *    `>= lqZeroSamples`, with `detail.lq = 0`.
 *
 * The two paths are mutually exclusive (the inferred path runs only when no
 * failsafe channel exists), so a single moment is never emitted twice.
 */
function detectFailsafe(log: ParsedLog, cfg: AnomalyConfig): AnomalyEvent[] {
  const out: AnomalyEvent[] = [];
  const lqCh = findChannelByKeys(log, ["link_quality", "lq", "linkQuality"]);
  const fsCh = findFailsafeChannel(log);
  const n = log.sampleCount;

  if (fsCh) {
    // A failsafe channel is authoritative: when one exists, the LQ===0 fallback
    // below is suppressed entirely (we `return` from this branch). By design an
    // LQ===0 sample alongside a failsafe channel that never activates yields NO
    // failsafe event — the channel, not link quality, is the source of truth.
    const isActive = (v: number): boolean => Number.isFinite(v) && v > 0;
    let i = 0;
    while (i < n) {
      const prevActive = i > 0 ? isActive(fsCh.values[i - 1]) : false;
      if (isActive(fsCh.values[i]) && !prevActive) {
        const start = i;
        let end = i;
        while (end + 1 < n && isActive(fsCh.values[end + 1])) end++;
        const lqRaw = lqCh ? lqCh.values[start] : NaN;
        const lq = Number.isFinite(lqRaw) ? round2(lqRaw) : 0;
        out.push(makeEvent(log, "failsafe", "critical", start, start, end, "anomaly.message.failsafe", { lq }));
        i = end + 1;
      } else {
        i++;
      }
    }
    return out;
  }

  if (lqCh) {
    const { lqZeroSamples } = cfg.failsafe;
    let runStart = -1;
    const flush = (endExclusive: number): void => {
      if (runStart !== -1) {
        if (endExclusive - runStart >= lqZeroSamples) {
          out.push(
            makeEvent(log, "failsafe", "critical", runStart, runStart, endExclusive - 1, "anomaly.message.failsafe", {
              lq: 0,
            })
          );
        }
        runStart = -1;
      }
    };
    for (let i = 0; i < n; i++) {
      const v = lqCh.values[i];
      if (Number.isFinite(v) && v === 0) {
        if (runStart === -1) runStart = i;
      } else {
        flush(i);
      }
    }
    flush(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detector 3 — link-quality drop
// ---------------------------------------------------------------------------

/**
 * Sharp link-quality drops, debounced to one event per drop until LQ recovers
 * back above `absThreshold`. A drop edge is a finite sample that either falls
 * `>= slopeDrop` below the max finite sample in the preceding `window` samples,
 * or crosses below `absThreshold` from a preceding high that was at-or-above it.
 * The event is anchored to the lowest sample reached before recovery (the
 * bottom), spanning from the pre-drop high to that bottom; `detail.from` is the
 * high, `detail.to` the bottom. A bottom of `0` is ceded to the failsafe detector
 * only when failsafe will actually claim it (a failsafe channel exists, or the
 * zero-touch reaches `failsafe.lqZeroSamples` consecutive samples); a shorter
 * zero-dip is still emitted here, so the moment is never dropped by both detectors.
 */
function detectLqDrop(log: ParsedLog, cfg: AnomalyConfig): AnomalyEvent[] {
  const ch = findChannelByKeys(log, ["link_quality", "lq", "linkQuality"]);
  if (!ch) return [];

  const { absThreshold, slopeDrop, window, criticalTo } = cfg.lqDrop;
  const n = log.sampleCount;
  const out: AnomalyEvent[] = [];

  // A bottom of 0 is failsafe's to own — but only when failsafe will actually
  // claim it. The failsafe LQ-zero fallback runs only when there is no dedicated
  // failsafe channel, and only fires for a maximal run of finite LQ === 0 of
  // length >= failsafe.lqZeroSamples. Mirror that gate here so a zero-touch too
  // brief to qualify (and unclaimed by a channel) is still reported as an lqDrop
  // rather than silently dropped by both detectors.
  const hasFailsafeChannel = findFailsafeChannel(log) !== undefined;
  const zeroTouchOwnedByFailsafe = (idx: number): boolean => {
    if (hasFailsafeChannel) return true;
    let run = 1;
    for (let j = idx - 1; j >= 0; j--) {
      const pv = ch.values[j];
      if (!Number.isFinite(pv) || pv !== 0) break;
      run++;
    }
    for (let j = idx + 1; j < n; j++) {
      const nv = ch.values[j];
      if (!Number.isFinite(nv) || nv !== 0) break;
      run++;
    }
    return run >= cfg.failsafe.lqZeroSamples;
  };

  let armed = true;
  let inDrop = false;
  let preHighIdx = -1;
  let preHighVal = NaN;
  let bottomIdx = -1;
  let bottomVal = NaN;

  const emit = (): void => {
    // A drop to 0 is failsafe's to own only when failsafe will actually claim
    // it; otherwise (a zero-touch too brief for the LQ-zero fallback and with no
    // failsafe channel) report it here so the moment isn't lost by both.
    if (bottomVal !== 0 || !zeroTouchOwnedByFailsafe(bottomIdx)) {
      const severity: AnomalySeverity = bottomVal <= criticalTo ? "critical" : "warning";
      out.push(
        makeEvent(log, "lqDrop", severity, bottomIdx, preHighIdx, bottomIdx, "anomaly.message.lqDrop", {
          from: round2(preHighVal),
          to: round2(bottomVal),
        })
      );
    }
    inDrop = false;
    armed = true;
  };

  for (let i = 0; i < n; i++) {
    const v = ch.values[i];
    if (!Number.isFinite(v)) continue;

    if (inDrop) {
      if (v < bottomVal) {
        bottomVal = v;
        bottomIdx = i;
      }
      if (v > absThreshold) emit(); // recovered — close out the drop
      continue;
    }

    // Not in a drop: find the max finite sample in the preceding `window`.
    // By design, a drop edge needs a preceding in-window high to fall from, so a
    // log that STARTS already at/below `absThreshold` (no earlier higher sample)
    // never flags an lqDrop — there is no "drop", only a low baseline.
    let maxVal = -Infinity;
    let maxIdx = -1;
    for (let j = i - 1; j >= 0 && j >= i - window; j--) {
      const pv = ch.values[j];
      if (Number.isFinite(pv) && pv > maxVal) {
        maxVal = pv;
        maxIdx = j;
      }
    }
    if (armed && maxIdx !== -1) {
      const slopeHit = maxVal - v >= slopeDrop;
      const absCross = v < absThreshold && maxVal >= absThreshold;
      if (slopeHit || absCross) {
        inDrop = true;
        armed = false;
        preHighIdx = maxIdx;
        preHighVal = maxVal;
        bottomIdx = i;
        bottomVal = v;
      }
    }
  }
  if (inDrop) emit(); // drop never recovered before the log ended
  return out;
}

// ---------------------------------------------------------------------------
// Detector 4 — TX-power change
// ---------------------------------------------------------------------------

/**
 * Every change of `>= minDeltaMw` between consecutive finite TX-power samples
 * (gaps are skipped, so "consecutive" means consecutive non-`NaN` values). The
 * event is anchored to the changed (later) sample; `detail.from`/`detail.to` are
 * the surrounding levels. Severity `info`.
 */
function detectTxPowerChange(log: ParsedLog, cfg: AnomalyConfig): AnomalyEvent[] {
  const ch = findChannelByKeys(log, ["tx_power", "txPower"]);
  if (!ch) return [];

  const { minDeltaMw } = cfg.txPowerChange;
  const out: AnomalyEvent[] = [];
  let prevVal = NaN;
  let prevIdx = -1;

  for (let i = 0; i < log.sampleCount; i++) {
    const v = ch.values[i];
    if (!Number.isFinite(v)) continue;
    if (prevIdx !== -1 && Math.abs(v - prevVal) >= minDeltaMw) {
      out.push(
        makeEvent(log, "txPowerChange", "info", i, i, i, "anomaly.message.txPowerChange", {
          from: round2(prevVal),
          to: round2(v),
        })
      );
    }
    prevVal = v;
    prevIdx = i;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run every detector over `log` and return all anomalies sorted ascending by
 * sample `index` (stable for ties). An empty log yields `[]`.
 */
export function detectAnomalies(log: ParsedLog, config: AnomalyConfig = DEFAULT_ANOMALY_CONFIG): AnomalyEvent[] {
  if (log.sampleCount === 0) return [];

  const events: AnomalyEvent[] = [
    ...detectSignalLoss(log, config),
    ...detectFailsafe(log, config),
    ...detectLqDrop(log, config),
    ...detectTxPowerChange(log, config),
  ];

  // Array.prototype.sort is stable (ES2019+), so equal-index events keep the
  // detector concatenation order above.
  events.sort((a, b) => a.index - b.index);
  return events;
}
