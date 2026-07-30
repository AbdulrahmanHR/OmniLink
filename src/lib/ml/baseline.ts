/**
 * Baseline characterization (M56b) — what the v2.0 detectors actually score, frozen.
 *
 * D25 says a v2.5 model may ship only if it beats **the measured v2.0 baseline** on the
 * same held-out set. This module is where that word "measured" is cashed. It runs the
 * two shipped detectors over the frozen fixture corpus through {@link runMlEval} and
 * assembles the {@link BaselineArtifact} that is checked in at
 * {@link import("./mlConsts").BASELINE_METRICS_ARTIFACT} (`data/ml/baseline-v20.json`).
 *
 * The whole point of freezing it as a file is that a later run must compare against a
 * number it cannot quietly re-derive into something friendlier.
 * `tests/unit/ml/baseline.test.ts` re-runs this characterization and deep-equals the
 * result against the checked-in JSON, so a changed rule threshold or a changed fixture
 * turns the suite red and forces a *conscious* re-freeze.
 *
 * ## The two baselines
 *  - **Baseline A — `v20-rule-engine`**: `evaluateSession` (`src/lib/diagnostics/engine.ts`)
 *    with the DEFAULT config, i.e. the five shipped rules `lq-collapse`, `rssi-floor`,
 *    `snr-noise`, `packet-instability`, `tx-power-saturation`. This is the baseline D25
 *    names, and the one {@link BaselineArtifact.gateBaseline} points at.
 *  - **Baseline B — `m15-anomaly-heuristic`**: `detectAnomalies` (`src/lib/anomaly.ts`),
 *    the older heuristic (`signalLoss | failsafe | lqDrop | txPowerChange`). Carried for
 *    context: it says how much of the corpus the *pre-diagnostics* app could see.
 *
 * ## How baseline B is scored — and why NOT per-finding
 * B is scored at **per-session granularity only**. Its output vocabulary is four
 * `AnomalyType`s; the ground truth is five `ruleId`s. They are not the same vocabulary
 * and there is no honest bijection between them:
 *  - `lqDrop` and `lq-collapse` look alignable, but `lqDrop` cedes a zero-bottomed drop
 *    to the `failsafe` detector while `lq-collapse` keeps it, so the same physical event
 *    is one `lq-collapse` but either an `lqDrop` **or** a `failsafe` depending on how
 *    long link quality sat at zero;
 *  - `signalLoss` (an RSSI-floor run) is close to `rssi-floor`, but `failsafe` has **no**
 *    rule-side counterpart at all — the rule engine has no failsafe rule;
 *  - `txPowerChange` fires on any ±1 mW step and is `info`; `tx-power-saturation` fires
 *    on a *pinned-at-max* run correlated with poor RSSI/LQ. They are not the same claim;
 *  - and **nothing** in B's vocabulary corresponds to `snr-noise` or `packet-instability`
 *    — B has no SNR detector and no packet-rate detector.
 * Inventing a mapping to make the two comparable would manufacture a correspondence the
 * code does not have, and every per-rule number that fell out of it would be an artifact
 * of my mapping rather than a measurement of B. So per-finding is **not computed** for B,
 * the report carries the `per-finding-not-scored` limitation, and the comparison between
 * A and B is made where it is genuinely apples-to-apples: "did you flag this session as
 * not clean?", which both detectors answer natively.
 *
 * ## Lead time — reported as zero predictions, on purpose
 * Neither baseline has an **emission timestamp**. Both are batch functions over a
 * complete log: `evaluateSession(log)` and `detectAnomalies(log)` cannot be asked "when
 * did you know?". The only timestamps they expose are the *edges of their evidence
 * windows*, and picking an edge picks the answer — over these fixtures the same failsafe
 * yields a "lead" of 40 ms or 6080 ms depending on whether you read the window's start or
 * its end. A quantity whose value is set by an arbitrary convention is not a measurement.
 *
 * So the lead-time section is run with the real ground-truth events ({@link FAILSAFE_ONSET_RULE})
 * and **zero predictions**: 17 failsafe onsets, 0 predicted, 17 missed. That is a
 * statement about the baselines' *architecture* — they are detectors, not predictors —
 * and it hands M59 the frozen event set to score a real predictor against. M59's
 * predictor must supply genuine emission timestamps.
 *
 * ## Purity
 * No I/O here: fixtures come in already parsed (`scripts/build-ml-baseline.ts` reads them
 * from disk, `tests/unit/ml/baseline.test.ts` reuses the existing test-side loader). No
 * clock — the artifact carries a {@link BaselineArtifact.corpus} fingerprint for
 * provenance, **never a generation timestamp**, which is what lets it be byte-identical
 * on every re-run.
 */

