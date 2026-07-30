/**
 * The data-readiness verdict (M56c): how far the labeled corpus is from the D21
 * bar, per class and in aggregate — and what that means for every number this
 * release's ML line can produce.
 *
 * ## The verdict, up front
 * D21 requires {@link MIN_LABELED_SESSIONS_PER_CLASS} = 300 labeled sessions **per
 * class**, across the 5 trainable classes: **1 500 sessions**. What exists is the
 * bundled fixture corpus — **36 sessions** — plus whatever the user has labeled
 * locally, which for every real user today is **0**. The largest class (healthy, 12)
 * has **4 %** of the sessions the bar asks of one class.
 *
 * {@link ReadinessReport.barMet} is therefore `false`, and it is not a near miss.
 * Every metric the v2.5 ML line reports is **indicative, not a gate pass**: the M56
 * gate (`clearsM56Gate`) is additionally *unclearable* against this corpus, because
 * the v2.0 baseline scores a 0.000 false-positive rate on it and D25 demands
 * **strictly below** that. No model passes. Not this one, not a better one.
 *
 * ## Fixtures are not the user's data
 * The 36 fixtures are OmniLink's bundled reference corpus (they are also what the
 * v2.0 rules were authored against — see `data/ml/baseline-v20.json` `honesty.
 * baselineHeldOutFromCorpus: false`). They are counted here because they are real
 * labeled sessions and the bar is about labeled sessions — but they are counted
 * **separately** from the user's own labels in every field of the report, and the
 * UI is required to keep them separate too. A reader must never be able to mistake
 * `fixtureSessions` for something they recorded.
 *
 * ## Purity
 * Pure data + pure functions: no clock, no RNG, no I/O, no network, no strings for
 * humans (the report carries codes and numbers; `src/components/ml/MlLabPanel.tsx`
 * renders them through i18n). Same input ⇒ same report, always.
 */

import { ML_LABELS, type MlLabel } from "./dataset";
import { MIN_LABELED_SESSIONS_PER_CLASS } from "./mlConsts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Semantic version of the {@link ReadinessReport} shape. Bump on any breaking change. */
export const READINESS_SCHEMA_VERSION = "1.0.0";

/**
 * The classes the D21 bar applies to: every canonical label **except `unknown`**.
 *
 * `unknown` is a real, storable label — "a human looked and could not tell" is a
 * fact worth recording, and conflating it with "nobody has looked yet" would corrupt
 * the denominator this whole module computes. But it is not a class to *collect*:
 * `splitDataset` says the same thing (an empty `unknown` raises no `absent-class`
 * warning), and no model is trained to predict it. So an `unknown`-labeled session
 * counts toward **no class's** D21 progress, and the report says so explicitly via
 * {@link ReadinessReport.userLabeledUnknown} rather than quietly dropping it.
 */
export const TRAINABLE_ML_LABELS = [
  "healthy",
  "warning",
  "failsafe",
  "wiringSuspicion",
  "antennaSuspicion",
] as const;

/** One class the D21 bar applies to. */
export type TrainableMlLabel = (typeof TRAINABLE_ML_LABELS)[number];

/** Narrow a canonical label to a trainable one (`unknown` ⇒ `false`). */
export function isTrainableLabel(label: MlLabel): label is TrainableMlLabel {
  return (TRAINABLE_ML_LABELS as readonly string[]).includes(label);
}

// ---------------------------------------------------------------------------
// The bundled fixture corpus — the reference denominator, NOT the user's data
// ---------------------------------------------------------------------------

/**
 * Sessions per class in the bundled fixture corpus
 * (`data/fixtures/diagnostics/fixtures-manifest.json`).
 *
 * Frozen here as data so the report stays pure (no fs, no 60 KB artifact in the app
 * bundle). It is **not** an unchecked copy: `tests/unit/ml/readiness.test.ts` reads
 * the checked-in `data/ml/baseline-v20.json` and asserts this record deep-equals its
 * `corpus.sessionsByClass`, so the two cannot drift.
 */
