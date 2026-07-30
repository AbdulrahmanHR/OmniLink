/**
 * The v2.5 ML dataset schema: label set, feature vector, and the seeded,
 * stratified, **session-level** split (M56).
 *
 * This is the foundation every later v2.5 task imports — M56b (baseline
 * characterization), M58 (the model), M59 (the predictor). The shapes here are a
 * contract; treat a change to {@link FEATURE_NAMES} or {@link ML_LABELS} as a
 * breaking change and bump {@link ML_DATASET_SCHEMA_VERSION}, exactly as
 * `DIAGNOSTIC_EXPORT_SCHEMA_VERSION` is versioned.
 *
 * ## Built ON TOP of the v2.0 export, not beside it
 * `src/lib/diagnostics/export.ts` says in its own header that its shape is "a
 * contract … consumed by M39a AND the v2.5 ML line". This module honours that: the
 * report-derived half of every feature vector is read out of a {@link
 * DiagnosticExport} produced by {@link buildDiagnosticExport}. There is no second,
 * parallel export path.
 *
 * ## Safety — zero identifiers, numeric only
 * A {@link FeatureVector} is `Record<FeatureName, number>` and nothing else. No
 * strings, no free text, no coordinates, no UID/MAC/IP/email/serial, no binding
 * phrase. This is enforced three ways:
 *  - **structurally**, by the type;
 *  - **by construction**, because `log.gps` is never read (see
 *    {@link GPS_FREE_PATTERN_IDS} for the one place that needed a deliberate
 *    exclusion rather than mere absence); and
 *  - **by test**, in `tests/unit/ml/dataset.test.ts`, which extracts features from
 *    two logs identical except that one carries a GPS track, and asserts the two
 *    vectors are deep-equal.
 *
 * The fixture CSVs happen to have blank `lat`/`lon`, so GPS exclusion would look
 * "free" — it is not. `ParsedLog.gps` exists and `detectSessionPatterns` reads it.
 * The exclusion is active, and it is tested against a log that actually has GPS.
 *
 * ## Purity
 * Every export is pure: no `Date.now`, no unseeded `Math.random`, no I/O, no
 * network. Randomness enters only through {@link import("./rng").createRng}, seeded
 * by the caller. Same inputs + same seed ⇒ byte-identical output (invariant #7).
 */

import type { ParsedLog } from "@/lib/blackbox";
import {
  buildDiagnosticExport,
  detectSessionPatterns,
  evaluateSession,
  LQ_COLLAPSE_RULE_ID,
  PACKET_INSTABILITY_RULE_ID,
  RSSI_FLOOR_RULE_ID,
  SNR_NOISE_RULE_ID,
  TX_POWER_SATURATION_RULE_ID,
  type DiagnosticExport,
  type DiagnosticReport,
  type SessionPatternId,
} from "@/lib/diagnostics";
import { CHANNEL_CANDIDATES, resolveChannelValues } from "@/lib/diagnostics/util";
import { TX_POWER_STEPS } from "@/lib/telemetry-constants";
import {
  DEFAULT_SPLIT_RATIOS,
  MIN_LABELED_SESSIONS_PER_CLASS,
  MIN_TEST_SESSIONS_PER_CLASS,
} from "./mlConsts";
import { createRng, DEFAULT_SEED, shuffled } from "./rng";
import {
  fractionWhere,
  isFiniteNumber,
  maxFinite,
  meanFinite,
  minFinite,
  quantileFinite,
  round6,
  stdDev,
} from "./stats";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/**
 * Semantic version of the ML dataset schema — the label set, the feature vector,
 * and the row/split shapes below. Bump on ANY breaking change (a renamed or
 * reordered feature, a new label, a changed feature definition), the same
 * discipline `DIAGNOSTIC_EXPORT_SCHEMA_VERSION` follows. A persisted dataset or
 * model artifact stamped with an older version must be rejected, not coerced.
 */
export const ML_DATASET_SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Labels — reused from v2.0, not reinvented
// ---------------------------------------------------------------------------

/**
 * The canonical ML label union. These are the **v2.0 labels**, reused verbatim so
 * an ML prediction and a v2.0 fixture label are directly comparable (which is the
 * only reason the M56 gate's "same held-out set" clause is meaningful).
 *
 * `unknown` is the explicit escape hatch for an unrecognised input label — see
 * {@link toMlLabel}. It is a real member of the union so that "we do not know" can
 * be *represented*, rather than being silently rounded into `healthy` (which would
 * corrupt exactly the class the false-positive rate is measured on).
 */
