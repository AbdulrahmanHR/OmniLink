/**
 * M40 per-session history summary — PURE.
 *
 * Holds {@link computeSessionSignature} + {@link summarizeSessionForHistory} to
 * their contract: a stable content signature that distinguishes genuinely
 * different sessions, correct rule/pattern/packet-rate rollups off the real M36 +
 * M38 engine over inline `buildLog` sessions, and determinism (same inputs →
 * deep-equal summary). Runs under the node vitest env like the rest of the corpus.
 */

import { describe, expect, it } from "vitest";
import type { ParsedLog } from "@/lib/blackbox";
import {
  computeSessionSignature,
  DEFAULT_DIAGNOSTIC_CONFIG,
  detectSessionPatterns,
  evaluateSession,
  summarizeSessionForHistory,
} from "@/lib/diagnostics";
import { buildLog } from "./fixtures";

/** A session with four LQ collapses → findings + a `repeated-lq-drops` pattern. */
function collapseLog(packetRate = 250): ParsedLog {
  const dip = [
    ...new Array(15).fill(95),
    ...new Array(6).fill(8),
    ...new Array(9).fill(95),
  ];
  const lq: number[] = [];
  for (let i = 0; i < 4; i++) lq.push(...dip);
  return buildLog({
    link_quality: lq,
    tx_power: lq.map((q) => (q < 50 ? 250 : 100)),
    packet_rate: lq.map(() => packetRate),
  });
}

/** A clean healthy session — no findings, no patterns. */
function healthyLog(): ParsedLog {
  const lq = new Array(120).fill(96);
  return buildLog({
    link_quality: lq,
    rssi1: lq.map(() => -55),
    snr: lq.map(() => 10),
    packet_rate: lq.map(() => 150),
  });
}

function summarize(log: ParsedLog) {
  const report = evaluateSession(log, DEFAULT_DIAGNOSTIC_CONFIG);
  const patternReport = detectSessionPatterns(log, report);
  return summarizeSessionForHistory(report, patternReport, log);
}

describe("computeSessionSignature", () => {
  it("is stable for the same loaded log", () => {
    const log = collapseLog();
    expect(computeSessionSignature(log)).toBe(computeSessionSignature(log));
  });

  it("encodes source, sample count, duration, endpoints, and a content checksum", () => {
    const log = collapseLog();
    const sig = computeSessionSignature(log);
    // The five-field shape prefix…
    expect(
      sig.startsWith(
        `omnilog|${log.sampleCount}|${log.durationMs}|${log.time[0]}|${
          log.time[log.time.length - 1]
        }|`
      )
    ).toBe(true);
    // …plus a trailing content checksum = six pipe-separated segments.
    expect(sig.split("|")).toHaveLength(6);
  });

  it("distinguishes sessions of different length", () => {
    const a = buildLog({ link_quality: new Array(50).fill(90) });
    const b = buildLog({ link_quality: new Array(60).fill(90) });
    expect(computeSessionSignature(a)).not.toBe(computeSessionSignature(b));
  });

  it("distinguishes two same-shape sessions by channel content (no dedupe collision)", () => {
    // Same sampleCount + relative (start-0) time axis + duration, but different
    // channel values — the shape prefix alone would collide; the checksum must not.
    const n = 80;
    const a = buildLog({
      link_quality: new Array(n).fill(95),
      rssi1: new Array(n).fill(-55),
    });
    const b = buildLog({
      link_quality: new Array(n).fill(40),
      rssi1: new Array(n).fill(-95),
    });
    // Identical shape prefix (first five fields)…
    expect(computeSessionSignature(a).split("|").slice(0, 5)).toEqual(
      computeSessionSignature(b).split("|").slice(0, 5)
    );
    // …but DISTINCT full signatures (the content checksum differs), so
    // recordSession keeps BOTH rather than silently dropping one.
    expect(computeSessionSignature(a)).not.toBe(computeSessionSignature(b));
  });

  it("coerces an empty log's endpoints to 0 (no crash)", () => {
    const empty = buildLog({});
    const sig = computeSessionSignature(empty);
    expect(sig.startsWith("omnilog|0|0|0|0|")).toBe(true);
    expect(sig.split("|")).toHaveLength(6);
  });
});

describe("summarizeSessionForHistory", () => {
  it("tallies findings into ruleCounts and lists sorted, deduped patternIds", () => {
    const summary = summarize(collapseLog());
    // The collapse fixture trips lq-collapse findings…
    expect(summary.ruleCounts["lq-collapse"]).toBeGreaterThan(0);
    // …and the M38 repeated-lq-drops pattern.
    expect(summary.patternIds).toContain("repeated-lq-drops");
    // patternIds is sorted + unique.
    expect(summary.patternIds).toEqual(
      [...new Set(summary.patternIds)].sort()
    );
    // Health score is a real 0–100 number.
    expect(summary.healthScore).toBeGreaterThanOrEqual(0);
    expect(summary.healthScore).toBeLessThanOrEqual(100);
  });

  it("reports the median packet rate, or null when the channel is absent", () => {
    expect(summarize(collapseLog(250)).packetRate).toBe(250);
    const noPacket = buildLog({ link_quality: new Array(80).fill(94) });
    expect(summarize(noPacket).packetRate).toBeNull();
  });

  it("carries a clean summary for a healthy session (no findings/patterns)", () => {
    const summary = summarize(healthyLog());
    expect(summary.ruleCounts).toEqual({});
    expect(summary.patternIds).toEqual([]);
    expect(summary.countsBySeverity).toEqual({ info: 0, warning: 0, critical: 0 });
    expect(summary.source).toBe("omnilog");
    expect(summary.packetRate).toBe(150);
  });

  it("is deterministic — the same session summarizes deep-equal", () => {
    const log = collapseLog();
    expect(summarize(log)).toEqual(summarize(log));
  });

  it("includes the content signature", () => {
    const log = collapseLog();
    expect(summarize(log).signature).toBe(computeSessionSignature(log));
  });
});
