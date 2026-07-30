/**
 * Frozen ML gate constants for the v2.5 predictive line (M56, D21/D25).
 *
 * This module is the **single source of truth** for every number the v2.5 ML line
 * is judged against. It exists — and is written — BEFORE any model code, on
 * purpose: a bar chosen after seeing a model's score is not a bar. Freezing the
 * gate first is the whole point of M56.
 *
 * It mirrors `src/lib/knowledge/retrievalConsts.ts` (and `src/lib/diagnostics/
 * perf.ts`, which already replicates that idiom): every `export const` carries a
 * docblock naming (a) the decision id it encodes, (b) WHY the number is what it
 * is, and (c) WHO asserts it. `tests/unit/ml/mlConsts.test.ts` re-asserts every
 * literal so the bar cannot be quietly loosened in a later commit — the same
 * anti-drift discipline `tests/unit/v24RetrievalEval.test.ts` applies to
 * `RELEVANCE_THRESHOLD`.
 *
 * ## What is deliberately NOT here
 * There is **no hardcoded false-positive rate**. D25 says a model must beat the
 * *measured* v2.0 baseline on the same held-out set; hardcoding a number would
 * let the baseline drift out from under the gate. What is frozen here is the
 * COMPARISON RULE ({@link FP_CEILING_RULE}, {@link MIN_RECALL_RULE}) and the
 * artifact the baseline is read from ({@link BASELINE_METRICS_ARTIFACT}).
 *
 * Pure data + pure predicates: no clock, no RNG, no I/O.
 */

// ---------------------------------------------------------------------------
// D21 — corpus size
// ---------------------------------------------------------------------------

/**
 * **D21.** Minimum labeled sessions **per class** required before a trained model
 * may be shipped as a product feature.
 *
 * Asserted by: `tests/unit/ml/mlConsts.test.ts` (literal re-assertion) and
 * `splitDataset` (emits a `class-below-d21-minimum` warning for every class under
 * this count — see `dataset.ts`).
 *
 * ## This is UNMET today, by a wide margin
 * The entire labeled corpus (`data/fixtures/diagnostics/fixtures-manifest.json`)
 * is **36 sessions across 5 classes**: healthy 12 / warning 7 / failsafe 7 /
 * wiring 5 / antenna 5. The largest class has **4 %** of the sessions D21 asks
 * for; the smallest has **1.7 %**. Nothing in the v2.5 line changes that, and no
 * amount of clever modelling substitutes for data that does not exist.
 *
 * The number is frozen here anyway — and frozen BEFORE any model exists —
 * precisely so the shortfall is a stated, testable fact rather than something a
 * later "it works well enough on the fixtures" commit can talk its way past.
 */
export const MIN_LABELED_SESSIONS_PER_CLASS = 300;

// ---------------------------------------------------------------------------
// Split ratios (frozen here so MIN_TEST_SESSIONS_PER_CLASS can derive from D21)
// ---------------------------------------------------------------------------

/**
 * Frozen train/val/test split ratios, applied **per class** and **by session**
 * (never by frame — see `dataset.ts::splitDataset`).
 *
 * 60/20/20 is chosen because:
 *  - it is the conventional default, so any number we publish is comparable to
 *    the outside world without an asterisk about an exotic split;
 *  - at the D21 target corpus (300/class) it yields 180/60/60 per class, which is
 *    the sizing {@link MIN_TEST_SESSIONS_PER_CLASS} derives from; and
 *  - the allocation is `floor` for train and val with the **remainder going to
 *    test**, so the scarcest and most consequential partition is never the one
 *    that loses a session to rounding.
 *
 * It does not rescue the current corpus — at 5 sessions a class splits 3/1/1 —
 * and `splitDataset` says so out loud rather than dressing that up. Asserted by
 * `tests/unit/ml/mlConsts.test.ts` (literals + sums to 1).
 */
export const DEFAULT_SPLIT_RATIOS = {
  train: 0.6,
  val: 0.2,
  test: 0.2,
} as const;