import type { ParsedLog } from "@/lib/blackbox";
import { DEFAULT_ANOMALY_CONFIG, detectAnomalies } from "@/lib/anomaly";
import {
  DEFAULT_DIAGNOSTIC_CONFIG,
  evaluateSession,
  type DiagnosticReport,
} from "@/lib/diagnostics";
import { CHANNEL_CANDIDATES, resolveChannelValues } from "@/lib/diagnostics/util";
import {
  buildDatasetRow,
  ML_DATASET_SCHEMA_VERSION,
  splitDataset,
  toMlLabel,
  type DatasetRow,
  type MlLabel,
} from "./dataset";
import {
  DEFAULT_WINDOW_TOLERANCE_SAMPLES,
  runMlEval,
  type EventOnset,
  type ExpectedFindingTruth,
  type FindingPrediction,
  type MlEvalReport,
  type MlGroundTruth,
  type SessionPrediction,
  type SessionTruth,
} from "./evalHarness";
import {
  DEFAULT_SPLIT_RATIOS,
  FP_RATE_QUANTUM_PP,
  MIN_LABELED_SESSIONS_PER_CLASS,
  PREDICTIVE_LEAD_TIME_TARGET_MS,
  type GateBaseline,
} from "./mlConsts";
import { DEFAULT_SEED } from "./rng";
import { isFiniteNumber, round6 } from "./stats";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Semantic version of the {@link BaselineArtifact} shape. Bump on any breaking change;
 * a consumer that does not recognise the version must reject the artifact, not coerce it
 * — the same discipline `DIAGNOSTIC_EXPORT_SCHEMA_VERSION` follows.
 */
export const BASELINE_ARTIFACT_SCHEMA_VERSION = "1.0.0";

/** The two detectors characterized here. */
export type BaselineId = "v20-rule-engine" | "m15-anomaly-heuristic";

/** Baseline A: the v2.0 diagnostic rule engine (`evaluateSession`, default config). */
export const BASELINE_RULE_ENGINE: BaselineId = "v20-rule-engine";

/** Baseline B: the M15 heuristic (`detectAnomalies`, default config). */
export const BASELINE_ANOMALY_HEURISTIC: BaselineId = "m15-anomaly-heuristic";

// ---------------------------------------------------------------------------
// The ground-truth event definition (M59's event set)
// ---------------------------------------------------------------------------

/**
 * How a ground-truth failsafe onset is derived — **reusing the app's own definition**,
 * not a new one invented for the eval.
 *
 * An onset is the **first sample of each maximal run of link quality `<= 0`** whose
 * length reaches `DEFAULT_ANOMALY_CONFIG.failsafe.lqZeroSamples` (**2** samples). That is
 * verbatim the inferred-failsafe condition `src/lib/anomaly.ts` ships (`detectFailsafe`'s
 * no-failsafe-channel path), so the event set is the app's notion of "the link was gone",
 * not the eval's.
 *
 * Over the bundled corpus this yields **17 onsets**, all in the `failsafe` (8) and
 * `wiring` (9) classes — `healthy`, `warning`, and `antenna` sessions contain none. That
 * is the correct shape: those are exactly the classes whose link actually dies.
 */
