/**
 * M58 — evaluating the anomaly-model prototype against the frozen v2.0 baselines.
 *
 * The counterpart of `baseline.ts`: same fixtures, same {@link runMlEval} harness, same
 * ground truth, same seeded session-level split — so the model's column and the
 * baseline's column can be read side by side without an asterisk. It assembles the
 * checked-in artifact `data/ml/model-eval-m58.json`, whose honesty header mirrors
 * `data/ml/baseline-v20.json`'s.
 *
 * ## The verdict, stated before the code that computes it
 * **The model does not clear the M56 gate, and no model can.** D25's FP ceiling is a
 * strict `<` against a baseline whose measured false-positive rate is **0.000**; nothing
 * is strictly below zero. `clearsM56Gate` returns `false` here not because the model is
 * bad but because the comparison is unsatisfiable — `baseline-v20.json` records the fact
 * as `gateBaseline.fpCeilingClearable: false`, and `tests/unit/ml/baseline.test.ts`
 * already asserts that a *flawless* model fails it too.
 *
 * Nothing in this module tries to route around that. The gate is called, its boolean is
 * recorded verbatim, and `tests/unit/ml/m58Gate.test.ts` will go red if a later commit
 * turns the `false` into a `true`.
 *
 * ## Two partitions, two baselines, never crossed
 * A model metric is only comparable to a baseline metric measured on the **same** set, so
 * each partition is gated against the baseline for *that* partition:
 *  - the **held-out test split** (9 sessions, 3 healthy) against `baseline.gateBaseline` —
 *    the partition `FP_CEILING_RULE.heldOutSplit === "test"` literally names, and the
 *    **official** verdict;
 *  - the **whole corpus** (36 sessions, 12 healthy) against baseline A's whole-corpus
 *    numbers — reported because its denominators are the strongest that exist here, and
 *    labelled as informational, not as the gate.
 * Gating whole-corpus model numbers against a test-split baseline (or vice versa) would be
 * a comparison between two different sets wearing one name. It is not done.
 *
 * ## Every number here is quantised, and the artifact says so
 * The test split has **3** healthy negatives, so its false-positive rate can only take the
 * four values `0/3, 1/3, 2/3, 3/3` — a **33.3-point** quantum (`fpRateQuantumPp(3)`). The
 * whole corpus has 12, for an 8.3-point quantum. A "false-positive rate" computed on three
 * negatives is not a measurement, and this module refuses to present it as one: the quantum
 * travels with every rate, in the artifact and in the UI.
 *
 * ## Purity
 * No I/O, no clock, no unseeded randomness. Fixtures arrive parsed (the script reads them
 * from disk, the test reuses the existing loader) and the frozen baseline arrives as data.
 * Two runs over the same corpus produce a byte-identical artifact.
 */

import type { ParsedLog } from "@/lib/blackbox";
import {
  DEFAULT_DIAGNOSTIC_CONFIG,
  evaluateSession,
  type DiagnosticReport,
} from "@/lib/diagnostics";
import {
  BASELINE_RULE_ENGINE,
  buildEventOnsets,
  buildGroundTruth,
  fingerprintCorpus,
  type BaselineArtifact,
  type BaselineFixture,
} from "./baseline";
import {
  buildDatasetRow,
  splitDataset,
  toMlLabel,
  toTrainingRow,
  type DatasetRow,
  type MlLabel,
} from "./dataset";
import {
  runMlEval,
  type MlEvalReport,
  type SessionPrediction,
  type TimedPrediction,
} from "./evalHarness";
import {
  DEFAULT_SPLIT_RATIOS,
  fpRateQuantumPp,
  MIN_LABELED_SESSIONS_PER_CLASS,
  PREDICTIVE_LEAD_TIME_TARGET_MS,
  type GateBaseline,
} from "./mlConsts";
import { DEFAULT_SEED } from "./rng";
import { round6 } from "./stats";
import {
  explainSession,
  FOREST_TREE_COUNT,
  scoreFeatures,
  trainAnomalyModel,
  type AnomalyModel,
  type AnomalyModelHyperparams,
  type AnomalyModelTrainingInfo,
  type FeatureContribution,
} from "./anomalyModel";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Semantic version of the {@link ModelEvalArtifact} shape. Bump on any breaking change. */
export const MODEL_EVAL_SCHEMA_VERSION = "1.0.0";

