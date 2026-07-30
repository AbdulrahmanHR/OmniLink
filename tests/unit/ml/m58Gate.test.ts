/**
 * M58 — the gate, and the honest record of what it returned.
 *
 * **This test exists to make a failure permanent.** The M58 model does not clear the M56
 * gate; `clearsM56Gate()` returns `false`. Everything below asserts that outcome AND the
 * structural reason for it, so that a later commit which "fixes" the model into a pass has
 * to turn these assertions red on its way through. If someone weakens `clearsFpCeiling`'s
 * strict `<` to a `<=`, relaxes the tolerance band, swaps the comparison baseline, or
 * re-freezes `baseline-v20.json` to a non-zero FP rate, this file goes red and names what
 * they did.
 *
 * ## The reason, stated once
 * D25's FP ceiling is **strictly below** the measured v2.0 baseline. The measured v2.0
 * baseline FP rate on the held-out test split is **0.000** — it was measured on a corpus
 * the v2.0 rules were *authored against*, so the 1.00/1.00/0.00 is a ceiling, not field
 * performance. Nothing is strictly below zero. The gate is therefore unsatisfiable by
 * construction: not by this model, not by a flawless oracle (which
 * `tests/unit/ml/baseline.test.ts` already asserts fails it too).
 *
 * A model that "wins" here would be a bug in the gate, not a win.
 *
 * Structure mirrors `baseline.test.ts`: (1) the frozen artifacts still reproduce from the
 * fixtures; (2) the gate's verdict, pinned; (3) the measured numbers, pinned — including
 * the ones that are bad news; (4) the early-warning branch, measured and disbelieved.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASELINE_METRICS_ARTIFACT,
  clearsFpCeiling,
  clearsM56Gate,
  clearsRecallFloor,
  DEFAULT_SEED,
  evaluateAnomalyModel,
  FP_CEILING_RULE,
  fpRateQuantumPp,
  MIN_RECALL_RULE,
  serializeAnomalyModel,
  serializeModelEvalArtifact,
  type BaselineArtifact,
  type BaselineFixture,
  type ModelEvalArtifact,
} from "@/lib/ml";
import { loadAllFixtures, loadManifest } from "../diagnostics/fixtures";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

const MODEL_ARTIFACT = "data/ml/model-m58.json";
const MODEL_EVAL_ARTIFACT = "data/ml/model-eval-m58.json";

const MANIFEST = loadManifest();
const FIXTURES: BaselineFixture[] = loadAllFixtures();

const BASELINE = JSON.parse(
  readFileSync(path.join(REPO_ROOT, BASELINE_METRICS_ARTIFACT), "utf8")
) as BaselineArtifact;

/** Re-derived from the fixtures — the same call `scripts/build-ml-model.ts` makes. */
const { artifact: REDERIVED, model: MODEL } = evaluateAnomalyModel(
  FIXTURES,
  MANIFEST.version,
  BASELINE
);

// ---------------------------------------------------------------------------
// 1. THE VERDICT
// ---------------------------------------------------------------------------