/**
 * Minimum sessions a class must have **in the test split** for a per-class metric
 * over that split to mean anything.
 *
 * Derived, not invented: `MIN_LABELED_SESSIONS_PER_CLASS × DEFAULT_SPLIT_RATIOS.test`
 * = 300 × 0.2 = **60**. It is the test-set size D21 was chosen to produce, so a
 * class that clears D21 automatically clears this, and a class that does not is
 * flagged by exactly one rule instead of two unrelated ones.
 *
 * Asserted by: `tests/unit/ml/mlConsts.test.ts` (the derivation itself is tested,
 * not just the value) and `splitDataset` (`test-split-below-significance`
 * warning). On the real 36-fixture corpus **every class fails this** — the
 * largest test split is 3 sessions.
 */
export const MIN_TEST_SESSIONS_PER_CLASS = 60;

// ---------------------------------------------------------------------------
// D25 — the false-positive ceiling + recall floor (RULES, not rates)
// ---------------------------------------------------------------------------

/**
 * Where the v2.0 baseline metrics are read from: the frozen artifact the M56b
 * baseline-characterization task writes and nothing else may edit.
 *
 * A path, not a number, on purpose. D25's ceiling is "strictly below the measured
 * v2.0 rule-engine baseline on the same held-out set" — if the baseline were
 * copy-pasted into this file as a literal it could silently diverge from the
 * artifact the model is actually compared against, and the gate would be
 * comparing a model to a memory. The comparison ALWAYS reads the artifact.
 */
export const BASELINE_METRICS_ARTIFACT = "data/ml/baseline-v20.json";

/** The candidate model's metrics on the held-out test split. */
export interface GateCandidate {
  /** False-positive rate in `[0, 1]`: healthy sessions the model called faulty. */
  modelFpRate: number;
  /** Recall in `[0, 1]`: faulty sessions the model correctly caught. */
  modelRecall: number;
}

/** The v2.0 rule-engine baseline's metrics on the **same** held-out test split. */
export interface GateBaseline {
  /** Baseline false-positive rate in `[0, 1]` (from {@link BASELINE_METRICS_ARTIFACT}). */
  baselineFpRate: number;
  /** Baseline recall in `[0, 1]` (from {@link BASELINE_METRICS_ARTIFACT}). */
  baselineRecall: number;
}

/**
 * **D25 — the false-positive ceiling, as a RULE.**
 *
 * A model ships only if its FP rate is **strictly below** the measured v2.0
 * baseline FP rate on the **same** held-out set. `comparator` is `"<"`, and
 * `toleranceBandPp` is **0**: there is no epsilon, no "within noise of", no
 * "statistically indistinguishable therefore fine". A model that merely *ties*
 * the rule engine has bought nothing and costs a model — it FAILS.
 *
 * Frozen as a descriptor (rather than only as a function) so the test suite can
 * assert the comparator and the zero tolerance band **literally**: loosening the
 * gate to `<=` or bolting on an epsilon requires editing a line that a red test
 * is already watching.
 *
 * Implemented by {@link clearsFpCeiling}; asserted by `tests/unit/ml/mlConsts.test.ts`.
 */
export const FP_CEILING_RULE = {
  /** Strict less-than. Equality FAILS. */
  comparator: "<",
  /** Zero. No tolerance band is permitted (D25). */
  toleranceBandPp: 0,
  /** The FP rate is compared against the baseline in this artifact. */
  measuredAgainst: BASELINE_METRICS_ARTIFACT,
  /** Both rates must come from the SAME split — the held-out test split. */
  heldOutSplit: "test",
} as const;

