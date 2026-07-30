/**
 * M40 cross-session trend aggregation — PURE.
 *
 * Seeds inline {@link DiagnosticHistoryRecord}[] (no engine, no fixtures) and holds
 * {@link summarizeTrends} to its contract: per-device grouping (incl. the unknown
 * bucket), oldest→newest health series, repeated-event recurrence (≥2 sessions),
 * weak-RF-mode detection, the `hasEnoughHistory` boundary at MIN_SESSIONS_FOR_TRENDS,
 * deterministic ordering, and the honest empty case.
 */

import { describe, expect, it } from "vitest";
import {
  MIN_SESSIONS_FOR_TRENDS,
  summarizeTrends,
  type DiagnosticHistoryRecord,
} from "@/lib/diagnostics";

let seq = 0;
/** Build a history record; sensible defaults, override per test. */
function rec(over: Partial<DiagnosticHistoryRecord> = {}): DiagnosticHistoryRecord {
  seq += 1;
  return {
    signature: `sig-${seq}`,
    source: "omnilog",
    sampleCount: 100,
    durationMs: 4000,
    healthScore: 90,
    countsBySeverity: { info: 0, warning: 0, critical: 0 },
    ruleCounts: {},
    patternIds: [],
    packetRate: null,
    recordedAt: seq * 1000,
    deviceKey: "dev-a|fw-1",
    deviceLabel: "dev-a",
    ...over,
  };
}

describe("summarizeTrends — honest empty / not-enough", () => {
  it("returns an empty, honest report for no records (no fabrication)", () => {
    const report = summarizeTrends([]);
    expect(report).toEqual({
      hasEnoughHistory: false,
      sessionCount: 0,
      devices: [],
    });
  });

  it("hasEnoughHistory flips exactly at MIN_SESSIONS_FOR_TRENDS", () => {
    const below = Array.from({ length: MIN_SESSIONS_FOR_TRENDS - 1 }, () => rec());
    const at = Array.from({ length: MIN_SESSIONS_FOR_TRENDS }, () => rec());
    expect(summarizeTrends(below).hasEnoughHistory).toBe(false);
    expect(summarizeTrends(at).hasEnoughHistory).toBe(true);
    // Devices still aggregate below the threshold (the page gates display, not us).
    expect(summarizeTrends(below).sessionCount).toBe(MIN_SESSIONS_FOR_TRENDS - 1);
  });
});

describe("summarizeTrends — per-device grouping", () => {
  it("groups by deviceKey and buckets null into an unknown device (sorted, null last)", () => {
    const report = summarizeTrends([
      rec({ deviceKey: "b|fw", deviceLabel: "b" }),
      rec({ deviceKey: null, deviceLabel: null }),
      rec({ deviceKey: "a|fw", deviceLabel: "a" }),
      rec({ deviceKey: "a|fw", deviceLabel: "a" }),
    ]);
    expect(report.devices.map((d) => d.deviceKey)).toEqual([
      "a|fw",
      "b|fw",
      null,
    ]);
    const a = report.devices.find((d) => d.deviceKey === "a|fw")!;
    expect(a.sessionCount).toBe(2);
    const unknown = report.devices.find((d) => d.deviceKey === null)!;
    expect(unknown.deviceLabel).toBeNull();
    expect(unknown.sessionCount).toBe(1);
  });

  it("orders healthSeries oldest→newest by recordedAt (regardless of input order)", () => {
    const report = summarizeTrends([
      rec({ recordedAt: 300, healthScore: 30 }),
      rec({ recordedAt: 100, healthScore: 10 }),
      rec({ recordedAt: 200, healthScore: 20 }),
    ]);
    const d = report.devices[0];
    expect(d.healthSeries).toEqual([10, 20, 30]);
    expect(d.avgHealth).toBe(20);
  });
});

