/**
 * M58 — the anomaly-model prototype itself: determinism, leakage, output schema, privacy,
 * and explainability.
 *
 * The *scoring* half of M58 (the gate, the numbers, the frozen artifact) lives in
 * `m58Gate.test.ts`. This file is about the model as an object: does it behave like a
 * model should, and can it hurt anything?
 *
 *  1. **Determinism** — train twice with one seed ⇒ byte-identical model; infer twice ⇒
 *     identical output. Invariant #7, and the reason the gate's verdict is auditable.
 *  2. **No leakage** — the model is a function of the train split ALONE. Asserted the
 *     strong way: mutate every test-split row and re-train; the model must not move.
 *  3. **Output schema + zero identifiers** — numeric-only `detail`, real feature names,
 *     a real `EvidenceWindow`, and nothing anywhere that could carry a coordinate, an id,
 *     or a device setting.
 *  4. **Advisory only** — the output has no field a hardware-writing path could consume.
 *     (Task 8 writes the regression proof; this pins the shape it will rely on.)
 */

import { describe, expect, it } from "vitest";
import {
  buildDatasetRow,
  DEFAULT_SEED,
  DEFAULT_SPLIT_RATIOS,
  FEATURE_NAMES,
  serializeAnomalyModel,
  splitDataset,
  toTrainingRow,
  trainAnomalyModel,
  explainSession,
  scoreFeatures,
  evidenceWindowFor,
  cNorm,
  EVIDENCE_WINDOW_SAMPLES,
  FOREST_TREE_COUNT,
  TOP_FEATURE_COUNT,
  UntrainableModelError,
  type DatasetRow,
  type AnomalyModel,
} from "@/lib/ml";
import { DEFAULT_DIAGNOSTIC_CONFIG, evaluateSession } from "@/lib/diagnostics";
import { ANOMALY_MODEL_ID, ANOMALY_MODEL_SCHEMA_VERSION } from "@/lib/ml/anomalyModel";
import { buildLog, loadAllFixtures } from "../diagnostics/fixtures";

const FIXTURES = loadAllFixtures();

/** Every fixture as a DatasetRow, in canonical order — exactly what `modelEval` builds. */
const ROWS: DatasetRow[] = FIXTURES.map((fx) =>
  buildDatasetRow(fx.file, fx.label, fx.log, evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG))
).sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));

const SPLIT = splitDataset(ROWS, { seed: DEFAULT_SEED, ratios: { ...DEFAULT_SPLIT_RATIOS } });

/** The model under test: fit to the healthy rows of the TRAIN split, and nothing else. */
function train(rows = SPLIT.train, seed = DEFAULT_SEED): AnomalyModel {
  return trainAnomalyModel(rows.map(toTrainingRow), { seed });
}

const MODEL = train();

