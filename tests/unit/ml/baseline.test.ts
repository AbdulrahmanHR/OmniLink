/**
 * M56b — the ML eval harness + the frozen v2.0 baseline characterization.
 *
 * Mirrors `tests/unit/knowledgeEval.test.ts`'s separation of concerns:
 *  1. **corpus integrity** — the labelled corpus is what we think it is;
 *  2. **harness math** — precision / recall / FP / lead time computed on
 *     hand-constructed inputs with KNOWN answers. Scoring the real corpus proves
 *     nothing about the arithmetic; only a set whose answer you worked out by hand does;
 *  3. **the frozen artifact** — `data/ml/baseline-v20.json` still reproduces EXACTLY
 *     from the fixtures. This is the anti-drift guard: change a rule threshold or a
 *     fixture and this goes red, forcing a conscious re-freeze via
 *     `npm run build:ml-baseline`;
 *  4. **the measured numbers**, pinned as literals — including the ones that are bad
 *     news.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASELINE_ANOMALY_HEURISTIC,
  BASELINE_ARTIFACT_SCHEMA_VERSION,
  BASELINE_METRICS_ARTIFACT,
  BASELINE_RULE_ENGINE,
  DEFAULT_WINDOW_TOLERANCE_SAMPLES,
  FAILSAFE_ONSET_RULE,
  MIN_INSTANCES_FOR_FINDING_RATE,
  MIN_LABELED_SESSIONS_PER_CLASS,
  PREDICTIVE_LEAD_TIME_TARGET_MS,
  buildEventOnsets,
  characterizeBaselines,
  clearsM56Gate,
  fingerprintCorpus,
  findFailsafeOnsetIndices,
  runMlEval,
  serializeBaselineArtifact,
  windowsOverlap as libWindowsOverlap,
  type BaselineArtifact,
  type BaselineFixture,
  type MlGroundTruth,
  type MlPredictions,
} from "@/lib/ml";
import {
  loadAllFixtures,
  loadManifest,
  windowsOverlap,
  WINDOW_TOLERANCE,
} from "../diagnostics/fixtures";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

const MANIFEST = loadManifest();
const FIXTURES: BaselineFixture[] = loadAllFixtures();

// ---------------------------------------------------------------------------
// 1. Corpus integrity — the eval is only as good as the set it runs on
// ---------------------------------------------------------------------------

describe("fixture corpus integrity", () => {
  it("is 36 sessions across 5 classes (healthy 12 / warning 7 / failsafe 7 / wiring 5 / antenna 5)", () => {
    expect(FIXTURES).toHaveLength(36);
    const byLabel: Record<string, number> = {};
    for (const fx of FIXTURES) byLabel[fx.label] = (byLabel[fx.label] ?? 0) + 1;
    expect(byLabel).toEqual({ healthy: 12, warning: 7, failsafe: 7, wiring: 5, antenna: 5 });
  });

  it("marks exactly the 12 healthy sessions clean — they are the only FP denominator", () => {
    const clean = FIXTURES.filter((f) => f.expectClean);
    expect(clean).toHaveLength(12);
    expect(new Set(clean.map((f) => f.label))).toEqual(new Set(["healthy"]));
    expect(FIXTURES.filter((f) => !f.expectClean)).toHaveLength(24);
  });

  it("carries 67 expected findings, with only lq-collapse and rssi-floor above the rate bar", () => {
    const byRule: Record<string, number> = {};
    for (const fx of FIXTURES) {
      for (const e of fx.expectedFindings) byRule[e.ruleId] = (byRule[e.ruleId] ?? 0) + 1;
    }
    expect(byRule).toEqual({
      "lq-collapse": 36,
      "rssi-floor": 22,
      "packet-instability": 5,
      "snr-noise": 2,
      "tx-power-saturation": 2,
    });
    expect(Object.values(byRule).reduce((a, b) => a + b, 0)).toBe(67);

    const quotable = Object.entries(byRule).filter(
      ([, n]) => n >= MIN_INSTANCES_FOR_FINDING_RATE
    );
    expect(quotable.map(([id]) => id).sort()).toEqual(["lq-collapse", "rssi-floor"]);
  });

  it("uses unique session keys", () => {
    const ids = FIXTURES.map((f) => f.file);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("no class comes close to the D21 minimum of 300 labeled sessions", () => {
    const byLabel: Record<string, number> = {};
    for (const fx of FIXTURES) byLabel[fx.label] = (byLabel[fx.label] ?? 0) + 1;
    for (const n of Object.values(byLabel)) {
      expect(n).toBeLessThan(MIN_LABELED_SESSIONS_PER_CLASS);
    }
    expect(Math.max(...Object.values(byLabel)) / MIN_LABELED_SESSIONS_PER_CLASS).toBeLessThan(0.05);
  });
});

describe("window-matching constants do not drift from the fixture corpus", () => {
  it("the harness tolerance equals the corpus's labelling tolerance", () => {
    expect(DEFAULT_WINDOW_TOLERANCE_SAMPLES).toBe(WINDOW_TOLERANCE);
    expect(DEFAULT_WINDOW_TOLERANCE_SAMPLES).toBe(8);
  });

  it("the harness's windowsOverlap agrees with the corpus loader's", () => {
    const cases: [number, number, number, number][] = [
      [0, 10, 5, 15],
      [0, 10, 10, 20],
      [0, 10, 11, 20],
      [11, 20, 0, 10],
      [5, 5, 5, 5],
      [-3, -1, -2, 0],
    ];
    for (const [a0, a1, b0, b1] of cases) {
      expect(libWindowsOverlap(a0, a1, b0, b1)).toBe(windowsOverlap(a0, a1, b0, b1));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Harness math — hand-built inputs with answers worked out by hand
// ---------------------------------------------------------------------------

/** 10 sessions: 4 clean, 6 faulty. */
const SYNTH_TRUTH: MlGroundTruth = {
  sessions: [
    { sessionId: "c1", label: "healthy", clean: true },
    { sessionId: "c2", label: "healthy", clean: true },
    { sessionId: "c3", label: "healthy", clean: true },
    { sessionId: "c4", label: "healthy", clean: true },
    { sessionId: "f1", label: "failsafe", clean: false },
    { sessionId: "f2", label: "failsafe", clean: false },
    { sessionId: "f3", label: "failsafe", clean: false },
    { sessionId: "w1", label: "warning", clean: false },
    { sessionId: "w2", label: "warning", clean: false },
    { sessionId: "w3", label: "warning", clean: false },
  ],
  findings: [],
};

