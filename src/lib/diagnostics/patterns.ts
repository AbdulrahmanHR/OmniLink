/**
 * Session-level pattern detection (M38, v2.0.1 backfill).
 *
 * Where the M36 engine ({@link import("./engine").evaluateSession}) grades each
 * *window* of a session with a {@link DiagnosticFinding}, this module reads those
 * findings back — plus the raw channels and the GPS track — and surfaces the
 * *recurring/correlated* stories that are hard to see from raw charts:
 *
 *  - **repeated-lq-drops** — the link keeps collapsing (≥ N `lq-collapse`s);
 *  - **heading-degradation** — a *direction*-correlated null (weak only when the
 *    craft faces one sector, not a uniformly weak link);
 *  - **gps-area-degradation** — a *location*-correlated weak spot the flight
 *    passes through more than once; and
 *  - **power-packet-link-events** — TX power / packet-rate shifting around the
 *    link events (edge-of-link-budget behaviour).
 *
 * ## Purity
 * Same contract as the M36 engine: pure & deterministic. No `Date.now`, no
 * `Math.random`, no I/O, no DOM, no store access. Same `(log, report, config)`
 * always yields a deeply-equal {@link SessionPatternReport}. This is an ADDITIVE
 * layer — it does not touch {@link DiagnosticConfig} or any M36 threshold; its own
 * thresholds live in the self-contained {@link PatternConfig} below.
 *
 * ## Safety
 * Every pattern's `detail` bag carries **only** non-identifying numbers/strings.
 * The GPS detector grid-buckets coordinates internally to find recurring passes,
 * but a cell key / lat / lon is **never** emitted — only counts and LQ percentages
 * leave the detector, exactly like a {@link DiagnosticFinding.detail}.
 */

import type { ParsedLog } from "@/lib/blackbox";
import { CHANNEL_CANDIDATES, clamp01, isFiniteNumber, resolveChannelValues, round2 } from "./util";
import type {
  DiagnosticReport,
  DiagnosticSeverity,
  EvidenceWindow,
  SessionPattern,
  SessionPatternReport,
} from "./types";

/**
 * Below this sample count a session is too short for any session-level pattern to
 * be meaningful — {@link detectSessionPatterns} short-circuits with
 * `hasEnoughEvidence: false` (drives the UI's honest "not enough evidence" state).
 */
export const MIN_SAMPLES_FOR_PATTERNS = 40;

/**
 * Candidate keys for the heading channel, tried in priority order (defined here,
 * not in the frozen `util.ts`). Betaflight imports carry the GPS ground course
 * under different keys, so a bare `"heading"` is not enough.
 */
const HEADING_CANDIDATES = [
  "heading",
  "GPS_ground_course",
  "gps_ground_course",
  "course",
] as const;

/**
 * Self-contained thresholds for the pattern detectors. Deliberately NOT part of
 * {@link DiagnosticConfig}: the M36 config/presets are frozen, and these knobs are
 * only ever a frozen default (no per-user tuning surface in M38).
 */
export interface PatternConfig {
  /** A — minimum `lq-collapse` findings to raise `repeated-lq-drops`. */
  minDrops: number;
  /** B — minimum finite samples in a heading sector for it to count. */
  headingMinSamplesPerSector: number;
  /**
   * B — a bad sector must also hold at least this FRACTION of the session's finite
   * heading&lq samples. Kills a long-flight transient that clears the absolute
   * per-sector floor but is a tiny slice of the whole flight (not a sustained,
   * direction-correlated null).
   */
  headingMinBadFraction: number;
  /** B — a sector's LQ must fall this far below baseline to be "bad". */
  headingDegradationDelta: number;
  /** B — a "bad" sector's mean LQ must also be below this floor (%). */
  headingLqFloor: number;
  /** B — required max−min sector-mean spread (the heading-CORRELATED guard). */
  headingSpreadThreshold: number;
  /** C — minimum non-null GPS fixes to attempt the area detector. */
  gpsMinFixCount: number;
  /** C — grid cell size in degrees (~50 m at mid-latitudes). Internal only. */
  gpsCellSize: number;
  /** C — a cell needs at least this many passes to count as "recurring". */
  gpsMinPasses: number;
  /** C — a recurring cell's mean LQ must fall this far below baseline to be "bad". */
  gpsDegradationDelta: number;
  /** D — lead-in samples inspected before each event window. */
  eventLeadIn: number;
  /** D — TX power rise (mW) from lead-in min to event max counted as a ramp. */
  txStepMw: number;
  /** D — minimum events showing a power/packet change to raise the pattern. */
  minEvents: number;
  /** B/C — cap on the number of evidence windows emitted per pattern. */
  maxWindows: number;
}

