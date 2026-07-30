/**
 * Evaluate the M59 predictive failsafe warner and freeze its report card.
 *
 * Run: `npm run build:ml-predictive`
 *
 * Reads the **real** labelled fixture corpus, the **synthetic** degradation corpus, and the
 * frozen v2.0 baseline artifact; replays every session through the predictor's *live* frame
 * pipeline; scores both corpora — **separately, never pooled** — through the pure ML eval
 * harness; and writes `data/ml/model-eval-m59.json`.
 *
 * ## The verdict it prints is the verdict it found
 * **M59's acceptance is UNMET on the real corpus, and unmeetable there by any predictor.**
 * The script prints that, because it is true. The real corpus contains no degradation ramp:
 * the maximum lead time extractable from it by a *perfect oracle* is 80 ms, and the median is
 * **0 ms**, against a 2000 ms target. Over half the frozen failsafe onsets give literally zero
 * warning — link quality goes from healthy to 0 in a single sample.
 *
 * **The null result is M59's deliverable.** Nothing here is tuned to route around it, and
 * `tests/unit/ml/predictive.test.ts` pins it so a later commit that claims a predictive signal
 * exists goes red.
 *
 * ## The synthetic numbers are printed, and they are not a pass
 * They demonstrate the pipeline runs end to end on data that contains the phenomenon the
 * predictor was built for. They are **indicative only**. They are **not** field evidence and
 * **not** an M59 acceptance result, and the artifact says so in its own honesty header
 * (`syntheticCorpusNotFieldEvidence: true`).
 *
 * ## Deterministic, and NOT a CI side effect
 * No clock, no machine state — provenance is the two corpus fingerprints and the seed. Mirrors
 * `scripts/build-ml-baseline.ts` / `build-ml-model.ts` exactly: `fs` (not the vite glob) so it
 * runs under plain `vite-node`, and the SAME pure modules the app and the test suite use.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOmniLogCsv } from "../src/lib/omnilog";
import type { BaselineArtifact } from "../src/lib/ml/baseline";
import { toMlLabel } from "../src/lib/ml/dataset";
import { BASELINE_METRICS_ARTIFACT } from "../src/lib/ml/mlConsts";
import {
  evaluatePredictor,
  serializePredictiveEvalArtifact,
  type PredictiveCorpusSession,
} from "../src/lib/ml/predictiveEval";
import { DEFAULT_SEED } from "../src/lib/ml/rng";
import {
  SYNTHETIC_CORPUS_DIR,
  SYNTHETIC_MANIFEST_FILE,
  type SyntheticManifest,
} from "../src/lib/ml/syntheticCorpus";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REAL_DIR = join(ROOT, "data", "fixtures", "diagnostics");
const SYNTHETIC_DIR = join(ROOT, SYNTHETIC_CORPUS_DIR);

/** Where M59's report card is checked in. */
const PREDICTIVE_EVAL_ARTIFACT = "data/ml/model-eval-m59.json";

interface RealManifest {
  version: string;
  fixtures: { file: string; label: string; expectClean: boolean }[];
}