export const FAILSAFE_ONSET_RULE = {
  channel: "linkQuality",
  condition: "lq<=0",
  minConsecutiveSamples: DEFAULT_ANOMALY_CONFIG.failsafe.lqZeroSamples,
  source: "src/lib/anomaly.ts::DEFAULT_ANOMALY_CONFIG.failsafe.lqZeroSamples",
} as const;

/**
 * Failsafe onsets in one session: the sample index that begins each maximal `lq <= 0` run
 * of at least {@link FAILSAFE_ONSET_RULE.minConsecutiveSamples} samples.
 *
 * Pure. `NaN` link-quality samples are gaps and break a run (they are never read as 0) —
 * the same rule every other module in this project follows.
 */
export function findFailsafeOnsetIndices(log: ParsedLog): number[] {
  const lq = resolveChannelValues(log, CHANNEL_CANDIDATES.linkQuality) ?? [];
  const need = FAILSAFE_ONSET_RULE.minConsecutiveSamples;
  const onsets: number[] = [];
  let run = 0;
  for (let i = 0; i < log.sampleCount; i++) {
    const v = lq[i];
    if (isFiniteNumber(v) && v <= 0) {
      run += 1;
      if (run === need) onsets.push(i - need + 1);
    } else {
      run = 0;
    }
  }
  return onsets;
}

// ---------------------------------------------------------------------------
// Inputs (kept I/O-free — see the module header)
// ---------------------------------------------------------------------------

/** One labelled fixture: its manifest entry plus its parsed log. */
export interface BaselineFixture {
  /** Manifest-relative filename — a corpus-local content key, never a user identifier. */
  file: string;
  /** The raw manifest label (`healthy | warning | failsafe | wiring | antenna`). */
  label: string;
  /** Manifest ground truth: is this session clean? */
  expectClean: boolean;
  /** Manifest ground truth: the findings the session should produce. */
  expectedFindings: readonly {
    ruleId: string;
    approxWindow: { startIndex: number; endIndex: number };
  }[];
  /** The parsed session. */
  log: ParsedLog;
}

// ---------------------------------------------------------------------------
// Corpus fingerprint
// ---------------------------------------------------------------------------

/** One 32-bit FNV-1a lane. `Math.imul` keeps the multiply in exact int32. */
function fnv1a(text: string, offsetBasis: number, prime: number): number {
  let h = offsetBasis | 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, prime);
  }
  return h >>> 0;
}

/** Zero-padded 8-hex-digit rendering of a uint32. */
function hex8(n: number): string {
  return n.toString(16).padStart(8, "0");
}

/**
 * A canonical, exhaustive string form of one fixture: its label, its ground truth, **and
 * every sample of every channel**.
 *
 * Hashing the parsed content rather than the CSV bytes is deliberate: it is what the
 * detectors actually see, so a whitespace-only CSV edit does not invalidate the artifact
 * while a single changed link-quality sample does.
 */
function canonicalFixtureText(fx: BaselineFixture): string {
  const parts: string[] = [
    fx.file,
    fx.label,
    fx.expectClean ? "1" : "0",
    String(fx.log.sampleCount),
    String(fx.log.durationMs),
  ];
  for (const e of fx.expectedFindings) {
    parts.push(`${e.ruleId}:${e.approxWindow.startIndex}-${e.approxWindow.endIndex}`);
  }
  // Channels in their parsed order; the parser is deterministic, so this is stable.
  for (const ch of fx.log.channels) {
    parts.push(`${ch.key}=${ch.values.join(",")}`);
  }
  parts.push(`t=${fx.log.time.join(",")}`);
  return parts.join("|");
}