/**
 * Frozen default pattern thresholds. Tuned on the DL2 corpus so the antenna
 * fixtures raise `heading-degradation` and the recurring/multi-drop fixtures raise
 * `repeated-lq-drops`, while **every healthy fixture stays pattern-free** (a
 * uniform link has near-zero heading spread, so B never fires; healthy sessions
 * have no `lq-collapse`/`rssi-floor` findings, so A and D never fire; and the
 * corpus carries no GPS, so C never fires).
 *
 * The heading detector requires a bad sector to be **sustained**: at least
 * `headingMinSamplesPerSector` (20) samples AND at least `headingMinBadFraction`
 * (5%) of the whole flight. The DL2 antenna nulls dwell 33–48 samples (~10–13% of
 * the flight) and stay positive; a brief transient excursion into one heading does
 * not (the antenna bad sectors are direction-correlated, a transient is not).
 */
export const DEFAULT_PATTERN_CONFIG: PatternConfig = {
  minDrops: 3,
  headingMinSamplesPerSector: 20,
  headingMinBadFraction: 0.05,
  headingDegradationDelta: 15,
  headingLqFloor: 85,
  headingSpreadThreshold: 15,
  gpsMinFixCount: 30,
  gpsCellSize: 0.0005,
  gpsMinPasses: 2,
  gpsDegradationDelta: 15,
  eventLeadIn: 10,
  txStepMw: 100,
  minEvents: 2,
  maxWindows: 12,
};

/** Sort rank for a severity (critical first) — mirrors `engine.ts`. */
function severityRank(severity: DiagnosticSeverity): number {
  return severity === "critical" ? 0 : severity === "warning" ? 1 : 2;
}

/** Mean of a non-empty numeric array. */
function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Clone an evidence window (avoids sharing a finding's window object). */
function cloneWindow(w: EvidenceWindow): EvidenceWindow {
  return { startIndex: w.startIndex, endIndex: w.endIndex };
}

/** Cap `windows` to `max` (keep the longest, deterministic ties), sort ascending. */
function capWindows(windows: EvidenceWindow[], max: number): EvidenceWindow[] {
  if (windows.length <= max) {
    return [...windows].sort((a, b) => a.startIndex - b.startIndex);
  }
  const kept = [...windows]
    .sort((a, b) => {
      const lenA = a.endIndex - a.startIndex;
      const lenB = b.endIndex - b.startIndex;
      if (lenB !== lenA) return lenB - lenA;
      return a.startIndex - b.startIndex;
    })
    .slice(0, max);
  return kept.sort((a, b) => a.startIndex - b.startIndex);
}

/** Heading (deg) → 45° sector index in `[0, 8)`. */
function headingSector(deg: number): number {
  return Math.floor((((deg % 360) + 360) % 360) / 45);
}

/**
 * Maximal runs of consecutive sample indices whose (finite) heading falls in one
 * of `badSectors`. Each run is one evidence window.
 */
function runsForSectors(
  heading: readonly number[],
  badSectors: ReadonlySet<number>,
  max: number
): EvidenceWindow[] {
  const runs: EvidenceWindow[] = [];
  let start = -1;
  for (let i = 0; i < heading.length; i++) {
    const h = heading[i];
    const inBad = isFiniteNumber(h) && badSectors.has(headingSector(h));
    if (inBad) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      runs.push({ startIndex: start, endIndex: i - 1 });
      start = -1;
    }
  }
  if (start !== -1) runs.push({ startIndex: start, endIndex: heading.length - 1 });
  return capWindows(runs, max);
}