export const ML_LABELS = [
  "healthy",
  "warning",
  "failsafe",
  "wiringSuspicion",
  "antennaSuspicion",
  "unknown",
] as const;

/** One canonical ML label. */
export type MlLabel = (typeof ML_LABELS)[number];

/**
 * The **explicit** mapping from the fixture manifest's label strings to the
 * canonical union.
 *
 * The manifest (`data/fixtures/diagnostics/fixtures-manifest.json`) says `wiring`
 * and `antenna`; the canonical union says `wiringSuspicion` and
 * `antennaSuspicion`. Those are not the same strings, and the difference is not an
 * accident — "suspicion" is the honest name for what a link-health log can support
 * (a loose coax and a pinched antenna are *inferred*, never observed). The mapping
 * is written out rather than derived by a `startsWith`/suffix trick so that a
 * future manifest label which nobody mapped becomes a visible `unknown` instead of
 * a plausible-looking coercion.
 *
 * Total over the 5 manifest labels; asserted in `tests/unit/ml/dataset.test.ts`.
 */
export const MANIFEST_LABEL_TO_ML_LABEL: Readonly<Record<string, MlLabel>> = {
  healthy: "healthy",
  warning: "warning",
  failsafe: "failsafe",
  wiring: "wiringSuspicion",
  antenna: "antennaSuspicion",
};

/**
 * Map a manifest label string to its canonical {@link MlLabel}.
 *
 * An unrecognised string maps to `"unknown"` — loudly representable, never
 * silently coerced into a real class. Callers that require a known class (dataset
 * construction, evaluation) should treat `"unknown"` as a data error and say so;
 * `splitDataset` will not invent a class for it either.
 */
