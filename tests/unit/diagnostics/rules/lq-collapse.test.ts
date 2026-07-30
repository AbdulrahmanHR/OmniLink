/**
 * Rule unit tests: `lq-collapse`. Inline pure-data mechanics + corpus checks.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_DIAGNOSTIC_CONFIG, lqCollapseRule } from "@/lib/diagnostics";
import type { DiagnosticFinding } from "@/lib/diagnostics";
import { buildLog, loadAllFixtures, windowsOverlap, WINDOW_TOLERANCE } from "../fixtures";

const run = (channels: Record<string, number[]>): DiagnosticFinding[] =>
  lqCollapseRule.evaluate(buildLog(channels), DEFAULT_DIAGNOSTIC_CONFIG);

describe("lq-collapse — mechanics", () => {
  it("warning on a sharp dip into the 50s that recovers", () => {
    const findings = run({ link_quality: [90, 90, 90, 90, 55, 55, 55, 90, 90, 90] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "lq-collapse", category: "link", severity: "warning" });
    expect(findings[0].detail).toEqual({ from: 90, to: 55 });
  });

  it("critical when the bottom reaches ≤ criticalTo (LQ → 0)", () => {
    const findings = run({ link_quality: [95, 95, 95, 0, 0, 0, 95, 95] });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].detail).toEqual({ from: 95, to: 0 });
  });

  it("owns the LQ→0 collapse as critical (does not cede to a failsafe detector)", () => {
    const findings = run({ link_quality: [98, 98, 0, 0, 0, 0, 98] });
    expect(findings.map((f) => f.severity)).toEqual(["critical"]);
  });

  it("debounce: one sustained drop → exactly one finding", () => {
    const findings = run({ link_quality: [95, 95, 30, 30, 30, 30, 30, 30] });
    expect(findings).toHaveLength(1);
  });

  it("re-arms after recovery: two separate dips → two findings", () => {
    const findings = run({ link_quality: [95, 95, 30, 30, 95, 95, 95, 30, 30, 95] });
    expect(findings).toHaveLength(2);
  });

  it("silent on healthy jitter that never drops sharply or below the floor", () => {
    expect(run({ link_quality: [95, 93, 96, 94, 92, 95, 93, 97] })).toEqual([]);
  });

  it("confidence is higher for a deeper drop", () => {
    const shallow = run({ link_quality: [90, 90, 55, 55, 90] })[0].confidence;
    const deep = run({ link_quality: [90, 90, 0, 0, 90] })[0].confidence;
    expect(deep).toBeGreaterThan(shallow);
  });
});

describe("lq-collapse — corpus", () => {
  const fixtures = loadAllFixtures();

  it("fires (with matching severity) on every fixture that expects lq-collapse", () => {
    for (const fx of fixtures) {
      const expected = fx.expectedFindings.filter((e) => e.ruleId === "lq-collapse");
      if (expected.length === 0) continue;
      const findings = lqCollapseRule.evaluate(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
      for (const e of expected) {
        const lo = e.approxWindow.startIndex - WINDOW_TOLERANCE;
        const hi = e.approxWindow.endIndex + WINDOW_TOLERANCE;
        const ok = findings.some(
          (f) =>
            f.severity === e.severity &&
            windowsOverlap(f.evidenceWindow.startIndex, f.evidenceWindow.endIndex, lo, hi)
        );
        expect(ok, `${fx.file}: missing ${e.severity} lq-collapse near ${e.approxWindow.startIndex}`).toBe(true);
      }
    }
  });

  it("is silent on every healthy fixture", () => {
    for (const fx of fixtures.filter((f) => f.label === "healthy")) {
      expect(lqCollapseRule.evaluate(fx.log, DEFAULT_DIAGNOSTIC_CONFIG)).toEqual([]);
    }
  });
});