export const FIXTURE_SESSIONS_BY_CLASS: Readonly<Record<TrainableMlLabel, number>> = {
  healthy: 12,
  warning: 7,
  failsafe: 7,
  wiringSuspicion: 5,
  antennaSuspicion: 5,
};

/** Total sessions in the bundled fixture corpus (36). Derived, never typed twice. */
export const FIXTURE_SESSION_TOTAL = TRAINABLE_ML_LABELS.reduce(
  (sum, label) => sum + FIXTURE_SESSIONS_BY_CLASS[label],
  0
);

/**
 * Total labeled sessions D21 requires across every trainable class:
 * `5 × 300 = 1 500`. Derived from {@link MIN_LABELED_SESSIONS_PER_CLASS} so the
 * aggregate bar can never disagree with the per-class bar.
 */
export const REQUIRED_SESSION_TOTAL =
  TRAINABLE_ML_LABELS.length * MIN_LABELED_SESSIONS_PER_CLASS;

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** A per-label session count. Absent keys read as 0. */
export type LabelCounts = Readonly<Partial<Record<MlLabel, number>>>;

/** Coerce an untrusted count to a non-negative integer (a bad number is 0, never negative). */
function safeCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * Tally a flat list of labels (**one per session** — the caller must have already
 * reduced a label's revision history to its latest assertion, via
 * `latestLabelBySession` in `src/lib/session-labels.ts`) into per-label counts.
 *
 * Every canonical label is present in the result, `unknown` included, so a caller
 * cannot silently lose a class by forgetting to initialise it.
 */