export function toMlLabel(manifestLabel: string): MlLabel {
  return MANIFEST_LABEL_TO_ML_LABEL[manifestLabel] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Feature-definition constants (part of the schema; version-locked with it)
// ---------------------------------------------------------------------------

/**
 * Link quality (%) below which a sample counts as degraded, for
 * `lqFracBelowLow`. Matches the v2.0 `lq-collapse` default `absThreshold` (50) so
 * the feature and the rule agree on what "low LQ" means — but it is frozen HERE,
 * independently, because a feature definition must not move when a user picks a
 * different diagnostic sensitivity preset. A feature that changes meaning with a
 * UI setting is not a feature.
 */
export const FEATURE_LQ_LOW_PCT = 50;

/**
 * RSSI (dBm) at or below which a sample counts as at the noise floor, for
 * `rssiFracBelowFloor`. Matches the v2.0 `rssi-floor` `floorDbm`, which is −100 in
 * *all three* sensitivity presets — i.e. v2.0 already treats it as a physical
 * constant rather than a tunable. Frozen here for the same reason as above.
 */
export const FEATURE_RSSI_FLOOR_DBM = -100;

/**
 * TX power (mW) at or above which a sample counts as pinned at the top step, for
 * `txPowerFracAtTopStep`. Derived from the canonical ladder
 * `TX_POWER_STEPS = [10, 25, 50, 100, 250, 500]` rather than typed as a literal,
 * so it cannot drift from the hardware ladder the rest of the app uses.
 */
export const FEATURE_TX_TOP_STEP_MW = TX_POWER_STEPS[TX_POWER_STEPS.length - 1];

/** Number of equal heading sectors (45° each) for `headingSectorRssiSpreadDb`. */
export const FEATURE_HEADING_SECTORS = 8;

/**
 * Minimum samples a heading sector needs before its mean RSSI is allowed to
 * contribute to `headingSectorRssiSpreadDb`. Without a floor, a sector clipped by
 * a single sample turns one noisy reading into a fake antenna null.
 */
export const FEATURE_HEADING_MIN_SECTOR_SAMPLES = 3;

/**
 * Candidate keys for the heading channel, in priority order. Mirrors the private
 * list in `diagnostics/patterns.ts` (Betaflight imports carry the ground course
 * under several names, so a bare `"heading"` is not enough).
 *
 * Heading is a **bearing**, not a position: it says which way the aircraft was
 * pointing, never where it was. It is safe, and it is the only channel that can
 * expose the directional RSSI signature of an antenna null.
 */
export const FEATURE_HEADING_CANDIDATES = [
  "heading",
  "GPS_ground_course",
  "gps_ground_course",
  "course",
] as const;

/**
 * The M38 session patterns a feature vector is allowed to see: **every pattern
 * except `gps-area-degradation`**.
 *
 * This is the one exclusion that had to be deliberate rather than automatic.
 * `detectSessionPatterns` *does* read `log.gps` — but only inside
 * `detectGpsAreaDegradation`, whose output is a location-correlated weak spot. Its
 * mere *presence flag* is a boolean, not a coordinate, and it would be easy to
 * argue it is therefore "safe". It is not: a feature that fires only when the
 * aircraft revisited a particular patch of ground is a function of where the
 * aircraft was, and a model can only have learned it from location data. So it is
 * excluded, and so is any aggregate (a pattern *count*, a max confidence over all
 * patterns) that would smuggle it back in — every pattern-derived feature below is
 * computed over this allowlist only.
 *
 * Proven by the GPS-vs-no-GPS deep-equality test in `tests/unit/ml/dataset.test.ts`.
 */
export const GPS_FREE_PATTERN_IDS: readonly SessionPatternId[] = [
  "repeated-lq-drops",
  "heading-degradation",
  "power-packet-link-events",
];

// ---------------------------------------------------------------------------
// The feature vector
// ---------------------------------------------------------------------------

/**
 * The frozen, ordered feature names.
 *
 * The vector is exposed BOTH ways on purpose, and this tuple is why:
 *  - {@link FeatureVector} is a **named record**, because M58 must report "top
 *    contributing features" and an explanation that says `feature[27]` is not an
 *    explanation; and
 *  - this tuple pins a canonical **order**, because a model wants a dense
 *    `number[]` and any array form needs an index↔name mapping that cannot drift.
 *
 * `FeatureVector` is typed as `Record<FeatureName, number>`, so the two can never
 * disagree: adding a name here without producing it in {@link extractFeatures} is
 * a compile error, and producing a key that is not here is a compile error too.
 * `toFeatureArray` is the only sanctioned way to flatten.
 *
 * Order is grouped by signal domain (link quality → RSSI → SNR → TX power →
 * packet rate → heading → session shape → v2.0 report → per-rule → patterns).
 */
export const FEATURE_NAMES = [
  // --- Link quality: the dominant failsafe/warning signal.
  "lqMean",
  "lqMin",
  "lqStd",
  "lqP05",
  "lqFracBelowLow",
  "lqFracZero",
  "lqMaxStepDrop",
  // --- RSSI, both antennas: absolute level + the diversity imbalance.
  "rssi1Mean",
  "rssi1Min",
  "rssi1Std",
  "rssi2Mean",
  "rssi2Min",
  "rssiBestMean",
  "rssiImbalanceMean",
  "rssiImbalanceMax",
  "rssiFracBelowFloor",
  // --- SNR: noise-floor quality.
  "snrMean",
  "snrMin",
  "snrStd",
  // --- TX power: how hard the radio had to work.
  "txPowerMean",
  "txPowerMax",
  "txPowerRangeMw",
  "txPowerFracAtTopStep",
  // --- Packet rate: RF mode + its instability.
  "packetRateMean",
  "packetRateChangeRate",
  // --- Heading (a bearing, never a position): the antenna-null signature.
  "headingSectorRssiSpreadDb",
  // --- Session shape.
  "sampleCount",
  "durationMs",
  // --- v2.0 diagnostic report (via the frozen DiagnosticExport contract).
  "healthScore",
  "findingCountInfo",
  "findingCountWarning",
  "findingCountCritical",
  "maxFindingConfidence",
  "findingCoverageFrac",
  // --- v2.0 per-rule finding counts.
  "ruleLqCollapseCount",
  "ruleRssiFloorCount",
  "ruleSnrNoiseCount",
  "rulePacketInstabilityCount",
  "ruleTxPowerSaturationCount",
  // --- M38 session patterns, GPS-free allowlist only (see GPS_FREE_PATTERN_IDS).
  "patternRepeatedLqDrops",
  "patternHeadingDegradation",
  "patternPowerPacketLinkEvents",
  "patternMaxConfidence",
] as const;

/** One feature name. */
export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Number of features in a vector (43). */
export const FEATURE_COUNT = FEATURE_NAMES.length;

/**
 * A session's features: **numeric only, zero identifiers**. The type itself is the
 * first line of the privacy guarantee — there is nowhere in this shape to put a
 * coordinate, a UID, a MAC, an IP, an email, a serial, a binding phrase, or a
 * sentence.
 */
export type FeatureVector = Readonly<Record<FeatureName, number>>;

/** Flatten a {@link FeatureVector} to a dense array in canonical {@link FEATURE_NAMES} order. */
export function toFeatureArray(features: FeatureVector): number[] {
  return FEATURE_NAMES.map((name) => features[name]);
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

/** Per-sample max of two aligned channels, `NaN` where both are gaps. */
function pairwiseBest(a: readonly number[], b: readonly number[]): number[] {
  const n = Math.max(a.length, b.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    const xOk = isFiniteNumber(x);
    const yOk = isFiniteNumber(y);
    out[i] = xOk && yOk ? Math.max(x, y) : xOk ? x : yOk ? y : NaN;
  }
  return out;
}

/** Per-sample `|a − b|`, `NaN` where either side is a gap. */
function pairwiseAbsDiff(a: readonly number[], b: readonly number[]): number[] {
  const n = Math.max(a.length, b.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = isFiniteNumber(a[i]) && isFiniteNumber(b[i]) ? Math.abs(a[i] - b[i]) : NaN;
  }
  return out;
}

/** Largest single-step DROP (`v[i-1] − v[i]`, positive = falling) between finite neighbours. */
function maxStepDrop(values: readonly number[]): number {
  let worst = 0;
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const cur = values[i];
    if (!isFiniteNumber(prev) || !isFiniteNumber(cur)) continue;
    const drop = prev - cur;
    if (drop > worst) worst = drop;
  }
  return worst;
}

/** Adjacent-value changes per transition, in `[0, 1]` (packet-rate jitter density). */
function changeRate(values: readonly number[]): number {
  let transitions = 0;
  let changes = 0;
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const cur = values[i];
    if (!isFiniteNumber(prev) || !isFiniteNumber(cur)) continue;
    transitions += 1;
    if (prev !== cur) changes += 1;
  }
  return transitions === 0 ? 0 : changes / transitions;
}