describe("summarizeTrends — repeated events", () => {
  it("surfaces a rule recurring in ≥2 sessions and omits a one-off", () => {
    const report = summarizeTrends([
      rec({ ruleCounts: { "rssi-floor": 2, "snr-noise": 1 } }),
      rec({ ruleCounts: { "rssi-floor": 1 } }),
      rec({ ruleCounts: { "lq-collapse": 1 } }),
    ]);
    const events = report.devices[0].repeatedEvents;
    const rssi = events.find((e) => e.id === "rssi-floor");
    expect(rssi).toEqual({ kind: "rule", id: "rssi-floor", sessions: 2 });
    // snr-noise + lq-collapse appear once each → not repeated.
    expect(events.some((e) => e.id === "snr-noise")).toBe(false);
    expect(events.some((e) => e.id === "lq-collapse")).toBe(false);
  });

  it("counts a rule once per session even with many findings in that session", () => {
    const report = summarizeTrends([
      rec({ ruleCounts: { "rssi-floor": 9 } }),
      rec({ ruleCounts: { "rssi-floor": 4 } }),
    ]);
    expect(report.devices[0].repeatedEvents[0].sessions).toBe(2);
  });

  it("surfaces recurring patterns tagged kind:pattern, desc by sessions", () => {
    const report = summarizeTrends([
      rec({ patternIds: ["repeated-lq-drops", "heading-degradation"] }),
      rec({ patternIds: ["repeated-lq-drops", "heading-degradation"] }),
      rec({ patternIds: ["repeated-lq-drops"] }),
    ]);
    const events = report.devices[0].repeatedEvents;
    expect(events[0]).toEqual({
      kind: "pattern",
      id: "repeated-lq-drops",
      sessions: 3,
    });
    expect(events).toContainEqual({
      kind: "pattern",
      id: "heading-degradation",
      sessions: 2,
    });
    // Sorted descending by sessions.
    expect(events[0].sessions).toBeGreaterThanOrEqual(events[1].sessions);
  });
});

describe("summarizeTrends — weak RF modes", () => {
  it("flags a packet rate that runs weak across ≥2 sessions", () => {
    const report = summarizeTrends([
      rec({ packetRate: 500, healthScore: 55 }),
      rec({ packetRate: 500, healthScore: 65 }),
      rec({ packetRate: 150, healthScore: 95 }), // healthy, different rate
    ]);
    const weak = report.devices[0].weakRfModes;
    expect(weak).toHaveLength(1);
    expect(weak[0]).toEqual({ packetRate: 500, sessions: 2, avgHealth: 60 });
  });

  it("does NOT flag a packet rate whose mean health stays healthy", () => {
    const report = summarizeTrends([
      rec({ packetRate: 500, healthScore: 88 }),
      rec({ packetRate: 500, healthScore: 92 }),
    ]);
    expect(report.devices[0].weakRfModes).toEqual([]);
  });

  it("ignores a weak rate seen only once (no recurrence)", () => {
    const report = summarizeTrends([
      rec({ packetRate: 500, healthScore: 40 }),
      rec({ packetRate: 150, healthScore: 40 }),
    ]);
    expect(report.devices[0].weakRfModes).toEqual([]);
  });

  it("skips null packet rates entirely", () => {
    const report = summarizeTrends([
      rec({ packetRate: null, healthScore: 30 }),
      rec({ packetRate: null, healthScore: 30 }),
    ]);
    expect(report.devices[0].weakRfModes).toEqual([]);
  });
});

describe("summarizeTrends — determinism", () => {
  it("breaks equal-recordedAt ties deterministically (reorder-invariant health series)", () => {
    const r1 = rec({ deviceKey: "x|1", recordedAt: 5, healthScore: 11, signature: "aaa" });
    const r2 = rec({ deviceKey: "x|1", recordedAt: 5, healthScore: 22, signature: "bbb" });
    const forward = summarizeTrends([r1, r2]).devices[0].healthSeries;
    const reversed = summarizeTrends([r2, r1]).devices[0].healthSeries;
    expect(reversed).toEqual(forward);
    // Tie broken by signature ascending → aaa(11) before bbb(22).
    expect(forward).toEqual([11, 22]);
  });

  it("produces a deep-equal report regardless of input order", () => {
    const records = [
      rec({ deviceKey: "z|1", recordedAt: 5, healthScore: 50 }),
      rec({ deviceKey: null, recordedAt: 2, healthScore: 60 }),
      rec({ deviceKey: "a|1", recordedAt: 9, healthScore: 70, ruleCounts: { "rssi-floor": 1 } }),
      rec({ deviceKey: "a|1", recordedAt: 1, healthScore: 80, ruleCounts: { "rssi-floor": 1 } }),
    ];
    const forward = summarizeTrends(records);
    const reversed = summarizeTrends([...records].reverse());
    expect(reversed).toEqual(forward);
  });
});
