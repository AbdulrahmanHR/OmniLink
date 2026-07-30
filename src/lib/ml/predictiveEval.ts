/**
 * M59 — evaluating the predictive failsafe warner, on two corpora that are never mixed.
 *
 * ## THE VERDICT, stated before the code that computes it
 * **M59's acceptance is UNMET on the real corpus, and it is unmeetable there by any
 * predictor.** The real corpus contains **no predictive signal**: the median lead time
 * available to a *perfect oracle* is **0 ms**, and the maximum is **80 ms**, against a
 * {@link PREDICTIVE_LEAD_TIME_TARGET_MS} ms target. That is an **oracle bound** measured by
 * `predictive.ts::measureCorpusLeadCeiling` — a property of the data, not a score achieved
 * by this predictor — so it forecloses the obvious objection that the predictor was merely
 * bad. There is nothing there to find.
 *
 * **The null result is the deliverable.** This module is built to measure it precisely, to
 * record it in a checked-in artifact, and to make a future commit that claims otherwise go
 * red (`tests/unit/ml/predictive.test.ts` pins it).
 *
 * ## The two tracks, and the wall between them
 *  - **{@link PredictiveEvalArtifact.realCorpus}** — the frozen 36-fixture corpus. This is
 *    the **only** partition M59's acceptance is measured on. It carries the null.
 *  - **{@link PredictiveEvalArtifact.syntheticCorpus}** — the generated ramp corpus
 *    (`syntheticCorpus.ts`). **Indicative only. Never an acceptance pass.** It exists to
 *    prove the pipeline runs end-to-end and to measure the false-alarm rate against
 *    genuinely confusable near-miss negatives — a thing the real corpus cannot do, because
 *    it contains no ramps at all.
 *
 * The two are scored by separate calls over separate session lists, are stored under
 * separate keys, and are never pooled. `syntheticCorpusNotFieldEvidence: true` is stamped
 * into the artifact's honesty header, and `acceptanceMetOnRealCorpus` is the **only** field
 * that decides M59.
 *
 * ## The false-alarm rate is reported TWICE, on purpose
 * "False-alarm rate" is ambiguous, and the ambiguity is exactly where a flattering number
 * could hide. Both denominators are reported, named, and neither is allowed to stand alone:
 *
 *  - **{@link PredictivePartition.predictiveFpRate}** — over **every session with no
 *    failsafe**. This is what a false alarm *means* for a failsafe predictor, and on the
 *    real corpus its denominator (24) includes the 7 `warning` fixtures — the genuinely
 *    confusable ones. It is the honest number and it is the headline.
 *  - **{@link PredictivePartition.healthyOnlyFpRate}** — over the **healthy** sessions only.
 *    This is the denominator M56's FP ceiling is *defined* on, so it is the only number that
 *    can legally be fed to `clearsFpCeiling`. It is also the *flattering* one, because it
 *    excludes every confusable negative.
 *
 * Quoting only the second would be choosing the comparison that makes the predictor look
 * best. Both are here, both are labelled, and `clearsFpCeiling` is run against the one D25
 * names — which fails regardless, because D25's ceiling is a strict `<` against a measured
 * baseline FP rate of **0.000** and nothing is strictly below zero. That half of the gate is
 * unclearable for the same structural reason M58's was (`baseline-v20.json` →
 * `gateBaseline.fpCeilingClearable: false`).
 *
 * **So M59 fails both halves of its acceptance, independently.** That matters: the
 * lead-time failure is *substantive* (there is no signal) and does not depend in any way on
 * the FP half being unclearable. Even if D25's ceiling were reachable, M59 would still fail
 * on 0 ms of lead.
 *
 * ## Purity
 * No I/O, no clock, no unseeded randomness. Sessions arrive parsed. Two runs over the same
 * corpora produce a byte-identical artifact.
 */

import type { ParsedLog } from "@/lib/blackbox";
import { findFailsafeOnsetIndices } from "./baseline";
import type { MlLabel } from "./dataset";
import {
  rateMetric,
  runMlEval,
  type EventOnset,
  type MlEvalReport,
  type MlGroundTruth,
  type RateMetric,
  type SessionPrediction,
  type SessionTruth,
  type TimedPrediction,
} from "./evalHarness";
import {
  clearsFpCeiling,
  fpRateQuantumPp,
  MEASURED_MAX_FIXTURE_LEAD_MS,
  PREDICTIVE_LEAD_TIME_TARGET_MS,
  type GateBaseline,
} from "./mlConsts";
import {
  alertFramesFromLog,
  measureCorpusLeadCeiling,
  runPredictorIntervals,
  PREDICTIVE_CREDIT_HORIZON_MS,
  PREDICTIVE_CLEAR_THRESHOLD,
  PREDICTIVE_RISK_THRESHOLD,
  PREDICTIVE_TRIP_FRAMES,
  PREDICTIVE_WINDOW_SAMPLES,
  PREDICTOR_ID,
  PREDICTIVE_SCHEMA_VERSION,
  type LeadCeilingReport,
} from "./predictive";
import { DEFAULT_SEED } from "./rng";
import { round6 } from "./stats";

/** Semantic version of the {@link PredictiveEvalArtifact} shape. Bump on any breaking change. */
export const PREDICTIVE_EVAL_SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Input: one corpus, whatever its provenance
// ---------------------------------------------------------------------------

