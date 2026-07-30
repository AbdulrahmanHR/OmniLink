/**
 * Diagnostics store tests (M36) — the impure bridge over the pure engine.
 *
 * The store adds no detection logic, so these tests assert wiring, not rule
 * behaviour: that each action calls the right engine function and lands the
 * result in state, that config edits deep-merge / preserve the right siblings,
 * that the live evaluator debounces and the rolling list caps + orders, and that
 * analysis stays deterministic. Inputs are built inline as pure data
 * (anomaly/liveAlerts test style); nothing reads `Date.now`/`Math.random`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DIAGNOSTIC_CONFIG,
  getConfigForPreset,
  LIVE_MIN_FRAMES,
} from "@/lib/diagnostics";
import type { ParsedLog } from "@/lib/blackbox";
import type { TelemetryFrame } from "@/stores/telemetry";
import { LIVE_FINDINGS_CAP, useDiagnosticsStore } from "@/stores/diagnostics";

const store = () => useDiagnosticsStore.getState();

/** Restore the singleton store to a clean, default state between tests. */
beforeEach(() => {
  useDiagnosticsStore.setState({
    config: DEFAULT_DIAGNOSTIC_CONFIG,
    sessionReport: null,
    sessionPatternReport: null,
  });
  store().resetLive();
});

// ---------------------------------------------------------------------------
// Inline pure data (no fixtures needed) — a small synthetic ParsedLog + frames.
// ---------------------------------------------------------------------------

/** Build a minimal {@link ParsedLog} from a `{ key: values[] }` channel map. */
function buildLog(channels: Record<string, number[]>): ParsedLog {
  const keys = Object.keys(channels);
  const sampleCount = keys.length ? channels[keys[0]].length : 0;
  const time = Array.from({ length: sampleCount }, (_, i) => i * 40);
  const logChannels = keys.map((key) => ({ key, label: key, values: channels[key] }));
  const durationMs = sampleCount >= 2 ? time[sampleCount - 1] - time[0] : 0;
  return { source: "omnilog", time, channels: logChannels, sampleCount, durationMs };
}

/**
 * A session that trips `rssi-floor` (a sustained run of rssi1 at/below the −100
 * dBm floor) — healthy on the head/tail so the report has a clear single finding.
 */
function badRssiLog(): ParsedLog {
  const rssi1 = [
    -60, -62, -61, // healthy head
    -104, -106, -108, -107, -105, // sustained sub-floor run (≥ minSamples)
    -63, -60, -62, // healthy tail
  ];
  return buildLog({ rssi1, link_quality: rssi1.map(() => 95), snr: rssi1.map(() => 9) });
}

/**
 * A session (≥ MIN_SAMPLES_FOR_PATTERNS samples) with four link-quality collapses
 * — trips the M38 `repeated-lq-drops` session pattern.
 */
function repeatedDropLog(): ParsedLog {
  const dip = [
    ...new Array(15).fill(95),
    ...new Array(6).fill(10),
    ...new Array(9).fill(95),
  ];
  const lq: number[] = [];
  for (let i = 0; i < 4; i++) lq.push(...dip);
  return buildLog({ link_quality: lq });
}

/** A healthy live frame; override only the metric under test. */
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

// ---------------------------------------------------------------------------
// 1. analyzeSession / clearSessionReport
// ---------------------------------------------------------------------------