function main(): void {
  // --- The REAL corpus. The only one M59's acceptance is measured on. ---------------------
  const realManifest = JSON.parse(
    readFileSync(join(REAL_DIR, "fixtures-manifest.json"), "utf8")
  ) as RealManifest;

  const realSessions: PredictiveCorpusSession[] = realManifest.fixtures.map((entry) => ({
    sessionId: entry.file,
    label: toMlLabel(entry.label),
    // Bucketed by the real class, so the false-alarm breakdown says WHICH kind of negative
    // the predictor fired on — the 7 `warning` fixtures being the confusable ones.
    bucket: entry.label,
    log: parseOmniLogCsv(readFileSync(join(REAL_DIR, entry.file), "utf8")),
  }));

  // --- The SYNTHETIC corpus. Indicative only. Loaded from its OWN manifest. ---------------
  const syntheticManifest = JSON.parse(
    readFileSync(join(SYNTHETIC_DIR, SYNTHETIC_MANIFEST_FILE), "utf8")
  ) as SyntheticManifest;

  if (!syntheticManifest.synthetic || !syntheticManifest.notFieldEvidence) {
    throw new Error(
      `${SYNTHETIC_MANIFEST_FILE} is missing its synthetic/notFieldEvidence markers — refusing to score it, ` +
        `because a corpus that does not declare itself synthetic could be mistaken for real data.`
    );
  }

  const syntheticSessions: PredictiveCorpusSession[] = syntheticManifest.sessions.map((s) => ({
    sessionId: s.sessionId,
    // `ramp` → failsafe, `nearMiss` → warning, `steady` → healthy. The near-misses map to
    // `warning` because that is exactly what they are: a session that degraded and recovered.
    label: s.cls === "ramp" ? "failsafe" : s.cls === "nearMiss" ? "warning" : "healthy",
    // Bucketed by DEPTH BAND, so the report can say where the false alarms came from rather
    // than averaging the deep (genuinely confusable) band against the shallow one.
    bucket: s.band ?? s.cls,
    log: parseOmniLogCsv(readFileSync(join(SYNTHETIC_DIR, s.file), "utf8")),
  }));

  const baseline = JSON.parse(
    readFileSync(join(ROOT, BASELINE_METRICS_ARTIFACT), "utf8")
  ) as BaselineArtifact;

  const artifact = evaluatePredictor({
    realSessions,
    realManifestVersion: realManifest.version,
    realFingerprint: baseline.corpus.fingerprint,
    syntheticSessions,
    syntheticFingerprint: syntheticManifest.fingerprint,
    syntheticSeed: DEFAULT_SEED,
    gateBaseline: {
      baselineFpRate: baseline.gateBaseline.baselineFpRate,
      baselineRecall: baseline.gateBaseline.baselineRecall,
      fpCeilingClearable: baseline.gateBaseline.fpCeilingClearable,
    },
  });

  const outPath = join(ROOT, PREDICTIVE_EVAL_ARTIFACT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serializePredictiveEvalArtifact(artifact), "utf8");

  const a = artifact.acceptance;
  const real = artifact.realCorpus;
  const syn = artifact.syntheticCorpus;
  const realLead = real.report.leadTime;
  const synLead = syn.report.leadTime;
  const nearMiss = syn.falseAlarmsByBucket.filter((b) => b.bucket !== "steady");
  const nmNeg = nearMiss.reduce((acc, b) => acc + b.negatives, 0);
  const nmFa = nearMiss.reduce((acc, b) => acc + b.falseAlarms, 0);

  process.stdout.write(
    `Wrote ${outPath}\n` +
      `\n` +
      `  ======================================================================\n` +
      `  M59 ACCEPTANCE ON THE REAL CORPUS: ${a.acceptanceMetOnRealCorpus ? "MET" : "NOT MET"}\n` +
      `  ======================================================================\n` +
      `\n` +
      `  REAL corpus (${real.sessionCount} sessions, ${real.eventCount} frozen failsafe onsets, fingerprint ${artifact.corpora.real.fingerprint})\n` +
      `    lead time      : median ${a.measuredMedianLeadMs === null ? "NONE (no creditable predictions at all -- stronger than a median of 0)" : `${a.measuredMedianLeadMs} ms`}  vs a ${a.targetLeadMs} ms target  -> meetsTarget=${a.meetsLeadTimeTarget}\n` +
      `    coverage       : ${a.creditablePredictions}/${realLead?.eventCount ?? 0} events warned BEFORE onset; ${a.lateDetections} caught only AFTER the link was gone (detection, not prediction); ${a.missedEvents} missed entirely\n` +
      `    ORACLE CEILING : median ${a.oracleMedianLeadMs} ms / max ${a.oracleMaxLeadMs} ms  -- the most ANY predictor could extract.\n` +
      `                     (maximally generous variant, crediting a 1-point noise wiggle: median ${a.oracleMedianLeadAnyMovementMs} ms / max ${a.oracleMaxLeadAnyMovementMs} ms -- still ~17x short)\n` +
      `                     ${real.leadCeiling.threshold.zeroLeadEvents}/${real.leadCeiling.eventCount} onsets give LITERALLY ZERO warning (LQ healthy -> 0 in one sample).\n` +
      `                     targetReachable=${a.targetReachableOnRealCorpus}. THE CORPUS HAS NO PREDICTIVE SIGNAL. This is M59's headline finding.\n` +
      `    false alarms   : predictive FP ${real.predictiveFpRate.value} (${real.predictiveFpRate.numerator}/${real.predictiveFpRate.denominator} non-failsafing sessions, quantum ${real.fpRateQuantumPp.toFixed(1)}pp)\n` +
      `                     healthy-only FP ${real.healthyOnlyFpRate.value} (${real.healthyOnlyFpRate.numerator}/${real.healthyOnlyFpRate.denominator}) -- the D25 denominator\n` +
      `    D25 FP ceiling : clearsFpCeiling=${a.clearsFpCeiling} (fpCeilingClearable=${a.fpCeilingClearable}; baseline FP = 0.000, strict '<' admits nothing)\n` +
      `    horizon check  : ${real.horizonSensitivity.map((h) => `${h.horizonMs === null ? "unbounded" : `${h.horizonMs}ms`}=${h.medianLeadMs === null ? "NONE" : `median ${h.medianLeadMs}ms`}`).join("  |  ")}\n` +
      `                     -> the null does NOT depend on the horizon.\n` +
      `    NAIVE artifact : median ${real.leadTimeNaive?.medianLeadMs ?? 0} ms -- IMPOSSIBLE (the oracle ceiling is ${a.oracleMaxLeadMs} ms).\n` +
      `                     It comes from crediting ${real.withdrawnWarnings} warnings the predictor ITSELF WITHDREW when the link RECOVERED.\n` +
      `                     Published, not believed. The headline number credits only warnings still standing at the failsafe.\n` +
      `\n` +
      `  SYNTHETIC corpus (${syn.sessionCount} sessions, fingerprint ${artifact.corpora.synthetic.fingerprint})  *** INDICATIVE ONLY -- NOT FIELD EVIDENCE, NOT AN ACCEPTANCE PASS ***\n` +
      `    lead time      : median ${synLead?.medianLeadMs ?? 0} ms / max ${synLead?.maxLeadMs ?? 0} ms, coverage ${synLead?.predictedCount ?? 0}/${synLead?.eventCount ?? 0}\n` +
      `    false alarms   : near-miss negatives ${nmFa}/${nmNeg} (quantum ${nmNeg > 0 ? (100 / nmNeg).toFixed(1) : "0.0"}pp)\n` +
      `${syn.falseAlarmsByBucket.map((b) => `                     ${b.bucket.padEnd(9)} ${b.falseAlarms}/${b.negatives} = ${b.fpRate.value}\n`).join("")}` +
      `    This measures "can the detector find a ramp we drew?". The ramps were drawn long enough that a 2 s lead is AVAILABLE.\n` +
      `    It says NOTHING about field performance. M59's real acceptance stays UNMET.\n`
  );
}

main();
