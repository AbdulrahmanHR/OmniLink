/**
 * Rule unit tests: `packet-instability`. Inline mechanics + corpus checks.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_DIAGNOSTIC_CONFIG, packetInstabilityRule } from "@/lib/diagnostics";
import type { DiagnosticFinding } from "@/lib/diagnostics";
import { buildLog, loadAllFixtures, windowsOverlap, WINDOW_TOLERANCE } from "../fixtures";

const run = (packet_rate: number[]): DiagnosticFinding[] =>
  packetInstabilityRule.evaluate(buildLog({ packet_rate }), DEFAULT_DIAGNOSTIC_CONFIG);

/** A jittery packet-rate span oscillating across three rates. */
function jitter(n: number): number[] {
  const rates = [150, 250, 500];
  return Array.from({ length: n }, (_, i) => rates[i % 3]);
}

describe("packet-instability — mechanics", () => {
  it("warning on a sustained packet-rate jitter window", () => {
    const pr = [...Array.from({ length: 30 }, () => 250), ...jitter(60), ...Array.from({ length: 30 }, () => 250)];
    const findings = run(pr);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]).toMatchObject({ ruleId: "packet-instability", category: "stability", severity: "warning" });
    expect(typeof findings[0].detail.changes).toBe("number");
    expect(findings[0].detail.window).toBe(DEFAULT_DIAGNOSTIC_CONFIG.rules.packetInstability.window);
  });

  it("silent on a constant healthy packet rate", () => {
    expect(run(Array.from({ length: 120 }, () => 250))).toEqual([]);
  });

  it("one finding per contiguous jitter window", () => {
    const pr = [...Array.from({ length: 25 }, () => 250), ...jitter(80), ...Array.from({ length: 25 }, () => 250)];
    expect(run(pr)).toHaveLength(1);
  });
});

describe("packet-instability — corpus", () => {
  const fixtures = loadAllFixtures();

  it("fires warning on every fixture that expects packet-instability", () => {
    for (const fx of fixtures) {
      const expected = fx.expectedFindings.filter((e) => e.ruleId === "packet-instability");
      if (expected.length === 0) continue;
      const findings = packetInstabilityRule.evaluate(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
      for (const e of expected) {
        const lo = e.approxWindow.startIndex - WINDOW_TOLERANCE;
        const hi = e.approxWindow.endIndex + WINDOW_TOLERANCE;
        const ok = findings.some(
          (f) =>
            f.severity === "warning" &&
            windowsOverlap(f.evidenceWindow.startIndex, f.evidenceWindow.endIndex, lo, hi)
        );
        expect(ok, `${fx.file}: missing packet-instability near ${e.approxWindow.startIndex}`).toBe(true);
      }
    }
  });

  it("is silent on every healthy fixture", () => {
    for (const fx of fixtures.filter((f) => f.label === "healthy")) {
      expect(packetInstabilityRule.evaluate(fx.log, DEFAULT_DIAGNOSTIC_CONFIG)).toEqual([]);
    }
  });
});