describe("analyzeSession / clearSessionReport", () => {
  it("populates sessionReport with findings and a 0–100 health score", () => {
    store().analyzeSession(badRssiLog());
    const report = store().sessionReport;
    expect(report).not.toBeNull();
    expect(report!.findings.length).toBeGreaterThan(0);
    expect(report!.findings.some((f) => f.ruleId === "rssi-floor")).toBe(true);
    expect(report!.healthScore).toBeGreaterThanOrEqual(0);
    expect(report!.healthScore).toBeLessThanOrEqual(100);
  });

  it("clearSessionReport nulls the report", () => {
    store().analyzeSession(badRssiLog());
    expect(store().sessionReport).not.toBeNull();
    store().clearSessionReport();
    expect(store().sessionReport).toBeNull();
  });

  it("analyzeSession also sets sessionPatternReport (M38)", () => {
    store().analyzeSession(repeatedDropLog());
    const patternReport = store().sessionPatternReport;
    expect(patternReport).not.toBeNull();
    expect(patternReport!.hasEnoughEvidence).toBe(true);
    expect(
      patternReport!.patterns.some((p) => p.patternId === "repeated-lq-drops")
    ).toBe(true);
    expect(patternReport!.mostLikely).toBe(patternReport!.patterns[0] ?? null);
  });

  it("clearSessionReport nulls the pattern report too (M38)", () => {
    store().analyzeSession(repeatedDropLog());
    expect(store().sessionPatternReport).not.toBeNull();
    store().clearSessionReport();
    expect(store().sessionPatternReport).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. updateConfig — deep merge
// ---------------------------------------------------------------------------

describe("updateConfig", () => {
  it("deep-merges a single rule threshold and preserves siblings", () => {
    const before = store().config.rules;
    store().updateConfig({ rules: { rssiFloor: { floorDbm: -110 } } });
    const after = store().config.rules;

    // The targeted leaf changed…
    expect(after.rssiFloor.floorDbm).toBe(-110);
    // …its sibling leaf in the same rule is preserved…
    expect(after.rssiFloor.minSamples).toBe(before.rssiFloor.minSamples);
    // …and unrelated rules are untouched (deep-equal to before).
    expect(after.lqCollapse).toEqual(before.lqCollapse);
    expect(after.snrNoise).toEqual(before.snrNoise);
    // The shared default config was not mutated.
    expect(DEFAULT_DIAGNOSTIC_CONFIG.rules.rssiFloor.floorDbm).toBe(-100);
  });
});

// ---------------------------------------------------------------------------
// 3. setSensitivityPreset — swaps thresholds, keeps enabledCategories
// ---------------------------------------------------------------------------

describe("setSensitivityPreset", () => {
  it("swaps thresholds to the preset but KEEPS a toggled category", () => {
    // User disables the "power" category first.
    store().updateConfig({ enabledCategories: { power: false } });
    expect(store().config.enabledCategories.power).toBe(false);

    store().setSensitivityPreset("advanced");

    const advanced = getConfigForPreset("advanced");
    // Thresholds now match the advanced preset…
    expect(store().config.sensitivity).toBe("advanced");
    expect(store().config.rules.snrNoise.stdThreshold).toBe(
      advanced.rules.snrNoise.stdThreshold
    );
    expect(store().config.rules.lqCollapse.slopeDrop).toBe(
      advanced.rules.lqCollapse.slopeDrop
    );
    // …but the user's category toggle survived the preset swap.
    expect(store().config.enabledCategories.power).toBe(false);
    // Other categories stay enabled.
    expect(store().config.enabledCategories.signal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. evaluateLiveFrame — debounce, single append, score, cap + order
// ---------------------------------------------------------------------------

describe("evaluateLiveFrame", () => {
  it("a single bad frame does NOT fire (debounce)", () => {
    store().evaluateLiveFrame(frame({ linkQuality: 96 }));
    store().evaluateLiveFrame(frame({ linkQuality: 40 })); // one bad frame
    store().evaluateLiveFrame(frame({ linkQuality: 96 }));
    expect(store().liveFindings).toHaveLength(0);
  });

  it("N sustained bad frames append exactly one finding", () => {
    const need = LIVE_MIN_FRAMES.lqCollapse;
    store().evaluateLiveFrame(frame({ linkQuality: 96 }));
    for (let i = 0; i < need + 3; i++) {
      store().evaluateLiveFrame(frame({ linkQuality: 40 }));
    }
    const lq = store().liveFindings.filter((f) => f.ruleId === "lq-collapse");
    expect(lq).toHaveLength(1);
  });

  it("updates liveHealthScore each frame", () => {
    store().evaluateLiveFrame(frame()); // healthy
    const healthy = store().liveHealthScore;
    expect(healthy).toBeGreaterThan(0);
    expect(healthy).toBeLessThanOrEqual(100);

    // A clearly bad frame yields a different (lower) score.
    for (let i = 0; i < 4; i++) store().evaluateLiveFrame(frame({ rssi1: -110, linkQuality: 5 }));
    const bad = store().liveHealthScore;
    expect(bad).not.toBe(healthy);
    expect(bad).toBeLessThan(healthy);
    expect(bad).toBeGreaterThanOrEqual(0);
  });

  it("caps liveFindings at LIVE_FINDINGS_CAP and keeps newest-first", () => {
    const need = LIVE_MIN_FRAMES.rssiFloor;
    const cycles = LIVE_FINDINGS_CAP + 5;
    // Each cycle re-fires rssi-floor once: `need` sub-floor frames (a deeper
    // floor each cycle so findings are distinguishable) then `need` recovery
    // frames to clear and re-arm.
    for (let k = 0; k < cycles; k++) {
      for (let i = 0; i < need; i++) store().evaluateLiveFrame(frame({ rssi1: -101 - k }));
      for (let i = 0; i < need; i++) store().evaluateLiveFrame(frame({ rssi1: -60 }));
    }
    const findings = store().liveFindings;
    // Capped, never grows past the cap.
    expect(findings).toHaveLength(LIVE_FINDINGS_CAP);
    expect(findings.every((f) => f.ruleId === "rssi-floor")).toBe(true);
    // Newest-first: the head is the most-recent cycle (deepest floor).
    expect(findings[0].detail.rssi).toBe(-101 - (cycles - 1));
    // Strictly more-negative toward the head (newest) than at the tail (oldest).
    expect(Number(findings[0].detail.rssi)).toBeLessThan(
      Number(findings[findings.length - 1].detail.rssi)
    );
  });
});

// ---------------------------------------------------------------------------
// 5. resetLive
// ---------------------------------------------------------------------------

describe("resetLive", () => {
  it("clears liveState/liveFindings and restores liveHealthScore to 100", () => {
    const need = LIVE_MIN_FRAMES.rssiFloor;
    for (let i = 0; i < need + 2; i++) store().evaluateLiveFrame(frame({ rssi1: -110 }));
    expect(store().liveFindings.length).toBeGreaterThan(0);
    expect(store().liveState.frameIndex).toBeGreaterThanOrEqual(0);

    store().resetLive();

    expect(store().liveFindings).toHaveLength(0);
    expect(store().liveHealthScore).toBe(100);
    expect(store().liveState.frameIndex).toBe(-1);
    expect(store().liveState.rssiFloor.phase).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 6. Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("analyzing the same log twice yields deep-equal reports", () => {
    const log = badRssiLog();
    store().analyzeSession(log);
    const first = store().sessionReport;
    store().clearSessionReport();
    store().analyzeSession(log);
    const second = store().sessionReport;
    expect(second).toEqual(first);
  });
});