describe("runMlEval — per-session math", () => {
  // Flags c1 (a false positive) and f1/f2/f3/w1 (four true positives).
  // ⇒ TP=4, FP=1, TN=3, FN=2.
  // ⇒ precision = 4/5 = 0.8, recall = 4/6 = 0.666667, FP rate = 1/4 = 0.25.
  const flagged = new Set(["c1", "f1", "f2", "f3", "w1"]);
  const predictions: MlPredictions = {
    sessions: SYNTH_TRUTH.sessions.map((s) => ({
      sessionId: s.sessionId,
      flagged: flagged.has(s.sessionId),
      findingCount: flagged.has(s.sessionId) ? 1 : 0,
    })),
  };
  const report = runMlEval(predictions, SYNTH_TRUTH);

  it("computes the confusion matrix by hand-checked counts", () => {
    expect(report.perSession.counts).toEqual({
      truePositives: 4,
      falsePositives: 1,
      trueNegatives: 3,
      falseNegatives: 2,
    });
    expect(report.perSession.negativeSessions).toBe(4);
    expect(report.perSession.positiveSessions).toBe(6);
  });

  it("computes precision = 4/5 = 0.8", () => {
    expect(report.perSession.precision).toEqual({
      kind: "rate",
      value: 0.8,
      numerator: 4,
      denominator: 5,
    });
  });

  it("computes recall = 4/6 = 0.666667", () => {
    expect(report.perSession.recall.value).toBeCloseTo(4 / 6, 6);
    expect(report.perSession.recall.denominator).toBe(6);
  });

  it("computes the false-positive rate = 1/4 = 0.25, over the CLEAN sessions only", () => {
    expect(report.perSession.falsePositiveRate).toEqual({
      kind: "rate",
      value: 0.25,
      numerator: 1,
      denominator: 4,
    });
    expect(report.perSession.fpRateQuantumPp).toBe(25);
  });

  it("names the sessions that failed, so a human can look at them", () => {
    expect(report.cases).toHaveLength(10);
    expect(report.cases.filter((c) => c.outcome === "falsePositive").map((c) => c.sessionId)).toEqual([
      "c1",
    ]);
    expect(report.cases.filter((c) => c.outcome === "falseNegative").map((c) => c.sessionId)).toEqual([
      "w2",
      "w3",
    ]);
  });

  it("treats a session the detector said nothing about as NOT flagged (a silent detector is not a correct one)", () => {
    const partial = runMlEval({ sessions: [{ sessionId: "f1", flagged: true, findingCount: 1 }] }, SYNTH_TRUTH);
    expect(partial.perSession.counts).toEqual({
      truePositives: 1,
      falsePositives: 0,
      trueNegatives: 4,
      falseNegatives: 5,
    });
  });

  it("fails closed: a detector that flags nothing has precision 0, not a vacuous 1", () => {
    const silent = runMlEval(
      { sessions: SYNTH_TRUTH.sessions.map((s) => ({ sessionId: s.sessionId, flagged: false, findingCount: 0 })) },
      SYNTH_TRUTH
    );
    expect(silent.perSession.precision).toEqual({
      kind: "rate",
      value: 0,
      numerator: 0,
      denominator: 0,
    });
    expect(silent.perSession.recall.value).toBe(0);
  });
});