/**
 * A 64-bit content fingerprint of the whole corpus, as 16 lowercase hex digits.
 *
 * Two independent 32-bit FNV-1a lanes (different offset bases and primes) concatenated —
 * a pure, dependency-free hash that runs identically in Node and the browser. It is a
 * **change detector**, not a cryptographic commitment: its job is to make a fixture edit
 * invalidate the frozen metrics *loudly*, which `tests/unit/ml/baseline.test.ts` enforces
 * by asserting the checked-in fingerprint still matches the live corpus. If someone
 * changes a fixture and the metrics happen to land on the same numbers, the fingerprint
 * still moves and the test still goes red.
 *
 * Fixtures are hashed in `file` order, so the caller's load order cannot change the
 * result.
 */
export function fingerprintCorpus(fixtures: readonly BaselineFixture[]): string {
  const ordered = [...fixtures].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0
  );
  const text = `${ordered.length}\n${ordered.map(canonicalFixtureText).join("\n")}`;
  // FNV-1a 32 (2166136261 / 16777619) + a second lane with a different basis+prime.
  return `${hex8(fnv1a(text, 0x811c9dc5, 0x01000193))}${hex8(fnv1a(text, 0x7fffffff, 0x85ebca6b))}`;
}

// ---------------------------------------------------------------------------
// Ground truth + per-baseline predictions
// ---------------------------------------------------------------------------

/** The labelled corpus, in the harness's vocabulary. */
export function buildGroundTruth(fixtures: readonly BaselineFixture[]): MlGroundTruth {
  const sessions: SessionTruth[] = fixtures.map((fx) => ({
    sessionId: fx.file,
    label: toMlLabel(fx.label),
    clean: fx.expectClean,
  }));
  const findings: ExpectedFindingTruth[] = [];
  for (const fx of fixtures) {
    for (const e of fx.expectedFindings) {
      findings.push({
        sessionId: fx.file,
        ruleId: e.ruleId,
        window: {
          startIndex: e.approxWindow.startIndex,
          endIndex: e.approxWindow.endIndex,
        },
      });
    }
  }
  return { sessions, findings };
}

/** The ground-truth failsafe onsets across the corpus, in fixture order. */
export function buildEventOnsets(fixtures: readonly BaselineFixture[]): EventOnset[] {
  const events: EventOnset[] = [];
  for (const fx of fixtures) {
    for (const i of findFailsafeOnsetIndices(fx.log)) {
      events.push({ sessionId: fx.file, onsetMs: fx.log.time[i] });
    }
  }
  return events;
}

/**
 * Baseline A's output: one {@link SessionPrediction} + its {@link FindingPrediction}s per
 * fixture, from `evaluateSession` under the **default** diagnostic config.
 *
 * A session is flagged when the engine produces **≥ 1 finding of any severity**. The
 * stricter of the two available definitions was chosen on purpose (the alternative —
 * ≥ 1 *warning-or-higher* finding — can only ever flag fewer sessions, so it could only
 * flatter the false-positive rate). On this corpus the two coincide exactly: no healthy
 * fixture produces even an `info` finding.
 */
export function ruleEnginePredictions(fixtures: readonly BaselineFixture[]): {
  sessions: SessionPrediction[];
  findings: FindingPrediction[];
  reports: Map<string, DiagnosticReport>;
} {
  const sessions: SessionPrediction[] = [];
  const findings: FindingPrediction[] = [];
  const reports = new Map<string, DiagnosticReport>();

  for (const fx of fixtures) {
    const report = evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
    reports.set(fx.file, report);
    sessions.push({
      sessionId: fx.file,
      flagged: report.findings.length > 0,
      findingCount: report.findings.length,
    });
    for (const f of report.findings) {
      findings.push({
        sessionId: fx.file,
        ruleId: f.ruleId,
        window: {
          startIndex: f.evidenceWindow.startIndex,
          endIndex: f.evidenceWindow.endIndex,
        },
      });
    }
  }
  return { sessions, findings, reports };
}

/**
 * Baseline B's output: one {@link SessionPrediction} per fixture from `detectAnomalies`
 * under the default anomaly config. **No finding-level predictions** — see the module
 * header for why a per-finding score against B's vocabulary would be fabricated.
 *
 * A session is flagged when B produces **≥ 1 anomaly of any severity**, mirroring
 * baseline A's rule exactly so the two per-session numbers are comparable. (`info`-severity
 * `txPowerChange` events count. On this corpus that changes nothing: no healthy fixture
 * produces any anomaly at all.)
 */