/**
 * Prefix cadence (samples) for the early-warning protocol: **5 samples = 200 ms** at the
 * canonical 40 ms cadence.
 *
 * Fine enough that the measured lead is not an artifact of a coarse grid (the whole lead
 * available in these fixtures is ~80 ms — see
 * {@link import("./mlConsts").MEASURED_MAX_FIXTURE_LEAD_MS} — so a coarse stride could
 * *manufacture* a lead by rounding an emission time backwards), and coarse enough that
 * re-scoring 36 sessions at every prefix stays a few seconds rather than a few minutes.
 */
export const PREFIX_STRIDE_SAMPLES = 5;

// ---------------------------------------------------------------------------
// Model predictions over the corpus
// ---------------------------------------------------------------------------

/** One fixture's full-session model verdict, with the explanation behind it. */
export interface ModelSessionResult {
  /** Corpus-local fixture key. Never a user identifier; never fed to the model. */
  sessionId: string;
  label: MlLabel;
  score: number;
  flagged: boolean;
  /** The top contributors, descending. */
  topFeatures: FeatureContribution[];
  /** Inclusive sample window the top contributor's channel is worst over. */
  evidenceWindow: { startIndex: number; endIndex: number };
}

/** Run the trained model over a set of fixtures (full sessions). */
export function modelPredictions(
  model: AnomalyModel,
  fixtures: readonly BaselineFixture[],
  reports: ReadonlyMap<string, DiagnosticReport>
): { sessions: SessionPrediction[]; results: ModelSessionResult[] } {
  const sessions: SessionPrediction[] = [];
  const results: ModelSessionResult[] = [];

  for (const fx of fixtures) {
    const out = explainSession(model, fx.log, reports.get(fx.file));
    sessions.push({
      sessionId: fx.file,
      flagged: out.flagged,
      // The model emits ONE session-level verdict, not a list of findings. Reporting
      // `1` here rather than a fabricated finding count keeps `findingCount` honest:
      // it is a count of what the detector produced, and the model produced one thing.
      findingCount: out.flagged ? 1 : 0,
    });
    results.push({
      sessionId: fx.file,
      label: toMlLabel(fx.label),
      score: out.score,
      flagged: out.flagged,
      topFeatures: out.topFeatures,
      evidenceWindow: out.evidenceWindow,
    });
  }

  return { sessions, results };
}

// ---------------------------------------------------------------------------
// Feature importance
// ---------------------------------------------------------------------------

/** Mean per-feature contribution over a set of sessions, descending. */
export interface FeatureImportance {
  /** The subject: `"allFaulty"`, or a class label. */
  subject: string;
  sessionCount: number;
  /** The strongest contributors for this subject, descending. */
  top: FeatureContribution[];
}

/** Mean contribution per feature across `rows`, sorted descending, truncated to `topN`. */
function meanContributions(
  model: AnomalyModel,
  rows: readonly DatasetRow[],
  topN: number
): FeatureContribution[] {
  if (rows.length === 0) return [];
  const sums = new Map<string, number>();
  for (const row of rows) {
    for (const c of scoreFeatures(model, row.features).contributions) {
      sums.set(c.feature, (sums.get(c.feature) ?? 0) + c.contribution);
    }
  }
  return [...sums.entries()]
    .map(([feature, sum]) => ({
      feature: feature as FeatureContribution["feature"],
      contribution: round6(sum / rows.length),
    }))
    .sort((a, b) => b.contribution - a.contribution || (a.feature < b.feature ? -1 : 1))
    .slice(0, topN);
}

// ---------------------------------------------------------------------------
// The early-warning protocol (M58's second acceptance branch)
// ---------------------------------------------------------------------------

/** Truncate a session to its first `end + 1` samples. Pure; channels are sliced, not mutated. */
function prefixLog(log: ParsedLog, end: number): ParsedLog {
  const n = end + 1;
  const time = log.time.slice(0, n);
  return {
    ...log,
    time,
    channels: log.channels.map((ch) => ({ ...ch, values: ch.values.slice(0, n) })),
    sampleCount: n,
    durationMs: n >= 2 ? time[n - 1] - time[0] : 0,
    gps: log.gps ? log.gps.slice(0, n) : undefined,
  };
}

/** The first time (ms, on the session's own axis) each detector would have warned. */
interface EmissionTimes {
  /** `null` when the detector never flagged this session, at any prefix. */
  modelMs: number | null;
  ruleMs: number | null;
}

