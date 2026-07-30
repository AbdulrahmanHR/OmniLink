/**
 * Generate the **SYNTHETIC** M59 degradation corpus (track b).
 *
 * Run: `npm run build:ml-synthetic`
 *
 * Writes `data/fixtures/ml-synthetic/` — 72 seeded, deterministic telemetry-session CSVs
 * (30 ramp-into-failsafe positives, 30 near-miss decay-and-recover negatives across three
 * depth bands, 12 clean-cruise negatives) plus `synthetic-manifest.json`.
 *
 * ## ⚠ This corpus is NOT field evidence and its numbers are NOT an M59 acceptance pass
 * Every session here was **drawn by a generator**, alongside the predictor it is used to
 * exercise. A number measured against it answers *"can the detector find a ramp we drew?"*,
 * never *"can the detector predict a real failsafe?"*. M59's real acceptance is measured on
 * the **real** corpus (`data/fixtures/diagnostics/`), where it is **UNMET** — the median lead
 * available to *any* predictor there is 0 ms against a 2000 ms target. See
 * `src/lib/ml/syntheticCorpus.ts`'s module header for the full list of what the generator
 * assumes, and `data/ml/model-eval-m59.json` for the null result that is M59's actual finding.
 *
 * ## It is written into its OWN directory, never `data/fixtures/diagnostics/`
 * Separate directory, separate manifest schema (`synthetic: true`, `notFieldEvidence: true`),
 * separate fingerprint, and a session type that is not structurally assignable to
 * `BaselineFixture`. Folding it into the real corpus would require a deliberate, visible
 * conversion — which is the point.
 *
 * ## Deterministic, and NOT a CI side effect
 * Seeded by `DEFAULT_SEED` alone; no clock, no machine state. Re-running rewrites
 * byte-identical bytes, and `tests/unit/ml/predictive.test.ts` regenerates the corpus and
 * deep-equals it against the checked-in files. So this script is never *needed* in CI: if the
 * generator changes, the test goes red and a human must consciously re-freeze. CI
 * regenerating the corpus would let a generator change silently move the numbers measured
 * against it.
 *
 * Mirrors `scripts/build-ml-baseline.ts` / `build-ml-model.ts`: `fs` (not the vite glob) so it
 * runs under plain `vite-node`, and the SAME pure modules the app and the test suite use — the
 * script owns no logic beyond writing files.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findFailsafeOnsetIndices } from "../src/lib/ml/baseline";
import {
  assertGroundTruth,
  buildSyntheticManifest,
  generateSyntheticCorpus,
  serializeSyntheticManifest,
  syntheticSessionToCsv,
  SYNTHETIC_CORPUS_DIR,
  SYNTHETIC_MANIFEST_FILE,
} from "../src/lib/ml/syntheticCorpus";
import { DEFAULT_SEED } from "../src/lib/ml/rng";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function main(): void {
  const outDir = join(ROOT, SYNTHETIC_CORPUS_DIR);

  const sessions = generateSyntheticCorpus(DEFAULT_SEED);

  // Verify the corpus honours its own ground truth BEFORE a byte is written, using the app's
  // OWN frozen onset rule. A near-miss that accidentally failsafed would be a positive
  // mislabelled as a negative, and every false-alarm number measured from this corpus would
  // then be wrong in the flattering direction. The generator throws rather than emit a corpus
  // it cannot vouch for.
  assertGroundTruth(sessions, findFailsafeOnsetIndices);

  // Rewrite from scratch so a renamed/removed session cannot linger as an orphan CSV that the
  // manifest no longer lists but a naive directory walk would still pick up.
  rmSync(outDir, { recursive: true, force: true });

  for (const session of sessions) {
    const path = join(outDir, session.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, syntheticSessionToCsv(session), "utf8");
  }

  const manifest = buildSyntheticManifest(sessions, DEFAULT_SEED);
  writeFileSync(
    join(outDir, SYNTHETIC_MANIFEST_FILE),
    serializeSyntheticManifest(manifest),
    "utf8"
  );

  const { counts } = manifest;
  process.stdout.write(
    `Wrote ${outDir}/ (SYNTHETIC — NOT field evidence, NOT an acceptance pass)\n` +
      `  sessions    : ${counts.total} (${counts.ramp} ramp-into-failsafe positives, ${counts.nearMiss} near-miss negatives, ${counts.steady} steady negatives)\n` +
      `  near-miss   : ${Object.entries(counts.byBand).map(([b, n]) => `${b} ${n}`).join(", ")}\n` +
      `  negatives   : ${counts.negatives} (FP quantum ${counts.fpRateQuantumPp.toFixed(1)}pp; over the near-misses alone ${counts.nearMissFpRateQuantumPp.toFixed(1)}pp)\n` +
      `  seed        : ${DEFAULT_SEED}\n` +
      `  fingerprint : ${manifest.fingerprint}\n` +
      `  ground truth: verified — every 'ramp' has exactly 1 failsafe onset, every negative has 0 (findFailsafeOnsetIndices, the frozen rule)\n` +
      `\n` +
      `  REMINDER: this corpus measures "can the detector find a ramp we drew?", not field performance.\n` +
      `  M59's real acceptance is measured on data/fixtures/diagnostics/, where it is UNMET (0 ms median lead vs a 2000 ms target).\n`
  );
}

main();