/**
 * **D25 — the recall floor, as a RULE.**
 *
 * A model ships only if its recall is **at least** the measured v2.0 baseline
 * recall on the same held-out set. `comparator` is `">="` — non-strict, unlike the
 * FP ceiling: a model that matches the rule engine's recall while genuinely
 * lowering its false-positive rate is a real win, and the gate must not reject it.
 * The asymmetry between the two comparators is the entire shape of D25 and is
 * therefore encoded, tested, and not left to a reader's memory.
 *
 * Implemented by {@link clearsRecallFloor}; asserted by `tests/unit/ml/mlConsts.test.ts`.
 */
export const MIN_RECALL_RULE = {
  /** At-least. Equality PASSES. */
  comparator: ">=",
  /** Zero. No tolerance band is permitted (D25). */
  toleranceBandPp: 0,
  /** Recall is compared against the baseline in this artifact. */
  measuredAgainst: BASELINE_METRICS_ARTIFACT,
  /** Both rates must come from the SAME split — the held-out test split. */
  heldOutSplit: "test",
} as const;

/**
 * {@link FP_CEILING_RULE} as a predicate: strictly below the baseline FP rate.
 *
 * Fails **closed**: a `NaN` on either side makes `<` false, so an unmeasured or
 * corrupt metric can never be read as a pass.
 */
export function clearsFpCeiling(modelFpRate: number, baselineFpRate: number): boolean {
  return modelFpRate < baselineFpRate;
}

/**
 * {@link MIN_RECALL_RULE} as a predicate: at or above the baseline recall.
 *
 * Fails **closed**: a `NaN` on either side makes `>=` false.
 */
export function clearsRecallFloor(modelRecall: number, baselineRecall: number): boolean {
  return modelRecall >= baselineRecall;
}

/**
 * The combined M56 ship gate (D25): a model must clear the FP ceiling **and** the
 * recall floor, both measured on the same held-out test split. Either one failing
 * fails the gate — there is no "on balance" path through it.
 *
 * This is the single predicate M58's model evaluation and the M60 launch audit
 * both call; neither re-implements the comparison.
 */
export function clearsM56Gate(model: GateCandidate, baseline: GateBaseline): boolean {
  return (
    clearsFpCeiling(model.modelFpRate, baseline.baselineFpRate) &&
    clearsRecallFloor(model.modelRecall, baseline.baselineRecall)
  );
}

// ---------------------------------------------------------------------------
// Statistical power — a first-class limitation, not a footnote
// ---------------------------------------------------------------------------

/**
 * Healthy sessions in the whole labeled corpus (`fixtures-manifest.json`). The
 * denominator of every false-positive rate this line can compute today.
 */
export const HEALTHY_FIXTURE_COUNT = 12;

/**
 * **The FP-rate quantum: one healthy false positive moves the measured FP rate by
 * 8.3 percentage points.**
 *
 * `100 / HEALTHY_FIXTURE_COUNT = 100 / 12 = 8.33…` pp. The FP rate over this
 * corpus is not a continuous quantity — it can only ever take the 13 values
 * `0/12, 1/12, … 12/12`. There is nothing between 0 % and 8.3 %.
 *
 * ## What follows, and it is not optional reading
 * **Any FP-rate comparison finer than ~±8 pp on this corpus is noise.** A model
 * that "beats the baseline by 4 points" has not beaten it by 4 points; it has
 * produced a number that cannot exist. D25's strict `<` is still the right rule —
 * but a `<` that resolves on a single flipped healthy session is a coin toss with
 * a p-value, not evidence. If the FP delta between a model and the baseline is one
 * quantum or less, the honest report is "indistinguishable at this corpus size",
 * and **that is what M56b/M58/M60 must say** — the gate's verdict is still binding,
 * but it must never be reported as if it were significant.
 *
 * The fix is not a better model. The fix is {@link MIN_LABELED_SESSIONS_PER_CLASS}
 * sessions per class, which at 300 healthy would put the quantum at 0.33 pp.
 *
 * Asserted by `tests/unit/ml/mlConsts.test.ts` (both the literal and the
 * derivation via {@link fpRateQuantumPp}).
 */
export const FP_RATE_QUANTUM_PP = 8.3;