// ---------------------------------------------------------------------------
// Detector A — repeated-lq-drops (link)
// ---------------------------------------------------------------------------

function detectRepeatedLqDrops(
  report: DiagnosticReport,
  config: PatternConfig
): SessionPattern | null {
  const drops = report.findings.filter((f) => f.ruleId === "lq-collapse");
  if (drops.length < config.minDrops) return null;

  const windows = drops
    .map((f) => cloneWindow(f.evidenceWindow))
    .sort((a, b) => a.startIndex - b.startIndex);
  const bottoms = drops
    .map((f) => Number(f.detail.to))
    .filter((n) => Number.isFinite(n));
  const lowestLq = bottoms.length ? Math.min(...bottoms) : 0;
  const anyCritical = drops.some((f) => f.severity === "critical");

  return {
    patternId: "repeated-lq-drops",
    category: "link",
    severity: anyCritical ? "critical" : "warning",
    confidence: round2(clamp01(drops.length / 5)),
    evidenceWindows: windows,
    summaryKey: "diagnostics.patternSummary.repeatedLqDrops",
    evidenceKey: "diagnostics.patternEvidence.repeatedLqDrops",
    checkFirstKey: "diagnostics.patternCheck.repeatedLqDrops",
    detail: { drops: drops.length, lowestLq: round2(lowestLq) },
  };
}

// ---------------------------------------------------------------------------
// Detector B — heading-degradation (signal)
// ---------------------------------------------------------------------------

