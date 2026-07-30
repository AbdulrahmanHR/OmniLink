/**
 * The ML evaluation harness (M56b) — the one place a detector's score is computed.
 *
 * Mirrors `src/lib/knowledge/eval.ts` in shape: counts → rates → a single boolean
 * {@link MlEvalReport.passes} gate → a per-case array. It is the scorer M56b's
 * baseline characterization, M58's model evaluation, and M59's predictor all run
 * through, so a number quoted anywhere in the v2.5 line was computed by this
 * function and not re-derived by hand.
 *
 * Pure and deterministic: no RNG, no clock, no I/O. Same inputs ⇒ deep-equal report.
 *
 * ## The two granularities, and why both exist
 * A "false-positive rate" is meaningless until you say *of what*. This report
 * carries two, named and typed separately so a reader can never conflate them:
 *
 *  - **{@link PerSessionMetrics}** — the binary question "did the detector flag this
 *    session as not-clean?". On the bundled corpus that is n = 36 (12 healthy
 *    negatives / 24 faulty positives). This is the statistically defensible
 *    granularity and it is the one **D25's gate is defined at** (see
 *    {@link import("./mlConsts").GateCandidate}: "healthy sessions the model called
 *    faulty" / "faulty sessions the model correctly caught").
 *
 *  - **{@link PerFindingMetrics}** — did the detector produce *this specific finding*,
 *    matched by `ruleId` + evidence-window overlap. Only viable where the corpus has
 *    enough instances of a rule; see {@link MIN_INSTANCES_FOR_FINDING_RATE}.
 *
 * ## Rates vs raw counts — enforced by the type, not by a comment
 * {@link EvalMetric} is a discriminated union. A denominator below
 * {@link MIN_INSTANCES_FOR_FINDING_RATE} yields a {@link CountMetric}, which has
 * **no `value` field at all** — a caller cannot accidentally read a 2-sample "50 %"
 * as a rate, because there is nothing there to read. It has to check `kind` first,
 * and the compiler makes it. A "50 % recall" derived from two instances is a lie with
 * a decimal point, and the way to stop shipping it is to make it unrepresentable.
 *
 * ## Limitations are first-class output, not a footnote
 * {@link MlEvalReport.limitations} reuses the structured `{code, label, detail}`
 * warning shape `splitDataset` established (`dataset.ts`), so the statistical-power
 * problems travel WITH the numbers instead of living in a changelog nobody reads.
 * On the bundled corpus this array is never empty.
 *
 * ## No user-facing strings
 * Every code here is a stable machine-readable identifier shaped to double as an
 * i18n key suffix, exactly like `DiagnosticFinding.explanation`. Nothing in this
 * module is a sentence intended for a human UI.
 */

import type { EvidenceWindow } from "@/lib/diagnostics";
import type { MlLabel } from "./dataset";
import {
  clearsM56Gate,
  fpRateQuantumPp,
  MIN_LABELED_SESSIONS_PER_CLASS,
  MIN_TEST_SESSIONS_PER_CLASS,
  PREDICTIVE_LEAD_TIME_TARGET_MS,
  type GateBaseline,
} from "./mlConsts";
import { quantileFinite, round6 } from "./stats";

// ---------------------------------------------------------------------------
// Schema + frozen harness constants
// ---------------------------------------------------------------------------

/**
 * Semantic version of the {@link MlEvalReport} shape. Bump on any breaking change
 * to the report — the checked-in baseline artifact stamps it, and a consumer must
 * reject an artifact it does not understand rather than coerce it.
 */
export const ML_EVAL_SCHEMA_VERSION = "1.0.0";

/**
 * ± sample tolerance when matching a produced finding's evidence window to a
 * ground-truth `approxWindow`.
 *
 * **8**, the same value the M36 fixture corpus was labelled with
 * (`tests/unit/diagnostics/fixtures.ts::WINDOW_TOLERANCE`). It is re-declared here
 * rather than imported because `src/` must not import from `tests/`; `baseline.test.ts`
 * asserts the two constants are equal, so they cannot drift apart silently.
 */
export const DEFAULT_WINDOW_TOLERANCE_SAMPLES = 8;