/**
 * The FP-rate quantum (percentage points) for an arbitrary healthy-session count:
 * `100 / healthySessionCount`, or `0` when there are no healthy sessions to score.
 *
 * Exposed as a function so M56b/M58/M60 report the quantum for the split they
 * actually scored (which is smaller than the whole corpus) rather than quoting
 * {@link FP_RATE_QUANTUM_PP} at a set it does not describe. On the **test split**
 * of the current corpus there are 3 healthy sessions — a quantum of **33.3 pp**.
 */
export function fpRateQuantumPp(healthySessionCount: number): number {
  return healthySessionCount > 0 ? 100 / healthySessionCount : 0;
}

// ---------------------------------------------------------------------------
// M59 — predictive lead time
// ---------------------------------------------------------------------------

/**
 * **M59.** Target **median** lead time: a predictive warning must arrive at least
 * this far ahead of the failsafe it predicts, across the evaluated sessions.
 *
 * 2000 ms is the product requirement (a pilot needs ~2 s to react — throttle down,
 * turn back, or land — before the link is gone).
 *
 * ## This target is UNMEETABLE on the real fixture corpus, and that is a finding
 * Measured against `data/fixtures/diagnostics/`: link quality sits at ~90 right up
 * until roughly **2 samples** before the failsafe edge, and the sample cadence is
 * 40 ms. The maximum lead any predictor — ML or otherwise — could extract from
 * these logs is therefore about **{@link MEASURED_MAX_FIXTURE_LEAD_MS} ms**, i.e.
 * **25× short** of this target. No model can predict from a signal that is not in
 * the data.
 *
 * The target stays frozen at the product number rather than being quietly retuned
 * down to what the corpus can deliver. M59 is expected to REPORT the shortfall
 * against this bar. A predictor tuned to "achieve" 2 s on these fixtures would be
 * fitting noise, and a target lowered to 80 ms would be a target that describes
 * the fixtures instead of the pilot.
 */
export const PREDICTIVE_LEAD_TIME_TARGET_MS = 2000;

/**
 * The maximum failsafe lead time actually achievable on the current fixture
 * corpus (~2 samples × 40 ms cadence). Recorded here so the {@link
 * PREDICTIVE_LEAD_TIME_TARGET_MS} shortfall is a checked-in number that a test
 * asserts, not a claim in a changelog.
 *
 * Asserted by `tests/unit/ml/mlConsts.test.ts`: this value is *less than* the
 * target — the gap is the finding.
 */
export const MEASURED_MAX_FIXTURE_LEAD_MS = 80;

// ---------------------------------------------------------------------------
// Interactive perf budget for ML inference
// ---------------------------------------------------------------------------

/**
 * The measured p95 of ONE full deterministic v2.0 session scan (`evaluateSession`
 * + `detectSessionPatterns`) over a 50 000-sample log — the reference figure that
 * {@link ML_INFERENCE_P95_BUDGET_MS} is reasoned against.
 *
 * Re-measured while freezing this module (WSL2 dev box, 15 runs): ~69 ms median /
 * ~88 ms p95, which corroborates the 124 ms reference from the other direction.
 * 124 is kept as the constant because it is the more conservative of the two, and
 * a budget should be justified against the *worse* measurement, not the flattering
 * one.
 *
 * The scan's own frozen ceiling is `DIAGNOSTICS_SCAN_P95_BUDGET_MS = 750` ms
 * (`src/lib/diagnostics/perf.ts`), i.e. ~6× headroom over this measurement. That
 * headroom exists to absorb CI/WSL2 jitter, **not** to be spent on new work.
 */
export const DIAGNOSTICS_SCAN_MEASURED_P95_MS = 124;

/** The log size (samples) both perf budgets are pinned at, so they are comparable. */
export const ML_INFERENCE_BUDGET_SAMPLE_COUNT = 50_000;

