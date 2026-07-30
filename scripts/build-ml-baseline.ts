/**
 * Regenerate the frozen v2.0 baseline-metrics artifact (M56b).
 *
 * Reads the labelled diagnostic fixture corpus from disk, runs BOTH shipped baselines
 * over it through the pure ML eval harness, and writes
 * `data/ml/baseline-v20.json` — the path `mlConsts.ts::BASELINE_METRICS_ARTIFACT` names
 * and the numbers D25's ship gate is measured against.
 *
 * Run: `npm run build:ml-baseline`
 *
 * Mirrors `scripts/build-knowledge-index.ts`: `fs` (not the vite glob) so it runs under
 * plain `vite-node`, and the SAME pure modules the app and the test suite use — the
 * script owns no logic of its own beyond reading files.
 *
 * ## Deterministic, and NOT a CI side effect
 * The artifact carries **no generation timestamp** — provenance is the corpus
 * fingerprint. Re-running this script on an unchanged corpus rewrites byte-identical
 * bytes, and `tests/unit/ml/baseline.test.ts` re-derives the artifact from the fixtures
 * and deep-equals it against the checked-in JSON. So this script is never *needed* in CI:
 * if the corpus or a rule threshold changes, the test goes red and a human must re-run it
 * and consciously re-freeze the numbers. That is the entire point — CI regenerating the
 * baseline would let a rule change silently move the bar it is graded against.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOmniLogCsv } from "../src/lib/omnilog";
import {
  characterizeBaselines,
  serializeBaselineArtifact,
  type BaselineFixture,
} from "../src/lib/ml/baseline";
import { BASELINE_METRICS_ARTIFACT } from "../src/lib/ml/mlConsts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIXTURES_DIR = join(ROOT, "data", "fixtures", "diagnostics");

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

  const artifact = characterizeBaselines(fixtures, manifest.version);

  const outPath = join(ROOT, BASELINE_METRICS_ARTIFACT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serializeBaselineArtifact(artifact), "utf8");

  const whole = artifact.wholeCorpus.baselines["v20-rule-engine"].perSession;
  process.stdout.write(
    `Wrote ${outPath}\n` +
      `  corpus      : ${artifact.corpus.sessionCount} sessions, fingerprint ${artifact.corpus.fingerprint}\n` +
      `  baseline A  : precision ${whole.precision.value}, recall ${whole.recall.value}, FP rate ${whole.falsePositiveRate.value} (whole corpus)\n` +
      `  gate        : fpCeilingClearable=${artifact.gateBaseline.fpCeilingClearable} (baselineFpRate=${artifact.gateBaseline.baselineFpRate})\n`
  );
}

main();