export function countLabels(labels: readonly MlLabel[]): Record<MlLabel, number> {
  const counts = {} as Record<MlLabel, number>;
  for (const label of ML_LABELS) counts[label] = 0;
  for (const label of labels) {
    if (label in counts) counts[label] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** One class's distance from the D21 bar. */
export interface ClassReadiness {
  /** The class. `unknown` never appears — it is not a class the bar applies to. */
  label: TrainableMlLabel;
  /** Sessions from OmniLink's **bundled fixture corpus**. Not the user's recordings. */
  fixtureSessions: number;
  /** Sessions the user has labeled **on this device**. 0 for every real user today. */
  userLabeledSessions: number;
  /** `fixtureSessions + userLabeledSessions` — what actually counts toward the bar. */
  labeledSessions: number;
  /** The D21 bar for one class ({@link MIN_LABELED_SESSIONS_PER_CLASS} = 300). */
  required: number;
  /** How many more sessions this class needs. `max(0, required − labeledSessions)`. */
  shortfall: number;
  /** `labeledSessions / required` in `[0, 1]` — a progress ratio, not a score. */
  fractionOfBar: number;
  /** `labeledSessions >= required`. **`false` for every class today.** */
  barMet: boolean;
}

/**
 * The verdict code (an i18n key suffix, never a sentence — this module ships no
 * user-facing strings):
 *  - `not-enough-data` — the D21 bar is unmet. **This is the answer today.**
 *  - `bar-met` — every trainable class has at least {@link MIN_LABELED_SESSIONS_PER_CLASS}
 *    labeled sessions. Reachable only with ~1 464 more labeled sessions than exist.
 */
export type ReadinessVerdict = "not-enough-data" | "bar-met";

/** The honest data-readiness verdict. */
export interface ReadinessReport {
  /** {@link READINESS_SCHEMA_VERSION}. */
  schemaVersion: string;
  /** The D21 bar, per class (300). */
  requiredPerClass: number;
  /** The D21 bar, in aggregate (1 500). */
  requiredTotal: number;
  /** Per-class detail, in canonical {@link TRAINABLE_ML_LABELS} order. */
  perClass: ClassReadiness[];

  /** Sessions in the bundled fixture corpus (36). **Reference data, not the user's.** */
  fixtureSessionTotal: number;
  /** Every session the user labeled locally, `unknown` included. */
  userLabeledTotal: number;
  /** The user's labels that land on a trainable class (i.e. excluding `unknown`). */
  userLabeledTrainableTotal: number;
  /**
   * The user's `unknown` labels. Recorded, and deliberately counted toward **no**
   * class: "I cannot tell" is data about the labeler, not about a class.
   */
  userLabeledUnknown: number;

  /** `fixtureSessionTotal + userLabeledTrainableTotal` — what counts toward the 1 500. */
  labeledSessionTotal: number;
  /** `max(0, requiredTotal − labeledSessionTotal)`. **1 464 today.** */
  shortfallTotal: number;
  /** `labeledSessionTotal / requiredTotal` in `[0, 1]`. **0.024 today.** */
  fractionOfBar: number;

  /** `true` only when EVERY trainable class clears D21. **`false`.** */
  barMet: boolean;
  /** {@link ReadinessVerdict}. **`"not-enough-data"`.** */
  verdict: ReadinessVerdict;
  /**
   * `!barMet`. When set, every metric the v2.5 ML line reports is **indicative
   * only** — a number produced for information, not a gate pass. Renderers must say
   * so; they must not present a passing-looking metric without it.
   */
  indicativeOnly: boolean;
}

/**
 * Build the {@link ReadinessReport} from the user's local label counts.
 *
 * Pure: the fixture half is the frozen {@link FIXTURE_SESSIONS_BY_CLASS} constant,
 * the user half is whatever the caller counted, and nothing here reads a clock, a
 * file, or the network. `buildReadinessReport({})` — a user who has labeled nothing,
 * which is every user — returns the release's honest baseline verdict: 36 of 1 500,
 * `barMet: false`.
 */
export function buildReadinessReport(userLabelCounts: LabelCounts = {}): ReadinessReport {
  const perClass: ClassReadiness[] = TRAINABLE_ML_LABELS.map((label) => {
    const fixtureSessions = FIXTURE_SESSIONS_BY_CLASS[label];
    const userLabeledSessions = safeCount(userLabelCounts[label]);
    const labeledSessions = fixtureSessions + userLabeledSessions;
    return {
      label,
      fixtureSessions,
      userLabeledSessions,
      labeledSessions,
      required: MIN_LABELED_SESSIONS_PER_CLASS,
      shortfall: Math.max(0, MIN_LABELED_SESSIONS_PER_CLASS - labeledSessions),
      fractionOfBar: Math.min(1, labeledSessions / MIN_LABELED_SESSIONS_PER_CLASS),
      barMet: labeledSessions >= MIN_LABELED_SESSIONS_PER_CLASS,
    };
  });

  const userLabeledTrainableTotal = perClass.reduce(
    (sum, c) => sum + c.userLabeledSessions,
    0
  );
  const userLabeledUnknown = safeCount(userLabelCounts.unknown);
  const labeledSessionTotal = FIXTURE_SESSION_TOTAL + userLabeledTrainableTotal;
  const barMet = perClass.every((c) => c.barMet);

  return {
    schemaVersion: READINESS_SCHEMA_VERSION,
    requiredPerClass: MIN_LABELED_SESSIONS_PER_CLASS,
    requiredTotal: REQUIRED_SESSION_TOTAL,
    perClass,
    fixtureSessionTotal: FIXTURE_SESSION_TOTAL,
    userLabeledTotal: userLabeledTrainableTotal + userLabeledUnknown,
    userLabeledTrainableTotal,
    userLabeledUnknown,
    labeledSessionTotal,
    shortfallTotal: Math.max(0, REQUIRED_SESSION_TOTAL - labeledSessionTotal),
    fractionOfBar: Math.min(1, labeledSessionTotal / REQUIRED_SESSION_TOTAL),
    barMet,
    verdict: barMet ? "bar-met" : "not-enough-data",
    indicativeOnly: !barMet,
  };
}