/**
 * Spread (dB) of mean best-antenna RSSI across the {@link FEATURE_HEADING_SECTORS}
 * heading sectors: `max(sectorMean) − min(sectorMean)` over sectors with at least
 * {@link FEATURE_HEADING_MIN_SECTOR_SAMPLES} samples.
 *
 * This is the antenna-null discriminator. A healthy diversity setup radiates
 * roughly evenly, so every heading sector sees a similar RSSI and the spread is
 * small; a null (a blocked, mis-oriented, or damaged antenna) shows up as one or
 * two sectors sitting several dB below the rest. `0` when fewer than two sectors
 * qualify — no evidence, not "no problem".
 */
function headingSectorRssiSpread(
  heading: readonly number[] | undefined,
  bestRssi: readonly number[]
): number {
  if (!heading) return 0;
  const sums = new Array<number>(FEATURE_HEADING_SECTORS).fill(0);
  const counts = new Array<number>(FEATURE_HEADING_SECTORS).fill(0);
  const width = 360 / FEATURE_HEADING_SECTORS;

  const n = Math.min(heading.length, bestRssi.length);
  for (let i = 0; i < n; i++) {
    const h = heading[i];
    const r = bestRssi[i];
    if (!isFiniteNumber(h) || !isFiniteNumber(r)) continue;
    const norm = ((h % 360) + 360) % 360;
    const sector = Math.min(FEATURE_HEADING_SECTORS - 1, Math.floor(norm / width));
    sums[sector] += r;
    counts[sector] += 1;
  }

  const means: number[] = [];
  for (let s = 0; s < FEATURE_HEADING_SECTORS; s++) {
    if (counts[s] >= FEATURE_HEADING_MIN_SECTOR_SAMPLES) means.push(sums[s] / counts[s]);
  }
  if (means.length < 2) return 0;
  return maxFinite(means, 0) - minFinite(means, 0);
}

/** Fraction of samples covered by at least one finding's evidence window, in `[0, 1]`. */
function findingCoverage(exported: DiagnosticExport): number {
  const n = exported.session.sampleCount;
  if (n <= 0 || exported.findings.length === 0) return 0;
  const covered = new Array<boolean>(n).fill(false);
  for (const f of exported.findings) {
    const lo = Math.max(0, Math.min(n - 1, f.window.startIndex));
    const hi = Math.max(0, Math.min(n - 1, f.window.endIndex));
    for (let i = lo; i <= hi; i++) covered[i] = true;
  }
  let hits = 0;
  for (const c of covered) if (c) hits += 1;
  return hits / n;
}

/** Count findings with a given rule id. */
function countRule(exported: DiagnosticExport, ruleId: string): number {
  let n = 0;
  for (const f of exported.findings) if (f.ruleId === ruleId) n += 1;
  return n;
}

