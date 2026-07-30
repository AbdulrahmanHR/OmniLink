/**
 * Health-score tests: reproducibility, healthy/failsafe calibration bounds, and
 * monotonic sanity on hand-built frames.
 */

import { describe, expect, it } from "vitest";
import {
  computeHealthScore,
  computeSessionHealthScore,
  DEFAULT_HEALTH_SCORE_CONFIG,
} from "@/lib/diagnostics";
import type { ParsedLog } from "@/lib/blackbox";
import type { TelemetryFrame } from "@/stores/telemetry";
import { loadAllFixtures } from "./fixtures";

const FIXTURES = loadAllFixtures();
const CFG = DEFAULT_HEALTH_SCORE_CONFIG;

/** One telemetry frame with healthy defaults, overridable per test. */
function frame(over: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    t: 0,
    rssi1: -60,
    rssi2: -64,
    linkQuality: 96,
    snr: 9,
    txPower: 100,
    packetRate: 250,
    antennas: [],
    ...over,
  };
}

describe("computeHealthScore — frame level", () => {
  it("is in [0, 100] and reproducible", () => {
    const f = frame();
    const a = computeHealthScore(f, CFG);
    const b = computeHealthScore(f, CFG);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(100);
  });

  it("a strong link scores high; a dropout frame scores very low", () => {
    expect(computeHealthScore(frame(), CFG)).toBeGreaterThanOrEqual(85);
    const dropout = frame({ linkQuality: 0, rssi1: -118, rssi2: -116, snr: -5 });
    expect(computeHealthScore(dropout, CFG)).toBeLessThanOrEqual(30);
  });

  it("monotonic: progressively worse link quality ⇒ non-increasing score", () => {
    const scores = [96, 80, 60, 40, 20, 0].map((lq) => computeHealthScore(frame({ linkQuality: lq }), CFG));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it("monotonic: progressively weaker RSSI ⇒ non-increasing score", () => {
    const scores = [-55, -70, -85, -95, -105, -115].map((r) =>
      computeHealthScore(frame({ rssi1: r, rssi2: r - 4 }), CFG)
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it("link quality dominates: a low-LQ frame scores below a strong-RSSI/low-LQ trade", () => {
    const goodLqWeakRssi = computeHealthScore(frame({ linkQuality: 95, rssi1: -82, rssi2: -85 }), CFG);
    const badLqStrongRssi = computeHealthScore(frame({ linkQuality: 35, rssi1: -55, rssi2: -58 }), CFG);
    expect(goodLqWeakRssi).toBeGreaterThan(badLqStrongRssi);
  });
});

describe("computeSessionHealthScore — calibration on the corpus", () => {
  it("every healthy fixture's overall score is ≥ 85", () => {
    for (const fx of FIXTURES.filter((f) => f.label === "healthy")) {
      const { overall } = computeSessionHealthScore(fx.log, CFG);
      expect(overall, `${fx.file} scored ${overall.toFixed(1)}`).toBeGreaterThanOrEqual(85);
    }
  });

  it("every failsafe fixture has at least one window ≤ 30", () => {
    for (const fx of FIXTURES.filter((f) => f.label === "failsafe")) {
      const { perWindow } = computeSessionHealthScore(fx.log, CFG);
      expect(Math.min(...perWindow), `${fx.file} min window`).toBeLessThanOrEqual(30);
    }
  });

  it("is reproducible across two runs (deep-equal)", () => {
    for (const fx of FIXTURES) {
      expect(computeSessionHealthScore(fx.log, CFG)).toEqual(computeSessionHealthScore(fx.log, CFG));
    }
  });

  it("an empty log returns a neutral overall of 100 with no windows", () => {
    const empty = { source: "omnilog" as const, time: [], channels: [], sampleCount: 0, durationMs: 0 };
    expect(computeSessionHealthScore(empty, CFG)).toEqual({ overall: 100, perWindow: [] });
  });

  it("healthy overalls sit clearly above failsafe overalls", () => {
    const healthy = FIXTURES.filter((f) => f.label === "healthy").map(
      (f) => computeSessionHealthScore(f.log, CFG).overall
    );
    const failsafeMins = FIXTURES.filter((f) => f.label === "failsafe").map(
      (f) => Math.min(...computeSessionHealthScore(f.log, CFG).perWindow)
    );
    expect(Math.min(...healthy)).toBeGreaterThan(Math.max(...failsafeMins));
  });
});

/** Build a minimal {@link ParsedLog} from per-channel value arrays (an omitted
 * channel is genuinely ABSENT, not zero-filled). */
function buildLog(channels: Record<string, number[]>, n: number): ParsedLog {
  return {
    source: "omnilog",
    time: Array.from({ length: n }, (_, i) => i * 40),
    channels: Object.entries(channels).map(([key, values]) => ({
      key,
      label: key,
      values,
    })),
    sampleCount: n,
    durationMs: n > 0 ? (n - 1) * 40 : 0,
  };
}

describe("computeSessionHealthScore — honesty (absent channels & masking)", () => {
  it("a strong-RSSI log with NO link-quality channel scores high, not 0", () => {
    // FIX 2: absent channels are NEUTRAL, not worst-case — a log that simply
    // lacks the LQ channel must not read a contradictory 0/100 with no findings.
    const n = 24;
    const log = buildLog({ rssi1: Array.from({ length: n }, () => -55) }, n);
    const { overall } = computeSessionHealthScore(log, CFG);
    expect(overall).toBeGreaterThan(75);
  });

  it("a 50% healthy / 50% sustained-loss session scores below the good band (<75)", () => {
    // FIX 1: the floored window weight stops a near-zero-LQ loss half from being
    // discounted to ~0 weight and masked behind the healthy half.
    const half = 12;
    const n = half * 2;
    const lq = [
      ...Array.from({ length: half }, () => 96),
      ...Array.from({ length: half }, () => 0),
    ];
    const rssi1 = [
      ...Array.from({ length: half }, () => -55),
      ...Array.from({ length: half }, () => -118),
    ];
    const { overall } = computeSessionHealthScore(buildLog({ link_quality: lq, rssi1 }, n), CFG);
    expect(overall).toBeLessThan(75);
  });
});