/**
 * Replay a session as it arrived, 200 ms at a time, and record when each detector first
 * said something.
 *
 * **The same protocol for both.** The v2.0 rules have no emission timestamp of their own
 * (`baseline.ts` explains at length why reading one off an evidence-window edge is a
 * convention, not a measurement) — so an "earlier than the baseline" claim can only mean
 * anything if the baseline is given the *same* chance to speak early. It is: at every
 * prefix, `evaluateSession` runs on exactly the data the model sees, and the first prefix
 * at which it produces a finding is its emission time. Comparing a prefix-scored model
 * against a baseline credited with **zero** predictions would be comparing a detector that
 * was asked with one that was not.
 */
function emissionTimes(model: AnomalyModel, log: ParsedLog): EmissionTimes {
  let modelMs: number | null = null;
  let ruleMs: number | null = null;

  for (let end = PREFIX_STRIDE_SAMPLES - 1; end < log.sampleCount; end += PREFIX_STRIDE_SAMPLES) {
    const prefix = prefixLog(log, end);
    const report = evaluateSession(prefix, DEFAULT_DIAGNOSTIC_CONFIG);
    const tMs = log.time[end];

    if (ruleMs === null && report.findings.length > 0) ruleMs = tMs;
    if (modelMs === null && explainSession(model, prefix, report).flagged) modelMs = tMs;
    if (modelMs !== null && ruleMs !== null) break;
  }
  return { modelMs, ruleMs };
}

/** What the prefix replay found, for one detector. */
export interface EarlyWarningDetector {
  /** Timestamped first warnings, one per session that was ever flagged. */
  warnedSessions: number;
  /**
   * **Healthy** sessions this detector flagged at *some* prefix. The number that decides
   * M58's second acceptance branch: the FP ceiling is 0, so a single one of these kills
   * "earlier warnings without raising FP".
   */
  healthyFlaggedAtSomePrefix: number;
  /**
   * Sessions the detector flagged at some prefix but did **not** flag on the complete
   * session — i.e. it "warned" and then, given *more* evidence, withdrew.
   *
   * **This is the number that decides whether a lead time here means anything at all.** A
   * detector whose early verdict contradicts its own final verdict is not warning early; it
   * is oscillating around its threshold, and the first crossing of an oscillation is a
   * timestamp, not a prediction. Any lead measured off it is an artifact of the sampling
   * grid.
   */
  flaggedAtPrefixButNotOnFullSession: number;
  /** Lead time against the frozen 17 failsafe onsets, **unbounded** horizon. */
  leadTimeUnbounded: MlEvalReport["leadTime"];
  /** The same, with a horizon of {@link PREDICTIVE_LEAD_TIME_TARGET_MS}. */
  leadTimeBounded: MlEvalReport["leadTime"];
}

/** The early-warning measurement (M58's "or it delivers earlier useful warnings" branch). */
export interface EarlyWarningReport {
  protocol: {
    strideSamples: number;
    strideMs: number;
    horizonBoundedMs: number;
    /** Dev-facing note. Never rendered; this is a data artifact. */
    note: string;
  };
  eventCount: number;
  model: EarlyWarningDetector;
  ruleEngine: EarlyWarningDetector;
  /**
   * `true` only when the model warned **strictly earlier** than the rule engine on at
   * least one event AND flagged **zero** healthy sessions at every prefix. Both halves are
   * required by M58's second branch (the FP ceiling is 0), and it is computed rather than
   * asserted.
   */
  branchMet: boolean;
  /** Everything wrong with the numbers above. Non-empty, and it is the important part. */
  caveats: string[];
}

/** Score one detector's timestamped warnings against the frozen failsafe onsets. */
function scoreEmissions(
  predictions: TimedPrediction[],
  fixtures: readonly BaselineFixture[],
  healthyFlagged: number,
  incoherent: number
): EarlyWarningDetector {
  const groundTruth = buildGroundTruth(fixtures);
  const events = buildEventOnsets(fixtures);
  const sessions: SessionPrediction[] = fixtures.map((fx) => ({
    sessionId: fx.file,
    flagged: predictions.some((p) => p.sessionId === fx.file),
    findingCount: 0,
  }));

  const unbounded = runMlEval({ sessions, leadTime: { predictions, events } }, groundTruth);
  const bounded = runMlEval({ sessions, leadTime: { predictions, events } }, groundTruth, {
    leadTimeHorizonMs: PREDICTIVE_LEAD_TIME_TARGET_MS,
  });

  return {
    warnedSessions: new Set(predictions.map((p) => p.sessionId)).size,
    healthyFlaggedAtSomePrefix: healthyFlagged,
    flaggedAtPrefixButNotOnFullSession: incoherent,
    leadTimeUnbounded: unbounded.leadTime,
    leadTimeBounded: bounded.leadTime,
  };
}