/**
 * Minimum ground-truth instances a **per-finding** metric needs before it may be
 * reported as a rate rather than as raw counts.
 *
 * **20**, because at n = 20 a single instance moves the rate by 5 percentage points —
 * and 5 % is already the resolution floor this project treats as meaningful (the DL3
 * acceptance bar in `tests/unit/diagnostics/manifest-acceptance.test.ts` is
 * "FP ≤ 5 %"). Below 20, a percentage is a decoration on a count.
 *
 * On the bundled corpus this cleanly separates the two rules that can carry a rate
 * (`lq-collapse`, n = 36; `rssi-floor`, n = 22) from the three that cannot
 * (`packet-instability`, n = 5; `snr-noise`, n = 2; `tx-power-saturation`, n = 2).
 *
 * ## It deliberately does NOT apply to the per-session metrics
 * The per-session false-positive rate has only 12 negatives — well under 20 — and is
 * still reported as a rate, because D25's gate is *defined* on it and a gate needs a
 * number. Its coarseness is carried instead by {@link PerSessionMetrics.fpRateQuantumPp}
 * and the `fp-rate-quantised` limitation, which say out loud that the rate moves in
 * 8.3-point steps. Two different honesty mechanisms, because they answer two
 * different questions: "may I quote a rate at all?" versus "how much may I read into
 * the rate I must quote?".
 */
export const MIN_INSTANCES_FOR_FINDING_RATE = 20;

// ---------------------------------------------------------------------------
// Metrics: a rate, or an honest refusal to compute one
// ---------------------------------------------------------------------------

/** A metric with a large enough denominator to be quoted as a rate. */
export interface RateMetric {
  kind: "rate";
  /** The rate in `[0, 1]`. `0` when the denominator is 0 (fails closed — never 1). */
  value: number;
  numerator: number;
  denominator: number;
}

/**
 * A metric whose denominator is too small for a rate: **raw counts only**.
 *
 * There is deliberately **no `value` field**. Reading a rate off this is a compile
 * error, which is the entire point.
 */
export interface CountMetric {
  kind: "count";
  numerator: number;
  denominator: number;
  /** The denominator a rate would have required ({@link MIN_INSTANCES_FOR_FINDING_RATE}). */
  minimumDenominator: number;
}

/** Either a quotable rate or an honest raw count. Discriminate on `kind`. */
export type EvalMetric = RateMetric | CountMetric;

/**
 * A rate, unconditionally — for the per-session metrics, where D25's gate needs a
 * number regardless of how coarse it is.
 *
 * **Fails closed** on a zero denominator: a detector that predicted nothing has
 * precision `0`, not a vacuous `1`. A gate must never read "no evidence" as "pass".
 */
export function rateMetric(numerator: number, denominator: number): RateMetric {
  return {
    kind: "rate",
    value: denominator > 0 ? round6(numerator / denominator) : 0,
    numerator,
    denominator,
  };
}

/**
 * A rate **if and only if** the denominator clears {@link MIN_INSTANCES_FOR_FINDING_RATE};
 * otherwise raw counts. Used for every per-finding metric.
 */
export function findingMetric(numerator: number, denominator: number): EvalMetric {
  if (denominator >= MIN_INSTANCES_FOR_FINDING_RATE) {
    return rateMetric(numerator, denominator);
  }
  return {
    kind: "count",
    numerator,
    denominator,
    minimumDenominator: MIN_INSTANCES_FOR_FINDING_RATE,
  };
}

// ---------------------------------------------------------------------------
// Limitations — the structured `{code, label, detail}` shape from `splitDataset`
// ---------------------------------------------------------------------------

/**
 * What a limitation is about.
 *
 * - `class-below-d21-minimum` — a class has fewer than
 *   {@link MIN_LABELED_SESSIONS_PER_CLASS} sessions (D21 unmet). Same code string
 *   `splitDataset` emits, on purpose: it is the same fact.
 * - `fp-rate-quantised` — the false-positive denominator is small, so the FP rate can
 *   only take a handful of values. `detail.quantumPp` is the step size in percentage
 *   points (12 healthy sessions ⇒ **8.33 pp**; there is nothing between 0 % and 8.3 %).
 * - `fp-ceiling-unclearable` — the measured FP rate is **0**, so D25's *strict* `<`
 *   ceiling cannot be cleared by any model: nothing is strictly below zero. This is a
 *   property of the measurement, not a bug in the gate, and it must be stated.
 * - `per-finding-rule-n-too-small` — a rule has fewer than
 *   {@link MIN_INSTANCES_FOR_FINDING_RATE} ground-truth instances, so its per-finding
 *   metrics are raw counts. `label` is the rule id.
 * - `per-finding-not-scored` — the caller supplied no finding-level predictions, so no
 *   per-finding metrics were computed (see `baseline.ts` for why baseline B is scored
 *   at per-session granularity only).
 * - `lead-time-no-predictions` — lead time was requested with zero timestamped
 *   predictions, so every event reads as missed. That is a statement about the
 *   detector's *architecture* (it has no emission time), not a measured failure.
 * - `lead-time-coverage-incomplete` — at least one event had no creditable prediction,
 *   so the median lead describes a subset. A median over the events you did catch is
 *   not a lead time.
 * - `gate-not-evaluated` — no baseline was supplied, so {@link MlEvalReport.passes} is
 *   `false` because the gate did not run, **not** because it failed. Fails closed.
 */
