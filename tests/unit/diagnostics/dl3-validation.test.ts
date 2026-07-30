/**
 * Explicit DL3 acceptance record (M36, v2.0.0).
 *
 * The engine's {@link import("./manifest-acceptance.test.ts")} already asserts the
 * corpus is reproduced; THIS suite is the self-documenting DL3 gate — the single
 * place that states, names, and logs the two DL3 quality numbers the release claims:
 *
 *  1. **False-positive rate** on the healthy class (must be ≤ 5% — i.e. 0/12).
 *  2. **Recall** of the labelled expected-finding windows across the whole corpus
 *     (must be ≥ 90%), with a per-class breakdown logged.
 *
 * The third DL3 concern — the **large-log scan budget** — is now formalized by the
 * M41 launch gate in {@link import("./scan-budget.test.ts")} (a frozen p95 budget
 * plus a deterministic `t(2N) < K·t(N)` complexity guard over the full
 * evaluateSession + detectSessionPatterns pipeline), so the loose 2000 ms smoke
 * that used to live here has been retired. The consolidated per-preset FP/recall
 * audit lives in {@link import("./v20-launch-audit.test.ts")}.
 *
 * Everything runs the intermediate default ({@link DEFAULT_DIAGNOSTIC_CONFIG}), the
 * acceptance baseline, over the on-disk DL2 fixture corpus via the shared loader.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIAGNOSTIC_CONFIG,
  evaluateSession,
  type DiagnosticFinding,
} from "@/lib/diagnostics";
import {
  loadAllFixtures,
  windowsOverlap,
  WINDOW_TOLERANCE,
  type ExpectedFinding,
  type LoadedFixture,
} from "./fixtures";

const FIXTURES = loadAllFixtures();

/** The five DL2 link-health classes. */
type FixtureLabel = LoadedFixture["label"];
const LABELS: readonly FixtureLabel[] = [
  "healthy",
  "warning",
  "failsafe",
  "wiring",
  "antenna",
];

const isWarnOrHigher = (f: DiagnosticFinding): boolean =>
  f.severity === "warning" || f.severity === "critical";

/** Does any finding reproduce the expected entry (ruleId + severity + window ±8)? */
function matches(findings: DiagnosticFinding[], expected: ExpectedFinding): boolean {
  const lo = expected.approxWindow.startIndex - WINDOW_TOLERANCE;
  const hi = expected.approxWindow.endIndex + WINDOW_TOLERANCE;
  return findings.some(
    (f) =>
      f.ruleId === expected.ruleId &&
      f.severity === expected.severity &&
      windowsOverlap(f.evidenceWindow.startIndex, f.evidenceWindow.endIndex, lo, hi)
  );
}

describe("DL3 — false-positive rate on the healthy class", () => {
  it("≤ 5% of healthy fixtures raise any warning-or-higher finding (target 0)", () => {
    const healthy = FIXTURES.filter((f) => f.label === "healthy");
    const falsePositives = healthy.filter((f) =>
      evaluateSession(f.log, DEFAULT_DIAGNOSTIC_CONFIG).findings.some(isWarnOrHigher)
    );
    const fpRate = falsePositives.length / healthy.length;

    // eslint-disable-next-line no-console
    console.log(
      `DL3 false-positive rate = ${falsePositives.length}/${healthy.length} = ${fpRate.toFixed(
        3
      )}${falsePositives.length ? ` (offenders: ${falsePositives.map((f) => f.file).join(", ")})` : ""}`
    );

    expect(healthy.length).toBe(12);
    expect(falsePositives.map((f) => f.file)).toEqual([]);
    expect(fpRate).toBeLessThanOrEqual(0.05);
  });
});

describe("DL3 — recall of the labelled expected-finding windows", () => {
  it("≥ 90% of all expected findings are reproduced, with a per-class breakdown", () => {
    let total = 0;
    let matched = 0;
    const perClass = new Map<FixtureLabel, { total: number; matched: number }>();
    for (const label of LABELS) perClass.set(label, { total: 0, matched: 0 });

    for (const fx of FIXTURES) {
      if (fx.expectedFindings.length === 0) continue;
      const { findings } = evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
      const bucket = perClass.get(fx.label)!;
      for (const expected of fx.expectedFindings) {
        total++;
        bucket.total++;
        if (matches(findings, expected)) {
          matched++;
          bucket.matched++;
        }
      }
    }

    const recall = matched / total;
    const breakdown = LABELS.map((label) => {
      const b = perClass.get(label)!;
      const pct = b.total === 0 ? "n/a" : (b.matched / b.total).toFixed(3);
      return `${label} ${b.matched}/${b.total} (${pct})`;
    }).join(", ");

    // eslint-disable-next-line no-console
    console.log(`DL3 recall = ${matched}/${total} = ${recall.toFixed(3)}`);
    // eslint-disable-next-line no-console
    console.log(`DL3 per-class recall: ${breakdown}`);

    expect(recall).toBeGreaterThanOrEqual(0.9);
    // Healthy carries no expected findings (it is the false-positive control).
    expect(perClass.get("healthy")!.total).toBe(0);
    // Every labelled-event class actually contributed expected findings.
    for (const label of ["warning", "failsafe", "wiring", "antenna"] as const) {
      expect(perClass.get(label)!.total).toBeGreaterThan(0);
    }
  });
});

// The former large-log scan-budget smoke has been RETIRED here — the M41 launch
// gate formalizes it in `scan-budget.test.ts` (frozen p95 budget + complexity
// guard over the full evaluateSession + detectSessionPatterns pipeline).