/** `1` when a GPS-free pattern of this id fired, else `0`. */
function patternFlag(exported: DiagnosticExport, id: SessionPatternId): number {
  if (!GPS_FREE_PATTERN_IDS.includes(id)) return 0;
  return exported.patterns.some((p) => p.patternId === id) ? 1 : 0;
}

/**
 * Extract a session's {@link FeatureVector}.
 *
 * **Pure and deterministic**: no clock, no RNG, no I/O. The same `log` always
 * yields a deep-equal vector, and `log.gps` is never read — pass a log with a GPS
 * track and one without, and the vectors are identical (asserted).
 *
 * `report` is optional. When omitted it is computed with
 * `evaluateSession(log)` — i.e. the DEFAULT diagnostic config. Dataset
 * construction must always use the default: a feature vector whose meaning depends
 * on a user's sensitivity preset is not a feature vector, it is a coincidence.
 * (The parameter exists so a caller that has already scanned the session does not
 * pay for a second scan, not so it can vary the config.)
 *
 * ## Perf contract — pass the report you already have
 * `ML_INFERENCE_P95_BUDGET_MS` (150 ms at 50 k samples) budgets the **marginal** ML
 * pass: this function called **with** the report the same "analyze this session"
 * action already produced, plus the model forward pass. Measured at 50 k samples on
 * the reference box: `extractFeatures(log, report)` ≈ 58 ms median / 69 ms p95,
 * versus `extractFeatures(log)` ≈ 127 ms median / 135 ms p95 — the difference is
 * the re-scan, which the action already paid for inside the diagnostics budget.
 * **The M58/M59 perf test must measure the two-argument form**; measuring the
 * one-argument form double-counts the scan and would burn most of the ML budget on
 * work ML did not cause.
 *
 * Report-derived features are read out of the frozen {@link DiagnosticExport}
 * contract, not re-derived — see the module header.
 */