describe("M58 — THE GATE VERDICT", () => {
  it("DOES NOT CLEAR THE M56 GATE: clearsM56Gate() returned false", () => {
    const held = REDERIVED.heldOutTestSplit;

    expect(held.passes).toBe(false);
    expect(held.model.gateEvaluated).toBe(true); // The gate RAN. It ran, and it failed.
    expect(held.model.passes).toBe(false);
    expect(REDERIVED.honesty.clearedM56Gate).toBe(false);

    // …and it is the SAME boolean, from the SAME predicate, on the SAME numbers.
    expect(
      clearsM56Gate(
        {
          modelFpRate: held.model.perSession.falsePositiveRate.value,
          modelRecall: held.model.perSession.recall.value,
        },
        held.gateBaseline
      )
    ).toBe(false);
  });

  it("fails because the ceiling is UNCLEARABLE, not merely because this model missed it", () => {
    expect(REDERIVED.honesty.fpCeilingClearable).toBe(false);
    expect(BASELINE.gateBaseline.fpCeilingClearable).toBe(false);
    expect(BASELINE.gateBaseline.baselineFpRate).toBe(0);

    // Nothing is strictly below zero. Not this model's 0.333, not a perfect 0.000.
    expect(clearsFpCeiling(0, 0)).toBe(false);
    expect(clearsM56Gate({ modelFpRate: 0, modelRecall: 1 }, BASELINE.gateBaseline)).toBe(false);
  });

  it("the gate is D25's, unmodified: strict '<' on FP, '>=' on recall, ZERO tolerance band", () => {
    // If a later commit loosens any of this to make the model "pass", it lands here first.
    expect(FP_CEILING_RULE.comparator).toBe("<");
    expect(FP_CEILING_RULE.toleranceBandPp).toBe(0);
    expect(FP_CEILING_RULE.heldOutSplit).toBe("test");
    expect(MIN_RECALL_RULE.comparator).toBe(">=");
    expect(MIN_RECALL_RULE.toleranceBandPp).toBe(0);

    expect(clearsFpCeiling(0.1, 0.2)).toBe(true);
    expect(clearsFpCeiling(0.2, 0.2)).toBe(false); // a tie FAILS
    expect(clearsRecallFloor(0.2, 0.2)).toBe(true); // a tie PASSES
  });

  it("is scored on the split D25 NAMES — the held-out test split, not the whole corpus", () => {
    expect(REDERIVED.heldOutTestSplit.sessionCount).toBe(9);
    expect(REDERIVED.heldOutTestSplit.negativeSessions).toBe(3);
    expect(REDERIVED.corpus.split.seed).toBe(DEFAULT_SEED);
    expect(REDERIVED.corpus.split).toMatchObject({ train: 21, val: 6, test: 9 });

    // The model's held-out partition is the SAME 9 sessions the baseline was measured on.
    const baselineIds = BASELINE.heldOutTestSplit.baselines["v20-rule-engine"].cases
      .map((c) => c.sessionId)
      .sort();
    const modelIds = REDERIVED.heldOutTestSplit.model.cases.map((c) => c.sessionId).sort();
    expect(modelIds).toEqual(baselineIds);
  });
});

// ---------------------------------------------------------------------------
// 2. The measured numbers, pinned — including the bad news
// ---------------------------------------------------------------------------