describe("runMlEval — the D25 gate", () => {
  const predictions: MlPredictions = {
    sessions: SYNTH_TRUTH.sessions.map((s) => ({
      sessionId: s.sessionId,
      flagged: !s.clean,
      findingCount: s.clean ? 0 : 1,
    })),
  };

  it("does not run the gate when no baseline is given — and says so instead of passing", () => {
    const report = runMlEval(predictions, SYNTH_TRUTH);
    expect(report.gateEvaluated).toBe(false);
    expect(report.passes).toBe(false);
    expect(report.limitations.map((l) => l.code)).toContain("gate-not-evaluated");
  });

  it("delegates to clearsM56Gate rather than re-implementing the comparison", () => {
    const baseline = { baselineFpRate: 0.25, baselineRecall: 0.9 };
    const report = runMlEval(predictions, SYNTH_TRUTH, { gateBaseline: baseline });
    // Perfect predictions: FP rate 0 < 0.25, recall 1 >= 0.9 ⇒ passes.
    expect(report.gateEvaluated).toBe(true);
    expect(report.passes).toBe(true);
    expect(report.passes).toBe(
      clearsM56Gate(
        {
          modelFpRate: report.perSession.falsePositiveRate.value,
          modelRecall: report.perSession.recall.value,
        },
        baseline
      )
    );
  });

  it("fails a model that only TIES the baseline FP rate (D25's strict '<')", () => {
    const report = runMlEval(predictions, SYNTH_TRUTH, {
      gateBaseline: { baselineFpRate: 0, baselineRecall: 1 },
    });
    expect(report.perSession.falsePositiveRate.value).toBe(0);
    expect(report.passes).toBe(false);
  });

  it("raises fp-ceiling-unclearable when the measured FP rate is 0 — nothing is strictly below zero", () => {
    const report = runMlEval(predictions, SYNTH_TRUTH);
    expect(report.limitations.map((l) => l.code)).toContain("fp-ceiling-unclearable");
  });
});

describe("runMlEval — per-finding math (one-to-one, ruleId + window overlap)", () => {
  const truth: MlGroundTruth = {
    sessions: [
      { sessionId: "s1", label: "warning", clean: false },
      { sessionId: "s2", label: "warning", clean: false },
    ],
    findings: [
      { sessionId: "s1", ruleId: "ruleX", window: { startIndex: 10, endIndex: 20 } },
      { sessionId: "s1", ruleId: "ruleX", window: { startIndex: 100, endIndex: 110 } },
      { sessionId: "s2", ruleId: "ruleY", window: { startIndex: 5, endIndex: 15 } },
    ],
  };
  const predictions: MlPredictions = {
    sessions: [
      { sessionId: "s1", flagged: true, findingCount: 2 },
      { sessionId: "s2", flagged: true, findingCount: 1 },
    ],
    findings: [
      // Matches truth[0] (overlaps [10,20]).
      { sessionId: "s1", ruleId: "ruleX", window: { startIndex: 12, endIndex: 18 } },
      // Matches nothing — far outside truth[1]'s ±8-expanded window [92,118].
      { sessionId: "s1", ruleId: "ruleX", window: { startIndex: 500, endIndex: 510 } },
      // Right window, WRONG rule ⇒ a false positive, and truth[2] stays a miss.
      { sessionId: "s2", ruleId: "ruleZ", window: { startIndex: 5, endIndex: 15 } },
    ],
  };
  const report = runMlEval(predictions, truth);
  const byRule = Object.fromEntries(
    (report.perFinding?.byRule ?? []).map((r) => [r.ruleId, r])
  );

  it("scores ruleX: 2 expected, 2 predicted, 1 matched ⇒ 1 FN + 1 FP", () => {
    expect(byRule.ruleX).toMatchObject({
      expected: 2,
      predicted: 2,
      matched: 1,
      falseNegatives: 1,
      falsePositives: 1,
    });
  });

  it("scores an unmatched expected finding as a miss, not silence", () => {
    expect(byRule.ruleY).toMatchObject({ expected: 1, predicted: 0, matched: 0, falseNegatives: 1 });
  });

  it("scores a produced finding with an unknown rule id as a false positive", () => {
    expect(byRule.ruleZ).toMatchObject({ expected: 0, predicted: 1, matched: 0, falsePositives: 1 });
  });

  it("pools an overall 1/3 matched", () => {
    expect(report.perFinding?.overall).toMatchObject({
      expected: 3,
      predicted: 3,
      matched: 1,
      falseNegatives: 2,
      falsePositives: 2,
    });
  });

  it("matches WITHIN the ±8 tolerance and refuses to match one sample outside it", () => {
    const base: MlGroundTruth = {
      sessions: [{ sessionId: "s", label: "warning", clean: false }],
      findings: [{ sessionId: "s", ruleId: "r", window: { startIndex: 10, endIndex: 20 } }],
    };
    const sessions = [{ sessionId: "s", flagged: true, findingCount: 1 }];
    // Expanded truth window is [2, 28].
    const inside = runMlEval(
      { sessions, findings: [{ sessionId: "s", ruleId: "r", window: { startIndex: 28, endIndex: 30 } }] },
      base
    );
    expect(inside.perFinding?.overall.matched).toBe(1);

    const outside = runMlEval(
      { sessions, findings: [{ sessionId: "s", ruleId: "r", window: { startIndex: 29, endIndex: 30 } }] },
      base
    );
    expect(outside.perFinding?.overall.matched).toBe(0);
  });

  it("matches ONE-TO-ONE: a duplicated finding cannot score twice off one ground truth", () => {
    const base: MlGroundTruth = {
      sessions: [{ sessionId: "s", label: "warning", clean: false }],
      findings: [{ sessionId: "s", ruleId: "r", window: { startIndex: 10, endIndex: 20 } }],
    };
    const dup = runMlEval(
      {
        sessions: [{ sessionId: "s", flagged: true, findingCount: 4 }],
        findings: [
          { sessionId: "s", ruleId: "r", window: { startIndex: 12, endIndex: 18 } },
          { sessionId: "s", ruleId: "r", window: { startIndex: 12, endIndex: 18 } },
          { sessionId: "s", ruleId: "r", window: { startIndex: 12, endIndex: 18 } },
          { sessionId: "s", ruleId: "r", window: { startIndex: 12, endIndex: 18 } },
        ],
      },
      base
    );
    expect(dup.perFinding?.overall).toMatchObject({
      expected: 1,
      predicted: 4,
      matched: 1,
      falsePositives: 3,
    });
  });

  it("does not match a finding across sessions", () => {
    const base: MlGroundTruth = {
      sessions: [
        { sessionId: "a", label: "warning", clean: false },
        { sessionId: "b", label: "warning", clean: false },
      ],
      findings: [{ sessionId: "a", ruleId: "r", window: { startIndex: 10, endIndex: 20 } }],
    };
    const crossed = runMlEval(
      {
        sessions: [
          { sessionId: "a", flagged: false, findingCount: 0 },
          { sessionId: "b", flagged: true, findingCount: 1 },
        ],
        findings: [{ sessionId: "b", ruleId: "r", window: { startIndex: 10, endIndex: 20 } }],
      },
      base
    );
    expect(crossed.perFinding?.overall).toMatchObject({ matched: 0, falseNegatives: 1, falsePositives: 1 });
  });

  it("returns perFinding: null (and says so) when no finding-level predictions are supplied", () => {
    const report2 = runMlEval({ sessions: predictions.sessions }, truth);
    expect(report2.perFinding).toBeNull();
    expect(report2.limitations.map((l) => l.code)).toContain("per-finding-not-scored");
  });
});