export function extractFeatures(log: ParsedLog, report?: DiagnosticReport): FeatureVector {
  const rep = report ?? evaluateSession(log);
  const patternReport = detectSessionPatterns(log, rep);
  const exported = buildDiagnosticExport(rep, patternReport, log);

  const empty: number[] = [];
  const lq = resolveChannelValues(log, CHANNEL_CANDIDATES.linkQuality) ?? empty;
  const rssi1 = resolveChannelValues(log, CHANNEL_CANDIDATES.rssi1) ?? empty;
  const rssi2 = resolveChannelValues(log, CHANNEL_CANDIDATES.rssi2) ?? empty;
  const snr = resolveChannelValues(log, CHANNEL_CANDIDATES.snr) ?? empty;
  const txPower = resolveChannelValues(log, CHANNEL_CANDIDATES.txPower) ?? empty;
  const packetRate = resolveChannelValues(log, CHANNEL_CANDIDATES.packetRate) ?? empty;
  const heading = resolveChannelValues(log, FEATURE_HEADING_CANDIDATES);

  const bestRssi = pairwiseBest(rssi1, rssi2);
  const imbalance = pairwiseAbsDiff(rssi1, rssi2);

  const txMax = maxFinite(txPower, 0);
  const txMin = minFinite(txPower, 0);

  // Confidence over the GPS-FREE patterns only — never over `exported.patterns`
  // wholesale, which can include the location-correlated `gps-area-degradation`.
  const gpsFreePatterns = exported.patterns.filter((p) =>
    GPS_FREE_PATTERN_IDS.includes(p.patternId)
  );

  const raw: Record<FeatureName, number> = {
    // Link quality.
    lqMean: meanFinite(lq, 0),
    lqMin: minFinite(lq, 0),
    lqStd: stdDev(lq),
    lqP05: quantileFinite(lq, 0.05, 0),
    lqFracBelowLow: fractionWhere(lq, (v) => v < FEATURE_LQ_LOW_PCT),
    lqFracZero: fractionWhere(lq, (v) => v <= 0),
    lqMaxStepDrop: maxStepDrop(lq),
    // RSSI.
    rssi1Mean: meanFinite(rssi1, 0),
    rssi1Min: minFinite(rssi1, 0),
    rssi1Std: stdDev(rssi1),
    rssi2Mean: meanFinite(rssi2, 0),
    rssi2Min: minFinite(rssi2, 0),
    rssiBestMean: meanFinite(bestRssi, 0),
    rssiImbalanceMean: meanFinite(imbalance, 0),
    rssiImbalanceMax: maxFinite(imbalance, 0),
    rssiFracBelowFloor: fractionWhere(bestRssi, (v) => v <= FEATURE_RSSI_FLOOR_DBM),
    // SNR.
    snrMean: meanFinite(snr, 0),
    snrMin: minFinite(snr, 0),
    snrStd: stdDev(snr),
    // TX power.
    txPowerMean: meanFinite(txPower, 0),
    txPowerMax: txMax,
    txPowerRangeMw: txMax - txMin,
    txPowerFracAtTopStep: fractionWhere(txPower, (v) => v >= FEATURE_TX_TOP_STEP_MW),
    // Packet rate.
    packetRateMean: meanFinite(packetRate, 0),
    packetRateChangeRate: changeRate(packetRate),
    // Heading (bearing only).
    headingSectorRssiSpreadDb: headingSectorRssiSpread(heading, bestRssi),
    // Session shape.
    sampleCount: log.sampleCount,
    durationMs: log.durationMs,
    // v2.0 report.
    healthScore: exported.healthScore,
    findingCountInfo: exported.countsBySeverity.info,
    findingCountWarning: exported.countsBySeverity.warning,
    findingCountCritical: exported.countsBySeverity.critical,
    maxFindingConfidence: maxFinite(
      exported.findings.map((f) => f.confidence),
      0
    ),
    findingCoverageFrac: findingCoverage(exported),
    // Per-rule counts.
    ruleLqCollapseCount: countRule(exported, LQ_COLLAPSE_RULE_ID),
    ruleRssiFloorCount: countRule(exported, RSSI_FLOOR_RULE_ID),
    ruleSnrNoiseCount: countRule(exported, SNR_NOISE_RULE_ID),
    rulePacketInstabilityCount: countRule(exported, PACKET_INSTABILITY_RULE_ID),
    ruleTxPowerSaturationCount: countRule(exported, TX_POWER_SATURATION_RULE_ID),
    // GPS-free patterns.
    patternRepeatedLqDrops: patternFlag(exported, "repeated-lq-drops"),
    patternHeadingDegradation: patternFlag(exported, "heading-degradation"),
    patternPowerPacketLinkEvents: patternFlag(exported, "power-packet-link-events"),
    patternMaxConfidence: maxFinite(
      gpsFreePatterns.map((p) => p.confidence),
      0
    ),
  };

  // Round for artifact stability + guarantee every entry is a finite number: a
  // NaN reaching a model is a silent poisoning, so it is coerced to 0 here and
  // asserted absent by the test suite.
  const out = {} as Record<FeatureName, number>;
  for (const name of FEATURE_NAMES) {
    const v = raw[name];
    out[name] = isFiniteNumber(v) ? round6(v) : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One labeled session.
 *
 * `sessionId` is a **corpus-local content key**, not a user identifier: for the
 * bundled fixtures it is the manifest-relative path (`"healthy/healthy-hover-08.csv"`).
 * It exists for exactly one reason — the split must group by session to prevent
 * leakage, and a leakage guard needs something to group on. It is **not** part of
 * {@link FeatureVector}, is never fed to a model, and must never be persisted into
 * a model artifact or leave the device: use {@link toTrainingRow} for anything that
 * gets written or trained on. A caller ingesting a real user log must supply a
 * non-identifying key (e.g. a content hash), never a filename, UID, or device id.
 */
export interface DatasetRow {
  /** Corpus-local session key (see interface docs). Never a user identifier. */
  sessionId: string;
  /** The canonical label. */
  label: MlLabel;
  /** Numeric-only features (zero identifiers). */
  features: FeatureVector;
}

/** A {@link DatasetRow} with the session key stripped — the only shape a model or artifact sees. */
export interface TrainingRow {
  label: MlLabel;
  features: FeatureVector;
}

/**
 * Drop `sessionId`, leaving the label + numeric features. Everything persisted or
 * trained on goes through here, so the corpus key cannot ride along into an
 * artifact by accident.
 */
export function toTrainingRow(row: DatasetRow): TrainingRow {
  return { label: row.label, features: row.features };
}

/**
 * Build one {@link DatasetRow} from a parsed session + its **manifest** label
 * string (mapped via {@link toMlLabel}).
 *
 * Pure; uses the DEFAULT diagnostic config (see {@link extractFeatures}). Kept
 * free of any file I/O so `src/lib/ml` stays a pure library — the fixture corpus
 * is read by the test-side loader (`tests/unit/diagnostics/fixtures.ts`), which is
 * reused rather than duplicated.
 */
export function buildDatasetRow(
  sessionId: string,
  manifestLabel: string,
  log: ParsedLog,
  report?: DiagnosticReport
): DatasetRow {
  return {
    sessionId,
    label: toMlLabel(manifestLabel),
    features: extractFeatures(log, report),
  };
}

// ---------------------------------------------------------------------------
// The split
// ---------------------------------------------------------------------------

/** Train/val/test proportions; must sum to 1. */
export interface SplitRatios {
  train: number;
  val: number;
  test: number;
}

/** Per-class session counts in a split. */
export interface ClassCounts {
  total: number;
  train: number;
  val: number;
  test: number;
}

/**
 * A machine-readable statement that the split is not what it looks like.
 *
 * Structured (a `code` + numbers), not a sentence: this keeps `src/lib/ml` free of
 * user-facing strings (release invariant #4) while remaining directly renderable —
 * the codes are shaped to double as i18n key suffixes if an eval report ever
 * surfaces them, exactly as `DiagnosticFinding.explanation` is a key and not a
 * sentence.
 */
export interface SplitWarning {
  /**
   * - `class-below-d21-minimum` — the class has fewer than
   *   {@link MIN_LABELED_SESSIONS_PER_CLASS} labeled sessions (D21 unmet).
   * - `test-split-below-significance` — the class's test split is smaller than
   *   {@link MIN_TEST_SESSIONS_PER_CLASS}, so any per-class metric over it is not
   *   statistically meaningful.
   * - `single-session-test-class` — the class's test split is ONE session: its
   *   recall can only ever read 0 % or 100 %.
   * - `empty-partition` — a class present in the data got zero sessions in some
   *   partition.
   * - `absent-class` — a canonical label (other than `unknown`) has no sessions at all.
   */
  code:
    | "class-below-d21-minimum"
    | "test-split-below-significance"
    | "single-session-test-class"
    | "empty-partition"
    | "absent-class";
  /** The class the warning is about. */
  label: MlLabel;
  /** Non-identifying numbers only (counts and required minimums). */
  detail: Record<string, number>;
}

/** The result of {@link splitDataset}. */
export interface DatasetSplit {
  /** Schema this split was produced under. */
  schemaVersion: typeof ML_DATASET_SCHEMA_VERSION;
  /** The seed that produced it — quote this with any metric derived from it. */
  seed: number;
  /** The ratios that produced it. */
  ratios: SplitRatios;
  train: DatasetRow[];
  val: DatasetRow[];
  test: DatasetRow[];
  /** Per-class totals + partition sizes, for every canonical label. */
  perClassCounts: Record<MlLabel, ClassCounts>;
  /**
   * Everything wrong with this split, stated. **Non-empty on the real corpus** —
   * downstream reports are expected to surface these, not swallow them.
   */
  warnings: SplitWarning[];
  /**
   * `true` only when {@link warnings} is empty — i.e. every class clears D21 and
   * every test split is large enough to mean something. **`false` on the bundled
   * 36-fixture corpus**, and any eval built on this split must say so.
   */
  adequate: boolean;
}

/** Options for {@link splitDataset}. */
export interface SplitOptions {
  /** Seed for the stratified shuffle. Defaults to {@link DEFAULT_SEED}. */
  seed?: number;
  /** Partition proportions. Defaults to {@link DEFAULT_SPLIT_RATIOS}. */
  ratios?: SplitRatios;
}

/** Thrown when a caller hands `splitDataset` a dataset it cannot honestly split. */
export class InvalidDatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDatasetError";
  }
}