export type EvalLimitationCode =
  | "class-below-d21-minimum"
  | "fp-rate-quantised"
  | "fp-ceiling-unclearable"
  | "per-finding-rule-n-too-small"
  | "per-finding-not-scored"
  | "lead-time-no-predictions"
  | "lead-time-coverage-incomplete"
  | "gate-not-evaluated";

/**
 * A machine-readable statement that a number is not what it looks like.
 *
 * Same `{code, label, detail}` shape as `dataset.ts`'s `SplitWarning`, with `label`
 * widened from `MlLabel` to `string` because an eval limitation can be about a *rule*
 * (`"rssi-floor"`) or the corpus as a whole (`"corpus"`), not only about a class.
 * `detail` is numbers only — zero identifiers, ever.
 */
export interface EvalLimitation {
  code: EvalLimitationCode;
  /** An {@link MlLabel}, a rule id, or `"corpus"`. */
  label: string;
  /** Non-identifying numbers only. */
  detail: Record<string, number>;
}

/** The subject used when a limitation is about the whole evaluation, not one class/rule. */
export const CORPUS_LIMITATION_SUBJECT = "corpus";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One detector's session-level verdict. */
export interface SessionPrediction {
  /** Corpus-local session key (a fixture filename). Never a user identifier. */
  sessionId: string;
  /** Did the detector call this session **not clean**? */
  flagged: boolean;
  /** How many findings/events it produced (diagnostic only; not scored). */
  findingCount: number;
}

/** One detector's finding-level output, for per-finding matching. */
export interface FindingPrediction {
  sessionId: string;
  ruleId: string;
  window: EvidenceWindow;
}

/** A timestamped early warning, for lead-time scoring. */
export interface TimedPrediction {
  sessionId: string;
  /** Wall-clock ms on the session's own time axis at which the warning was emitted. */
  tMs: number;
}

/** A timestamped ground-truth event the predictor is supposed to get ahead of. */
export interface EventOnset {
  sessionId: string;
  /** Wall-clock ms on the session's own time axis at which the event began. */
  onsetMs: number;
}

/** Everything a detector produced. `findings`/`leadTime` are optional; `sessions` is not. */
export interface MlPredictions {
  sessions: readonly SessionPrediction[];
  /**
   * Finding-level output. **Omit** when the detector's output vocabulary does not map
   * onto the ground-truth rule ids — a per-finding score against an incomparable
   * vocabulary is a fabricated correspondence, and omitting it (which raises
   * `per-finding-not-scored`) is the honest alternative.
   */
  findings?: readonly FindingPrediction[];
  /** Timestamped warnings + the ground-truth onsets they are scored against (M59). */
  leadTime?: {
    predictions: readonly TimedPrediction[];
    events: readonly EventOnset[];
  };
}

/** Ground truth for one session. */
export interface SessionTruth {
  sessionId: string;
  label: MlLabel;
  /** `true` for a healthy session — the negatives the false-positive rate is over. */
  clean: boolean;
}

/** One ground-truth finding. */
export interface ExpectedFindingTruth {
  sessionId: string;
  ruleId: string;
  /** The labelled approximate window; matching expands it by the window tolerance. */
  window: EvidenceWindow;
}

/** The labelled corpus a detector is scored against. */
export interface MlGroundTruth {
  sessions: readonly SessionTruth[];
  findings: readonly ExpectedFindingTruth[];
}

