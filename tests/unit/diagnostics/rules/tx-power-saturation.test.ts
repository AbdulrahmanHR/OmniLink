/**
 * Rule unit tests: `tx-power-saturation`. Inline mechanics + corpus checks.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_DIAGNOSTIC_CONFIG, txPowerSaturationRule } from "@/lib/diagnostics";
import type { DiagnosticFinding } from "@/lib/diagnostics";
import { buildLog, loadAllFixtures, windowsOverlap, WINDOW_TOLERANCE } from "../fixtures";

const run = (channels: Record<string, number[]>): DiagnosticFinding[] =>
  txPowerSaturationRule.evaluate(buildLog(channels), DEFAULT_DIAGNOSTIC_CONFIG);

const fill = (n: number, v: number): number[] => Array.from({ length: n }, () => v);

describe("tx-power-saturation — mechanics", () => {
  it("warning when TX pinned at 500 mW while RSSI is poor", () => {
    const findings = run({ tx_power: fill(40, 500), rssi1: fill(40, -94), link_quality: fill(40, 72) });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "tx-power-saturation", category: "power", severity: "warning" });
    expect(findings[0].detail.txPower).toBe(500);
    expect(typeof findings[0].detail.avgRssi).toBe("number");
  });

  it("warning when TX pinned at max while LQ is degraded (even if RSSI is okay)", () => {
    const findings = run({ tx_power: fill(40, 500), rssi1: fill(40, -82), link_quality: fill(40, 70) });
    expect(findings).toHaveLength(1);
  });

  it("silent when TX is high but the link is GOOD (saturated but not signal-limited)", () => {
    // Mirrors failsafe-after-warning: 500 mW but mean rssi −83 / LQ 83.
    expect(run({ tx_power: fill(40, 500), rssi1: fill(40, -83), link_quality: fill(40, 83) })).toEqual([]);
  });

  it("silent when TX is not at the max step", () => {
    expect(run({ tx_power: fill(40, 250), rssi1: fill(40, -95), link_quality: fill(40, 70) })).toEqual([]);
  });
});

describe("tx-power-saturation — corpus", () => {
  const fixtures = loadAllFixtures();

  it("fires warning on every fixture that expects tx-power-saturation", () => {
    for (const fx of fixtures) {
      const expected = fx.expectedFindings.filter((e) => e.ruleId === "tx-power-saturation");
      if (expected.length === 0) continue;
      const findings = txPowerSaturationRule.evaluate(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
      for (const e of expected) {
        const lo = e.approxWindow.startIndex - WINDOW_TOLERANCE;
        const hi = e.approxWindow.endIndex + WINDOW_TOLERANCE;
        const ok = findings.some(
          (f) =>
            f.severity === "warning" &&
            windowsOverlap(f.evidenceWindow.startIndex, f.evidenceWindow.endIndex, lo, hi)
        );
        expect(ok, `${fx.file}: missing tx-power-saturation near ${e.approxWindow.startIndex}`).toBe(true);
      }
    }
  });

  it("is silent on healthy fixtures and on the saturated-but-healthy failsafe-after-warning case", () => {
    for (const fx of fixtures) {
      const expectsTx = fx.expectedFindings.some((e) => e.ruleId === "tx-power-saturation");
      if (expectsTx) continue;
      expect(
        txPowerSaturationRule.evaluate(fx.log, DEFAULT_DIAGNOSTIC_CONFIG),
        `${fx.file} unexpectedly fired tx-power-saturation`
      ).toEqual([]);
    }
  });
});