/**
 * One session to score. Deliberately *neutral* about provenance — the real fixtures and the
 * synthetic sessions are both projected onto this shape by the caller, so the **scoring code
 * is provably identical for both** and no reader has to check whether the synthetic track
 * got an easier scorer. Which corpus a session came from is recorded by the *partition it is
 * scored into*, never by the scorer.
 */
export interface PredictiveCorpusSession {
  /** Corpus-local key. For the synthetic corpus it is prefixed `synthetic/`. Never an identifier. */
  sessionId: string;
  /** Canonical class, for the D21 limitation machinery + the per-class FP breakdown. */
  label: MlLabel;
  /**
   * The bucket the false-alarm breakdown is grouped by: the real class (`healthy`,
   * `warning`, `antenna`…) or the synthetic depth band (`shallow`, `moderate`, `deep`,
   * `steady`). It is what lets the report say *where* the false alarms came from instead of
   * averaging a hard case against an easy one.
   */
  bucket: string;
  log: ParsedLog;
}

// ---------------------------------------------------------------------------
// Ground truth — the PREDICTIVE one, and why it is not the manifest's
// ---------------------------------------------------------------------------

/**
 * Build the predictive ground truth: a session is a **positive** iff it contains at least one
 * failsafe onset under the **frozen** `findFailsafeOnsetIndices` rule.
 *
 * ## This is NOT `baseline.ts::buildGroundTruth`, and the difference is deliberate
 * `buildGroundTruth` reads the manifest's `expectClean`, i.e. *is this session healthy?*.
 * That is the right question for a **fault detector** and it is what D25's gate is defined
 * on. It is the **wrong** question for a **failsafe predictor**: under it, the 7 `warning`
 * fixtures — which are precisely the sessions a failsafe predictor is most likely to
 * false-alarm on, because they dip and recover — count as **positives**, and firing on them
 * would be scored as a *success*.
 *
 * Using the manifest's definition here would therefore have *hidden* the predictor's hardest
 * failure mode inside its recall. So the event definition is inherited (M59 does not invent
 * an onset rule) but the **session** definition follows the event: positive = "this session
 * failsafed". The confusable `warning` sessions land where they belong — in the false-alarm
 * denominator.
 *
 * The manifest's healthy/faulty view is not discarded; it is reported alongside, as
 * {@link PredictivePartition.healthyOnlyFpRate}, because D25's ceiling is defined on it.
 */
export function buildPredictiveGroundTruth(
  sessions: readonly PredictiveCorpusSession[]
): MlGroundTruth {
  const truths: SessionTruth[] = sessions.map((s) => ({
    sessionId: s.sessionId,
    label: s.label,
    // `clean` here means "did NOT failsafe" — see the docblock.
    clean: findFailsafeOnsetIndices(s.log).length === 0,
  }));
  // No finding-level ground truth: a predictive warning has no `ruleId`, and matching it
  // against the v2.0 rule vocabulary would manufacture a correspondence it does not have —
  // the same reason `baseline.ts` refuses to score baseline B per-finding.
  return { sessions: truths, findings: [] };
}