export function anomalyHeuristicPredictions(
  fixtures: readonly BaselineFixture[]
): SessionPrediction[] {
  return fixtures.map((fx) => {
    const events = detectAnomalies(fx.log, DEFAULT_ANOMALY_CONFIG);
    return {
      sessionId: fx.file,
      flagged: events.length > 0,
      findingCount: events.length,
    };
  });
}

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

/** Corpus provenance: what was measured, and a fingerprint that moves if it changes. */
export interface BaselineCorpusInfo {
  /** `fixtures-manifest.json`'s own `version`. */
  manifestVersion: string;
  sessionCount: number;
  /** Sessions per canonical ML label. */
  sessionsByClass: Record<string, number>;
  /** Ground-truth findings per rule id — the per-finding denominators. */
  expectedFindingsByRule: Record<string, number>;
  expectedFindingCount: number;
  /** Ground-truth failsafe onsets ({@link FAILSAFE_ONSET_RULE}). */
  failsafeEventCount: number;
  /** 64-bit content fingerprint ({@link fingerprintCorpus}). */
  fingerprint: string;
}

/**
 * The honesty header. **These numbers are indicative, not a gate pass**, and the artifact
 * says so in its own body rather than making the reader go and find the context.
 */
export interface BaselineHonesty {
  /** Sessions in the whole labelled corpus. **36.** */
  corpusSessions: number;
  /** D21's bar: labelled sessions **per class** required to ship a model. **300.** */
  d21RequiredSessionsPerClass: number;
  /** The largest class in the corpus, as a fraction of the D21 bar. */
  largestClassFractionOfD21: number;
  /** `false`. No class is within two orders of magnitude of D21. */
  d21Met: boolean;
  /** Healthy sessions — the false-positive denominator. **12.** */
  healthySessions: number;
  /** One healthy false positive moves the FP rate by this many points. **8.3.** */
  fpRateQuantumPp: number;
  /**
   * `true`. Every metric in this file is **indicative**. Nothing here is a gate pass:
   * every report carries `gateEvaluated: false`, because D25's gate compares a *model*
   * against this baseline and there is no model here.
   */
  indicativeNotAGatePass: boolean;
  /**
   * `false`. The corpus is **not held out** from the thing being measured: the fixtures
   * were authored alongside the v2.0 rules and `manifest-acceptance.test.ts` asserts the
   * engine reproduces them. Baseline A's scores are therefore a **ceiling**, not an
   * estimate of field performance.
   */
  baselineHeldOutFromCorpus: boolean;
  /** Dev-facing notes. Never rendered in the UI; this is a data artifact, not a string table. */
  notes: string[];
}

/** How each baseline was scored, recorded with the numbers so it travels with them. */
export interface BaselineScoringDecisions {
  perSessionFlagRule: string;
  windowToleranceSamples: number;
  /** The baselines a per-finding score was computed for. Baseline B is absent, by decision. */
  perFindingScoredFor: BaselineId[];
  perFindingOmittedFor: BaselineId[];
  perFindingOmissionReason: string;
  leadTime: {
    targetMs: number;
    onsetRule: string;
    /** Both baselines supply zero timestamped predictions. See the module header. */
    baselinePredictionCount: number;
    rationale: string;
  };
  notes: string[];
}

/** One scored partition of the corpus. */
export interface BaselinePartition {
  sessionCount: number;
  negativeSessions: number;
  positiveSessions: number;
  /** Sessions per class in this partition. */
  sessionsByClass: Record<string, number>;
  /** One {@link MlEvalReport} per baseline. */
  baselines: Record<BaselineId, MlEvalReport>;
}

