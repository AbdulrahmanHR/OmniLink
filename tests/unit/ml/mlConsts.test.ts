import { describe, expect, it } from "vitest";
import {
  BASELINE_METRICS_ARTIFACT,
  DEFAULT_SPLIT_RATIOS,
  DIAGNOSTICS_SCAN_MEASURED_P95_MS,
  FP_CEILING_RULE,
  FP_RATE_QUANTUM_PP,
  HEALTHY_FIXTURE_COUNT,
  MEASURED_MAX_FIXTURE_LEAD_MS,
  MIN_LABELED_SESSIONS_PER_CLASS,
  MIN_RECALL_RULE,
  MIN_TEST_SESSIONS_PER_CLASS,
  ML_INFERENCE_BUDGET_SAMPLE_COUNT,
  ML_INFERENCE_P95_BUDGET_MS,
  PREDICTIVE_LEAD_TIME_TARGET_MS,
  clearsFpCeiling,
  clearsM56Gate,
  clearsRecallFloor,
  fpRateQuantumPp,
} from "@/lib/ml";
import { DIAGNOSTICS_SCAN_P95_BUDGET_MS } from "@/lib/diagnostics";

/**
 * THE FROZEN ML GATE (M56, D21/D25) — the anti-drift guard.
 *
 * Every number in `src/lib/ml/mlConsts.ts` is re-asserted here **literally**, in
 * exactly the spirit of `tests/unit/v24RetrievalEval.test.ts` re-asserting
 * `expect(RELEVANCE_THRESHOLD).toBe(0.18)`. The point is not to test arithmetic —
 * it is that the bar was frozen BEFORE any model existed, and cannot be quietly
 * loosened afterwards to fit whatever a model happens to score. Loosening any of
 * these requires editing a red test, which requires a reviewer.
 *
 * Separated (like `knowledgeEval.test.ts`) into: the frozen literals, then the
 * gate predicates' behaviour.
 */

