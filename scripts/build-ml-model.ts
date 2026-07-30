/**
 * Train the M58 anomaly-model prototype and freeze its report card (M58).
 *
 * Reads the labelled diagnostic fixture corpus + the frozen v2.0 baseline artifact, trains
 * the one-class isolation forest on the **train split only**, scores it against the
 * baseline through the pure ML eval harness, and writes two artifacts:
 *
 *  - `data/ml/model-m58.json`      — the trained forest. A machine artifact: compact,
 *                                    numeric + structural only, zero identifiers. This is
 *                                    what the flag-gated ML lab loads to run the model
 *                                    on-device.
 *  - `data/ml/model-eval-m58.json` — the report card. 2-space-indented like
 *                                    `baseline-v20.json`, with its own honesty header, its
 *                                    own corpus fingerprint, and the gate verdict.
 *
 * Run: `npm run build:ml-model`
 *
 * Mirrors `scripts/build-ml-baseline.ts` exactly: `fs` (not the vite glob) so it runs under
 * plain `vite-node`, and the SAME pure modules the app and the test suite use — the script
 * owns no logic beyond reading files.
 *
 * ## Deterministic, and NOT a CI side effect
 * Neither artifact carries a generation timestamp — provenance is the corpus fingerprint
 * and the seed. Re-running on an unchanged corpus rewrites byte-identical bytes, and
 * `tests/unit/ml/m58Gate.test.ts` re-derives both from the fixtures and deep-equals them
 * against the checked-in files. So this script is never *needed* in CI: if a fixture, a
 * rule threshold, or the model changes, the test goes red and a human must consciously
 * re-freeze. CI regenerating the artifacts would let a change silently move the numbers it
 * is graded against.
 *
 * ## The verdict it prints is the verdict it found
 * The gate is expected to FAIL, and the script prints that it failed. D25's FP ceiling is a
 * strict `<` against a baseline FP rate of 0.000 — nothing is strictly below zero, so no
 * model clears it. See `data/ml/baseline-v20.json` → `gateBaseline.fpCeilingClearable`.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOmniLogCsv } from "../src/lib/omnilog";
import type { BaselineArtifact, BaselineFixture } from "../src/lib/ml/baseline";
import { serializeAnomalyModel } from "../src/lib/ml/anomalyModel";
import {
  evaluateAnomalyModel,
  serializeModelEvalArtifact,
} from "../src/lib/ml/modelEval";
import { BASELINE_METRICS_ARTIFACT } from "../src/lib/ml/mlConsts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIXTURES_DIR = join(ROOT, "data", "fixtures", "diagnostics");

/** Where the trained forest is checked in (mirrored in `modelEval.ts`'s artifact). */
const MODEL_ARTIFACT = "data/ml/model-m58.json";
/** Where the model's report card is checked in. */
const MODEL_EVAL_ARTIFACT = "data/ml/model-eval-m58.json";

interface ManifestEntry {
  file: string;
  label: string;
  expectClean: boolean;
  expectedFindings: { ruleId: string; approxWindow: { startIndex: number; endIndex: number } }[];
}

interface Manifest {
  version: string;
  fixtures: ManifestEntry[];
}

function main(): void {
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES_DIR, "fixtures-manifest.json"), "utf8")
  ) as Manifest;

  const fixtures: BaselineFixture[] = manifest.fixtures.map((entry) => ({
    file: entry.file,
    label: entry.label,
    expectClean: entry.expectClean,
    expectedFindings: entry.expectedFindings,
    log: parseOmniLogCsv(readFileSync(join(FIXTURES_DIR, entry.file), "utf8")),
  }));

  const baseline = JSON.parse(
    readFileSync(join(ROOT, BASELINE_METRICS_ARTIFACT), "utf8")
  ) as BaselineArtifact;

  const { artifact, model } = evaluateAnomalyModel(fixtures, manifest.version, baseline);

  const modelPath = join(ROOT, MODEL_ARTIFACT);
  const evalPath = join(ROOT, MODEL_EVAL_ARTIFACT);
  mkdirSync(dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, serializeAnomalyModel(model), "utf8");
  writeFileSync(evalPath, serializeModelEvalArtifact(artifact), "utf8");

  const held = artifact.heldOutTestSplit.model.perSession;
  const whole = artifact.wholeCorpus.model.perSession;
  const ew = artifact.earlyWarning;

  process.stdout.write(
    `Wrote ${modelPath}\n` +
      `Wrote ${evalPath}\n` +
      `  corpus       : ${artifact.corpus.sessionCount} sessions, fingerprint ${artifact.corpus.fingerprint}\n` +
      `  trained on   : ${model.training.rowCount} healthy rows (train split only), ${model.training.splittableFeatureCount}/43 splittable features\n` +
      `  threshold    : ${model.threshold} (max training score; a-priori, fitted on train alone)\n` +
      `  TEST split   : precision ${held.precision.value}, recall ${held.recall.value}, FP ${held.falsePositiveRate.value} (n=${artifact.heldOutTestSplit.sessionCount}, ${artifact.heldOutTestSplit.negativeSessions} negatives, quantum ${artifact.heldOutTestSplit.fpRateQuantumPp.toFixed(1)}pp)\n` +
      `  whole corpus : precision ${whole.precision.value}, recall ${whole.recall.value}, FP ${whole.falsePositiveRate.value} (n=${artifact.wholeCorpus.sessionCount}, ${artifact.wholeCorpus.negativeSessions} negatives, quantum ${artifact.wholeCorpus.fpRateQuantumPp.toFixed(1)}pp)\n` +
      `  M56 GATE     : clearsM56Gate() = ${artifact.heldOutTestSplit.passes}  (fpCeilingClearable=${artifact.honesty.fpCeilingClearable}; baseline FP = ${artifact.heldOutTestSplit.gateBaseline.baselineFpRate}, strict '<' admits no model)\n` +
      `  early warning: branchMet=${ew.branchMet}; model flagged ${ew.model.healthyFlaggedAtSomePrefix} healthy sessions at some prefix; bounded coverage ${ew.model.leadTimeBounded?.coverage ?? 0} vs rules ${ew.ruleEngine.leadTimeBounded?.coverage ?? 0}\n`
  );
}

main();