/** The frozen baseline metrics artifact (`data/ml/baseline-v20.json`). */
export interface BaselineArtifact {
  schemaVersion: string;
  /** The dataset schema the split was produced under. */
  mlDatasetSchemaVersion: string;
  corpus: BaselineCorpusInfo;
  honesty: BaselineHonesty;
  scoring: BaselineScoringDecisions;
  /**
   * The whole 36-session corpus. The strongest denominators available (12 negatives /
   * 24 positives) and the numbers to quote when describing what the v2.0 detectors do.
   */
  wholeCorpus: BaselinePartition;
  /**
   * The seeded, stratified, session-level **test** split (seed {@link DEFAULT_SEED},
   * 60/20/20) — the partition `FP_CEILING_RULE.heldOutSplit === "test"` literally names.
   * It is **9 sessions**, with **3** healthy negatives, so its FP rate quantises in
   * 33.3-point steps. It is included because D25's rule points at it and M58 must be able
   * to honour that rule with an apples-to-apples number; it is not included because it is
   * a good measurement.
   */
  heldOutTestSplit: BaselinePartition & { seed: number; ratios: typeof DEFAULT_SPLIT_RATIOS };
  /**
   * The numbers D25's gate reads: baseline A's FP rate and recall on the **held-out test
   * split**, honouring `FP_CEILING_RULE.heldOutSplit`.
   *
   * `fpCeilingClearable` records the fact that decides the whole line: with a measured FP
   * rate of **0**, D25's *strict* `<` ceiling admits **no** model — nothing is strictly
   * below zero.
   */
  gateBaseline: GateBaseline & {
    baselineId: BaselineId;
    granularity: "per-session";
    split: "test";
    fpCeilingClearable: boolean;
  };
}

/** Per-class session counts over a set of fixtures, keyed by canonical ML label. */
function classCounts(fixtures: readonly BaselineFixture[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const fx of fixtures) {
    const label: MlLabel = toMlLabel(fx.label);
    out[label] = (out[label] ?? 0) + 1;
  }
  return out;
}

/** Score both baselines over one partition of the corpus. */
function scorePartition(fixtures: readonly BaselineFixture[]): BaselinePartition {
  const groundTruth = buildGroundTruth(fixtures);
  const events = buildEventOnsets(fixtures);
  const ruleEngine = ruleEnginePredictions(fixtures);

  // Both baselines are scored against the SAME ground truth and the SAME event set —
  // that is the only reason the two columns can be read side by side.
  const reportA = runMlEval(
    {
      sessions: ruleEngine.sessions,
      findings: ruleEngine.findings,
      // Zero predictions: neither baseline has an emission timestamp (module header).
      leadTime: { predictions: [], events },
    },
    groundTruth,
    { windowToleranceSamples: DEFAULT_WINDOW_TOLERANCE_SAMPLES }
  );

  const reportB = runMlEval(
    {
      sessions: anomalyHeuristicPredictions(fixtures),
      // `findings` deliberately omitted — B's vocabulary is not the rule vocabulary.
      leadTime: { predictions: [], events },
    },
    groundTruth,
    { windowToleranceSamples: DEFAULT_WINDOW_TOLERANCE_SAMPLES }
  );

  const negativeSessions = fixtures.filter((f) => f.expectClean).length;

  return {
    sessionCount: fixtures.length,
    negativeSessions,
    positiveSessions: fixtures.length - negativeSessions,
    sessionsByClass: classCounts(fixtures),
    baselines: {
      [BASELINE_RULE_ENGINE]: reportA,
      [BASELINE_ANOMALY_HEURISTIC]: reportB,
    } as Record<BaselineId, MlEvalReport>,
  };
}

/** Ground-truth findings per rule id, over a set of fixtures. */
function expectedFindingsByRule(
  fixtures: readonly BaselineFixture[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const fx of fixtures) {
    for (const e of fx.expectedFindings) out[e.ruleId] = (out[e.ruleId] ?? 0) + 1;
  }
  // Sorted by descending frequency, then rule id — deterministic key order in the JSON.
  return Object.fromEntries(
    Object.entries(out).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
  );
}