describe("M58 — the model's numbers (it is WORSE than the rule engine on every axis)", () => {
  it("held-out test split (n=9, 3 negatives): precision 0.75, recall 0.500, FP 0.333", () => {
    const ps = REDERIVED.heldOutTestSplit.model.perSession;
    expect(ps.counts).toEqual({
      truePositives: 3,
      falsePositives: 1,
      trueNegatives: 2,
      falseNegatives: 3,
    });
    expect(ps.precision.value).toBe(0.75);
    expect(ps.recall.value).toBe(0.5);
    expect(ps.falsePositiveRate.value).toBeCloseTo(1 / 3, 5);

    // The baseline, on the SAME 9 sessions: 1.000 / 1.000 / 0.000. The model loses on all
    // three, and it is not close.
    expect(REDERIVED.heldOutTestSplit.gateBaseline).toEqual({
      baselineFpRate: 0,
      baselineRecall: 1,
    });
  });

  it("whole corpus (n=36, 12 negatives): precision 0.889, recall 0.667, FP 0.167", () => {
    const ps = REDERIVED.wholeCorpus.model.perSession;
    expect(ps.counts).toEqual({
      truePositives: 16,
      falsePositives: 2,
      trueNegatives: 10,
      falseNegatives: 8,
    });
    expect(ps.recall.value).toBeCloseTo(16 / 24, 5);
    expect(ps.falsePositiveRate.value).toBeCloseTo(2 / 12, 5);
    // The whole corpus is gated against the WHOLE-CORPUS baseline — same set, same
    // denominators. It fails there too.
    expect(REDERIVED.wholeCorpus.passes).toBe(false);
  });

  it("every rate carries its quantum: 33.3 pp on the test split, 8.3 pp on the corpus", () => {
    expect(REDERIVED.heldOutTestSplit.fpRateQuantumPp).toBeCloseTo(fpRateQuantumPp(3), 5);
    expect(REDERIVED.heldOutTestSplit.fpRateQuantumPp).toBeCloseTo(100 / 3, 4);
    expect(REDERIVED.wholeCorpus.fpRateQuantumPp).toBeCloseTo(100 / 12, 4);
    // A "false-positive rate" over 3 negatives can only be 0/3, 1/3, 2/3 or 3/3. It is not
    // a measurement, and the report says so out loud rather than in a footnote.
    expect(REDERIVED.heldOutTestSplit.model.limitations.map((l) => l.code)).toContain(
      "fp-rate-quantised"
    );
    expect(REDERIVED.heldOutTestSplit.model.limitations.map((l) => l.code)).toContain(
      "class-below-d21-minimum"
    );
  });

  it("is NOT scored per-finding: one session-level score is not five rule ids", () => {
    expect(REDERIVED.heldOutTestSplit.model.perFinding).toBeNull();
    expect(REDERIVED.heldOutTestSplit.model.limitations.map((l) => l.code)).toContain(
      "per-finding-not-scored"
    );
  });

  it("was fit to SEVEN healthy sessions, and is blind along 20 of its 43 features", () => {
    expect(REDERIVED.honesty.trainingRows).toBe(7);
    expect(REDERIVED.honesty.d21Met).toBe(false);
    expect(REDERIVED.model.training.splittableFeatureCount).toBe(23);
    expect(REDERIVED.model.training.constantFeatures).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// 3. Not a strawman — the sensitivity probe
// ---------------------------------------------------------------------------

describe("M58 — the weak result is the CORPUS, not a badly-configured forest", () => {
  const cells = REDERIVED.sensitivity.cells;
  const shipped = cells.find((c) => c.isShippedConfig)!;

  it("scores its grid on train + val ONLY — the test split is never in it", () => {
    expect(REDERIVED.sensitivity.scoredOnSessions).toBe(27); // 21 train + 6 val
    expect(cells).toHaveLength(4);
    expect(cells.filter((c) => c.isShippedConfig)).toHaveLength(1);
  });

  it("the shipped configuration is Liu et al.'s reference — and it is the BEST cell in the grid", () => {
    expect(shipped.trees).toBe(100);
    expect(shipped.heightLimit).toBe(3);
    for (const cell of cells) {
      expect(cell.aucTrainVal, `trees=${cell.trees} hl=${cell.heightLimit}`).toBeLessThanOrEqual(
        shipped.aucTrainVal
      );
    }
  });

  it("a BIGGER forest — a more accurate score estimator — separates the classes WORSE", () => {
    // The tell. At 1000 trees the expected path length is estimated far more precisely, and
    // the separation collapses: the 100-tree model's apparent performance is substantially
    // Monte-Carlo noise. You cannot fix that with hyperparameters. You fix it with data.
    const shippedDeeper = cells.find((c) => c.trees === 1000 && c.heightLimit === 3)!;
    expect(shippedDeeper.aucTrainVal).toBeLessThan(shipped.aucTrainVal);
    expect(shippedDeeper.recallTrainVal).toBeLessThan(shipped.recallTrainVal);
  });

  it("and no cell in the grid comes anywhere near the rule engine's 1.00 / 1.00 / 0.00", () => {
    for (const cell of cells) {
      expect(cell.recallTrainVal).toBeLessThan(1);
      expect(cell.fpRateTrainVal).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The "earlier useful warnings" branch — measured, and NOT believed
// ---------------------------------------------------------------------------

describe("M58 — the second acceptance branch (earlier warnings, FP not raised)", () => {
  const ew = REDERIVED.earlyWarning;

  it("IS NOT MET", () => {
    expect(ew.branchMet).toBe(false);
  });

  it("fails the FP half outright: the model flags 6 of the 12 HEALTHY sessions at some prefix", () => {
    // The branch says "without raising FP above the ceiling". The ceiling is 0.
    expect(ew.model.healthyFlaggedAtSomePrefix).toBe(6);
    expect(ew.ruleEngine.healthyFlaggedAtSomePrefix).toBe(0);
  });

  it("and its early verdicts CONTRADICT its own final ones on a third of the corpus", () => {
    // 12 sessions where the model warned at some prefix and then, given MORE data, withdrew
    // the warning. A detector that contradicts itself is not warning early; it is
    // oscillating across its threshold. Any "lead time" read off that is an artifact of the
    // sampling grid, not a prediction. The rule engine never does this.
    expect(ew.model.flaggedAtPrefixButNotOnFullSession).toBe(12);
    expect(ew.ruleEngine.flaggedAtPrefixButNotOnFullSession).toBe(0);
  });

  it("gives BOTH detectors the same protocol — the baseline is not held to zero predictions", () => {
    expect(ew.protocol.strideSamples).toBe(5);
    expect(ew.protocol.strideMs).toBe(200);
    expect(ew.eventCount).toBe(17);
    // Both are replayed over the same prefixes of the same sessions.
    expect(ew.model.leadTimeBounded?.eventCount).toBe(17);
    expect(ew.ruleEngine.leadTimeBounded?.eventCount).toBe(17);
  });

  it("neither detector comes close to the 2000 ms product target for MEDIAN lead", () => {
    expect(ew.model.leadTimeBounded?.meetsTargetMedian).toBe(false);
    expect(ew.ruleEngine.leadTimeBounded?.meetsTargetMedian).toBe(false);
    // Coverage first, median second: a median over the 2 events out of 17 you happened to
    // catch is not a lead time.
    expect(ew.model.leadTimeBounded?.coverage ?? 1).toBeLessThan(0.2);
  });

  it("states its caveats in the artifact rather than in a changelog nobody reads", () => {
    expect(ew.caveats.length).toBeGreaterThanOrEqual(5);
    expect(ew.caveats[0]).toMatch(/BRANCH NOT MET/);
  });
});

// ---------------------------------------------------------------------------
// 5. The frozen artifacts — anti-drift
// ---------------------------------------------------------------------------

describe("the frozen M58 artifacts", () => {
  const modelText = readFileSync(path.join(REPO_ROOT, MODEL_ARTIFACT), "utf8");
  const evalText = readFileSync(path.join(REPO_ROOT, MODEL_EVAL_ARTIFACT), "utf8");
  const committedEval = JSON.parse(evalText) as ModelEvalArtifact;

  it("both still reproduce EXACTLY from the fixtures — re-freeze deliberately, via npm run build:ml-model", () => {
    expect(serializeAnomalyModel(MODEL)).toBe(modelText);
    expect(JSON.parse(evalText)).toEqual(REDERIVED);
    expect(serializeModelEvalArtifact(REDERIVED)).toBe(evalText);
  });

  it("is deterministic: re-deriving twice yields byte-identical bytes (no clock, one seed)", () => {
    const again = evaluateAnomalyModel(FIXTURES, MANIFEST.version, BASELINE);
    expect(serializeModelEvalArtifact(again.artifact)).toBe(serializeModelEvalArtifact(REDERIVED));
    expect(serializeAnomalyModel(again.model)).toBe(serializeAnomalyModel(MODEL));
  });

  it("does not depend on the order the corpus was loaded in", () => {
    const reversed = [...FIXTURES].reverse();
    const out = evaluateAnomalyModel(reversed, MANIFEST.version, BASELINE);
    expect(out.artifact).toEqual(REDERIVED);
  });

  it("is fingerprinted against the SAME corpus the baseline was measured on", () => {
    expect(committedEval.corpus.fingerprint).toBe(BASELINE.corpus.fingerprint);
    expect(committedEval.corpus.baselineFingerprint).toBe(BASELINE.corpus.fingerprint);
    expect(committedEval.corpus.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("carries its own honesty header, and it leads with the failure", () => {
    expect(committedEval.honesty.indicativeNotAGatePass).toBe(true);
    expect(committedEval.honesty.clearedM56Gate).toBe(false);
    expect(committedEval.honesty.fpCeilingClearable).toBe(false);
    expect(committedEval.honesty.d21Met).toBe(false);
    expect(committedEval.honesty.trainingRows).toBe(7);
    expect(committedEval.honesty.heldOutHealthySessions).toBe(3);
    expect(committedEval.honesty.notes[0]).toMatch(/DOES NOT CLEAR THE M56 GATE, AND NO MODEL CAN/);
    expect(committedEval.honesty.notes.length).toBeGreaterThanOrEqual(5);
  });

  it("stamps NO clock — provenance is the corpus fingerprint + the seed", () => {
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
    walk(committedEval);
    for (const k of keys) {
      expect(k, `artifact carries a clock-shaped key: ${k}`).not.toMatch(
        /timestamp|generatedat|createdat|^date$|^now$/i
      );
    }
  });

  it("carries zero identifiers: the trained forest is numbers, and the report is fixture keys", () => {
    // The forest — the thing that would ship in a bundle — has no strings at all beyond its
    // own ids.
    for (const fx of FIXTURES) expect(modelText.includes(fx.file), fx.file).toBe(false);
    for (const text of [modelText, evalText]) {
      expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/); // dotted-quad IP
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/); // email
    }
    // Every sessionId in the report is a manifest fixture path and nothing else.
    const known = new Set(FIXTURES.map((f) => f.file));
    for (const partition of [committedEval.heldOutTestSplit, committedEval.wholeCorpus]) {
      for (const c of partition.model.cases) expect(known.has(c.sessionId)).toBe(true);
      for (const r of partition.results) expect(known.has(r.sessionId)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. What the model learned to look at
// ---------------------------------------------------------------------------

describe("feature importance — measured against the known separability facts", () => {
  const bySubject = Object.fromEntries(
    REDERIVED.featureImportance.map((f) => [f.subject, f])
  );

  it("REPRODUCES imbalance ⇒ wiring: rssiImbalanceMean is wiring's top contributor, by far", () => {
    const wiring = bySubject.wiringSuspicion;
    expect(wiring.top[0].feature).toBe("rssiImbalanceMean");
    // …and by a wide margin over the next feature, which is a generic link-quality stat.
    expect(wiring.top[0].contribution).toBeGreaterThan(wiring.top[1].contribution * 1.4);
  });

  it("does NOT reproduce heading-spread ⇒ antenna: the antenna class's top contributors are generic LQ stats", () => {
    // A real negative result, and it is not massaged. `headingSectorRssiSpreadDb` separates
    // antenna sessions cleanly in the raw features (22.60 dB vs 2.41 healthy) — but it does
    // not appear anywhere in the model's top-5 contributors for that class. The forest cuts
    // a feature at a value drawn uniformly INSIDE the training range, so a session sitting
    // far ABOVE that range is routed into whichever training points lie above the cut — a
    // group that is not systematically small, and therefore not systematically isolating.
    // The forest sees the antenna sessions' link-quality dips instead, which is a weaker and
    // less specific signal, and grades them accordingly (it misses the one in the test split).
    const antenna = bySubject.antennaSuspicion;
    expect(antenna.top.map((c) => c.feature)).not.toContain("headingSectorRssiSpreadDb");
    expect(antenna.top[0].feature).toBe("lqP05");
  });

  it("leans overall on the link-quality and RSSI statistics — the axes it can actually cut", () => {
    const all = bySubject.allFaulty.top.map((c) => c.feature);
    expect(all[0]).toBe("lqMean");
    // Never on a feature it is structurally blind to.
    for (const f of all) {
      expect(REDERIVED.model.training.constantFeatures).not.toContain(f);
    }
  });
});
