/**
 * Formal v2.0 scan-budget gate (M41, v2.0.2).
 *
 * The M41 launch gate that supersedes the loose 2000 ms "smoke" M36 carried in
 * `dl3-validation.test.ts`. It pins the cost of a FULL v2.0 session scan —
 * {@link evaluateSession} (M36) + {@link detectSessionPatterns} (M38) — over a
 * large log, two independent ways so neither flakes:
 *
 *  1. **A frozen p95 wall-clock budget** ({@link DIAGNOSTICS_SCAN_P95_BUDGET_MS}):
 *     warm up, then time many full scans of a ~50k-sample log and assert the p95
 *     stays under the (deliberately generous) frozen ceiling. Mirrors
 *     `knowledgeRetrievePerf.test.ts`. Fewer samples than that suite because each
 *     full scan is ~70 ms (vs. the sub-ms retrieval), so ~30 timed runs already
 *     give a steady p95 without bloating the unit run.
 *  2. **A deterministic complexity guard** `t(2N) < K · t(N)`: a linear scan
 *     doubles when the input doubles (ratio ≈ 2); an O(n²) regression quadruples
 *     it (≈ 4). Best-of timing (least-contended sample) kills load noise, so this
 *     catches a super-linear regression WITHOUT a flaky absolute bound.
 *
 * A sanity check that the large scan does real work (findings AND ≥1 pattern), so
 * the budget covers the whole pipeline rather than an early-out.
 *
 * The frozen constants + the shared {@link buildLargeSessionLog} live in
 * `src/lib/diagnostics/perf.ts` (the single source of truth).
 */

import { describe, expect, it } from "vitest";
import type { ParsedLog } from "@/lib/blackbox";
import {
  DEFAULT_DIAGNOSTIC_CONFIG,
  DIAGNOSTICS_SCAN_COMPLEXITY_K,
  DIAGNOSTICS_SCAN_P95_BUDGET_MS,
  buildLargeSessionLog,
  detectSessionPatterns,
  evaluateSession,
} from "@/lib/diagnostics";

/** One full v2.0 session scan: M36 findings + M38 patterns. */
function fullScan(log: ParsedLog): { findings: number; patterns: number } {
  const report = evaluateSession(log, DEFAULT_DIAGNOSTIC_CONFIG);
  const patternReport = detectSessionPatterns(log, report);
  return { findings: report.findings.length, patterns: patternReport.patterns.length };
}

/** p95 of a sample set (nearest-rank, clamped to the last index). */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
  return sorted[idx];
}

/** Best-of (min) full-scan time for `log` — the least-contended measurement. */
function bestScanMs(log: ParsedLog, warmups = 3, reps = 8): number {
  for (let i = 0; i < warmups; i++) fullScan(log);
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fullScan(log);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("M41 — full v2.0 scan budget (evaluateSession + detectSessionPatterns)", () => {
  it(`a 50k-sample full scan stays under the frozen p95 of ${DIAGNOSTICS_SCAN_P95_BUDGET_MS}ms`, () => {
    const log = buildLargeSessionLog(50_000);
    expect(log.sampleCount).toBe(50_000);

    // Warm up (JIT + first-call effects) so the measured window is steady-state.
    for (let i = 0; i < 5; i++) fullScan(log);

    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      fullScan(log);
      samples.push(performance.now() - t0);
    }

    const observed = p95(samples);
    // eslint-disable-next-line no-console
    console.log(
      `M41 scan budget: 50k-sample full scan p95 = ${observed.toFixed(1)} ms (budget ${DIAGNOSTICS_SCAN_P95_BUDGET_MS} ms)`
    );
    expect(observed).toBeLessThan(DIAGNOSTICS_SCAN_P95_BUDGET_MS);
  }, 30_000);

  it(`scales sub-quadratically: t(50k) < ${DIAGNOSTICS_SCAN_COMPLEXITY_K}·t(25k)`, () => {
    const logN = buildLargeSessionLog(25_000);
    const log2N = buildLargeSessionLog(50_000);

    const tN = bestScanMs(logN);
    const t2N = bestScanMs(log2N);
    const ratio = t2N / tN;

    // eslint-disable-next-line no-console
    console.log(
      `M41 complexity guard: t(25k)=${tN.toFixed(1)}ms t(50k)=${t2N.toFixed(1)}ms ratio=${ratio.toFixed(2)} (< ${DIAGNOSTICS_SCAN_COMPLEXITY_K})`
    );
    expect(ratio).toBeLessThan(DIAGNOSTICS_SCAN_COMPLEXITY_K);
  }, 30_000);

  it("the large scan does real work: findings AND ≥1 pattern (not an early-out)", () => {
    const log = buildLargeSessionLog(50_000);
    const report = evaluateSession(log, DEFAULT_DIAGNOSTIC_CONFIG);
    const patternReport = detectSessionPatterns(log, report);

    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.healthScore).toBeGreaterThanOrEqual(0);
    expect(report.healthScore).toBeLessThanOrEqual(100);
    // The periodic dropouts drive ≥3 lq-collapse findings ⇒ repeated-lq-drops.
    expect(patternReport.hasEnoughEvidence).toBe(true);
    expect(patternReport.patterns.length).toBeGreaterThanOrEqual(1);
    expect(patternReport.patterns.map((p) => p.patternId)).toContain("repeated-lq-drops");
  });
});