/**
 * Characterize both v2.0 baselines over the frozen fixture corpus.
 *
 * **Pure and deterministic**: no clock, no RNG beyond the seeded split ({@link DEFAULT_SEED}),
 * no I/O. Two calls with the same fixtures produce a deep-equal artifact, which is exactly
 * what `tests/unit/ml/baseline.test.ts` relies on to prove the checked-in JSON has not
 * drifted from the code that produced it.
 *
 * @param fixtures every labelled fixture, already parsed.
 * @param manifestVersion the fixture manifest's own `version` field.
 */
export function characterizeBaselines(
  fixtures: readonly BaselineFixture[],
  manifestVersion: string
): BaselineArtifact {
  // Canonical order: the artifact must not depend on how the caller listed the corpus.
  const ordered = [...fixtures].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0
  );

  const wholeCorpus = scorePartition(ordered);

  // The held-out test split, produced by the SAME `splitDataset` M58 will call — not a
  // re-implementation of it, so the partition the gate is measured on is provably the
  // partition the model is tested on.
  const rows: DatasetRow[] = ordered.map((fx) =>
    buildDatasetRow(fx.file, fx.label, fx.log, evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG))
  );
  const split = splitDataset(rows, { seed: DEFAULT_SEED, ratios: { ...DEFAULT_SPLIT_RATIOS } });
  const testIds = new Set(split.test.map((r) => r.sessionId));
  const testFixtures = ordered.filter((fx) => testIds.has(fx.file));
  const heldOut = scorePartition(testFixtures);

  const gateReport = heldOut.baselines[BASELINE_RULE_ENGINE];
  const baselineFpRate = gateReport.perSession.falsePositiveRate.value;
  const baselineRecall = gateReport.perSession.recall.value;

  const byClass = classCounts(ordered);
  const largestClass = Math.max(0, ...Object.values(byClass));
  const healthySessions = ordered.filter((f) => f.expectClean).length;
  const byRule = expectedFindingsByRule(ordered);
  const eventCount = buildEventOnsets(ordered).length;

  return {
    schemaVersion: BASELINE_ARTIFACT_SCHEMA_VERSION,
    mlDatasetSchemaVersion: ML_DATASET_SCHEMA_VERSION,
    corpus: {
      manifestVersion,
      sessionCount: ordered.length,
      sessionsByClass: byClass,
      expectedFindingsByRule: byRule,
      expectedFindingCount: Object.values(byRule).reduce((a, b) => a + b, 0),
      failsafeEventCount: eventCount,
      fingerprint: fingerprintCorpus(ordered),
    },
    honesty: {
      corpusSessions: ordered.length,
      d21RequiredSessionsPerClass: MIN_LABELED_SESSIONS_PER_CLASS,
      largestClassFractionOfD21: round6(largestClass / MIN_LABELED_SESSIONS_PER_CLASS),
      d21Met: largestClass >= MIN_LABELED_SESSIONS_PER_CLASS,
      healthySessions,
      fpRateQuantumPp: FP_RATE_QUANTUM_PP,
      indicativeNotAGatePass: true,
      baselineHeldOutFromCorpus: false,
      notes: [
        "INDICATIVE, NOT A GATE PASS. Every report in this artifact carries gateEvaluated=false: D25's gate compares a MODEL against this baseline, and there is no model here.",
        "The corpus is 36 sessions across 5 classes (healthy 12, warning 7, failsafe 7, wiring 5, antenna 5). D21 requires 300 labeled sessions PER CLASS. The largest class has 4% of that; the smallest has 1.7%.",
        "The 12 healthy sessions are the only false-positive denominator that exists, so the FP rate can only take the 13 values 0/12..12/12. One flipped healthy session moves it by 8.3 points. Any FP comparison finer than that is noise.",
        "The corpus is NOT held out from baseline A. The fixtures were authored alongside the v2.0 rules, and tests/unit/diagnostics/manifest-acceptance.test.ts asserts the engine reproduces them. Baseline A's perfect scores are a CEILING measured on its own training data, not an estimate of field performance.",
        "Baseline A's measured false-positive rate is 0. D25's FP ceiling is a STRICT '<', so no model can clear it against this baseline: nothing is strictly below zero. The gate is unclearable on this corpus, and that is a fact about the corpus, not a fault in the gate.",
      ],
    },
    scoring: {
      perSessionFlagRule:
        "A session is flagged when the detector produces >= 1 finding/event of ANY severity. Identical rule for both baselines. On this corpus it coincides with the >= 1 warning-or-higher definition: no healthy fixture produces any finding or any anomaly.",
      windowToleranceSamples: DEFAULT_WINDOW_TOLERANCE_SAMPLES,
      perFindingScoredFor: [BASELINE_RULE_ENGINE],
      perFindingOmittedFor: [BASELINE_ANOMALY_HEURISTIC],
      perFindingOmissionReason:
        "Baseline B emits AnomalyEvents (signalLoss|failsafe|lqDrop|txPowerChange), not DiagnosticFindings. That vocabulary does not map onto the 5 rule ids: 'failsafe' has no rule counterpart, nothing in B corresponds to snr-noise or packet-instability, and lqDrop/lq-collapse disagree about which detector owns a zero-bottomed drop. Defining a mapping would manufacture a correspondence the code does not have, so per-finding is NOT computed for B and the report carries the per-finding-not-scored limitation. A and B are compared where the comparison is genuine: the per-session 'is this session clean?' question both answer natively.",
      leadTime: {
        targetMs: PREDICTIVE_LEAD_TIME_TARGET_MS,
        onsetRule: `${FAILSAFE_ONSET_RULE.condition} for >= ${FAILSAFE_ONSET_RULE.minConsecutiveSamples} consecutive samples on the ${FAILSAFE_ONSET_RULE.channel} channel (${FAILSAFE_ONSET_RULE.source})`,
        baselinePredictionCount: 0,
        rationale:
          "Neither baseline has an emission timestamp: evaluateSession and detectAnomalies are batch functions over a complete log and cannot be asked 'when did you know?'. The only timestamps they expose are the edges of their evidence windows, and the choice of edge sets the answer — over these fixtures the same failsafe yields a 'lead' of 40ms or 6080ms depending on whether you read the window start or the window end. So lead time is scored with the real event set and ZERO predictions: the baselines are DETECTORS, not predictors, and every onset reads as missed. That is a statement about their architecture, not a measured predictive failure. M59's predictor must supply genuine emission timestamps and will be scored against this same frozen event set.",
      },
      notes: [
        "Per-finding matching is one-to-one, by ruleId + evidence-window overlap with the manifest window expanded by +/- 8 samples. Severity is not part of the match key.",
        "Per-finding metrics are reported as RATES only where the rule has >= 20 ground-truth instances (lq-collapse n=36, rssi-floor n=22). snr-noise (n=2), tx-power-saturation (n=2) and packet-instability (n=5) are reported as RAW COUNTS: a rate computed from 2 instances is a lie with a decimal point.",
      ],
    },
    wholeCorpus,
    heldOutTestSplit: {
      ...heldOut,
      seed: DEFAULT_SEED,
      ratios: { ...DEFAULT_SPLIT_RATIOS },
    },
    gateBaseline: {
      baselineId: BASELINE_RULE_ENGINE,
      granularity: "per-session",
      split: "test",
      baselineFpRate,
      baselineRecall,
      fpCeilingClearable: baselineFpRate > 0,
    },
  };
}

/**
 * Serialize an artifact to the exact bytes checked in at `data/ml/baseline-v20.json`:
 * 2-space-indented JSON with a trailing newline (matching
 * `scripts/build-knowledge-index.ts`). Deterministic — no timestamp, no machine state.
 */
export function serializeBaselineArtifact(artifact: BaselineArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
