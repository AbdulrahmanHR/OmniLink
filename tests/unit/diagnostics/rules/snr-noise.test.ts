/**
 * Rule unit tests: `snr-noise`. Inline pure-data mechanics + corpus checks.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_DIAGNOSTIC_CONFIG, snrNoiseRule } from "@/lib/diagnostics";
import type { DiagnosticFinding } from "@/lib/diagnostics";
import { buildLog, loadAllFixtures, windowsOverlap, WINDOW_TOLERANCE } from "../fixtures";

const run = (snr: number[]): DiagnosticFinding[] =>
  snrNoiseRule.evaluate(buildLog({ snr }), DEFAULT_DIAGNOSTIC_CONFIG);

/** A noisy SNR span: alternating ±9 dB swing for `n` samples. */
function noisy(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 10 : -8));
}

describe("snr-noise — mechanics", () => {
  it("warning on a sustained high-variance SNR window", () => {
    const snr = [...Array.from({ length: 30 }, () => 8), ...noisy(40), ...Array.from({ length: 30 }, () => 8)];
    const findings = run(snr);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]).toMatchObject({ ruleId: "snr-noise", category: "signal", severity: "warning" });
    expect(typeof findings[0].detail.stdDev).toBe("number");
    expect(findings[0].detail.window).toBe(DEFAULT_DIAGNOSTIC_CONFIG.rules.snrNoise.window);
  });

  it("merges a contiguous noisy span into one finding", () => {
    const snr = [...Array.from({ length: 20 }, () => 8), ...noisy(60), ...Array.from({ length: 20 }, () => 8)];
    expect(run(snr)).toHaveLength(1);
  });

  it("silent on low-variance healthy SNR", () => {
    expect(run(Array.from({ length: 120 }, (_, i) => 8 + (i % 3) * 0.2))).toEqual([]);
  });
});

describe("snr-noise — corpus", () => {
  const fixtures = loadAllFixtures();

  it("fires warning on every fixture that expects snr-noise", () => {
    for (const fx of fixtures) {
      const expected = fx.expectedFindings.filter((e) => e.ruleId === "snr-noise");
      if (expected.length === 0) continue;
      const findings = snrNoiseRule.evaluate(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
      for (const e of expected) {
        const lo = e.approxWindow.startIndex - WINDOW_TOLERANCE;
        const hi = e.approxWindow.endIndex + WINDOW_TOLERANCE;
        const ok = findings.some(
          (f) =>
            f.severity === "warning" &&
            windowsOverlap(f.evidenceWindow.startIndex, f.evidenceWindow.endIndex, lo, hi)
        );
        expect(ok, `${fx.file}: missing snr-noise near ${e.approxWindow.startIndex}`).toBe(true);
      }
    }
  });

  it("is silent on every healthy fixture", () => {
    for (const fx of fixtures.filter((f) => f.label === "healthy")) {
      expect(snrNoiseRule.evaluate(fx.log, DEFAULT_DIAGNOSTIC_CONFIG)).toEqual([]);
    }
  });
});