/**
 * Frozen p95 wall-clock budget (ms) for ONE **marginal** ML pass over a
 * {@link ML_INFERENCE_BUDGET_SAMPLE_COUNT}-sample log. Asserted by the M58/M59
 * perf test at the same log size the diagnostics scan budget is asserted at.
 *
 * ## What "one ML pass" means — precisely
 * `extractFeatures(log, report)` **plus** the model forward pass, where `report` is
 * the {@link import("@/lib/diagnostics").DiagnosticReport} the SAME "analyze this
 * session" action already produced. It is the *additional* cost of adding ML to an
 * action that was going to run the deterministic scan anyway — which is the only
 * cost a user can actually perceive as new.
 *
 * This scoping is load-bearing and is why `extractFeatures` takes an optional
 * `report`: called as `extractFeatures(log)` it re-runs the whole scan internally
 * (measured ~127 ms median / ~135 ms p95 at 50 k — nearly all of it the re-scan),
 * and budgeting THAT would double-count work the 750 ms envelope already paid for.
 * The M58/M59 perf test must therefore measure the two-argument form. A caller that
 * has no report yet is not doing an extra ML pass; it is doing a scan and an ML
 * pass, and it is billed for both.
 *
 * ## Why 150 ms
 * The user-perceived unit of work is **one "analyze this session" action**, and ML
 * inference is an ADDITIONAL pass layered on top of the deterministic scan inside
 * that same action — the user waits once, for both. So the budget cannot be
 * reasoned about in isolation; it has to be reasoned about as a *slice of an
 * envelope the project already froze*.
 *
 * That envelope is `DIAGNOSTICS_SCAN_P95_BUDGET_MS = 750` ms: the number v2.0
 * committed to as "this action still feels interactive". Adding a model must not
 * widen it. The slice is sized as follows:
 *
 * 1. **One fifth of the frozen envelope: 750 / 5 = 150 ms.** A fraction of the
 *    existing budget is the natural framing — it says "ML may cost a minority
 *    share of an action whose total cost is already agreed", and it keeps the two
 *    numbers in one relationship instead of two independent guesses.
 *
 * 2. **It is achievable with real headroom, and measured — not hoped for.** The
 *    feature half of the pass (43 features over ~7 channels, all O(n)) measures
 *    ~58 ms median / **~69 ms p95** at 50 k samples on the reference box, so the
 *    budget carries ~2.2× headroom for the forward pass and for CI/WSL2 jitter. A
 *    small-model forward pass on a **43-dimensional** vector is microseconds; the
 *    feature sweep is the entire cost, and it is already inside the bar.
 *
 * 3. **It is still more wall-clock than the whole deterministic scan costs**
 *    (measured p95 {@link DIAGNOSTICS_SCAN_MEASURED_P95_MS} = 124 ms). An ML pass
 *    that cannot beat the five rules + four session detectors it rides on is not a
 *    forward pass; it is an architectural mistake, and the budget SHOULD fail it. A
 *    budget that a wrong design still passes is decoration.
 *
 * 4. **The combined worst case still holds the envelope.** Scan at its measured
 *    p95 (124) + ML at its ceiling (150) = **274 ms**, 2.7× under the 750 ms the
 *    project already calls interactive. Even if the scan drifts up under load, the
 *    combined action has room; the ML pass never becomes the reason a user waits.
 *
 * 5. **150 ms sits under the ~200 ms "still feels immediate" band.** Taken alone,
 *    the ML pass at its ceiling is below the threshold where a UI action stops
 *    reading as instantaneous — so ML can never be the component that makes the
 *    analyze action feel slow, only the component that makes it feel *slower*, and
 *    only by a minority share.
 *
 * Deliberately NOT chosen: `750 − 124 = 626 ms` (all remaining headroom). That
 * would hand the model every millisecond the scan's jitter allowance was reserved
 * for, so a loaded machine where the scan drifts toward its own ceiling would blow
 * the combined envelope. The headroom belongs to the scan; ML gets a slice, not
 * the remainder.
 */
export const ML_INFERENCE_P95_BUDGET_MS = 150;