describe("runMlEval — 'n too small ⇒ raw counts, not a rate'", () => {
  /** A rule with `n` ground-truth instances, every one of them correctly found. */
  function allHit(ruleId: string, n: number): { truth: MlGroundTruth; predictions: MlPredictions } {
    const findings = Array.from({ length: n }, (_, i) => ({
      sessionId: "s",
      ruleId,
      window: { startIndex: i * 100, endIndex: i * 100 + 10 },
    }));
    return {
      truth: {
        sessions: [{ sessionId: "s", label: "warning", clean: false }],
        findings,
      },
      predictions: {
        sessions: [{ sessionId: "s", flagged: true, findingCount: n }],
        findings,
      },
    };
  }

  it("reports a RATE at exactly the 20-instance bar", () => {
    const { truth, predictions } = allHit("big", MIN_INSTANCES_FOR_FINDING_RATE);
    const rule = runMlEval(predictions, truth).perFinding?.byRule[0];
    expect(rule?.recall.kind).toBe("rate");
    expect(rule?.recall).toMatchObject({ kind: "rate", value: 1, denominator: 20 });
  });

  it("reports RAW COUNTS one instance below the bar — and there is no `value` to misread", () => {
    const { truth, predictions } = allHit("small", MIN_INSTANCES_FOR_FINDING_RATE - 1);
    const rule = runMlEval(predictions, truth).perFinding?.byRule[0];
    expect(rule?.recall).toEqual({
      kind: "count",
      numerator: 19,
      denominator: 19,
      minimumDenominator: 20,
    });
    expect(rule?.recall).not.toHaveProperty("value");
  });

  it("fires on the real corpus for snr-noise, tx-power-saturation and packet-instability — and NOT for lq-collapse/rssi-floor", () => {
    const artifact = characterizeBaselines(FIXTURES, MANIFEST.version);
    const report = artifact.wholeCorpus.baselines[BASELINE_RULE_ENGINE];
    const byRule = Object.fromEntries(
      (report.perFinding?.byRule ?? []).map((r) => [r.ruleId, r])
    );

    for (const ruleId of ["snr-noise", "tx-power-saturation", "packet-instability"]) {
      expect(byRule[ruleId].recall.kind, ruleId).toBe("count");
      expect(byRule[ruleId].precision.kind, ruleId).toBe("count");
      expect(byRule[ruleId].recall).not.toHaveProperty("value");
    }
    for (const ruleId of ["lq-collapse", "rssi-floor"]) {
      expect(byRule[ruleId].recall.kind, ruleId).toBe("rate");
      expect(byRule[ruleId].precision.kind, ruleId).toBe("rate");
    }

    const tooSmall = report.limitations
      .filter((l) => l.code === "per-finding-rule-n-too-small")
      .map((l) => l.label)
      .sort();
    expect(tooSmall).toEqual(["packet-instability", "snr-noise", "tx-power-saturation"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Lead-time math — hand-built offsets, median worked out by hand
// ---------------------------------------------------------------------------

describe("runMlEval — lead-time math", () => {
  const sessions = ["s1", "s2", "s3", "s4", "s5"].map((sessionId) => ({
    sessionId,
    flagged: true,
    findingCount: 1,
  }));
  const truth: MlGroundTruth = {
    sessions: sessions.map((s) => ({ sessionId: s.sessionId, label: "failsafe" as const, clean: false })),
    findings: [],
  };

  // s1: onset 10000, warned at 8000       ⇒ predicted, lead 2000
  // s2: onset  5000, warned at 4000       ⇒ predicted, lead 1000
  // s3: onset  3000, warned at 3500       ⇒ LATE (a report, not a prediction), lead −500
  // s4: onset  7000, never warned         ⇒ missed, lead null
  // s5: onset  9000, warned at 6000, 8500 ⇒ predicted from the EARLIEST: lead 3000
  // leads = [1000, 2000, 3000] ⇒ median 2000, p25 1500, p75 2500.
  const leadTime = {
    predictions: [
      { sessionId: "s1", tMs: 8000 },
      { sessionId: "s2", tMs: 4000 },
      { sessionId: "s3", tMs: 3500 },
      { sessionId: "s5", tMs: 8500 },
      { sessionId: "s5", tMs: 6000 },
    ],
    events: [
      { sessionId: "s1", onsetMs: 10000 },
      { sessionId: "s2", onsetMs: 5000 },
      { sessionId: "s3", onsetMs: 3000 },
      { sessionId: "s4", onsetMs: 7000 },
      { sessionId: "s5", onsetMs: 9000 },
    ],
  };
  const report = runMlEval({ sessions, leadTime }, truth);
  const lt = report.leadTime;

  it("classifies every event as predicted / late / missed", () => {
    expect(lt?.eventCount).toBe(5);
    expect(lt?.predictedCount).toBe(3);
    expect(lt?.lateCount).toBe(1);
    expect(lt?.missedCount).toBe(1);
    const byId = Object.fromEntries((lt?.cases ?? []).map((c) => [c.sessionId, c]));
    expect(byId.s1).toMatchObject({ outcome: "predicted", leadMs: 2000 });
    expect(byId.s2).toMatchObject({ outcome: "predicted", leadMs: 1000 });
    expect(byId.s5).toMatchObject({ outcome: "predicted", leadMs: 3000 });
    expect(byId.s3).toMatchObject({ outcome: "late", leadMs: -500 });
    expect(byId.s4).toMatchObject({ outcome: "missed", leadMs: null });
  });

  it("a LATE warning is a MISS, not a 0 ms lead — it is excluded from the distribution", () => {
    // Median over [1000, 2000, 3000] — the late −500 and the missing s4 are NOT in it.
    expect(lt?.medianLeadMs).toBe(2000);
    expect(lt?.minLeadMs).toBe(1000);
    expect(lt?.maxLeadMs).toBe(3000);
    expect(lt?.p25LeadMs).toBe(1500);
    expect(lt?.p75LeadMs).toBe(2500);
  });

  it("reports coverage so a median over the events you caught cannot pose as a lead time", () => {
    expect(lt?.coverage).toBe(0.6);
    expect(report.limitations.map((l) => l.code)).toContain("lead-time-coverage-incomplete");
  });

  it("scores the target against the median (2000 >= 2000)", () => {
    expect(lt?.targetMs).toBe(PREDICTIVE_LEAD_TIME_TARGET_MS);
    expect(lt?.meetsTargetMedian).toBe(true);
  });

  it("fails closed when nothing was predicted: no median, target not met", () => {
    const none = runMlEval(
      { sessions, leadTime: { predictions: [], events: leadTime.events } },
      truth
    );
    expect(none.leadTime).toMatchObject({
      eventCount: 5,
      predictedCount: 0,
      lateCount: 0,
      missedCount: 5,
      coverage: 0,
      medianLeadMs: null,
      meetsTargetMedian: false,
    });
    expect(none.limitations.map((l) => l.code)).toContain("lead-time-no-predictions");
  });

  it("uses an even-n median (the mean of the two middle leads)", () => {
    const even = runMlEval(
      {
        sessions,
        leadTime: {
          events: [
            { sessionId: "s1", onsetMs: 1000 },
            { sessionId: "s2", onsetMs: 1000 },
            { sessionId: "s3", onsetMs: 1000 },
            { sessionId: "s4", onsetMs: 1000 },
          ],
          // leads 100, 200, 300, 400 ⇒ median (200 + 300) / 2 = 250.
          predictions: [
            { sessionId: "s1", tMs: 900 },
            { sessionId: "s2", tMs: 800 },
            { sessionId: "s3", tMs: 700 },
            { sessionId: "s4", tMs: 600 },
          ],
        },
      },
      truth
    );
    expect(even.leadTime?.medianLeadMs).toBe(250);
  });

  it("credits a multi-event session's warning to the NEXT event it precedes", () => {
    const multi = runMlEval(
      {
        sessions: [{ sessionId: "m", flagged: true, findingCount: 2 }],
        leadTime: {
          events: [
            { sessionId: "m", onsetMs: 1000 },
            { sessionId: "m", onsetMs: 5000 },
          ],
          predictions: [
            { sessionId: "m", tMs: 900 }, // 100 ms before event 1
            { sessionId: "m", tMs: 1200 }, // in event 1's aftermath
          ],
        },
      },
      { sessions: [{ sessionId: "m", label: "failsafe", clean: false }], findings: [] }
    );
    // With no horizon, the 1200 ms warning is the nearest one preceding event 2 and is
    // credited with a 3800 ms "lead" it plainly never had — the pathology `horizonMs`
    // exists to bound.
    expect(multi.leadTime?.cases.map((c) => c.leadMs)).toEqual([100, 3800]);
  });

  it("a horizon makes a stale warning uncreditable instead of a fake 3800 ms lead", () => {
    const bounded = runMlEval(
      {
        sessions: [{ sessionId: "m", flagged: true, findingCount: 2 }],
        leadTime: {
          events: [
            { sessionId: "m", onsetMs: 1000 },
            { sessionId: "m", onsetMs: 5000 },
          ],
          predictions: [
            { sessionId: "m", tMs: 900 },
            { sessionId: "m", tMs: 1200 },
          ],
        },
      },
      { sessions: [{ sessionId: "m", label: "failsafe", clean: false }], findings: [] },
      { leadTimeHorizonMs: 500 }
    );
    expect(bounded.leadTime?.horizonMs).toBe(500);
    expect(bounded.leadTime?.cases).toEqual([
      { sessionId: "m", onsetMs: 1000, outcome: "predicted", leadMs: 100 },
      { sessionId: "m", onsetMs: 5000, outcome: "missed", leadMs: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. The frozen artifact — anti-drift
// ---------------------------------------------------------------------------

describe("the frozen baseline artifact (data/ml/baseline-v20.json)", () => {
  const artifactPath = path.join(REPO_ROOT, BASELINE_METRICS_ARTIFACT);
  const committedText = readFileSync(artifactPath, "utf8");
  const committed = JSON.parse(committedText) as BaselineArtifact;
  const rederived = characterizeBaselines(FIXTURES, MANIFEST.version);

  it("lives at the path mlConsts.ts names", () => {
    expect(BASELINE_METRICS_ARTIFACT).toBe("data/ml/baseline-v20.json");
    expect(committed.schemaVersion).toBe(BASELINE_ARTIFACT_SCHEMA_VERSION);
  });

  it("still reproduces EXACTLY from the fixtures — change a rule or a fixture and re-freeze deliberately", () => {
    // Deep-equal on the parsed object AND byte-equal on the serialized form: the second
    // catches key-order/formatting drift the first would happily ignore.
    expect(rederived).toEqual(committed);
    expect(serializeBaselineArtifact(rederived)).toBe(committedText);
  });

  it("is deterministic: characterizing twice yields a byte-identical artifact (no clock, no RNG)", () => {
    expect(serializeBaselineArtifact(characterizeBaselines(FIXTURES, MANIFEST.version))).toBe(
      serializeBaselineArtifact(rederived)
    );
  });

  it("stamps NO clock — provenance is the corpus fingerprint, so the file cannot churn", () => {
    // Checked structurally (over the KEYS), not by scanning the text: the prose in
    // `scoring.leadTime.rationale` legitimately uses the word "timestamp" to explain why
    // the baselines have no emission time, and a text scan would flag its own explanation.
    const keys: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const v of node) walk(v);
      } else if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          keys.push(k);
          walk(v);
        }
      }
    };
    walk(committed);
    for (const k of keys) {
      expect(k, `artifact carries a clock-shaped key: ${k}`).not.toMatch(
        /timestamp|generatedat|createdat|^date$|^time$|^now$/i
      );
    }
  });

  it("pins the corpus fingerprint — a fixture edit invalidates it even if the metrics land the same", () => {
    expect(committed.corpus.fingerprint).toBe(fingerprintCorpus(FIXTURES));
    expect(committed.corpus.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(committed.corpus.manifestVersion).toBe(MANIFEST.version);
    expect(committed.corpus.sessionCount).toBe(36);

    // A single flipped link-quality sample must move the fingerprint.
    const tampered: BaselineFixture[] = FIXTURES.map((fx, i) => {
      if (i !== 0) return fx;
      const channels = fx.log.channels.map((ch, j) =>
        j === 0 ? { ...ch, values: [...ch.values.slice(0, -1), 12345] } : ch
      );
      return { ...fx, log: { ...fx.log, channels } };
    });
    expect(fingerprintCorpus(tampered)).not.toBe(committed.corpus.fingerprint);
  });

  it("does not depend on the order the corpus was loaded in", () => {
    const reversed = [...FIXTURES].reverse();
    expect(fingerprintCorpus(reversed)).toBe(fingerprintCorpus(FIXTURES));
    expect(characterizeBaselines(reversed, MANIFEST.version)).toEqual(rederived);
  });

  it("carries its own honesty header — the reader never has to go and find the context", () => {
    expect(committed.honesty.corpusSessions).toBe(36);
    expect(committed.honesty.d21RequiredSessionsPerClass).toBe(300);
    expect(committed.honesty.d21Met).toBe(false);
    expect(committed.honesty.healthySessions).toBe(12);
    expect(committed.honesty.fpRateQuantumPp).toBe(8.3);
    expect(committed.honesty.indicativeNotAGatePass).toBe(true);
    expect(committed.honesty.baselineHeldOutFromCorpus).toBe(false);
    expect(committed.honesty.notes.length).toBeGreaterThanOrEqual(5);
  });

  it("carries zero identifiers: numbers, rule ids, and corpus-local fixture filenames only", () => {
    // No coordinates, MACs, IPs, emails, UIDs, serials, or binding phrases — anywhere.
    expect(committedText).not.toMatch(
      /\b(?:lat|lon|lng|latitude|longitude|gps|coord|mac|ipv4|email|uid|serial|bindingPhrase)\b/i
    );
    expect(committedText).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/); // dotted-quad IP
    expect(committedText).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/); // email
    // Every sessionId is a manifest fixture path and nothing else.
    const known = new Set(FIXTURES.map((f) => f.file));
    for (const partition of [committed.wholeCorpus, committed.heldOutTestSplit]) {
      for (const report of Object.values(partition.baselines)) {
        for (const c of report.cases) expect(known.has(c.sessionId)).toBe(true);
        for (const c of report.leadTime?.cases ?? []) expect(known.has(c.sessionId)).toBe(true);
      }
    }
  });

  it("is not a gate pass, and every report in it says so", () => {
    for (const partition of [committed.wholeCorpus, committed.heldOutTestSplit]) {
      for (const report of Object.values(partition.baselines)) {
        expect(report.gateEvaluated).toBe(false);
        expect(report.passes).toBe(false);
        expect(report.limitations.map((l) => l.code)).toContain("gate-not-evaluated");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The measured numbers, pinned — including the bad news
// ---------------------------------------------------------------------------

describe("baseline A — the v2.0 rule engine (evaluateSession, default config)", () => {
  const artifact = characterizeBaselines(FIXTURES, MANIFEST.version);
  const report = artifact.wholeCorpus.baselines[BASELINE_RULE_ENGINE];

  it("is PERFECT at per-session granularity: 24 TP / 0 FP / 12 TN / 0 FN", () => {
    expect(report.perSession.counts).toEqual({
      truePositives: 24,
      falsePositives: 0,
      trueNegatives: 12,
      falseNegatives: 0,
    });
    expect(report.perSession.precision.value).toBe(1);
    expect(report.perSession.recall.value).toBe(1);
    expect(report.perSession.falsePositiveRate.value).toBe(0);
  });

  it("raises ZERO findings on all 12 healthy fixtures — not merely zero warnings", () => {
    const healthy = report.cases.filter((c) => c.label === "healthy");
    expect(healthy).toHaveLength(12);
    for (const c of healthy) {
      expect(c.flagged, c.sessionId).toBe(false);
      expect(c.findingCount, c.sessionId).toBe(0);
    }
  });

  it("is PERFECT at per-finding granularity too: 67/67 matched, zero spurious findings", () => {
    expect(report.perFinding?.overall).toMatchObject({
      expected: 67,
      predicted: 67,
      matched: 67,
      falseNegatives: 0,
      falsePositives: 0,
    });
  });

  it("the corpus is NOT held out from it — the perfect score is a CEILING, not an estimate", () => {
    // The fixtures were authored alongside these rules, and manifest-acceptance.test.ts
    // asserts the engine reproduces them. A detector scored on its own labelling set
    // cannot be over-fitted; it can only be tautological. Stated in the artifact, and
    // pinned here so nobody quotes 1.00/1.00/0.00 as field performance.
    expect(artifact.honesty.baselineHeldOutFromCorpus).toBe(false);
  });

  it("its FP rate of 0 makes D25's strict '<' ceiling UNCLEARABLE — no model can go below zero", () => {
    expect(artifact.gateBaseline.baselineFpRate).toBe(0);
    expect(artifact.gateBaseline.fpCeilingClearable).toBe(false);
    // A hypothetical flawless model — 0 % FP, 100 % recall — still fails the gate.
    expect(
      clearsM56Gate({ modelFpRate: 0, modelRecall: 1 }, artifact.gateBaseline)
    ).toBe(false);
    expect(report.limitations.map((l) => l.code)).toContain("fp-ceiling-unclearable");
  });

  it("quantises: 12 healthy sessions ⇒ the FP rate can only move in 8.3-point steps", () => {
    expect(report.perSession.fpRateQuantumPp).toBeCloseTo(100 / 12, 5);
    const quantised = report.limitations.find((l) => l.code === "fp-rate-quantised");
    expect(quantised?.detail.negativeSessions).toBe(12);
  });
});

describe("baseline B — the M15 anomaly heuristic (detectAnomalies, default config)", () => {
  const artifact = characterizeBaselines(FIXTURES, MANIFEST.version);
  const report = artifact.wholeCorpus.baselines[BASELINE_ANOMALY_HEURISTIC];

  it("scores 20 TP / 0 FP / 12 TN / 4 FN ⇒ precision 1.00, recall 0.833, FP rate 0.00", () => {
    expect(report.perSession.counts).toEqual({
      truePositives: 20,
      falsePositives: 0,
      trueNegatives: 12,
      falseNegatives: 4,
    });
    expect(report.perSession.precision.value).toBe(1);
    expect(report.perSession.recall.value).toBeCloseTo(20 / 24, 6);
    expect(report.perSession.falsePositiveRate.value).toBe(0);
  });

  it("misses exactly the four warning fixtures its vocabulary cannot express", () => {
    // anomaly.ts has NO SNR detector and NO packet-rate detector, and txPowerChange fires
    // on a CHANGE, so a session pinned at max power produces nothing. Those four gaps are
    // the whole of its recall shortfall — it is blind, not wrong.
    const missed = report.cases
      .filter((c) => c.outcome === "falseNegative")
      .map((c) => c.sessionId)
      .sort();
    expect(missed).toEqual([
      "warning/warning-mixed-05.csv",
      "warning/warning-packet-jitter-03.csv",
      "warning/warning-snr-noise-02.csv",
      "warning/warning-tx-saturation-06.csv",
    ]);
  });

  it("is NOT scored per-finding — its AnomalyType vocabulary is not the rule vocabulary", () => {
    expect(report.perFinding).toBeNull();
    expect(report.limitations.map((l) => l.code)).toContain("per-finding-not-scored");
    expect(artifact.scoring.perFindingScoredFor).toEqual([BASELINE_RULE_ENGINE]);
    expect(artifact.scoring.perFindingOmittedFor).toEqual([BASELINE_ANOMALY_HEURISTIC]);
    expect(artifact.scoring.perFindingOmissionReason.length).toBeGreaterThan(100);
  });
});

describe("lead time on the real corpus — the baselines are detectors, not predictors", () => {
  const artifact = characterizeBaselines(FIXTURES, MANIFEST.version);

  it("derives 17 failsafe onsets using the app's OWN failsafe definition", () => {
    expect(FAILSAFE_ONSET_RULE.minConsecutiveSamples).toBe(2);
    const events = buildEventOnsets(FIXTURES);
    expect(events).toHaveLength(17);
    expect(artifact.corpus.failsafeEventCount).toBe(17);

    // Onsets occur ONLY in the classes whose link actually dies.
    const classesWithEvents = new Set(
      FIXTURES.filter((f) => findFailsafeOnsetIndices(f.log).length > 0).map((f) => f.label)
    );
    expect([...classesWithEvents].sort()).toEqual(["failsafe", "wiring"]);
  });

  it("scores both baselines with ZERO predictions: neither has an emission timestamp", () => {
    for (const id of [BASELINE_RULE_ENGINE, BASELINE_ANOMALY_HEURISTIC]) {
      const lt = artifact.wholeCorpus.baselines[id].leadTime;
      expect(lt?.eventCount, id).toBe(17);
      expect(lt?.predictedCount, id).toBe(0);
      expect(lt?.missedCount, id).toBe(17);
      expect(lt?.medianLeadMs, id).toBeNull();
      expect(lt?.meetsTargetMedian, id).toBe(false);
    }
    expect(artifact.scoring.leadTime.baselinePredictionCount).toBe(0);
    expect(artifact.scoring.leadTime.targetMs).toBe(PREDICTIVE_LEAD_TIME_TARGET_MS);
  });
});

describe("the held-out test split — the partition D25's rule literally names", () => {
  const artifact = characterizeBaselines(FIXTURES, MANIFEST.version);

  it("is 9 sessions with only 3 healthy negatives ⇒ a 33.3-point FP quantum", () => {
    expect(artifact.heldOutTestSplit.sessionCount).toBe(9);
    expect(artifact.heldOutTestSplit.negativeSessions).toBe(3);
    expect(artifact.heldOutTestSplit.positiveSessions).toBe(6);
    const ps = artifact.heldOutTestSplit.baselines[BASELINE_RULE_ENGINE].perSession;
    expect(ps.fpRateQuantumPp).toBeCloseTo(100 / 3, 4);
  });

  it("gives the gate the same verdict as the whole corpus does: FP 0, recall 1, unclearable", () => {
    expect(artifact.gateBaseline).toMatchObject({
      baselineId: BASELINE_RULE_ENGINE,
      granularity: "per-session",
      split: "test",
      baselineFpRate: 0,
      baselineRecall: 1,
      fpCeilingClearable: false,
    });
  });
});