/** The frozen failsafe onsets across a corpus, in session order. */
export function buildPredictiveOnsets(
  sessions: readonly PredictiveCorpusSession[]
): EventOnset[] {
  const events: EventOnset[] = [];
  for (const s of sessions) {
    for (const i of findFailsafeOnsetIndices(s.log)) {
      events.push({ sessionId: s.sessionId, onsetMs: s.log.time[i] });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Running the predictor
// ---------------------------------------------------------------------------

/** What the predictor did on one session. */
export interface PredictiveSessionResult {
  sessionId: string;
  label: MlLabel;
  bucket: string;
  /** Ground truth: did this session actually failsafe? */
  failsafed: boolean;
  /** Did the predictor warn at all? A `true` on a `failsafed: false` session is a false alarm. */
  warned: boolean;
  /** Warnings raised. */
  warningCount: number;
  /**
   * Warnings the predictor **withdrew before the failsafe it is supposedly about**. Each one
   * is a warning that, by the predictor's own admission, stopped being true — and each one is
   * a multi-second phantom "lead" in the naive scoring. See {@link PredictivePartition
   * .leadTimeNaive}.
   */
  withdrawnBeforeOnset: number;
  /** Session-axis ms of the first warning, or `null`. */
  firstWarningMs: number | null;
  /** Confidence of the first warning, or `null`. */
  firstConfidence: number | null;
}

/**
 * Replay every session through the predictor. Pure; the **live** frame path, not an offline
 * variant.
 *
 * Produces **two** prediction sets, because the difference between them is M59's central
 * measurement problem:
 *
 *  - **`naivePredictions`** — every warning start, unconditionally. This is what a scorer that
 *    only sees timestamps would use, and on the real corpus it reports a **multi-second median
 *    lead**. That number is an **artifact**, and it is provably one: the corpus's own oracle
 *    ceiling is **80 ms**, so a 3.5 s lead cannot be real. It is reported anyway — believing
 *    only the coherent number while *hiding* the naive one would be asking the reader to take
 *    the correction on trust.
 *
 *  - **`coherentPredictions`** — warning starts, **minus** any warning the predictor
 *    **withdrew before the onset it would otherwise be credited with predicting**. A warning
 *    that was raised, then cleared because the link *recovered*, and only then followed by a
 *    separate collapse, did not predict that collapse. It predicted a collapse that did not
 *    happen. This is the honest set, and it is the one the headline reads.
 *
 * The rule is decided by the **predictor's own hysteresis state machine** — not by a scoring
 * convention invented after the numbers were seen. It is the generalisation of the incoherence
 * M58 found and correctly disbelieved (`flaggedAtPrefixButNotOnFullSession`).
 */
export function runPredictorOverCorpus(sessions: readonly PredictiveCorpusSession[]): {
  sessions: SessionPrediction[];
  naivePredictions: TimedPrediction[];
  coherentPredictions: TimedPrediction[];
  results: PredictiveSessionResult[];
} {
  const sessionPreds: SessionPrediction[] = [];
  const naivePredictions: TimedPrediction[] = [];
  const coherentPredictions: TimedPrediction[] = [];
  const results: PredictiveSessionResult[] = [];

  for (const s of sessions) {
    const intervals = runPredictorIntervals(alertFramesFromLog(s.log));
    const onsetIndices = findFailsafeOnsetIndices(s.log);
    const onsetTimes = onsetIndices.map((i) => s.log.time[i]);

    let withdrawn = 0;

    for (const interval of intervals) {
      naivePredictions.push({ sessionId: s.sessionId, tMs: interval.startMs });

      // The event this warning could possibly be about: the first onset at or after it.
      const nextOnset = onsetTimes.find((t) => t >= interval.startMs);

      // Withdrawn before that event ⇒ it is not a prediction of it. Drop it from the coherent
      // set. (`coversOnset` is the same predicate, expressed positively; this branch is the
      // one that also has to handle "there is no later onset at all".)
      if (nextOnset !== undefined && interval.endMs !== null && interval.endMs < nextOnset) {
        withdrawn += 1;
        continue;
      }
      coherentPredictions.push({ sessionId: s.sessionId, tMs: interval.startMs });
    }

    sessionPreds.push({
      sessionId: s.sessionId,
      // A false alarm is a warning the pilot SAW. Withdrawal does not un-ring the bell, so the
      // session-level flag counts every warning — including the withdrawn ones. Only the
      // *lead-time credit* is withheld from them, never the false-alarm debit.
      flagged: intervals.length > 0,
      findingCount: intervals.length,
    });
    results.push({
      sessionId: s.sessionId,
      label: s.label,
      bucket: s.bucket,
      failsafed: onsetIndices.length > 0,
      warned: intervals.length > 0,
      warningCount: intervals.length,
      withdrawnBeforeOnset: withdrawn,
      firstWarningMs: intervals.length > 0 ? intervals[0].startMs : null,
      firstConfidence: intervals.length > 0 ? intervals[0].warning.confidence : null,
    });
  }

  return { sessions: sessionPreds, naivePredictions, coherentPredictions, results };
}

// ---------------------------------------------------------------------------
// Horizon sensitivity — so nobody has to trust that the horizon was fair
// ---------------------------------------------------------------------------

/** Lead time re-scored under one creditability horizon. */
export interface HorizonCell {
  /** `null` = unbounded. */
  horizonMs: number | null;
  eventCount: number;
  predictedCount: number;
  lateCount: number;
  missedCount: number;
  coverage: number;
  medianLeadMs: number | null;
  maxLeadMs: number | null;
  meetsTargetMedian: boolean;
}

/**
 * Re-score lead time at several horizons, **including unbounded**.
 *
 * The obvious objection to a null lead-time result is *"you chose a horizon that threw the
 * predictor's early warnings away"*. This table answers it with data. On the real corpus the
 * median lead is **0 ms under every horizon, including no horizon at all** — because there is
 * nothing there to credit under any of them.
 *
 * It is also the guard `modelEval.ts` learned the hard way: an **unbounded** horizon is what
 * let M58's probe credit a standing wiring fault, flagged at sample 0, with a multi-second
 * "lead" on a failsafe it never foresaw. Reporting the unbounded cell **and** the bounded
 * ones — and believing only the bounded one — is the honest way to present both.
 */
function scoreHorizons(
  predictions: readonly TimedPrediction[],
  events: readonly EventOnset[],
  sessionPreds: readonly SessionPrediction[],
  groundTruth: MlGroundTruth
): HorizonCell[] {
  const horizons: (number | null)[] = [
    PREDICTIVE_LEAD_TIME_TARGET_MS,
    PREDICTIVE_CREDIT_HORIZON_MS,
    null,
  ];

  return horizons.map((horizonMs) => {
    const report = runMlEval(
      { sessions: sessionPreds, leadTime: { predictions, events } },
      groundTruth,
      { leadTimeHorizonMs: horizonMs }
    );
    const lt = report.leadTime;
    return {
      horizonMs,
      eventCount: lt?.eventCount ?? 0,
      predictedCount: lt?.predictedCount ?? 0,
      lateCount: lt?.lateCount ?? 0,
      missedCount: lt?.missedCount ?? 0,
      coverage: lt?.coverage ?? 0,
      medianLeadMs: lt?.medianLeadMs ?? null,
      maxLeadMs: lt?.maxLeadMs ?? null,
      meetsTargetMedian: lt?.meetsTargetMedian ?? false,
    };
  });
}

// ---------------------------------------------------------------------------
// A scored partition
// ---------------------------------------------------------------------------

/** False alarms in one bucket of negatives. */
export interface BucketFalseAlarms {
  bucket: string;
  /** Sessions in this bucket that did NOT failsafe — the denominator. */
  negatives: number;
  /** ...of which the predictor warned on. */
  falseAlarms: number;
  /** `falseAlarms / negatives`. Read {@link fpRateQuantumPp} before reading this. */
  fpRate: RateMetric;
  /** `100 / negatives`: the smallest step this bucket's FP rate can move by. */
  fpRateQuantumPp: number;
}

/** One corpus, scored. */
export interface PredictivePartition {
  sessionCount: number;
  /** Sessions containing ≥ 1 failsafe onset. */
  positiveSessions: number;
  /** Sessions containing none — the false-alarm denominator that matters. */
  negativeSessions: number;
  /** Ground-truth failsafe onsets (the frozen event set). */
  eventCount: number;

  /**
   * **THE REPORT M59 IS JUDGED ON.** Scored at {@link PREDICTIVE_CREDIT_HORIZON_MS}, over the
   * **coherent** prediction set — warnings the predictor had **not withdrawn** by the time the
   * failsafe arrived. See {@link runPredictorOverCorpus}.
   */
  report: MlEvalReport;

  /**
   * The same scoring over the **naive** prediction set, which credits warnings the predictor
   * itself later withdrew.
   *
   * ## This number is an ARTIFACT, it is reported anyway, and here is the proof it is one
   * On the real corpus this reports a **multi-second median lead**. It cannot be real: the
   * corpus's own oracle ceiling ({@link leadCeiling}) is **80 ms**, measured with no reference
   * to any predictor. A lead of 3.5 s on a corpus that offers at most 0.08 s is not a
   * discovery; it is a mis-attribution.
   *
   * What actually happens: `failsafe-after-warning-05.csv` dips to LQ 40, **recovers to LQ
   * 91**, and only then — seconds later — dies. The predictor warns on the dip, withdraws the
   * warning when the link recovers, and a timestamp-only scorer then credits that withdrawn
   * warning with having "predicted" the later failsafe. The *identical* dip shape appears in
   * the 7 `warning` fixtures, **which never failsafe at all** — where the very same warning is
   * counted as a false alarm. The same signal, scored as a triumph or a failure depending on
   * what happened afterwards, is not a predictor. It is a coin flip with a timestamp.
   *
   * It is published rather than deleted because a reader is entitled to see the number the
   * naive method produces, the number the honest method produces, and the independent bound
   * that adjudicates between them. Deleting it would ask them to take the correction on trust.
   */
  leadTimeNaive: MlEvalReport["leadTime"];

  /** Warnings dropped from the coherent set because the predictor withdrew them pre-onset. */
  withdrawnWarnings: number;

  /**
   * **The headline false-alarm rate**: fraction of *non-failsafing* sessions the predictor
   * warned on. On the real corpus its denominator includes the confusable `warning` fixtures.
   */
  predictiveFpRate: RateMetric;
  /** `100 / negativeSessions`. */
  fpRateQuantumPp: number;

  /**
   * The false-alarm rate over **healthy sessions only** — the denominator D25's FP ceiling is
   * *defined* on, and therefore the only number that may legally be compared against it. It
   * is also the flattering one (it excludes every confusable negative), which is exactly why
   * it is reported *beside* {@link predictiveFpRate} and never instead of it.
   */
  healthyOnlyFpRate: RateMetric;

  /** Where the false alarms came from. */
  falseAlarmsByBucket: BucketFalseAlarms[];

  /** Lead time at every horizon, including unbounded. On the coherent set. */
  horizonSensitivity: HorizonCell[];

  /**
   * The **oracle bound**: the maximum lead time *any* predictor could have extracted from
   * this corpus. On the real corpus this is the number that proves the null — it is measured
   * without reference to any predictor at all, under **two** independent definitions of "the
   * link first showed something", and the null survives both.
   */
  leadCeiling: LeadCeilingReport;

  /** Per-session outcomes, for a human to look at. */
  results: PredictiveSessionResult[];
}

/** Score one corpus end to end. The SAME function for both tracks — no easier scorer anywhere. */
export function scorePredictiveCorpus(
  sessions: readonly PredictiveCorpusSession[]
): PredictivePartition {
  const ordered = [...sessions].sort((a, b) =>
    a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0
  );

  const groundTruth = buildPredictiveGroundTruth(ordered);
  const events = buildPredictiveOnsets(ordered);
  const { sessions: sessionPreds, naivePredictions, coherentPredictions, results } =
    runPredictorOverCorpus(ordered);

  // The headline: the COHERENT set — warnings the predictor still stood behind at the event.
  const report = runMlEval(
    { sessions: sessionPreds, leadTime: { predictions: coherentPredictions, events } },
    groundTruth,
    { leadTimeHorizonMs: PREDICTIVE_CREDIT_HORIZON_MS }
  );

  // The artifact, published beside it. Same harness, same horizon, same events — the ONLY
  // difference is that withdrawn warnings are credited. See `PredictivePartition.leadTimeNaive`.
  const naiveReport = runMlEval(
    { sessions: sessionPreds, leadTime: { predictions: naivePredictions, events } },
    groundTruth,
    { leadTimeHorizonMs: PREDICTIVE_CREDIT_HORIZON_MS }
  );

  const negatives = results.filter((r) => !r.failsafed);
  const falseAlarms = negatives.filter((r) => r.warned).length;

  // Healthy-only FP: the D25-comparable denominator. `healthy` is the canonical ML label the
  // manifest's `expectClean` maps to, and the synthetic `steady` class maps to it too.
  const healthyNegatives = negatives.filter((r) => r.label === "healthy");
  const healthyFalseAlarms = healthyNegatives.filter((r) => r.warned).length;

  const buckets = [...new Set(negatives.map((r) => r.bucket))].sort();
  const falseAlarmsByBucket: BucketFalseAlarms[] = buckets.map((bucket) => {
    const inBucket = negatives.filter((r) => r.bucket === bucket);
    const fired = inBucket.filter((r) => r.warned).length;
    return {
      bucket,
      negatives: inBucket.length,
      falseAlarms: fired,
      fpRate: rateMetric(fired, inBucket.length),
      fpRateQuantumPp: round6(fpRateQuantumPp(inBucket.length)),
    };
  });

  const leadCeiling = measureCorpusLeadCeiling(
    ordered.map((s) => ({
      sessionId: s.sessionId,
      log: s.log,
      onsets: findFailsafeOnsetIndices(s.log),
    }))
  );

  return {
    sessionCount: ordered.length,
    positiveSessions: results.filter((r) => r.failsafed).length,
    negativeSessions: negatives.length,
    eventCount: events.length,
    report,
    leadTimeNaive: naiveReport.leadTime,
    withdrawnWarnings: results.reduce((acc, r) => acc + r.withdrawnBeforeOnset, 0),
    predictiveFpRate: rateMetric(falseAlarms, negatives.length),
    fpRateQuantumPp: round6(fpRateQuantumPp(negatives.length)),
    healthyOnlyFpRate: rateMetric(healthyFalseAlarms, healthyNegatives.length),
    falseAlarmsByBucket,
    horizonSensitivity: scoreHorizons(coherentPredictions, events, sessionPreds, groundTruth),
    leadCeiling,
    results,
  };
}

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

/** M59's acceptance, evaluated. Every field is computed; none is asserted. */
export interface PredictiveAcceptance {
  /** `leadTime.meetsTargetMedian` on the REAL corpus: median lead ≥ 2000 ms. */
  meetsLeadTimeTarget: boolean;
  /**
   * The measured median lead on the real corpus: **`null`**.
   *
   * **`null` is not "missing data" — it is a stronger null result than `0` would be.** There
   * is no median because there are **no creditable predictions to take a median of**: the
   * predictor warned before **zero** of the 17 frozen failsafe onsets. `0 ms` would mean "it
   * warned, with no lead"; `null` means "it never warned in time at all". See
   * {@link creditablePredictions} and {@link lateDetections}.
   */
  measuredMedianLeadMs: number | null;
  /** Events warned about **before** onset. **0 of 17.** The number behind the `null` above. */
  creditablePredictions: number;
  /** Events the predictor caught only **after** the link was already gone — detection, not prediction. */
  lateDetections: number;
  /** Events it said nothing about at all. */
  missedEvents: number;
  /** The target. **2000 ms.** */
  targetLeadMs: number;
  /**
   * The maximum lead **any** predictor could have extracted from the real corpus. **80 ms.**
   * From `measureCorpusLeadCeiling`, i.e. measured *without reference to any predictor*.
   */
  oracleMaxLeadMs: number;
  /** The oracle's *median*. **0 ms** — most events give literally zero warning. */
  oracleMedianLeadMs: number;
  /**
   * The same bound under the **maximally generous** definition, which credits a single-point
   * noise wiggle as a precursor. **120 ms max / 40 ms median.** Still ~17× short of the
   * target. Reported so the null cannot be dismissed as an artifact of a stingy definition.
   */
  oracleMaxLeadAnyMovementMs: number;
  oracleMedianLeadAnyMovementMs: number;
  /**
   * `false`. The corpus's own ceiling is below the target under **both** definitions, so **no
   * predictor can meet this acceptance on this data**. The shortfall is a property of the
   * corpus, not of the model.
   */
  targetReachableOnRealCorpus: boolean;

  /** `clearsFpCeiling(healthyOnlyFp, baselineFp)` — D25's half, run on the D25 denominator. */
  clearsFpCeiling: boolean;
  /**
   * `false`. The measured v2.0 baseline FP rate is **0.000** and D25's ceiling is a **strict
   * `<`**; nothing is strictly below zero. Copied from `baseline-v20.json`, not re-derived.
   */
  fpCeilingClearable: boolean;

  /**
   * **`false`. THE M59 VERDICT.** Both halves fail, *independently*: there is no lead time to
   * be had (the substantive failure), and the FP ceiling is unclearable by construction (the
   * structural one). Either alone is decisive.
   */
  acceptanceMetOnRealCorpus: boolean;
}

/** The honesty header. Mirrors `BaselineHonesty` / `ModelEvalHonesty` — same discipline. */
export interface PredictiveEvalHonesty {
  /** `true`. Nothing in this file is a gate pass. */
  indicativeNotAGatePass: boolean;
  /**
   * `true`. **The synthetic corpus is not evidence of field performance.** It was authored
   * alongside the predictor; every number measured on it answers "can the detector find a ramp
   * we drew?", not "can the detector predict a real failsafe?".
   */
  syntheticCorpusNotFieldEvidence: boolean;
  /** `false`. No synthetic number is, or may be promoted to, an M59 acceptance result. */
  syntheticCorpusIsAcceptanceEvidence: boolean;
  /** `false`. D21 is unmet: 36 labeled sessions against a bar of 300 **per class**. */
  d21Met: boolean;
  /** Sessions in the real labeled corpus. **36.** */
  realCorpusSessions: number;
  /** Sessions in the synthetic corpus. Drawn, not flown. */
  syntheticCorpusSessions: number;
  /** Dev-facing notes. Never rendered as UI copy; this is a data artifact. */
  notes: string[];
}

/** What the predictor is, recorded with its numbers so the two travel together. */
export interface PredictorDescriptor {
  predictorId: string;
  schemaVersion: string;
  /** The risk model, as data. */
  model: {
    kind: "projected-time-to-link-loss";
    windowSamples: number;
    tripThreshold: number;
    clearThreshold: number;
    tripFrames: number;
    creditHorizonMs: number;
    /** The identity that makes the trip threshold a derivation rather than a knob. */
    derivation: string;
  };
  /** What it is structurally unable to do, said out loud. */
  limits: string[];
}

/** The frozen M59 evaluation artifact (`data/ml/model-eval-m59.json`). */
export interface PredictiveEvalArtifact {
  schemaVersion: string;
  predictor: PredictorDescriptor;
  corpora: {
    real: {
      manifestVersion: string;
      sessionCount: number;
      /** The SAME fingerprint `baseline-v20.json` carries. They must agree. */
      fingerprint: string;
    };
    synthetic: {
      /** Its OWN fingerprint. Provably not the real corpus's. */
      fingerprint: string;
      sessionCount: number;
      seed: number;
      generator: string;
    };
  };
  honesty: PredictiveEvalHonesty;
  /** **The verdict.** The only partition M59's acceptance is measured on. */
  acceptance: PredictiveAcceptance;
  /** The real corpus. Carries the null result. */
  realCorpus: PredictivePartition;
  /** The synthetic corpus. **Indicative only — NOT an acceptance pass.** */
  syntheticCorpus: PredictivePartition;
}

/** Inputs the caller reads from disk (this module stays I/O-free). */
export interface PredictiveEvalInputs {
  realSessions: readonly PredictiveCorpusSession[];
  realManifestVersion: string;
  /** The real corpus's frozen fingerprint, from `baseline-v20.json`. */
  realFingerprint: string;
  syntheticSessions: readonly PredictiveCorpusSession[];
  /** The synthetic corpus's own fingerprint, from its own manifest. */
  syntheticFingerprint: string;
  syntheticSeed?: number;
  /** The frozen D25 baseline, from `baseline-v20.json`. */
  gateBaseline: GateBaseline & { fpCeilingClearable: boolean };
}

/**
 * Evaluate the predictor on both corpora and assemble the artifact.
 *
 * **Pure + deterministic.** Two runs over the same corpora produce a deep-equal artifact —
 * which is what `tests/unit/ml/predictive.test.ts` relies on to prove the checked-in JSON has
 * not drifted from the code that produced it.
 */
export function evaluatePredictor(inputs: PredictiveEvalInputs): PredictiveEvalArtifact {
  const realCorpus = scorePredictiveCorpus(inputs.realSessions);
  const syntheticCorpus = scorePredictiveCorpus(inputs.syntheticSessions);

  const lead = realCorpus.report.leadTime;
  const ceiling = realCorpus.leadCeiling;

  // D25's FP half, run on D25's OWN denominator (healthy sessions). It fails, and it would
  // fail for a flawless predictor too: the baseline FP rate is 0.000 and the comparator is a
  // strict `<`.
  const clearsFp = clearsFpCeiling(
    realCorpus.healthyOnlyFpRate.value,
    inputs.gateBaseline.baselineFpRate
  );
  const meetsLead = lead?.meetsTargetMedian ?? false;

  const acceptance: PredictiveAcceptance = {
    meetsLeadTimeTarget: meetsLead,
    // NOT coalesced to 0. `null` here means the predictor made zero creditable predictions,
    // which is a stronger and more honest statement than a median of zero — see the field docs.
    measuredMedianLeadMs: lead?.medianLeadMs ?? null,
    creditablePredictions: lead?.predictedCount ?? 0,
    lateDetections: lead?.lateCount ?? 0,
    missedEvents: lead?.missedCount ?? 0,
    targetLeadMs: PREDICTIVE_LEAD_TIME_TARGET_MS,
    oracleMaxLeadMs: ceiling.threshold.maxMs,
    oracleMedianLeadMs: ceiling.threshold.medianMs,
    oracleMaxLeadAnyMovementMs: ceiling.anyMovement.maxMs,
    oracleMedianLeadAnyMovementMs: ceiling.anyMovement.medianMs,
    targetReachableOnRealCorpus: ceiling.targetReachable,
    clearsFpCeiling: clearsFp,
    fpCeilingClearable: inputs.gateBaseline.fpCeilingClearable,
    acceptanceMetOnRealCorpus: meetsLead && clearsFp,
  };

  const syntheticLead = syntheticCorpus.report.leadTime;

  return {
    schemaVersion: PREDICTIVE_EVAL_SCHEMA_VERSION,
    predictor: {
      predictorId: PREDICTOR_ID,
      schemaVersion: PREDICTIVE_SCHEMA_VERSION,
      model: {
        kind: "projected-time-to-link-loss",
        windowSamples: PREDICTIVE_WINDOW_SAMPLES,
        tripThreshold: PREDICTIVE_RISK_THRESHOLD,
        clearThreshold: PREDICTIVE_CLEAR_THRESHOLD,
        tripFrames: PREDICTIVE_TRIP_FRAMES,
        creditHorizonMs: PREDICTIVE_CREDIT_HORIZON_MS,
        derivation: `Fit a line to the last ${PREDICTIVE_WINDOW_SAMPLES} samples of link quality and of best-antenna RSSI. Project each to its floor (LQ = 0; RSSI = -100 dBm) at its fitted decay rate; take the sooner. Warn when that projected time-to-loss falls to or below ${PREDICTIVE_LEAD_TIME_TARGET_MS} ms - the pilot's reaction window - for ${PREDICTIVE_TRIP_FRAMES} consecutive frames. The trip threshold of ${PREDICTIVE_RISK_THRESHOLD} is NOT a free parameter: risk = clamp01(1 - ttl / (2 x ${PREDICTIVE_LEAD_TIME_TARGET_MS})), so 'risk >= 0.5' and 'ttl <= ${PREDICTIVE_LEAD_TIME_TARGET_MS} ms' are the same statement. The threshold IS the product requirement, restated in the units the telemetry provides.`,
      },
      limits: [
        "It requires a TREND. A channel that is not falling contributes an infinite time-to-loss and therefore ZERO risk, however bad its absolute level. A standing fault - a wiring session's constant RSSI imbalance, a link sitting flat at a terrible-but-stable LQ 30 - produces NO warning from this predictor. That is deliberate: M58's early-warning probe manufactured an unbounded-horizon 'median lead 4920 ms' by flagging exactly such a standing fault at sample 0 and crediting it with predicting a failsafe seconds later. This predictor is structurally incapable of that artifact.",
        "Detecting a fault that is already present is DETECTION, which the shipped v2.0 rules and the M26 live alerts already do. This predictor only ever claims PREDICTION, and it is scored only on prediction.",
        "It cannot predict an INSTANTANEOUS failure, and no predictor can. The 9 wiring-class onsets in the real corpus go from LQ >= 86 to LQ 0 in a SINGLE sample. There is no precursor to fit a line to. This is not a limitation of the model; it is a limitation of physics.",
        "Its confidence is a confidence in the PROJECTION, not a probability of a crash. It says how far inside the reaction window the current fitted decay rate puts the link. It says nothing about how likely that rate is to continue, which it has no way to know and does not claim to.",
      ],
    },
    corpora: {
      real: {
        manifestVersion: inputs.realManifestVersion,
        sessionCount: realCorpus.sessionCount,
        fingerprint: inputs.realFingerprint,
      },
      synthetic: {
        fingerprint: inputs.syntheticFingerprint,
        sessionCount: syntheticCorpus.sessionCount,
        seed: inputs.syntheticSeed ?? DEFAULT_SEED,
        generator: "src/lib/ml/syntheticCorpus.ts",
      },
    },
    honesty: {
      indicativeNotAGatePass: true,
      syntheticCorpusNotFieldEvidence: true,
      syntheticCorpusIsAcceptanceEvidence: false,
      d21Met: false,
      realCorpusSessions: realCorpus.sessionCount,
      syntheticCorpusSessions: syntheticCorpus.sessionCount,
      notes: [
        `M59 ACCEPTANCE ON THE REAL CORPUS: NOT MET. The predictor warned before ${lead?.predictedCount ?? 0} of the ${lead?.eventCount ?? 0} frozen failsafe onsets. There is NO median lead time (medianLeadMs is null) because there are no creditable predictions to take a median of - which is a STRONGER null than a median of 0 ms would be: 0 ms would mean 'it warned, with no lead'; null means 'it never warned in time at all'. It caught ${lead?.lateCount ?? 0} of the onsets only AFTER the link was already gone (that is DETECTION, which the shipped M26 alerts already do) and said nothing at all about ${lead?.missedCount ?? 0}. The target is a ${PREDICTIVE_LEAD_TIME_TARGET_MS} ms MEDIAN lead.`,
        `AND IT IS NOT MEETABLE BY ANY PREDICTOR. The ORACLE bound - the maximum lead extractable from this corpus by anything, measured with no reference to any model - is a median of ${ceiling.threshold.medianMs} ms and a maximum of ${ceiling.threshold.maxMs} ms. ${ceiling.threshold.zeroLeadEvents} of the ${ceiling.eventCount} frozen failsafe onsets give LITERALLY ZERO warning: link quality goes from healthy to 0 in a single sample. There is no signal in this corpus to predict from. That is the headline finding of M59, and it is a legitimate milestone output: the question was 'can we warn before a failsafe', and on the data we have the answer is NO, with a number.`,
        `The ${ceiling.threshold.maxMs} ms maximum independently reproduces MEASURED_MAX_FIXTURE_LEAD_MS = ${MEASURED_MAX_FIXTURE_LEAD_MS}, which was frozen in mlConsts.ts before this evaluation existed. Two derivations, one number.`,
        `The null does NOT depend on how 'the link first showed something' is defined. Under the MAXIMALLY GENEROUS definition - any downward movement in LQ at all, including a single-point noise wiggle no real detector could act on - the ceiling rises only to a median of ${ceiling.anyMovement.medianMs} ms and a maximum of ${ceiling.anyMovement.maxMs} ms. Still ~17x short of the target. Both bounds are in realCorpus.leadCeiling.`,
        "The null does NOT depend on the creditability horizon either. realCorpus.horizonSensitivity re-scores lead time at 2000 ms, at 10000 ms, and UNBOUNDED, and the answer does not move.",
        `THE NAIVE LEAD TIME IS AN ARTIFACT, AND IT IS PUBLISHED SO YOU CAN SEE THAT IT IS. realCorpus.leadTimeNaive reports a median of ${realCorpus.leadTimeNaive?.medianLeadMs ?? 0} ms - which is IMPOSSIBLE, because the oracle ceiling above is ${ceiling.threshold.maxMs} ms. It arises by crediting warnings the predictor ITSELF LATER WITHDREW: failsafe-after-warning-05.csv dips to LQ 40, RECOVERS TO LQ 91, and only then dies seconds later. A timestamp-only scorer credits the warning raised on that dip with 'predicting' the failsafe. The identical dip shape appears in the 7 'warning' fixtures, WHICH NEVER FAILSAFE - where the very same warning is scored as a false alarm. The same signal, counted as a triumph or a failure depending on what happened afterwards, is not a predictor; it is a coin flip with a timestamp. The headline number (realCorpus.report.leadTime) credits ONLY warnings the predictor was still standing behind when the link died. ${realCorpus.withdrawnWarnings} withdrawn warnings were dropped. This is the same artifact M58 hit and correctly disbelieved.`,
        "THE SECOND HALF OF THE ACCEPTANCE ALSO FAILS, INDEPENDENTLY AND STRUCTURALLY. D25's FP ceiling is a strict '<' against a measured v2.0 baseline FP rate of 0.000; nothing is strictly below zero, so no predictor clears it - not this one, not a flawless one. baseline-v20.json records the fact as gateBaseline.fpCeilingClearable: false. This is the same structural failure M58 hit. It matters that the two halves fail INDEPENDENTLY: even with a reachable FP ceiling, M59 would still fail on 0 ms of lead.",
        "THE SYNTHETIC CORPUS IS NOT EVIDENCE OF FIELD PERFORMANCE, AND ITS NUMBERS ARE NOT AN ACCEPTANCE PASS. It was authored alongside this predictor. Its ramps were drawn to be long enough that a 2-second lead is AVAILABLE - that choice alone is what produces any lead time at all. It measures 'can the detector find a ramp we drew?'. It cannot speak to 'can the detector predict a real failsafe?'.",
        "The synthetic corpus draws exactly ONE failure mode: a smooth monotone collapse of a single latent link margin (flying out of range). It does NOT draw the instantaneous failures the real 'wiring' fixtures contain. A predictor scored on it is being scored on the one failure mode that is predictable BY ASSUMPTION.",
        `The synthetic near-miss negatives are drawn from the SAME ramp family as the positives and differ only in what happens after the bottom - so before the bottom, a deep near-miss and a positive are THE SAME SIGNAL. Lead time and false alarms on confusable negatives are therefore in direct physical tension. The synthetic false-alarm rate against the near-miss negatives is ${syntheticCorpus.falseAlarmsByBucket.filter((b) => b.bucket !== "steady").reduce((a, b) => a + b.falseAlarms, 0)} of ${syntheticCorpus.falseAlarmsByBucket.filter((b) => b.bucket !== "steady").reduce((a, b) => a + b.negatives, 0)}, and syntheticCorpus.falseAlarmsByBucket shows which depth band they came from. A predictor that achieved lead time WITHOUT firing on the deep band would not be predicting; it would be peeking at the future.`,
        `For the record, and NOT as an acceptance result: on the synthetic corpus the predictor's median lead is ${syntheticLead?.medianLeadMs ?? 0} ms over ${syntheticLead?.predictedCount ?? 0} of ${syntheticLead?.eventCount ?? 0} events. This demonstrates the PIPELINE RUNS. It demonstrates nothing about the field.`,
        `AND EVEN ON THE CORPUS DRAWN TO BE FINDABLE, THE CONCEPT DOES NOT CLEAR THE BAR. The predictor achieves its lead time on the synthetic ramps ONLY by firing on the near-miss negatives too: it false-alarms on ${syntheticCorpus.falseAlarmsByBucket.find((b) => b.bucket === "deep")?.falseAlarms ?? 0}/${syntheticCorpus.falseAlarmsByBucket.find((b) => b.bucket === "deep")?.negatives ?? 0} of the DEEP near-misses - sessions that decayed just as hard and then RECOVERED. That is not a defect in the predictor; it is the physics. Before the bottom of the ramp, a deep near-miss and a true failsafe are THE SAME SIGNAL, and no causal predictor can separate them, because the information that separates them does not yet exist. Buying 2 seconds of lead means buying the false alarms that come with it. The synthetic false-alarm rate is therefore FAR above the M56 FP ceiling of 0.000 - so the experiment stays RESEARCH-ONLY even on its own most favourable data, and NOT ONLY because the ceiling is unclearable.`,
        "D21 is unmet by a factor of ~40: the real corpus is 36 labeled sessions against a bar of 300 PER CLASS. The predictor here is deterministic and fits no weights, so it is not limited by that - but the CORPUS it is evaluated on is, and every real-corpus number in this artifact carries the small-n limitations the harness attaches to it.",
      ],
    },
    acceptance,
    realCorpus,
    syntheticCorpus,
  };
}

/**
 * Serialize the artifact to the exact bytes checked in at `data/ml/model-eval-m59.json`:
 * 2-space-indented JSON with a trailing newline, matching `serializeBaselineArtifact` and
 * `serializeModelEvalArtifact`. Deterministic — no timestamp, no machine state.
 */
export function serializePredictiveEvalArtifact(artifact: PredictiveEvalArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