/**
 * Seeded, **stratified by class**, **split by session** — never by frame.
 *
 * ## Why by session
 * Splitting at frame level would leak, catastrophically and invisibly: adjacent
 * 40 ms frames from one flight are near-duplicates, so a frame-level split puts
 * near-copies of the same moment in both train and test and the model scores
 * beautifully by memorising them. Every partition here is a set of whole sessions;
 * a session appears in exactly one of train/val/test, and the test suite asserts
 * the three `sessionId` sets are pairwise disjoint.
 *
 * ## Determinism
 * Rows are first sorted by `sessionId` into a canonical order, so the result does
 * not depend on the order the caller happened to load them in; then each class is
 * shuffled with a single {@link createRng} generator consumed in fixed
 * {@link ML_LABELS} order. Same rows + same seed ⇒ byte-identical split, always.
 *
 * ## Allocation
 * Per class: `nTrain = floor(n · train)`, `nVal = floor(n · val)`, and the
 * **remainder goes to test** — the scarcest, most consequential partition is never
 * the one that loses a session to rounding.
 *
 * ## The degenerate case, stated rather than dressed up
 * The bundled corpus has **5** sessions each of `wiring` and `antenna`. At 60/20/20
 * that is a **3 / 1 / 1** split: a test set of **ONE session** for those classes.
 * One session means the class's recall is a coin with two faces — 0 % or 100 % —
 * and *nothing in between is representable*. The same corpus gives `healthy` a
 * 3-session test split, so its false-positive rate quantises in 33-point steps.
 *
 * This function will produce that split (there is nothing else to produce), but it
 * will not let it pass as respectable: every affected class raises a
 * `test-split-below-significance` warning, the two 1-session classes additionally
 * raise `single-session-test-class`, all five raise `class-below-d21-minimum`, and
 * {@link DatasetSplit.adequate} comes back **`false`**. Downstream code and the
 * eval report are expected to say so out loud.
 *
 * @throws {InvalidDatasetError} if the ratios do not sum to 1, or if two rows share
 *   a `sessionId` (which would defeat the leakage guarantee this function exists to
 *   provide).
 */