describe("frozen literals — D21 corpus size", () => {
  it("pins the minimum labeled sessions per class at 300", () => {
    expect(MIN_LABELED_SESSIONS_PER_CLASS).toBe(300);
  });

  it("pins the split ratios at 60/20/20 and they sum to exactly 1", () => {
    expect(DEFAULT_SPLIT_RATIOS.train).toBe(0.6);
    expect(DEFAULT_SPLIT_RATIOS.val).toBe(0.2);
    expect(DEFAULT_SPLIT_RATIOS.test).toBe(0.2);
    const sum =
      DEFAULT_SPLIT_RATIOS.train + DEFAULT_SPLIT_RATIOS.val + DEFAULT_SPLIT_RATIOS.test;
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it("pins the significance floor at 60 test sessions/class AND proves it derives from D21", () => {
    expect(MIN_TEST_SESSIONS_PER_CLASS).toBe(60);
    // Not an invented number: it is the test split D21 was chosen to produce.
    expect(MIN_TEST_SESSIONS_PER_CLASS).toBe(
      MIN_LABELED_SESSIONS_PER_CLASS * DEFAULT_SPLIT_RATIOS.test,
    );
  });
});

describe("frozen literals — D25 gate is a RULE, not a hardcoded rate", () => {
  it("names the artifact the baseline is measured from — and hardcodes no FP number", () => {
    expect(BASELINE_METRICS_ARTIFACT).toBe("data/ml/baseline-v20.json");
    expect(FP_CEILING_RULE.measuredAgainst).toBe(BASELINE_METRICS_ARTIFACT);
    expect(MIN_RECALL_RULE.measuredAgainst).toBe(BASELINE_METRICS_ARTIFACT);
  });

  it("pins the FP ceiling comparator as STRICT '<' with a ZERO tolerance band", () => {
    expect(FP_CEILING_RULE.comparator).toBe("<");
    expect(FP_CEILING_RULE.toleranceBandPp).toBe(0);
    expect(FP_CEILING_RULE.heldOutSplit).toBe("test");
  });

  it("pins the recall floor comparator as NON-STRICT '>=' with a ZERO tolerance band", () => {
    expect(MIN_RECALL_RULE.comparator).toBe(">=");
    expect(MIN_RECALL_RULE.toleranceBandPp).toBe(0);
    expect(MIN_RECALL_RULE.heldOutSplit).toBe("test");
  });

  it("the two comparators are DIFFERENT — the asymmetry is the shape of D25", () => {
    expect(FP_CEILING_RULE.comparator).not.toBe(MIN_RECALL_RULE.comparator);
  });
});

describe("frozen literals — statistical power", () => {
  it("pins the healthy-fixture count at 12 and the FP-rate quantum at 8.3 pp", () => {
    expect(HEALTHY_FIXTURE_COUNT).toBe(12);
    expect(FP_RATE_QUANTUM_PP).toBe(8.3);
  });

  it("the quantum is the real 100/12 — one healthy FP moves the rate 8.3 points", () => {
    expect(fpRateQuantumPp(HEALTHY_FIXTURE_COUNT)).toBeCloseTo(8.333, 3);
    // The frozen literal is that quantum to 1 dp — so any FP-rate comparison
    // finer than ~±8 pp on this corpus is noise, and must be reported as such.
    expect(Math.round(fpRateQuantumPp(HEALTHY_FIXTURE_COUNT) * 10) / 10).toBe(
      FP_RATE_QUANTUM_PP,
    );
  });

  it("scores the 3-healthy TEST split at a 33-point quantum — worse still", () => {
    // 60/20/20 over 12 healthy sessions leaves 3 in test. A single flipped healthy
    // session there swings the FP rate by a third.
    expect(fpRateQuantumPp(3)).toBeCloseTo(33.333, 3);
  });

  it("degrades safely when there is nothing to score", () => {
    expect(fpRateQuantumPp(0)).toBe(0);
    expect(fpRateQuantumPp(-1)).toBe(0);
  });

  it("the D21 target would shrink the quantum to a third of a point", () => {
    expect(fpRateQuantumPp(MIN_LABELED_SESSIONS_PER_CLASS)).toBeCloseTo(0.333, 3);
  });
});

describe("frozen literals — M59 predictive lead time", () => {
  it("pins the median lead-time target at 2000 ms", () => {
    expect(PREDICTIVE_LEAD_TIME_TARGET_MS).toBe(2000);
  });

  it("records that the real fixture corpus tops out at 80 ms of achievable lead", () => {
    expect(MEASURED_MAX_FIXTURE_LEAD_MS).toBe(80);
  });

  it("the target is therefore UNMEETABLE on real fixtures — a finding, not a bug", () => {
    // LQ sits at ~90 until ~2 samples (40 ms cadence) before failsafe, so no
    // predictor can extract more than ~80 ms of lead from these logs. The target
    // stays at the product number; M59 is expected to REPORT the shortfall.
    expect(MEASURED_MAX_FIXTURE_LEAD_MS).toBeLessThan(PREDICTIVE_LEAD_TIME_TARGET_MS);
    expect(PREDICTIVE_LEAD_TIME_TARGET_MS / MEASURED_MAX_FIXTURE_LEAD_MS).toBe(25);
  });
});

describe("frozen literals — ML inference perf budget", () => {
  it("pins the ML p95 budget at 150 ms, measured at 50k samples", () => {
    expect(ML_INFERENCE_P95_BUDGET_MS).toBe(150);
    expect(ML_INFERENCE_BUDGET_SAMPLE_COUNT).toBe(50_000);
  });

  it("records the measured 124 ms p95 of the deterministic 50k-sample scan", () => {
    expect(DIAGNOSTICS_SCAN_MEASURED_P95_MS).toBe(124);
    // The scan's own frozen ceiling is 750 ms — ~6x headroom over the measurement.
    expect(DIAGNOSTICS_SCAN_MEASURED_P95_MS).toBeLessThan(DIAGNOSTICS_SCAN_P95_BUDGET_MS);
  });

  it("is exactly one fifth of the frozen 750 ms interactive envelope", () => {
    // The user waits ONCE for "analyze this session" — the deterministic scan AND
    // the ML pass. ML gets a minority slice of the envelope v2.0 already froze; it
    // does not get to widen it.
    expect(ML_INFERENCE_P95_BUDGET_MS * 5).toBe(DIAGNOSTICS_SCAN_P95_BUDGET_MS);
  });

  it("gives the ML pass MORE wall-clock than the whole deterministic scan costs", () => {
    // An implementation that cannot beat the five-rule + four-detector scan it
    // rides on is not a forward pass; the budget SHOULD fail it.
    expect(ML_INFERENCE_P95_BUDGET_MS).toBeGreaterThan(DIAGNOSTICS_SCAN_MEASURED_P95_MS);
  });

  it("keeps the COMBINED worst case well inside the interactive envelope", () => {
    const combined = DIAGNOSTICS_SCAN_MEASURED_P95_MS + ML_INFERENCE_P95_BUDGET_MS;
    expect(combined).toBe(274);
    expect(combined).toBeLessThan(DIAGNOSTICS_SCAN_P95_BUDGET_MS);
    // 2.7x under. Adding a model does not regress the v2.0 interactivity promise.
    expect(DIAGNOSTICS_SCAN_P95_BUDGET_MS / combined).toBeGreaterThan(2.5);
  });

  it("does NOT claim all the scan's jitter headroom (750 - 124 = 626 ms)", () => {
    // The headroom belongs to the scan, to absorb CI/WSL2 load. ML takes a slice.
    expect(ML_INFERENCE_P95_BUDGET_MS).toBeLessThan(
      DIAGNOSTICS_SCAN_P95_BUDGET_MS - DIAGNOSTICS_SCAN_MEASURED_P95_MS,
    );
  });
});

describe("gate predicates — the FP ceiling is STRICT", () => {
  it("passes only when the model FP rate is strictly below the baseline", () => {
    expect(clearsFpCeiling(0.1, 0.2)).toBe(true);
  });

  it("FAILS on an EQUAL FP rate — a tie buys nothing and costs a model", () => {
    expect(clearsFpCeiling(0.2, 0.2)).toBe(false);
  });

  it("FAILS on a worse FP rate", () => {
    expect(clearsFpCeiling(0.3, 0.2)).toBe(false);
  });

  it("admits NO epsilon — a hair above the baseline still fails", () => {
    expect(clearsFpCeiling(0.2 + Number.EPSILON, 0.2)).toBe(false);
    // ...and a hair below passes: the comparator really is `<`, not `<= - eps`.
    expect(clearsFpCeiling(0.19999999, 0.2)).toBe(true);
  });

  it("fails CLOSED on an unmeasured (NaN) metric", () => {
    expect(clearsFpCeiling(NaN, 0.2)).toBe(false);
    expect(clearsFpCeiling(0.1, NaN)).toBe(false);
  });
});

describe("gate predicates — the recall floor is NON-STRICT", () => {
  it("PASSES on an EQUAL recall — matching recall at a lower FP rate is a real win", () => {
    expect(clearsRecallFloor(0.8, 0.8)).toBe(true);
  });

  it("passes on better recall, fails on worse", () => {
    expect(clearsRecallFloor(0.9, 0.8)).toBe(true);
    expect(clearsRecallFloor(0.79, 0.8)).toBe(false);
  });

  it("fails CLOSED on an unmeasured (NaN) metric", () => {
    expect(clearsRecallFloor(NaN, 0.8)).toBe(false);
    expect(clearsRecallFloor(0.9, NaN)).toBe(false);
  });
});

describe("gate predicates — the combined M56 gate", () => {
  const baseline = { baselineFpRate: 0.2, baselineRecall: 0.8 };

  it("passes only when BOTH clauses clear", () => {
    expect(clearsM56Gate({ modelFpRate: 0.1, modelRecall: 0.9 }, baseline)).toBe(true);
    // Equal recall + strictly better FP — the canonical "worth shipping" case.
    expect(clearsM56Gate({ modelFpRate: 0.1, modelRecall: 0.8 }, baseline)).toBe(true);
  });

  it("fails when the FP ceiling is only TIED, however good the recall", () => {
    expect(clearsM56Gate({ modelFpRate: 0.2, modelRecall: 1.0 }, baseline)).toBe(false);
  });

  it("fails when recall regresses, however good the FP rate", () => {
    expect(clearsM56Gate({ modelFpRate: 0.0, modelRecall: 0.79 }, baseline)).toBe(false);
  });

  it("has no 'on balance' path — neither clause can compensate for the other", () => {
    expect(clearsM56Gate({ modelFpRate: 0.0, modelRecall: 0.0 }, baseline)).toBe(false);
    expect(clearsM56Gate({ modelFpRate: 1.0, modelRecall: 1.0 }, baseline)).toBe(false);
  });

  it("fails CLOSED when either metric is unmeasured", () => {
    expect(clearsM56Gate({ modelFpRate: NaN, modelRecall: 0.9 }, baseline)).toBe(false);
    expect(clearsM56Gate({ modelFpRate: 0.1, modelRecall: NaN }, baseline)).toBe(false);
  });
});