function detectHeadingDegradation(
  log: ParsedLog,
  config: PatternConfig
): SessionPattern | null {
  const heading = resolveChannelValues(log, HEADING_CANDIDATES);
  const lq = resolveChannelValues(log, CHANNEL_CANDIDATES.linkQuality);
  if (!heading || !lq) return null;

  const sums = new Array<number>(8).fill(0);
  const counts = new Array<number>(8).fill(0);
  let totalFiniteSamples = 0;
  for (let i = 0; i < log.sampleCount; i++) {
    const h = heading[i];
    const q = lq[i];
    if (!isFiniteNumber(h) || !isFiniteNumber(q)) continue;
    const s = headingSector(h);
    sums[s] += q;
    counts[s] += 1;
    totalFiniteSamples += 1;
  }

  const qualifying: { sector: number; mean: number; count: number }[] = [];
  for (let s = 0; s < 8; s++) {
    if (counts[s] >= config.headingMinSamplesPerSector) {
      qualifying.push({ sector: s, mean: sums[s] / counts[s], count: counts[s] });
    }
  }
  // Need at least two sectors to speak of a direction-correlated difference.
  if (qualifying.length < 2) return null;

  const means = qualifying.map((q) => q.mean);
  const spread = Math.max(...means) - Math.min(...means);
  // CRITICAL guard: a uniformly-weak link (small spread) is M36's job, not a
  // heading pattern — require a real per-direction difference before firing.
  if (spread < config.headingSpreadThreshold) return null;

  // Two-pass baseline: provisional (all sectors) → drop the bad ones → recompute
  // over the good sectors so a deep null does not drag the baseline down.
  const baseline1 = mean(means);
  const isBad1 = (m: number): boolean =>
    m < config.headingLqFloor && baseline1 - m >= config.headingDegradationDelta;
  const good = qualifying.filter((q) => !isBad1(q.mean));
  const baseline = good.length ? mean(good.map((q) => q.mean)) : baseline1;

  // A bad sector must be depressed (delta + floor) AND hold a real slice of the
  // flight (fraction guard) — so a brief transient excursion into one heading is
  // NOT mistaken for a sustained, direction-correlated null.
  const minBadCount = config.headingMinBadFraction * totalFiniteSamples;
  const bad = qualifying.filter(
    (q) =>
      q.mean < config.headingLqFloor &&
      baseline - q.mean >= config.headingDegradationDelta &&
      q.count >= minBadCount
  );
  if (bad.length === 0) return null;

  const badSectors = new Set(bad.map((b) => b.sector));
  const worst = bad.reduce((a, b) => (b.mean < a.mean ? b : a));
  const windows = runsForSectors(heading, badSectors, config.maxWindows);
  if (windows.length === 0) return null;

  return {
    patternId: "heading-degradation",
    category: "signal",
    severity: "warning",
    confidence: round2(clamp01((baseline - worst.mean) / 40)),
    evidenceWindows: windows,
    summaryKey: "diagnostics.patternSummary.headingDegradation",
    evidenceKey: "diagnostics.patternEvidence.headingDegradation",
    checkFirstKey: "diagnostics.patternCheck.headingDegradation",
    detail: {
      sectorDeg: Math.round(worst.sector * 45 + 22.5),
      sectorLq: Math.round(worst.mean),
      baselineLq: Math.round(baseline),
      sectors: bad.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Detector C — gps-area-degradation (signal)
// ---------------------------------------------------------------------------

/** Internal cell accumulator (its key is never emitted). */
interface GpsCell {
  passes: EvidenceWindow[];
  lqSum: number;
  lqCount: number;
}

function detectGpsAreaDegradation(
  log: ParsedLog,
  config: PatternConfig
): SessionPattern | null {
  const gps = log.gps;
  const lq = resolveChannelValues(log, CHANNEL_CANDIDATES.linkQuality);
  if (!gps || !lq) return null;

  let fixCount = 0;
  for (const g of gps) if (g) fixCount += 1;
  if (fixCount < config.gpsMinFixCount) return null;

  const cell = config.gpsCellSize;
  const key = (lat: number, lon: number): string =>
    `${Math.round(lat / cell)},${Math.round(lon / cell)}`;

  const cells = new Map<string, GpsCell>();
  const getCell = (k: string): GpsCell => {
    let c = cells.get(k);
    if (!c) {
      c = { passes: [], lqSum: 0, lqCount: 0 };
      cells.set(k, c);
    }
    return c;
  };

  // A "pass" is a maximal run of samples in the same cell. It is tolerant of GPS
  // DROPOUT: a `null` fix does NOT close the run (an intermittent dropout inside a
  // single hover must not be counted as several "passes"). A run only closes+reopens
  // when a genuine NON-null fix lands in a DIFFERENT cell — so a real departure to
  // another cell and later return still yields ≥2 passes (true recurrence), while
  // dropout within one hover stays a single pass.
  let runKey: string | null = null;
  let runStart = -1;
  let runEnd = -1;
  const closeRun = (): void => {
    if (runKey !== null) {
      getCell(runKey).passes.push({ startIndex: runStart, endIndex: runEnd });
    }
    runKey = null;
  };
  for (let i = 0; i < log.sampleCount; i++) {
    const fix = gps[i];
    if (!fix) continue; // dropout: skip, but keep the current run open
    const k = key(fix.lat, fix.lon);
    if (k === runKey) {
      runEnd = i;
    } else {
      closeRun();
      runKey = k;
      runStart = i;
      runEnd = i;
    }
    const q = lq[i];
    if (isFiniteNumber(q)) {
      const c = getCell(k);
      c.lqSum += q;
      c.lqCount += 1;
    }
  }
  closeRun();

  // Overall baseline (weighted mean of all fixed, finite-LQ samples).
  let allSum = 0;
  let allCount = 0;
  for (const c of cells.values()) {
    allSum += c.lqSum;
    allCount += c.lqCount;
  }
  if (allCount === 0) return null;
  const baseline1 = allSum / allCount;

  const cellMean = (c: GpsCell): number => c.lqSum / c.lqCount;
  const recurring = (c: GpsCell): boolean =>
    c.passes.length >= config.gpsMinPasses && c.lqCount > 0;

  // Recompute baseline over the non-bad cells so a bad area doesn't lower it.
  let goodSum = 0;
  let goodCount = 0;
  for (const c of cells.values()) {
    if (c.lqCount === 0) continue;
    const isBad1 = recurring(c) && cellMean(c) <= baseline1 - config.gpsDegradationDelta;
    if (!isBad1) {
      goodSum += c.lqSum;
      goodCount += c.lqCount;
    }
  }
  const baseline = goodCount > 0 ? goodSum / goodCount : baseline1;

  const badCells: GpsCell[] = [];
  for (const c of cells.values()) {
    if (recurring(c) && cellMean(c) <= baseline - config.gpsDegradationDelta) {
      badCells.push(c);
    }
  }
  if (badCells.length === 0) return null;

  let badSum = 0;
  let badCount = 0;
  let totalPasses = 0;
  const windows: EvidenceWindow[] = [];
  for (const c of badCells) {
    badSum += c.lqSum;
    badCount += c.lqCount;
    totalPasses += c.passes.length;
    for (const p of c.passes) windows.push(cloneWindow(p));
  }
  const meanBadLq = badSum / badCount;

  return {
    patternId: "gps-area-degradation",
    category: "signal",
    severity: "warning",
    confidence: round2(
      clamp01((baseline - meanBadLq) / 40 + 0.1 * (totalPasses - config.gpsMinPasses))
    ),
    evidenceWindows: capWindows(windows, config.maxWindows),
    summaryKey: "diagnostics.patternSummary.gpsAreaDegradation",
    evidenceKey: "diagnostics.patternEvidence.gpsAreaDegradation",
    checkFirstKey: "diagnostics.patternCheck.gpsAreaDegradation",
    detail: {
      areas: badCells.length,
      passes: totalPasses,
      areaLq: Math.round(meanBadLq),
      baselineLq: Math.round(baseline),
    },
  };
}

// ---------------------------------------------------------------------------
// Detector D — power-packet-link-events (power)
// ---------------------------------------------------------------------------

function detectPowerPacketLinkEvents(
  log: ParsedLog,
  report: DiagnosticReport,
  config: PatternConfig
): SessionPattern | null {
  const events = report.findings.filter(
    (f) => f.ruleId === "lq-collapse" || f.ruleId === "rssi-floor"
  );
  if (events.length === 0) return null;

  const tx = resolveChannelValues(log, CHANNEL_CANDIDATES.txPower);
  const pkt = resolveChannelValues(log, CHANNEL_CANDIDATES.packetRate);
  if (!tx && !pkt) return null;

  let changed = 0;
  let maxRise = 0;
  let packetRateChanges = 0;
  const windows: EvidenceWindow[] = [];

  for (const ev of events) {
    const start = ev.evidenceWindow.startIndex;
    const end = ev.evidenceWindow.endIndex;
    const leadStart = Math.max(0, start - config.eventLeadIn);
    let eventChanged = false;

    if (tx) {
      let leadMin = Infinity;
      for (let i = leadStart; i < start; i++) {
        const v = tx[i];
        if (isFiniteNumber(v) && v < leadMin) leadMin = v;
      }
      // No lead-in samples (event at the very start): fall back to the first
      // in-event reading as the reference.
      if (!Number.isFinite(leadMin) && isFiniteNumber(tx[start])) leadMin = tx[start];
      let eventMax = -Infinity;
      for (let i = start; i <= end; i++) {
        const v = tx[i];
        if (isFiniteNumber(v) && v > eventMax) eventMax = v;
      }
      if (Number.isFinite(leadMin) && Number.isFinite(eventMax)) {
        const rise = eventMax - leadMin;
        if (rise >= config.txStepMw) {
          eventChanged = true;
          if (rise > maxRise) maxRise = rise;
        }
      }
    }

    if (pkt) {
      const leadVals = new Set<number>();
      for (let i = leadStart; i < start; i++) {
        const v = pkt[i];
        if (isFiniteNumber(v)) leadVals.add(v);
      }
      const eventVals = new Set<number>();
      for (let i = start; i <= end; i++) {
        const v = pkt[i];
        if (isFiniteNumber(v)) eventVals.add(v);
      }
      let differs = false;
      if (leadVals.size === 0) {
        // No baseline to compare against: a change is ≥2 distinct rates in-event.
        differs = eventVals.size > 1;
      } else {
        for (const v of eventVals) {
          if (!leadVals.has(v)) {
            differs = true;
            break;
          }
        }
      }
      if (differs) {
        eventChanged = true;
        packetRateChanges += 1;
      }
    }

    if (eventChanged) {
      changed += 1;
      windows.push({ startIndex: start, endIndex: end });
    }
  }

  if (changed < config.minEvents) return null;

  return {
    patternId: "power-packet-link-events",
    category: "power",
    severity: "warning",
    confidence: round2(clamp01(changed / events.length)),
    evidenceWindows: windows.sort((a, b) => a.startIndex - b.startIndex),
    summaryKey: "diagnostics.patternSummary.powerPacketLinkEvents",
    evidenceKey: "diagnostics.patternEvidence.powerPacketLinkEvents",
    checkFirstKey: "diagnostics.patternCheck.powerPacketLinkEvents",
    detail: {
      events: changed,
      maxTxRampMw: round2(maxRise),
      packetRateChanges,
    },
  };
}

/**
 * Detect session-level patterns over an already-evaluated session (M38).
 *
 * Runs the four detectors, collects the patterns they raise, sorts them
 * (severity critical→warning→info, then confidence descending, then `patternId`
 * ascending — a total, deterministic order), and returns them with the top one as
 * `mostLikely`. A session shorter than {@link MIN_SAMPLES_FOR_PATTERNS} returns an
 * empty report with `hasEnoughEvidence: false`.
 *
 * Pure & deterministic; reads `log.gps` **only** to find recurring areas and never
 * emits a coordinate.
 */
export function detectSessionPatterns(
  log: ParsedLog,
  report: DiagnosticReport,
  config: PatternConfig = DEFAULT_PATTERN_CONFIG
): SessionPatternReport {
  if (log.sampleCount < MIN_SAMPLES_FOR_PATTERNS) {
    return {
      patterns: [],
      mostLikely: null,
      hasEnoughEvidence: false,
      sampleCount: log.sampleCount,
      durationMs: log.durationMs,
    };
  }

  const patterns: SessionPattern[] = [];
  const a = detectRepeatedLqDrops(report, config);
  if (a) patterns.push(a);
  const b = detectHeadingDegradation(log, config);
  if (b) patterns.push(b);
  const c = detectGpsAreaDegradation(log, config);
  if (c) patterns.push(c);
  const d = detectPowerPacketLinkEvents(log, report, config);
  if (d) patterns.push(d);

  patterns.sort((x, y) => {
    const bySeverity = severityRank(x.severity) - severityRank(y.severity);
    if (bySeverity !== 0) return bySeverity;
    if (y.confidence !== x.confidence) return y.confidence - x.confidence;
    return x.patternId < y.patternId ? -1 : x.patternId > y.patternId ? 1 : 0;
  });

  return {
    patterns,
    mostLikely: patterns[0] ?? null,
    hasEnoughEvidence: true,
    sampleCount: log.sampleCount,
    durationMs: log.durationMs,
  };
}