export function splitDataset(
  rows: readonly DatasetRow[],
  options: SplitOptions = {}
): DatasetSplit {
  const seed = options.seed ?? DEFAULT_SEED;
  const ratios = options.ratios ?? { ...DEFAULT_SPLIT_RATIOS };

  const sum = ratios.train + ratios.val + ratios.test;
  if (!isFiniteNumber(sum) || Math.abs(sum - 1) > 1e-9) {
    throw new InvalidDatasetError(`split ratios must sum to 1 (got ${sum})`);
  }
  if (ratios.train < 0 || ratios.val < 0 || ratios.test < 0) {
    throw new InvalidDatasetError("split ratios must be non-negative");
  }

  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.sessionId)) {
      throw new InvalidDatasetError(`duplicate sessionId: ${row.sessionId}`);
    }
    seen.add(row.sessionId);
  }

  // Canonical order first: the split must not depend on load order.
  const canonical = rows
    .slice()
    .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));

  const byLabel = new Map<MlLabel, DatasetRow[]>();
  for (const label of ML_LABELS) byLabel.set(label, []);
  for (const row of canonical) byLabel.get(row.label)?.push(row);

  const rng = createRng(seed);
  const train: DatasetRow[] = [];
  const val: DatasetRow[] = [];
  const test: DatasetRow[] = [];
  const perClassCounts = {} as Record<MlLabel, ClassCounts>;
  const warnings: SplitWarning[] = [];

  // Fixed label order ⇒ the single RNG stream is consumed identically every run.
  for (const label of ML_LABELS) {
    const group = byLabel.get(label) ?? [];
    const n = group.length;
    const order = shuffled(group, rng);

    const nTrain = Math.floor(n * ratios.train);
    const nVal = Math.floor(n * ratios.val);
    const nTest = n - nTrain - nVal;

    train.push(...order.slice(0, nTrain));
    val.push(...order.slice(nTrain, nTrain + nVal));
    test.push(...order.slice(nTrain + nVal));

    perClassCounts[label] = { total: n, train: nTrain, val: nVal, test: nTest };

    if (n === 0) {
      // `unknown` is legitimately empty — it is the escape hatch, not a class to
      // collect. Any OTHER canonical label missing entirely is a broken dataset.
      if (label !== "unknown") {
        warnings.push({ code: "absent-class", label, detail: { total: 0 } });
      }
      continue;
    }

    if (n < MIN_LABELED_SESSIONS_PER_CLASS) {
      warnings.push({
        code: "class-below-d21-minimum",
        label,
        detail: { total: n, required: MIN_LABELED_SESSIONS_PER_CLASS },
      });
    }
    if (nTest < MIN_TEST_SESSIONS_PER_CLASS) {
      warnings.push({
        code: "test-split-below-significance",
        label,
        detail: { test: nTest, required: MIN_TEST_SESSIONS_PER_CLASS },
      });
    }
    if (nTest === 1) {
      warnings.push({ code: "single-session-test-class", label, detail: { test: 1 } });
    }
    if (nTrain === 0 || nVal === 0 || nTest === 0) {
      warnings.push({
        code: "empty-partition",
        label,
        detail: { train: nTrain, val: nVal, test: nTest },
      });
    }
  }

  return {
    schemaVersion: ML_DATASET_SCHEMA_VERSION,
    seed,
    ratios,
    train,
    val,
    test,
    perClassCounts,
    warnings,
    adequate: warnings.length === 0,
  };
}
