/**
 * M36 acceptance: reproduce the DL2 fixture manifest with the intermediate
 * preset, and assert the DL3 metrics (zero healthy false positives, ≥90% recall,
 * warning-fixture severity ceiling).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIAGNOSTIC_CONFIG,
  SENSITIVITY_PRESETS,
  evaluateSession,
  type DiagnosticFinding,
  type DiagnosticSensitivity,
} from "@/lib/diagnostics";
import {
  loadAllFixtures,
  windowsOverlap,
  WINDOW_TOLERANCE,
  type ExpectedFinding,
} from "./fixtures";

const FIXTURES = loadAllFixtures();

/** Does any finding match the expected entry (rule + severity + window overlap)? */
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

const isWarnOrHigher = (f: DiagnosticFinding): boolean =>
  f.severity === "warning" || f.severity === "critical";

describe("manifest acceptance — per fixture", () => {
  for (const fx of FIXTURES) {
    it(`${fx.file} (${fx.label})`, () => {
      const { findings } = evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);

      if (fx.expectClean) {
        // Healthy fixtures: zero warning-or-higher findings.
        expect(findings.filter(isWarnOrHigher)).toEqual([]);
      } else {
        // Every expected finding must be reproduced.
        for (const expected of fx.expectedFindings) {
          expect(
            matches(findings, expected),
            `missing ${expected.ruleId}/${expected.severity} near [${expected.approxWindow.startIndex}, ${expected.approxWindow.endIndex}] in ${fx.file}`
          ).toBe(true);
        }
      }
    });
  }
});

describe("DL3 metrics — false-positive rate, recall, severity ceiling", () => {
  it("zero healthy fixtures raise any warning-or-higher finding (FP ≤ 5% ⇒ 0)", () => {
    const healthy = FIXTURES.filter((f) => f.label === "healthy");
    const falsePositives = healthy.filter(
      (f) => evaluateSession(f.log, DEFAULT_DIAGNOSTIC_CONFIG).findings.some(isWarnOrHigher)
    );
    const fpRate = falsePositives.length / healthy.length;
    // eslint-disable-next-line no-console
    console.log(`DL3 false-positive rate = ${falsePositives.length}/${healthy.length} = ${fpRate.toFixed(3)}`);
    expect(falsePositives.map((f) => f.file)).toEqual([]);
    expect(fpRate).toBeLessThanOrEqual(0.05);
  });

  it("reproduces ≥90% of all expected findings (recall)", () => {
    let total = 0;
    let matched = 0;
    for (const fx of FIXTURES) {
      if (fx.expectedFindings.length === 0) continue;
      const { findings } = evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
      for (const expected of fx.expectedFindings) {
        total++;
        if (matches(findings, expected)) matched++;
      }
    }
    const recall = matched / total;
    // eslint-disable-next-line no-console
    console.log(`DL3 recall = ${matched}/${total} = ${recall.toFixed(3)}`);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });

  it("no warning-labelled fixture emits a critical finding (severity ceiling)", () => {
    const warningFixtures = FIXTURES.filter((f) => f.label === "warning");
    for (const fx of warningFixtures) {
      const { findings } = evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
      const criticals = findings.filter((f) => f.severity === "critical");
      expect(criticals, `${fx.file} emitted a critical finding`).toEqual([]);
    }
  });
});

describe("all sensitivity presets keep healthy false positives at zero", () => {
  const presets: DiagnosticSensitivity[] = ["beginner", "intermediate", "advanced"];
  for (const preset of presets) {
    it(`${preset} preset → 0 healthy warning-or-higher findings`, () => {
      const healthy = FIXTURES.filter((f) => f.label === "healthy");
      for (const f of healthy) {
        const { findings } = evaluateSession(f.log, SENSITIVITY_PRESETS[preset]);
        expect(findings.filter(isWarnOrHigher), `${preset} FP on ${f.file}`).toEqual([]);
      }
    });
  }

  it("intermediate preset still reproduces ≥90% recall across the corpus", () => {
    let total = 0;
    let matched = 0;
    for (const fx of FIXTURES) {
      if (fx.expectedFindings.length === 0) continue;
      const { findings } = evaluateSession(fx.log, SENSITIVITY_PRESETS.intermediate);
      for (const expected of fx.expectedFindings) {
        total++;
        if (matches(findings, expected)) matched++;
      }
    }
    expect(matched / total).toBeGreaterThanOrEqual(0.9);
  });
});

describe("report shape & determinism", () => {
  it("findings are sorted by severity (critical→warning→info) then startIndex", () => {
    const rank = (s: string): number => (s === "critical" ? 0 : s === "warning" ? 1 : 2);
    for (const fx of FIXTURES) {
      const { findings } = evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
      for (let i = 1; i < findings.length; i++) {
        const prev = findings[i - 1];
        const cur = findings[i];
        const ok =
          rank(prev.severity) < rank(cur.severity) ||
          (rank(prev.severity) === rank(cur.severity) &&
            prev.evidenceWindow.startIndex <= cur.evidenceWindow.startIndex);
        expect(ok, `unsorted at ${i} in ${fx.file}`).toBe(true);
      }
    }
  });

  it("sessionSummary counts and per-window length are coherent", () => {
    for (const fx of FIXTURES) {
      const report = evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
      const { countsBySeverity } = report.sessionSummary;
      const totalCounted = countsBySeverity.info + countsBySeverity.warning + countsBySeverity.critical;
      expect(totalCounted).toBe(report.findings.length);
      expect(report.sessionSummary.sampleCount).toBe(fx.log.sampleCount);
      expect(report.healthScore).toBeGreaterThanOrEqual(0);
      expect(report.healthScore).toBeLessThanOrEqual(100);
      expect(report.sessionSummary.perWindowHealth.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic: two evaluations are deeply equal", () => {
    for (const fx of FIXTURES) {
      expect(evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG)).toEqual(
        evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG)
      );
    }
  });

  it("never emits a GPS/identifier key or coordinate value in any detail", () => {
    for (const fx of FIXTURES) {
      const { findings } = evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
      for (const f of findings) {
        for (const [key, value] of Object.entries(f.detail)) {
          expect(key).not.toMatch(/lat|lon|lng|gps|coord|geo|uid|mac|email/i);
          if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });
});