/** Options for {@link runMlEval}. */
export interface RunMlEvalOptions {
  /** Defaults to {@link DEFAULT_WINDOW_TOLERANCE_SAMPLES}. */
  windowToleranceSamples?: number;
  /** Defaults to {@link PREDICTIVE_LEAD_TIME_TARGET_MS} (2000 ms, M59). */
  leadTimeTargetMs?: number;
  /**
   * Only a prediction in `[onsetMs − horizonMs, onsetMs)` is creditable to an event.
   * `null` (the default) means unbounded.
   *
   * **A horizon matters on multi-event sessions.** With no horizon, a warning fired in
   * the *aftermath* of event *k* is the nearest preceding prediction for event *k+1*
   * and gets credited with a multi-second "lead" it never had. Timestamps alone cannot
   * tell "warning about the next failure" from "report of the last one", so the caller
   * must bound it. See `baseline.ts`, which sets a horizon for exactly this reason.
   */
  leadTimeHorizonMs?: number | null;
  /**
   * The measured v2.0 baseline to run D25's gate against. **Omit when measuring the
   * baseline itself** — then `passes` is `false` and `gateEvaluated` is `false`, so a
   * baseline artifact can never be misread as a gate pass.
   */
  gateBaseline?: GateBaseline;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** Binary confusion counts. */
export interface ConfusionCounts {
  /** Faulty session, flagged. */
  truePositives: number;
  /** Healthy session, flagged — the ones the FP rate counts. */
  falsePositives: number;
  /** Healthy session, not flagged. */
  trueNegatives: number;
  /** Faulty session, not flagged — a missed fault. */
  falseNegatives: number;
}

/** Session-level metrics: the granularity D25's gate is defined at. */
export interface PerSessionMetrics {
  granularity: "per-session";
  counts: ConfusionCounts;
  /** Faulty sessions in the ground truth (recall's denominator). */
  positiveSessions: number;
  /** Healthy sessions in the ground truth (the FP rate's denominator). */
  negativeSessions: number;
  /** `tp / (tp + fp)`. */
  precision: RateMetric;
  /** `tp / (tp + fn)`. D25's recall floor is measured on this. */
  recall: RateMetric;
  /** `fp / negativeSessions`. D25's FP ceiling is measured on this. */
  falsePositiveRate: RateMetric;
  /**
   * The smallest step the FP rate can move by: `100 / negativeSessions` pp. At 12
   * healthy sessions this is **8.33 pp** — any FP comparison finer than that is noise.
   */
  fpRateQuantumPp: number;
}

/** Per-finding metrics for one rule. */
export interface PerRuleFindingMetrics {
  ruleId: string;
  /** Ground-truth instances of this rule. */
  expected: number;
  /** Findings the detector produced with this rule id. */
  predicted: number;
  /** One-to-one matches (rule id + window overlap within tolerance). */
  matched: number;
  /** `expected − matched`. */
  falseNegatives: number;
  /** `predicted − matched` — findings that matched nothing in the ground truth. */
  falsePositives: number;
  /** `matched / predicted`. A {@link CountMetric} when `predicted` is too small. */
  precision: EvalMetric;
  /** `matched / expected`. A {@link CountMetric} when `expected` is too small. */
  recall: EvalMetric;
}

/** Finding-level metrics, matched by rule id + window overlap. */
export interface PerFindingMetrics {
  granularity: "per-finding";
  /** The ± sample tolerance the ground-truth windows were expanded by. */
  windowToleranceSamples: number;
  /** Per rule, in ground-truth-frequency order (descending), then rule id. */
  byRule: PerRuleFindingMetrics[];
  /** Pooled across every rule. Its denominators are the corpus totals (67 expected). */
  overall: Omit<PerRuleFindingMetrics, "ruleId">;
}

/**
 * What happened to one ground-truth event.
 *
 * - `predicted` — a creditable warning arrived **strictly before** the onset. `leadMs`
 *   is positive.
 * - `late` — no warning before the onset, but one arrived **at or after** it. `leadMs`
 *   is `≤ 0` and is **kept, for diagnosis** — but a late warning is scored as a **MISS**,
 *   not as a 0 ms lead: it is excluded from the lead-time distribution and does not
 *   count towards {@link LeadTimeMetrics.coverage}. A warning that arrives after the
 *   failsafe is a *report*, not a prediction, and rounding it to "0 ms of lead" would
 *   let a pure detector claim it "predicts" every event it detects.
 * - `missed` — no warning at all, before or after. `leadMs` is `null`.
 */
export type LeadTimeOutcome = "predicted" | "late" | "missed";

/** One ground-truth event and what the detector did about it. */
export interface LeadTimeCase {
  sessionId: string;
  onsetMs: number;
  outcome: LeadTimeOutcome;
  /** `> 0` when predicted; `≤ 0` when late (diagnostic only); `null` when missed. */
  leadMs: number | null;
}

/** Early-warning lead time (M59). */
export interface LeadTimeMetrics {
  /** The bar: {@link PREDICTIVE_LEAD_TIME_TARGET_MS} unless overridden. */
  targetMs: number;
  /** The creditability horizon in force (`null` = unbounded). */
  horizonMs: number | null;
  eventCount: number;
  /** Events warned about strictly before onset — the only ones in the distribution. */
  predictedCount: number;
  /** Events whose only warning arrived at/after onset. Scored as misses. */
  lateCount: number;
  /** Events with no warning at all. */
  missedCount: number;
  /**
   * `predictedCount / eventCount`. **Read this before the median.** A 3-second median
   * lead over the 2 events out of 17 that a detector happened to catch is not a
   * 3-second lead time.
   */
  coverage: number;
  /** Median lead over the `predicted` events only. `null` when there are none. */
  medianLeadMs: number | null;
  p25LeadMs: number | null;
  p75LeadMs: number | null;
  minLeadMs: number | null;
  maxLeadMs: number | null;
  /** `predictedCount > 0 && medianLeadMs >= targetMs`. Fails closed on no predictions. */
  meetsTargetMedian: boolean;
  cases: LeadTimeCase[];
}

/** Per-session outcome, so a human can see WHICH sessions failed. */
export interface SessionCaseResult {
  sessionId: string;
  /** Ground-truth class. */
  label: MlLabel;
  /** Ground truth: was this session clean? */
  clean: boolean;
  /** Did the detector flag it? */
  flagged: boolean;
  outcome: "truePositive" | "falsePositive" | "trueNegative" | "falseNegative";
  /** How many findings/events the detector produced (diagnostic only). */
  findingCount: number;
}

/** The full evaluation report. */
export interface MlEvalReport {
  schemaVersion: string;
  /** The statistically defensible granularity, and the one D25's gate reads. */
  perSession: PerSessionMetrics;
  /** `null` when the detector's output vocabulary is not comparable to the rule ids. */
  perFinding: PerFindingMetrics | null;
  /** `null` when lead time was not requested. */
  leadTime: LeadTimeMetrics | null;
  /** `true` only when a baseline was supplied and D25's gate actually ran. */
  gateEvaluated: boolean;
  /**
   * D25's combined gate, via {@link clearsM56Gate} — never re-implemented here.
   * **`false` whenever {@link gateEvaluated} is `false`**, so an unevaluated gate can
   * never be read as a pass.
   */
  passes: boolean;
  /** Everything wrong with these numbers. Non-empty on the bundled corpus. */
  limitations: EvalLimitation[];
  /** One entry per ground-truth session, in ground-truth order. */
  cases: SessionCaseResult[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Inclusive 1-D window overlap. Mirrors `tests/unit/diagnostics/fixtures.ts::windowsOverlap`. */
export function windowsOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 <= b1 && b0 <= a1;
}

/** `null`-safe rounded quantile over a non-empty numeric list. */
function quantileOrNull(values: readonly number[], p: number): number | null {
  return values.length === 0 ? null : round6(quantileFinite(values, p, 0));
}

/**
 * Score the per-session binary question. Sessions the detector said nothing about are
 * treated as **not flagged** (a silent detector is not a correct one).
 */
function scorePerSession(
  predictions: readonly SessionPrediction[],
  truth: readonly SessionTruth[]
): { metrics: PerSessionMetrics; cases: SessionCaseResult[] } {
  const byId = new Map<string, SessionPrediction>();
  for (const p of predictions) byId.set(p.sessionId, p);

  const counts: ConfusionCounts = {
    truePositives: 0,
    falsePositives: 0,
    trueNegatives: 0,
    falseNegatives: 0,
  };
  const cases: SessionCaseResult[] = [];

  for (const t of truth) {
    const p = byId.get(t.sessionId);
    const flagged = p?.flagged ?? false;
    const findingCount = p?.findingCount ?? 0;

    let outcome: SessionCaseResult["outcome"];
    if (t.clean) {
      if (flagged) {
        counts.falsePositives += 1;
        outcome = "falsePositive";
      } else {
        counts.trueNegatives += 1;
        outcome = "trueNegative";
      }
    } else if (flagged) {
      counts.truePositives += 1;
      outcome = "truePositive";
    } else {
      counts.falseNegatives += 1;
      outcome = "falseNegative";
    }

    cases.push({
      sessionId: t.sessionId,
      label: t.label,
      clean: t.clean,
      flagged,
      outcome,
      findingCount,
    });
  }

  const negativeSessions = counts.trueNegatives + counts.falsePositives;
  const positiveSessions = counts.truePositives + counts.falseNegatives;

  return {
    metrics: {
      granularity: "per-session",
      counts,
      positiveSessions,
      negativeSessions,
      precision: rateMetric(counts.truePositives, counts.truePositives + counts.falsePositives),
      recall: rateMetric(counts.truePositives, positiveSessions),
      falsePositiveRate: rateMetric(counts.falsePositives, negativeSessions),
      fpRateQuantumPp: round6(fpRateQuantumPp(negativeSessions)),
    },
    cases,
  };
}

/**
 * Score the per-finding question with **one-to-one** matching: a produced finding can
 * satisfy at most one ground-truth finding and vice versa. Without that constraint a
 * detector that emitted the same finding four times would score four true positives
 * off one real one.
 *
 * Matching is by `ruleId` + overlap of the produced evidence window with the
 * ground-truth window expanded by `± tolerance`. Severity is deliberately NOT part of
 * the match key — the question here is "did you find the problem", not "did you grade
 * it identically".
 *
 * Deterministic: ground-truth findings are consumed in input order and claim the first
 * unclaimed compatible prediction, also in input order.
 */
function scorePerFinding(
  predictions: readonly FindingPrediction[],
  truth: readonly ExpectedFindingTruth[],
  tolerance: number
): PerFindingMetrics {
  const bySession = new Map<string, FindingPrediction[]>();
  for (const p of predictions) {
    const list = bySession.get(p.sessionId);
    if (list) list.push(p);
    else bySession.set(p.sessionId, [p]);
  }

  const claimed = new Set<FindingPrediction>();
  const expected = new Map<string, number>();
  const matched = new Map<string, number>();
  const predictedCount = new Map<string, number>();

  for (const p of predictions) {
    predictedCount.set(p.ruleId, (predictedCount.get(p.ruleId) ?? 0) + 1);
  }

  for (const t of truth) {
    expected.set(t.ruleId, (expected.get(t.ruleId) ?? 0) + 1);
    const lo = t.window.startIndex - tolerance;
    const hi = t.window.endIndex + tolerance;
    const candidates = bySession.get(t.sessionId) ?? [];
    for (const c of candidates) {
      if (claimed.has(c)) continue;
      if (c.ruleId !== t.ruleId) continue;
      if (!windowsOverlap(c.window.startIndex, c.window.endIndex, lo, hi)) continue;
      claimed.add(c);
      matched.set(t.ruleId, (matched.get(t.ruleId) ?? 0) + 1);
      break;
    }
  }

  const ruleIds = [...new Set([...expected.keys(), ...predictedCount.keys()])];
  // Descending ground-truth frequency, then rule id — deterministic, and it puts the
  // rules whose metrics are actually quotable at the top.
  ruleIds.sort((a, b) => {
    const byFreq = (expected.get(b) ?? 0) - (expected.get(a) ?? 0);
    return byFreq !== 0 ? byFreq : a < b ? -1 : a > b ? 1 : 0;
  });

  const byRule: PerRuleFindingMetrics[] = ruleIds.map((ruleId) => {
    const exp = expected.get(ruleId) ?? 0;
    const pred = predictedCount.get(ruleId) ?? 0;
    const hit = matched.get(ruleId) ?? 0;
    return {
      ruleId,
      expected: exp,
      predicted: pred,
      matched: hit,
      falseNegatives: exp - hit,
      falsePositives: pred - hit,
      precision: findingMetric(hit, pred),
      recall: findingMetric(hit, exp),
    };
  });

  const totalExpected = truth.length;
  const totalPredicted = predictions.length;
  const totalMatched = claimed.size;

  return {
    granularity: "per-finding",
    windowToleranceSamples: tolerance,
    byRule,
    overall: {
      expected: totalExpected,
      predicted: totalPredicted,
      matched: totalMatched,
      falseNegatives: totalExpected - totalMatched,
      falsePositives: totalPredicted - totalMatched,
      precision: findingMetric(totalMatched, totalPredicted),
      recall: findingMetric(totalMatched, totalExpected),
    },
  };
}

/**
 * Score early-warning lead time.
 *
 * Per session, events are sorted ascending by onset. A prediction is **creditable** to
 * an event when it lies strictly before that event's onset, at or after the previous
 * event's onset (so each prediction is attributed to the next event it precedes), and —
 * when a `horizonMs` is given — no earlier than `onsetMs − horizonMs`. The event's lead
 * is measured from the **earliest** creditable prediction, i.e. the first warning the
 * pilot would have seen.
 *
 * An event with no creditable prediction but with a warning at/after its onset (and
 * before the next event) is `late`: its negative lead is retained for diagnosis, but it
 * is scored as a **miss** and excluded from the distribution. See {@link LeadTimeOutcome}.
 */
function scoreLeadTime(
  predictions: readonly TimedPrediction[],
  events: readonly EventOnset[],
  targetMs: number,
  horizonMs: number | null
): LeadTimeMetrics {
  const predsBySession = new Map<string, number[]>();
  for (const p of predictions) {
    const list = predsBySession.get(p.sessionId);
    if (list) list.push(p.tMs);
    else predsBySession.set(p.sessionId, [p.tMs]);
  }
  for (const list of predsBySession.values()) list.sort((a, b) => a - b);

  const eventsBySession = new Map<string, number[]>();
  for (const e of events) {
    const list = eventsBySession.get(e.sessionId);
    if (list) list.push(e.onsetMs);
    else eventsBySession.set(e.sessionId, [e.onsetMs]);
  }
  for (const list of eventsBySession.values()) list.sort((a, b) => a - b);

  const cases: LeadTimeCase[] = [];
  const leads: number[] = [];
  let predictedCount = 0;
  let lateCount = 0;
  let missedCount = 0;

  // Iterate sessions in the order the caller listed the events, so the output is
  // deterministic and mirrors the caller's corpus order.
  const sessionOrder = [...new Set(events.map((e) => e.sessionId))];
  for (const sessionId of sessionOrder) {
    const onsets = eventsBySession.get(sessionId) ?? [];
    const preds = predsBySession.get(sessionId) ?? [];

    for (let k = 0; k < onsets.length; k++) {
      const onsetMs = onsets[k];
      const prevOnset = k > 0 ? onsets[k - 1] : -Infinity;
      const nextOnset = k + 1 < onsets.length ? onsets[k + 1] : Infinity;
      const earliestCreditable =
        horizonMs === null ? -Infinity : onsetMs - horizonMs;

      const before = preds.filter(
        (t) => t < onsetMs && t >= prevOnset && t >= earliestCreditable
      );
      if (before.length > 0) {
        const leadMs = round6(onsetMs - before[0]);
        predictedCount += 1;
        leads.push(leadMs);
        cases.push({ sessionId, onsetMs, outcome: "predicted", leadMs });
        continue;
      }

      const after = preds.filter((t) => t >= onsetMs && t < nextOnset);
      if (after.length > 0) {
        lateCount += 1;
        cases.push({
          sessionId,
          onsetMs,
          outcome: "late",
          leadMs: round6(onsetMs - after[0]),
        });
        continue;
      }

      missedCount += 1;
      cases.push({ sessionId, onsetMs, outcome: "missed", leadMs: null });
    }
  }

  const eventCount = cases.length;
  const sorted = [...leads].sort((a, b) => a - b);
  const medianLeadMs = quantileOrNull(sorted, 0.5);

  return {
    targetMs,
    horizonMs,
    eventCount,
    predictedCount,
    lateCount,
    missedCount,
    coverage: eventCount > 0 ? round6(predictedCount / eventCount) : 0,
    medianLeadMs,
    p25LeadMs: quantileOrNull(sorted, 0.25),
    p75LeadMs: quantileOrNull(sorted, 0.75),
    minLeadMs: sorted.length > 0 ? sorted[0] : null,
    maxLeadMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    meetsTargetMedian: medianLeadMs !== null && medianLeadMs >= targetMs,
    cases,
  };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/**
 * Score a detector against the labelled corpus.
 *
 * Pure and deterministic — no RNG, no clock, no I/O. Mirrors
 * `knowledge/eval.ts::runEval`: counts → rates → one boolean gate → per-case results,
 * plus the {@link MlEvalReport.limitations} the small corpus makes mandatory.
 *
 * `passes` is D25's gate via {@link clearsM56Gate} (never re-implemented here), read
 * off the **per-session** metrics because that is the granularity D25 defines. With no
 * `opts.gateBaseline` the gate does not run and `passes` is `false` — the state a
 * baseline characterization is in, and the reason a baseline artifact can never be
 * mistaken for a pass.
 */
export function runMlEval(
  predictions: MlPredictions,
  groundTruth: MlGroundTruth,
  opts: RunMlEvalOptions = {}
): MlEvalReport {
  const tolerance = opts.windowToleranceSamples ?? DEFAULT_WINDOW_TOLERANCE_SAMPLES;
  const leadTargetMs = opts.leadTimeTargetMs ?? PREDICTIVE_LEAD_TIME_TARGET_MS;
  const horizonMs = opts.leadTimeHorizonMs ?? null;

  const { metrics: perSession, cases } = scorePerSession(
    predictions.sessions,
    groundTruth.sessions
  );

  const perFinding = predictions.findings
    ? scorePerFinding(predictions.findings, groundTruth.findings, tolerance)
    : null;

  const leadTime = predictions.leadTime
    ? scoreLeadTime(
        predictions.leadTime.predictions,
        predictions.leadTime.events,
        leadTargetMs,
        horizonMs
      )
    : null;

  // --- Limitations ---------------------------------------------------------
  const limitations: EvalLimitation[] = [];

  // D21: every class below the 300/class minimum.
  const classCounts = new Map<MlLabel, number>();
  for (const t of groundTruth.sessions) {
    classCounts.set(t.label, (classCounts.get(t.label) ?? 0) + 1);
  }
  for (const [label, total] of classCounts) {
    if (total < MIN_LABELED_SESSIONS_PER_CLASS) {
      limitations.push({
        code: "class-below-d21-minimum",
        label,
        detail: { total, required: MIN_LABELED_SESSIONS_PER_CLASS },
      });
    }
  }

  // The FP rate moves in coarse steps.
  if (
    perSession.negativeSessions > 0 &&
    perSession.negativeSessions < MIN_TEST_SESSIONS_PER_CLASS
  ) {
    limitations.push({
      code: "fp-rate-quantised",
      label: CORPUS_LIMITATION_SUBJECT,
      detail: {
        negativeSessions: perSession.negativeSessions,
        quantumPp: perSession.fpRateQuantumPp,
        required: MIN_TEST_SESSIONS_PER_CLASS,
      },
    });
  }

  // A measured FP rate of exactly 0 makes D25's strict `<` ceiling unclearable.
  if (perSession.falsePositiveRate.value === 0) {
    limitations.push({
      code: "fp-ceiling-unclearable",
      label: CORPUS_LIMITATION_SUBJECT,
      detail: { falsePositiveRate: 0, negativeSessions: perSession.negativeSessions },
    });
  }

  if (perFinding) {
    for (const rule of perFinding.byRule) {
      if (rule.expected < MIN_INSTANCES_FOR_FINDING_RATE) {
        limitations.push({
          code: "per-finding-rule-n-too-small",
          label: rule.ruleId,
          detail: { expected: rule.expected, required: MIN_INSTANCES_FOR_FINDING_RATE },
        });
      }
    }
  } else {
    limitations.push({
      code: "per-finding-not-scored",
      label: CORPUS_LIMITATION_SUBJECT,
      detail: { expectedFindings: groundTruth.findings.length },
    });
  }

  if (leadTime) {
    if (predictions.leadTime !== undefined && predictions.leadTime.predictions.length === 0) {
      limitations.push({
        code: "lead-time-no-predictions",
        label: CORPUS_LIMITATION_SUBJECT,
        detail: { events: leadTime.eventCount, predictions: 0 },
      });
    }
    if (leadTime.predictedCount < leadTime.eventCount) {
      limitations.push({
        code: "lead-time-coverage-incomplete",
        label: CORPUS_LIMITATION_SUBJECT,
        detail: {
          events: leadTime.eventCount,
          predicted: leadTime.predictedCount,
          late: leadTime.lateCount,
          missed: leadTime.missedCount,
        },
      });
    }
  }

  // --- The gate ------------------------------------------------------------
  const gateEvaluated = opts.gateBaseline !== undefined;
  if (!gateEvaluated) {
    limitations.push({
      code: "gate-not-evaluated",
      label: CORPUS_LIMITATION_SUBJECT,
      detail: {},
    });
  }
  const passes =
    gateEvaluated &&
    clearsM56Gate(
      {
        modelFpRate: perSession.falsePositiveRate.value,
        modelRecall: perSession.recall.value,
      },
      opts.gateBaseline as GateBaseline
    );

  return {
    schemaVersion: ML_EVAL_SCHEMA_VERSION,
    perSession,
    perFinding,
    leadTime,
    gateEvaluated,
    passes,
    limitations,
    cases,
  };
}