// ---------------------------------------------------------------------------
// 1. Determinism (release invariant #7)
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("training twice with the same seed yields a BYTE-identical model", () => {
    const a = train();
    const b = train();
    expect(b).toEqual(a);
    expect(serializeAnomalyModel(b)).toBe(serializeAnomalyModel(a));
  });

  it("a different seed yields a different forest (the seed is really doing something)", () => {
    expect(serializeAnomalyModel(train(SPLIT.train, DEFAULT_SEED + 1))).not.toBe(
      serializeAnomalyModel(MODEL)
    );
  });

  it("inference twice over the same session yields an identical output", () => {
    const fx = FIXTURES[0];
    const report = evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
    const a = explainSession(MODEL, fx.log, report);
    const b = explainSession(MODEL, fx.log, report);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("passing the report the scan already produced does not change the answer", () => {
    // The perf contract (`ML_INFERENCE_P95_BUDGET_MS`) depends on callers passing the
    // report they already have. That optimisation must be free of semantics: with and
    // without it, the model must say exactly the same thing.
    const fx = FIXTURES.find((f) => f.label === "failsafe")!;
    const withReport = explainSession(MODEL, fx.log, evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG));
    const withoutReport = explainSession(MODEL, fx.log);
    expect(withoutReport).toEqual(withReport);
  });

  it("uses no clock and no unseeded randomness: the model carries no time-shaped key", () => {
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
    walk(MODEL);
    for (const k of keys) {
      expect(k, `model carries a clock-shaped key: ${k}`).not.toMatch(
        /timestamp|generatedat|createdat|^date$|^now$/i
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. No leakage — the cardinal sin
// ---------------------------------------------------------------------------

describe("leakage", () => {
  it("splits by session: train / val / test session ids are pairwise disjoint", () => {
    const t = new Set(SPLIT.train.map((r) => r.sessionId));
    const v = new Set(SPLIT.val.map((r) => r.sessionId));
    const x = new Set(SPLIT.test.map((r) => r.sessionId));
    for (const id of v) expect(t.has(id)).toBe(false);
    for (const id of x) {
      expect(t.has(id), id).toBe(false);
      expect(v.has(id), id).toBe(false);
    }
    expect(t.size + v.size + x.size).toBe(36);
  });

  it("is fit to the 7 HEALTHY rows of the train split — not to val, not to test", () => {
    const healthyTrain = SPLIT.train.filter((r) => r.label === "healthy");
    expect(healthyTrain).toHaveLength(7);
    expect(MODEL.training.rowCount).toBe(7);
    expect(MODEL.training.offeredRowCount).toBe(SPLIT.train.length);
    expect(MODEL.hyperparams.trainedOnClass).toBe("healthy");
    expect(MODEL.hyperparams.subsampleSize).toBe(7);
  });

  it("is INVARIANT to the test split: corrupt every test row and the model is unchanged", () => {
    // The strong form of the leakage assertion. If a single test session had reached the
    // fit, changing all of them could not leave the forest byte-identical.
    const corrupted = ROWS.map((row) => {
      if (!SPLIT.test.some((t) => t.sessionId === row.sessionId)) return row;
      const features = Object.fromEntries(
        FEATURE_NAMES.map((name) => [name, row.features[name] * 1000 + 7])
      ) as typeof row.features;
      return { ...row, features };
    });
    const reSplit = splitDataset(corrupted, {
      seed: DEFAULT_SEED,
      ratios: { ...DEFAULT_SPLIT_RATIOS },
    });
    expect(serializeAnomalyModel(train(reSplit.train))).toBe(serializeAnomalyModel(MODEL));
  });

  it("only ever sees the sessionId-STRIPPED shape (TrainingRow), and carries no id", () => {
    const rows = SPLIT.train.map(toTrainingRow);
    for (const row of rows) expect(row).not.toHaveProperty("sessionId");

    const text = serializeAnomalyModel(MODEL);
    for (const fx of FIXTURES) {
      expect(text.includes(fx.file), fx.file).toBe(false);
    }
  });

  it("refuses to train when the training class is absent, rather than fitting nothing", () => {
    const faultyOnly = SPLIT.train.filter((r) => r.label !== "healthy").map(toTrainingRow);
    expect(() => trainAnomalyModel(faultyOnly)).toThrow(UntrainableModelError);
  });
});

// ---------------------------------------------------------------------------
// 3. The forest itself
// ---------------------------------------------------------------------------

describe("the isolation forest", () => {
  it("grows Liu et al.'s reference configuration: 100 trees, height limit ceil(log2 psi)", () => {
    expect(MODEL.trees).toHaveLength(FOREST_TREE_COUNT);
    expect(MODEL.hyperparams.trees).toBe(100);
    expect(MODEL.hyperparams.heightLimit).toBe(Math.ceil(Math.log2(7)));
    expect(MODEL.hyperparams.heightLimit).toBe(3);
    expect(MODEL.pathNorm).toBeCloseTo(cNorm(7), 5);
  });

  it("can only cut a feature that VARIES in training — 20 of the 43 are constant and blind", () => {
    // The forest's structural blind spot, pinned as a number. Every v2.0 finding count and
    // every pattern flag is 0 across all 7 healthy training sessions, so the trees never
    // split on them: a session with 3 critical findings is invisible along those axes.
    expect(MODEL.training.constantFeatures.length + MODEL.training.splittableFeatureCount).toBe(43);
    expect(MODEL.training.splittableFeatureCount).toBe(23);
    expect(MODEL.training.constantFeatures).toContain("findingCountCritical");
    expect(MODEL.training.constantFeatures).toContain("ruleLqCollapseCount");
    expect(MODEL.training.constantFeatures).toContain("patternRepeatedLqDrops");
    for (const f of MODEL.training.constantFeatures) {
      expect(FEATURE_NAMES).toContain(f);
    }
    // And no tree ever splits on one of them.
    const blind = new Set(MODEL.training.constantFeatures);
    for (const tree of MODEL.trees) {
      for (const node of tree.nodes) {
        if (node.f >= 0) expect(blind.has(FEATURE_NAMES[node.f])).toBe(false);
      }
    }
  });

  it("every internal node splits both ways: no child is empty (a cut is drawn strictly inside the range)", () => {
    for (const tree of MODEL.trees) {
      for (const node of tree.nodes) {
        if (node.f < 0) continue;
        const l = tree.nodes[node.l];
        const r = tree.nodes[node.r];
        expect(l.n).toBeGreaterThan(0);
        expect(r.n).toBeGreaterThan(0);
        expect(l.n + r.n).toBe(node.n);
      }
    }
  });

  it("scores into [0, 1] and flags exactly `score > threshold`", () => {
    for (const row of ROWS) {
      const s = scoreFeatures(MODEL, row.features);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
      expect(s.flagged).toBe(s.score > MODEL.threshold);
    }
  });

  it("fits its threshold on TRAIN alone: no training row is flagged, by construction", () => {
    // `threshold = max(training scores)` and the flag is a strict `>`, so the training set
    // has zero false positives by definition. That is a property of the rule, NOT evidence
    // that the model works — which is exactly why it is asserted here and nowhere else.
    for (const row of SPLIT.train.filter((r) => r.label === "healthy")) {
      expect(scoreFeatures(MODEL, row.features).flagged, row.sessionId).toBe(false);
    }
  });

  it("decomposes EXACTLY: the contributions sum to c(psi) − meanPathLength, with no residual", () => {
    for (const row of ROWS) {
      const s = scoreFeatures(MODEL, row.features);
      const sum = s.contributions.reduce((acc, c) => acc + c.contribution, 0);
      expect(sum).toBeCloseTo(MODEL.pathNorm - s.meanPathLength, 4);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Output schema, explainability, and privacy
// ---------------------------------------------------------------------------

describe("model output — schema, explainability, privacy", () => {
  const outputs = FIXTURES.map((fx) => ({
    fx,
    out: explainSession(MODEL, fx.log, evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG)),
  }));

  it("is ADVISORY, always: `advisory` is a literal `true` with no other inhabitant", () => {
    for (const { out } of outputs) expect(out.advisory).toBe(true);
  });

  it("names REAL features from the frozen FEATURE_NAMES tuple — never an index, never prose", () => {
    for (const { out, fx } of outputs) {
      expect(out.topFeatures, fx.file).toHaveLength(TOP_FEATURE_COUNT);
      for (const c of out.topFeatures) {
        expect(FEATURE_NAMES, fx.file).toContain(c.feature);
        expect(Number.isFinite(c.contribution)).toBe(true);
      }
      // Descending, so "top" means top.
      const values = out.topFeatures.map((c) => c.contribution);
      expect([...values].sort((a, b) => b - a)).toEqual(values);
    }
  });

  it("carries a real EvidenceWindow: inclusive, in range, and start <= end", () => {
    for (const { out, fx } of outputs) {
      const w = out.evidenceWindow;
      expect(w.startIndex, fx.file).toBeGreaterThanOrEqual(0);
      expect(w.endIndex, fx.file).toBeLessThan(fx.log.sampleCount);
      expect(w.startIndex, fx.file).toBeLessThanOrEqual(w.endIndex);
    }
  });

  it("localises a channel-backed top feature to a 25-sample window, and a session aggregate to the whole session", () => {
    const log = buildLog({
      link_quality: Array.from({ length: 100 }, (_, i) => (i >= 40 && i < 60 ? 5 : 95)),
      rssi1: Array.from({ length: 100 }, () => -60),
      rssi2: Array.from({ length: 100 }, () => -62),
    });

    // A channel-backed feature localises to where that channel is worst (the LQ trough at
    // samples 40–59): the extremal 25-sample rolling window must cover it.
    const lqWindow = evidenceWindowFor(log, "lqMin");
    expect(lqWindow.endIndex - lqWindow.startIndex + 1).toBe(EVIDENCE_WINDOW_SAMPLES);
    expect(lqWindow.startIndex).toBeGreaterThanOrEqual(35);
    expect(lqWindow.startIndex).toBeLessThanOrEqual(40);
    expect(lqWindow.endIndex).toBeGreaterThanOrEqual(59);

    // A session aggregate does NOT localise, and does not pretend to.
    expect(evidenceWindowFor(log, "findingCountCritical")).toEqual({ startIndex: 0, endIndex: 99 });
    expect(evidenceWindowFor(log, "healthScore")).toEqual({ startIndex: 0, endIndex: 99 });
  });

  it("has a NUMERIC-ONLY detail bag — stricter than DiagnosticFinding.detail, which allows strings", () => {
    for (const { out, fx } of outputs) {
      for (const [key, value] of Object.entries(out.detail)) {
        expect(typeof value, `${fx.file}.detail.${key}`).toBe("number");
        expect(Number.isFinite(value), `${fx.file}.detail.${key}`).toBe(true);
      }
    }
  });

  it("carries ZERO identifiers: no session key, no coordinate, no UID/MAC/IP/email/serial", () => {
    for (const { out, fx } of outputs) {
      const text = JSON.stringify(out);
      expect(text.includes(fx.file), fx.file).toBe(false);
      expect(text).not.toMatch(/\b(?:lat|lon|lng|latitude|longitude|gps|coord|mac|ipv4|email|uid|serial|bindingPhrase)\b/i);
      expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/); // dotted-quad IP
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/); // email
    }
  });

  it("is GPS-free by construction: a session with a GPS track scores identically to one without", () => {
    const channels = {
      link_quality: Array.from({ length: 80 }, (_, i) => (i > 50 ? 10 : 92)),
      rssi1: Array.from({ length: 80 }, () => -70),
      rssi2: Array.from({ length: 80 }, () => -95),
      snr: Array.from({ length: 80 }, () => 6),
    };
    const bare = buildLog(channels);
    const tracked = {
      ...buildLog(channels),
      gps: Array.from({ length: 80 }, (_, i) => ({ lat: 47.1 + i * 0.001, lon: 8.2 + i * 0.001 })),
    };
    expect(explainSession(MODEL, tracked)).toEqual(explainSession(MODEL, bare));
  });

  it("cannot reach a hardware-writing path: the output has NO field a device writer consumes", () => {
    // Structural, not behavioural. A flash/config writer takes an instruction — a setting
    // key, a value to write, a target, a firmware field. This shape is a fixed set of keys
    // over a CLOSED vocabulary, and the assertion below proves it: every string anywhere in
    // the output is either the model id, the schema version, or a name from the frozen
    // FEATURE_NAMES tuple. There is no representable output that carries an instruction,
    // because there is nowhere to put one and no string it could be spelled with.
    const allowedStrings = new Set<string>([
      ANOMALY_MODEL_ID,
      ANOMALY_MODEL_SCHEMA_VERSION,
      ...FEATURE_NAMES,
    ]);

    for (const { out, fx } of outputs) {
      expect(Object.keys(out).sort(), fx.file).toEqual([
        "advisory",
        "detail",
        "evidenceWindow",
        "flagged",
        "modelId",
        "schemaVersion",
        "score",
        "threshold",
        "topFeatures",
      ]);

      const walk = (node: unknown, path: string): void => {
        if (typeof node === "number" || typeof node === "boolean") return;
        if (typeof node === "string") {
          expect(allowedStrings.has(node), `${fx.file} ${path} = "${node}"`).toBe(true);
          return;
        }
        if (Array.isArray(node)) {
          node.forEach((v, i) => walk(v, `${path}[${i}]`));
          return;
        }
        expect(node !== null && typeof node === "object", `${fx.file} ${path}`).toBe(true);
        for (const [k, v] of Object.entries(node as object)) walk(v, `${path}.${k}`);
      };
      walk(out, "output");
    }
  });
});