/** Run the prefix replay over the whole corpus for both detectors. */
export function measureEarlyWarning(
  model: AnomalyModel,
  fixtures: readonly BaselineFixture[]
): EarlyWarningReport {
  const modelPreds: TimedPrediction[] = [];
  const rulePreds: TimedPrediction[] = [];
  let modelHealthyFlagged = 0;
  let ruleHealthyFlagged = 0;
  let modelIncoherent = 0;
  let ruleIncoherent = 0;

  for (const fx of fixtures) {
    const { modelMs, ruleMs } = emissionTimes(model, fx.log);
    const fullReport = evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
    const modelFlagsFullSession = explainSession(model, fx.log, fullReport).flagged;
    const ruleFlagsFullSession = fullReport.findings.length > 0;

    if (modelMs !== null) {
      modelPreds.push({ sessionId: fx.file, tMs: modelMs });
      if (fx.expectClean) modelHealthyFlagged += 1;
      if (!modelFlagsFullSession) modelIncoherent += 1;
    }
    if (ruleMs !== null) {
      rulePreds.push({ sessionId: fx.file, tMs: ruleMs });
      if (fx.expectClean) ruleHealthyFlagged += 1;
      if (!ruleFlagsFullSession) ruleIncoherent += 1;
    }
  }

  const modelDetector = scoreEmissions(modelPreds, fixtures, modelHealthyFlagged, modelIncoherent);
  const ruleDetector = scoreEmissions(rulePreds, fixtures, ruleHealthyFlagged, ruleIncoherent);

  // "Earlier" is decided per event, on the same event set, under the bounded horizon —
  // the one that refuses to credit a warning fired in a previous event's aftermath (or in
  // a standing fault's presence) with a multi-second lead on the NEXT failsafe.
  const modelLeads = new Map<string, number>();
  for (const c of modelDetector.leadTimeBounded?.cases ?? []) {
    if (c.outcome === "predicted" && c.leadMs !== null) {
      modelLeads.set(`${c.sessionId}@${c.onsetMs}`, c.leadMs);
    }
  }
  const ruleLeads = new Map<string, number>();
  for (const c of ruleDetector.leadTimeBounded?.cases ?? []) {
    if (c.outcome === "predicted" && c.leadMs !== null) {
      ruleLeads.set(`${c.sessionId}@${c.onsetMs}`, c.leadMs);
    }
  }
  let strictlyEarlierEvents = 0;
  for (const [key, lead] of modelLeads) {
    if (lead > (ruleLeads.get(key) ?? 0)) strictlyEarlierEvents += 1;
  }

  // M58's second branch, literally: "earlier useful warnings" AND "without raising FP above
  // the ceiling". The FP ceiling is 0, so a single healthy session flagged at any prefix
  // fails the second half outright.
  const branchMet = strictlyEarlierEvents > 0 && modelHealthyFlagged === 0;
  const eventCount = buildEventOnsets(fixtures).length;
  const healthyCount = fixtures.filter((f) => f.expectClean).length;

  return {
    protocol: {
      strideSamples: PREFIX_STRIDE_SAMPLES,
      strideMs: PREFIX_STRIDE_SAMPLES * 40,
      horizonBoundedMs: PREDICTIVE_LEAD_TIME_TARGET_MS,
      note:
        "Both detectors are replayed over the SAME prefixes of the SAME sessions: at each 200 ms step the model and evaluateSession() see exactly the samples that had arrived, and each detector's emission time is the first prefix at which it says anything. The rule engine is given the same chance to speak early that the model is; crediting a prefix-scored model against a baseline held to zero predictions would compare a detector that was asked with one that was not.",
    },
    eventCount,
    model: modelDetector,
    ruleEngine: ruleDetector,
    branchMet,
    caveats: [
      `BRANCH NOT MET, and the first reason is decisive: the model flagged ${modelHealthyFlagged} of the ${healthyCount} HEALTHY sessions at some prefix. M58's second branch requires earlier warnings "without raising FP above the ceiling", and the ceiling is 0. The rule engine flagged ${ruleHealthyFlagged}.`,
      `The second reason is that the model's prefix verdicts are not coherent with its own final verdicts: on ${modelIncoherent} sessions it flagged at some prefix and then did NOT flag the complete session. It warned, and then — given MORE evidence — withdrew. A detector that contradicts itself is not warning early; it is oscillating across its threshold, and the first crossing of an oscillation is a timestamp, not a prediction. (The rule engine: ${ruleIncoherent}.)`,
      `Nominally the model "warned strictly earlier" than the rule engine on ${strictlyEarlierEvents} of the ${eventCount} frozen failsafe onsets under the ${PREDICTIVE_LEAD_TIME_TARGET_MS} ms horizon. That number is reported and NOT believed, for the two reasons above and the two below.`,
      "An UNBOUNDED horizon inflates it further. On a wiring session the RSSI imbalance is present from sample 0, so the model flags the very first prefix — and an unbounded scorer then credits that flag with a multi-second 'lead' on a failsafe seconds later. Even where that flag is genuine it is the detection of a STANDING FAULT, not the prediction of a failsafe: the model did not foresee the link dying, it noticed a bad antenna feed that had been there all along. Both numbers are in this artifact; only the bounded one is even a candidate for being a lead time.",
      "And the link-collapse signal itself carries no usable lead in this corpus. Link quality sits at ~90 until roughly 2 samples (80 ms) before the failsafe edge (MEASURED_MAX_FIXTURE_LEAD_MS = 80), which is 25x short of the 2000 ms product target (PREDICTIVE_LEAD_TIME_TARGET_MS). No model predicts from a signal that is not in the data.",
      "Finally, none of this could clear the M56 gate even if it were real: the gate is FP + recall on the complete session, and D25's FP ceiling is a strict '<' against a baseline FP rate of 0.000.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Hyperparameter sensitivity — the anti-strawman check
// ---------------------------------------------------------------------------

/** One cell of the sensitivity grid, scored on **train + val only**. */
export interface SensitivityCell {
  trees: number;
  heightLimit: number;
  /** `true` for the cell the shipped model actually uses (Liu et al.'s reference defaults). */
  isShippedConfig: boolean;
  /** The a-priori threshold this configuration produced (max training score). */
  threshold: number;
  /**
   * Rank AUC of faulty-vs-healthy scores over train + val — a **threshold-free** read of
   * how separable the two classes are under this configuration. 0.5 is a coin.
   */
  aucTrainVal: number;
  /** Recall over train + val at that configuration's own threshold. */
  recallTrainVal: number;
  /** False-positive rate over train + val at that configuration's own threshold. */
  fpRateTrainVal: number;
}

/**
 * The sensitivity probe, and what it is for.
 *
 * A reader is entitled to ask whether the model's weak numbers are the *corpus* talking or
 * merely a badly-configured forest — i.e. whether the prototype is a strawman built to
 * lose. This section answers that with data instead of assurance.
 *
 * **It selects nothing.** The shipped model is Liu et al.'s reference configuration (100
 * trees, `ceil(log2 ψ)` height limit), fixed before any score was computed and never
 * changed. The grid is scored on **train + val only** — the held-out test split is not in
 * it, and no cell of it can reach the gate.
 *
 * The result is the interesting part: **no cell separates the classes**, and the cells with
 * *more* trees — which estimate the expected path length *more accurately* — separate them
 * **worse**. That is the signature of a model whose apparent performance at 100 trees is
 * substantially Monte-Carlo noise, and it is the strongest single piece of evidence that
 * the ceiling here is the 7-session training set and not the hyperparameters.
 */
export interface SensitivityReport {
  /** Sessions the grid was scored on (train + val). The test split is NOT among them. */
  scoredOnSessions: number;
  cells: SensitivityCell[];
  note: string;
}

/** Rank AUC of `pos` vs `neg` (ties count a half). Pure; 0.5 is chance. */
function rankAuc(pos: readonly number[], neg: readonly number[]): number {
  if (pos.length === 0 || neg.length === 0) return 0;
  let wins = 0;
  for (const p of pos) {
    for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  }
  return round6(wins / (pos.length * neg.length));
}

/** Score a small, fixed grid of configurations on train + val. Selects nothing. */
function measureSensitivity(
  trainRows: readonly DatasetRow[],
  valRows: readonly DatasetRow[],
  shipped: AnomalyModel
): SensitivityReport {
  const inspect = [...trainRows, ...valRows];
  const trainingRows = trainRows.map(toTrainingRow);
  const referenceHeight = shipped.hyperparams.heightLimit;
  // Full isolation over ψ points: the deepest a tree could ever go. The other pole of the
  // one hyperparameter that could plausibly be blamed for the result.
  const fullHeight = Math.max(referenceHeight, shipped.hyperparams.subsampleSize);

  const cells: SensitivityCell[] = [];
  for (const trees of [FOREST_TREE_COUNT, 1000]) {
    for (const heightLimit of [referenceHeight, fullHeight]) {
      const model = trainAnomalyModel(trainingRows, {
        seed: DEFAULT_SEED,
        trees,
        heightLimit,
      });
      const healthy: number[] = [];
      const faulty: number[] = [];
      for (const row of inspect) {
        const s = scoreFeatures(model, row.features).score;
        (row.label === "healthy" ? healthy : faulty).push(s);
      }
      const tp = faulty.filter((s) => s > model.threshold).length;
      const fp = healthy.filter((s) => s > model.threshold).length;
      cells.push({
        trees,
        heightLimit,
        isShippedConfig:
          trees === shipped.hyperparams.trees && heightLimit === referenceHeight,
        threshold: model.threshold,
        aucTrainVal: rankAuc(faulty, healthy),
        recallTrainVal: faulty.length > 0 ? round6(tp / faulty.length) : 0,
        fpRateTrainVal: healthy.length > 0 ? round6(fp / healthy.length) : 0,
      });
    }
  }

  return {
    scoredOnSessions: inspect.length,
    cells,
    note:
      "This grid SELECTS NOTHING. The shipped model is Liu et al.'s reference configuration (100 trees, ceil(log2 psi) height limit), fixed before any score was computed. The grid is scored on train+val only — the held-out test split is not in it — and exists solely to answer whether the model's weak numbers are the corpus or a badly-configured forest. They are the corpus: no cell separates the classes, and the 1000-tree cells (which estimate the expected path length MORE accurately) separate them WORSE than the 100-tree ones. A model whose apparent performance improves when you estimate its score less carefully is a model whose performance is substantially Monte-Carlo noise.",
  };
}

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

/** One partition, scored: the model beside the baseline it is gated against. */
export interface ModelEvalPartition {
  sessionCount: number;
  negativeSessions: number;
  positiveSessions: number;
  /** `100 / negativeSessions` — the smallest step this partition's FP rate can move by. */
  fpRateQuantumPp: number;
  /** The baseline this partition's gate was run against (same partition, always). */
  gateBaseline: GateBaseline;
  /** The model's report, with D25's gate actually run. */
  model: MlEvalReport;
  /** `model.passes`, restated at the top level so nobody has to go and find it. */
  passes: boolean;
  /** Per-session model output, for a human to look at. */
  results: ModelSessionResult[];
}

/** The honesty header. Mirrors `BaselineHonesty` — same discipline, same prominence. */
export interface ModelEvalHonesty {
  /** `true`. Nothing in this file is a gate pass. */
  indicativeNotAGatePass: boolean;
  /** `false`, on both partitions. The boolean `clearsM56Gate` actually returned. */
  clearedM56Gate: boolean;
  /**
   * `false`. D25's FP ceiling is a **strict `<`** against a baseline FP rate of 0.000, so
   * NO model can clear it — not this one, not a flawless one. Copied from
   * `baseline-v20.json`'s `gateBaseline.fpCeilingClearable` rather than re-derived.
   */
  fpCeilingClearable: boolean;
  /** Sessions in the whole labeled corpus. **36.** */
  corpusSessions: number;
  /** D21's bar, per class. **300.** */
  d21RequiredSessionsPerClass: number;
  /** `false`. */
  d21Met: boolean;
  /** Rows the one-class model was actually fit to. **7.** */
  trainingRows: number;
  /** Healthy negatives in the held-out test split. **3.** */
  heldOutHealthySessions: number;
  /** The test split's FP quantum in percentage points. **33.3.** */
  heldOutFpRateQuantumPp: number;
  /** Dev-facing notes. Never rendered as UI copy; this is a data artifact. */
  notes: string[];
}

/** The frozen M58 model-evaluation artifact (`data/ml/model-eval-m58.json`). */
export interface ModelEvalArtifact {
  schemaVersion: string;
  mlDatasetSchemaVersion: string;
  /** Which model produced these numbers, and under what hyperparameters. */
  model: {
    modelId: string;
    schemaVersion: string;
    hyperparams: AnomalyModelHyperparams;
    training: AnomalyModelTrainingInfo;
    /** The a-priori flag threshold, fitted on the train split alone. */
    threshold: number;
    pathNorm: number;
    /** Where the trained forest itself lives (it is a separate, compact artifact). */
    forestArtifact: string;
  };
  corpus: {
    manifestVersion: string;
    sessionCount: number;
    /** The SAME 64-bit fingerprint `baseline-v20.json` carries. They must agree. */
    fingerprint: string;
    /** The baseline artifact these numbers were gated against. */
    baselineFingerprint: string;
    split: { seed: number; ratios: typeof DEFAULT_SPLIT_RATIOS; train: number; val: number; test: number };
  };
  honesty: ModelEvalHonesty;
  /**
   * **The official verdict.** `FP_CEILING_RULE.heldOutSplit === "test"`, so this is the
   * partition D25 names and this is the boolean that decides M58.
   */
  heldOutTestSplit: ModelEvalPartition;
  /** Informational: the strongest denominators available. NOT the gate. */
  wholeCorpus: ModelEvalPartition;
  /** What the model learned to look at, overall and per class. */
  featureImportance: FeatureImportance[];
  /** M58's second acceptance branch, measured rather than asserted. */
  earlyWarning: EarlyWarningReport;
  /** Proof the shipped configuration is not a strawman. Selects nothing; never sees test. */
  sensitivity: SensitivityReport;
}

/** Score one partition: run the model, run the gate, keep the boolean. */
function scorePartition(
  model: AnomalyModel,
  fixtures: readonly BaselineFixture[],
  gateBaseline: GateBaseline
): ModelEvalPartition {
  const groundTruth = buildGroundTruth(fixtures);
  const reports = new Map<string, DiagnosticReport>();
  for (const fx of fixtures) {
    reports.set(fx.file, evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG));
  }

  const { sessions, results } = modelPredictions(model, fixtures, reports);

  // `findings` is deliberately OMITTED: the model emits one session-level score, not
  // findings with rule ids and windows. Matching its single verdict against the corpus's
  // five rule ids would manufacture a correspondence the model does not have — the same
  // reason `baseline.ts` refuses to score baseline B per-finding. The report carries the
  // `per-finding-not-scored` limitation instead.
  const report = runMlEval({ sessions }, groundTruth, { gateBaseline });

  const negativeSessions = fixtures.filter((f) => f.expectClean).length;
  return {
    sessionCount: fixtures.length,
    negativeSessions,
    positiveSessions: fixtures.length - negativeSessions,
    fpRateQuantumPp: round6(fpRateQuantumPp(negativeSessions)),
    gateBaseline,
    model: report,
    passes: report.passes,
    results,
  };
}

/**
 * Train the M58 model on the **train split only** and score it against the frozen v2.0
 * baseline, on both the held-out test split and the whole corpus.
 *
 * Pure + deterministic: the only randomness is {@link DEFAULT_SEED}, threaded through
 * `splitDataset` and `trainAnomalyModel`. Two runs over the same corpus produce a
 * deep-equal artifact — which is what `tests/unit/ml/m58Gate.test.ts` relies on to prove
 * the checked-in JSON has not drifted from the code that produced it.
 *
 * @param fixtures every labelled fixture, already parsed.
 * @param manifestVersion the fixture manifest's own `version`.
 * @param baseline the frozen `data/ml/baseline-v20.json`, read by the caller.
 */
export function evaluateAnomalyModel(
  fixtures: readonly BaselineFixture[],
  manifestVersion: string,
  baseline: BaselineArtifact
): { artifact: ModelEvalArtifact; model: AnomalyModel } {
  const ordered = [...fixtures].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  // The SAME split `baseline.ts` measured its held-out numbers on — produced by the same
  // `splitDataset` call with the same seed, not re-implemented. That is the only reason
  // "the same held-out set" in D25 is a true statement here.
  const rows: DatasetRow[] = ordered.map((fx) =>
    buildDatasetRow(fx.file, fx.label, fx.log, evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG))
  );
  const split = splitDataset(rows, { seed: DEFAULT_SEED, ratios: { ...DEFAULT_SPLIT_RATIOS } });

  // TRAIN ONLY, and stripped of session keys before the model can see them.
  const model = trainAnomalyModel(split.train.map(toTrainingRow), { seed: DEFAULT_SEED });

  const testIds = new Set(split.test.map((r) => r.sessionId));
  const testFixtures = ordered.filter((fx) => testIds.has(fx.file));

  const heldOutTestSplit = scorePartition(model, testFixtures, {
    baselineFpRate: baseline.gateBaseline.baselineFpRate,
    baselineRecall: baseline.gateBaseline.baselineRecall,
  });

  // The whole-corpus gate reads the whole-corpus baseline — same set, same denominators.
  const wholeBaseline = baseline.wholeCorpus.baselines[BASELINE_RULE_ENGINE].perSession;
  const wholeCorpus = scorePartition(model, ordered, {
    baselineFpRate: wholeBaseline.falsePositiveRate.value,
    baselineRecall: wholeBaseline.recall.value,
  });

  const faulty = rows.filter((r) => r.label !== "healthy");
  const featureImportance: FeatureImportance[] = [
    { subject: "allFaulty", sessionCount: faulty.length, top: meanContributions(model, faulty, 8) },
  ];
  for (const label of ["healthy", "warning", "failsafe", "wiringSuspicion", "antennaSuspicion"] as const) {
    const group = rows.filter((r) => r.label === label);
    featureImportance.push({
      subject: label,
      sessionCount: group.length,
      top: meanContributions(model, group, 5),
    });
  }

  const earlyWarning = measureEarlyWarning(model, ordered);
  const heldOutNegatives = heldOutTestSplit.negativeSessions;

  const artifact: ModelEvalArtifact = {
    schemaVersion: MODEL_EVAL_SCHEMA_VERSION,
    mlDatasetSchemaVersion: baseline.mlDatasetSchemaVersion,
    model: {
      modelId: model.modelId,
      schemaVersion: model.schemaVersion,
      hyperparams: model.hyperparams,
      training: model.training,
      threshold: model.threshold,
      pathNorm: model.pathNorm,
      forestArtifact: "data/ml/model-m58.json",
    },
    corpus: {
      manifestVersion,
      sessionCount: ordered.length,
      fingerprint: fingerprintCorpus(ordered),
      baselineFingerprint: baseline.corpus.fingerprint,
      split: {
        seed: DEFAULT_SEED,
        ratios: { ...DEFAULT_SPLIT_RATIOS },
        train: split.train.length,
        val: split.val.length,
        test: split.test.length,
      },
    },
    honesty: {
      indicativeNotAGatePass: true,
      clearedM56Gate: heldOutTestSplit.passes,
      fpCeilingClearable: baseline.gateBaseline.fpCeilingClearable,
      corpusSessions: ordered.length,
      d21RequiredSessionsPerClass: MIN_LABELED_SESSIONS_PER_CLASS,
      d21Met: baseline.honesty.d21Met,
      trainingRows: model.training.rowCount,
      heldOutHealthySessions: heldOutNegatives,
      heldOutFpRateQuantumPp: round6(fpRateQuantumPp(heldOutNegatives)),
      notes: [
        "THE MODEL DOES NOT CLEAR THE M56 GATE, AND NO MODEL CAN. D25's false-positive ceiling is a STRICT '<' against the measured v2.0 baseline, whose FP rate on the held-out test split is 0.000. Nothing is strictly below zero. clearsM56Gate() returns false for this model, and it returns false for a flawless oracle too (asserted in tests/unit/ml/baseline.test.ts).",
        "The v2.0 baseline's 1.000 precision / 1.000 recall / 0.000 FP is a CEILING, not field performance: the 36 fixtures were authored alongside the v2.0 rules and manifest-acceptance.test.ts asserts the engine reproduces them. There is nothing to beat, and no headroom to beat it in.",
        `The one-class model was fit to ${model.training.rowCount} healthy sessions in 43 dimensions. That is not a training set; it is a handful of points. D21 asks for ${MIN_LABELED_SESSIONS_PER_CLASS} labeled sessions PER CLASS.`,
        `The held-out test split has ${heldOutNegatives} healthy negatives, so its false-positive rate quantises in ${round6(fpRateQuantumPp(heldOutNegatives))}-point steps: the only values it can take are 0/3, 1/3, 2/3, 3/3. A number computed on three negatives is not a measurement.`,
        `The forest is structurally blind along ${model.training.constantFeatures.length} of the 43 features, because they are constant across the healthy training rows and an isolation tree can only cut a feature that varies. Every v2.0 finding count and pattern flag is among them. The model detects faults through the continuous channel statistics and through nothing else.`,
        "Per-finding metrics are NOT computed for the model. It emits one session-level score, not findings with rule ids and evidence windows; matching that single verdict against the corpus's five rule ids would manufacture a correspondence the model does not have.",
      ],
    },
    heldOutTestSplit,
    wholeCorpus,
    featureImportance,
    earlyWarning,
    sensitivity: measureSensitivity(split.train, split.val, model),
  };

  return { artifact, model };
}

/**
 * Serialize the eval artifact to the exact bytes checked in at
 * `data/ml/model-eval-m58.json`: 2-space-indented JSON with a trailing newline, matching
 * `serializeBaselineArtifact`. Deterministic — no timestamp, no machine state.
 */
export function serializeModelEvalArtifact(artifact: ModelEvalArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
