/**
 * Rule unit tests: `rssi-floor`. Inline pure-data mechanics + corpus checks.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_DIAGNOSTIC_CONFIG, rssiFloorRule } from "@/lib/diagnostics";
import type { DiagnosticFinding } from "@/lib/diagnostics";
import { buildLog, loadAllFixtures, windowsOverlap, WINDOW_TOLERANCE } from "../fixtures";

const run = (channels: Record<string, number[]>): DiagnosticFinding[] =>
  rssiFloorRule.evaluate(buildLog(channels), DEFAULT_DIAGNOSTIC_CONFIG);

describe("rssi-floor — mechanics", () => {
  it("critical on a ≥3-sample run at/below the floor; detail.rssi is the run minimum", () => {
    const findings = run({ rssi1: [-60, -60, -105, -112, -108, -60] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "rssi-floor", category: "signal", severity: "critical" });
    expect(findings[0].evidenceWindow).toEqual({ startIndex: 2, endIndex: 4 });
    expect(findings[0].detail).toEqual({ rssi: -112 });
  });

  it("silent on a 2-sample dip (< minSamples)", () => {
    expect(run({ rssi1: [-60, -105, -112, -60] })).toEqual([]);
  });

  it("silent on chronically marginal RSSI above the floor (−90…−98)", () => {
    expect(run({ rssi1: [-90, -94, -97, -92, -95, -98, -93] })).toEqual([]);
  });

  it("reads the PRIMARY antenna only — a weak rssi2 never trips it", () => {
    // rssi1 strong throughout, rssi2 far below the floor.
    const findings = run({
      rssi1: [-60, -60, -60, -60, -60, -60],
      rssi2: [-130, -130, -130, -130, -130, -130],
    });
    expect(findings).toEqual([]);
  });

  it("two separate floor runs → two findings", () => {
    const findings = run({ rssi1: [-105, -106, -107, -60, -60, -105, -108, -109] });
    expect(findings).toHaveLength(2);
  });
});

describe("rssi-floor — corpus", () => {
  const fixtures = loadAllFixtures();

  it("fires critical on every fixture that expects rssi-floor", () => {
    for (const fx of fixtures) {
      const expected = fx.expectedFindings.filter((e) => e.ruleId === "rssi-floor");
      if (expected.length === 0) continue;
      const findings = rssiFloorRule.evaluate(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
      for (const e of expected) {
        const lo = e.approxWindow.startIndex - WINDOW_TOLERANCE;
        const hi = e.approxWindow.endIndex + WINDOW_TOLERANCE;
        const ok = findings.some(
          (f) =>
            f.severity === "critical" &&
            windowsOverlap(f.evidenceWindow.startIndex, f.evidenceWindow.endIndex, lo, hi)
        );
        expect(ok, `${fx.file}: missing rssi-floor near ${e.approxWindow.startIndex}`).toBe(true);
      }
    }
  });

  it("is silent on healthy fixtures and on fixtures that do NOT expect rssi-floor", () => {
    for (const fx of fixtures) {
      const expectsRssi = fx.expectedFindings.some((e) => e.ruleId === "rssi-floor");
      if (expectsRssi) continue;
      expect(
        rssiFloorRule.evaluate(fx.log, DEFAULT_DIAGNOSTIC_CONFIG),
        `${fx.file} unexpectedly fired rssi-floor`
      ).toEqual([]);
    }
  });
});
