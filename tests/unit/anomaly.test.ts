import { describe, expect, it } from "vitest";
import type { LogChannel, LogGpsFix, ParsedLog } from "@/lib/blackbox";
import { isSensitiveChannel } from "@/lib/log-range-summary";
import {
  type AnomalyEvent,
  DEFAULT_ANOMALY_CONFIG,
  detectAnomalies,
} from "@/lib/anomaly";

// ---------------------------------------------------------------------------
// Fixture helper — hand-build a valid ParsedLog from channel arrays + a time
// axis, keeping sampleCount / durationMs / per-channel length all consistent.
// ---------------------------------------------------------------------------

interface BuildOptions {
  /** Explicit time axis; defaults to 0,100,200,... aligned to the channels. */
  time?: number[];
  /** Optional GPS track (kept out of channels, as in the real model). */
  gps?: Array<LogGpsFix | null>;
  /** Per-key human labels; defaults each label to its key. */
  labels?: Record<string, string>;
}

/** Build a ParsedLog from a `{ key: values[] }` map. */
function buildLog(channels: Record<string, number[]>, opts: BuildOptions = {}): ParsedLog {
  const keys = Object.keys(channels);
  const sampleCount = opts.time ? opts.time.length : keys.length ? channels[keys[0]].length : 0;
  const time = opts.time ?? Array.from({ length: sampleCount }, (_, i) => i * 100);
  const logChannels: LogChannel[] = keys.map((key) => ({
    key,
    label: opts.labels?.[key] ?? key,
    values: channels[key],
  }));
  const durationMs = sampleCount >= 2 ? time[sampleCount - 1] - time[0] : 0;
  const log: ParsedLog = { source: "blackbox", time, channels: logChannels, sampleCount, durationMs };
  if (opts.gps) log.gps = opts.gps;
  return log;
}

// ---------------------------------------------------------------------------
// Detector 1 — signalLoss
// ---------------------------------------------------------------------------

describe("detectAnomalies — signalLoss", () => {
  it("POSITIVE: a >=3-sample run at/below the RSSI floor → one critical event at the run minimum", () => {
    // run at indices 2,3,4; minimum -110 at index 3.
    const log = buildLog({ rssi1: [-50, -50, -105, -110, -108, -50] });
    const events = detectAnomalies(log);

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe("signalLoss");
    expect(e.severity).toBe("critical");
    expect(e.messageKey).toBe("anomaly.message.signalLoss");
    expect(e.index).toBe(3); // run minimum
    expect(e.startIndex).toBe(2);
    expect(e.endIndex).toBe(4);
    expect(e.detail).toEqual({ rssi: -110 });
  });

  it("NEGATIVE: RSSI steady around -50 (never at/below floor) → no event", () => {
    const log = buildLog({ rssi1: [-50, -52, -48, -50, -51] });
    expect(detectAnomalies(log)).toEqual([]);
  });

  it("NEGATIVE: a dip below floor for only 2 samples (< minSamples) → no event", () => {
    const log = buildLog({ rssi1: [-50, -105, -110, -50] });
    expect(detectAnomalies(log)).toEqual([]);
  });

  it("TWO RUNS: two distinct >=3-sample dips (recovering between) → two events, one per run", () => {
    // run 1 at idx 1,2,3 (min -110 @3); recovers at 4,5; run 2 at idx 6,7,8 (min -107 @8).
    const log = buildLog({
      rssi1: [-50, -105, -110, -105, -50, -50, -105, -106, -107, -50],
    });
    const events = detectAnomalies(log).filter((e) => e.type === "signalLoss");

    expect(events).toHaveLength(2);
    expect(events[0].index).toBe(2);
    expect(events[0].detail).toEqual({ rssi: -110 });
    expect(events[1].index).toBe(8);
    expect(events[1].detail).toEqual({ rssi: -107 });
  });
});

// ---------------------------------------------------------------------------
// Detector 2 — failsafe
// ---------------------------------------------------------------------------

describe("detectAnomalies — failsafe", () => {
  it("POSITIVE (channel): a failsafe channel going 0→1 → one critical event spanning the active run", () => {
    const log = buildLog({ failsafe: [0, 0, 1, 1, 0, 0] });
    const events = detectAnomalies(log);

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe("failsafe");
    expect(e.severity).toBe("critical");
    expect(e.messageKey).toBe("anomaly.message.failsafe");
    expect(e.index).toBe(2); // activation
    expect(e.startIndex).toBe(2);
    expect(e.endIndex).toBe(3); // active run
    expect(e.detail).toEqual({ lq: 0 }); // no LQ channel present → 0
  });

  it("POSITIVE (channel): detail.lq reads the link-quality channel at the activation sample", () => {
    const log = buildLog({
      failsafe: [0, 0, 0, 0, 1, 1],
      link_quality: [95, 95, 95, 95, 42, 42],
    });
    const fs = detectAnomalies(log).find((e) => e.type === "failsafe");
    expect(fs?.detail).toEqual({ lq: 42 });
  });

  it("POSITIVE (LQ-zero fallback): link_quality === 0 for >=2 samples and no failsafe channel → one failsafe event", () => {
    const log = buildLog({ link_quality: [95, 95, 0, 0, 95] });
    const events = detectAnomalies(log);

    // Only failsafe is emitted; the drop-to-zero is NOT double-counted as lqDrop.
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe("failsafe");
    expect(e.severity).toBe("critical");
    expect(e.index).toBe(2);
    expect(e.startIndex).toBe(2);
    expect(e.endIndex).toBe(3);
    expect(e.detail).toEqual({ lq: 0 });
    expect(events.some((ev) => ev.type === "lqDrop")).toBe(false);
  });

  it("NEGATIVE: failsafe channel all 0 and LQ never 0 → no failsafe event", () => {
    const log = buildLog({ failsafe: [0, 0, 0, 0], link_quality: [95, 94, 96, 95] });
    expect(detectAnomalies(log)).toEqual([]);
  });

  it("BY DESIGN: failsafe channel present but never active + a momentary LQ===0 → no failsafe event", () => {
    // The failsafe channel is authoritative, so when one exists the LQ===0
    // fallback is suppressed — an LQ-0 sample beside a non-activating failsafe
    // channel must NOT synthesize a failsafe event. (Regression guard.)
    const log = buildLog({
      failsafe: [0, 0, 0, 0, 0],
      link_quality: [95, 0, 0, 95, 95],
    });
    const events = detectAnomalies(log);
    expect(events.some((e) => e.type === "failsafe")).toBe(false);
    // The drop-to-0 is owned by failsafe, so it is not re-emitted as lqDrop either.
    expect(events.some((e) => e.type === "lqDrop")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Detector 3 — lqDrop
// ---------------------------------------------------------------------------

describe("detectAnomalies — lqDrop", () => {
  it("POSITIVE (warning): a steep fall >= slopeDrop with bottom > criticalTo → warning event", () => {
    // 95 → 40 (drop of 55), bottom 40 (> criticalTo 20).
    const log = buildLog({ link_quality: [95, 95, 95, 40, 40, 95] });
    const events = detectAnomalies(log);

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe("lqDrop");
    expect(e.severity).toBe("warning");
    expect(e.messageKey).toBe("anomaly.message.lqDrop");
    expect(e.index).toBe(3); // bottom
    expect(e.startIndex).toBe(2); // pre-drop high
    expect(e.endIndex).toBe(3);
    expect(e.detail).toEqual({ from: 95, to: 40 });
  });

  it("POSITIVE (critical): bottom <= criticalTo (but not 0) → critical event", () => {
    const log = buildLog({ link_quality: [95, 95, 10, 10, 95] });
    const events = detectAnomalies(log);

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe("lqDrop");
    expect(e.severity).toBe("critical");
    expect(e.detail).toEqual({ from: 95, to: 10 });
  });

  it("NEGATIVE: steady ~95 with small jitter (< slopeDrop, never below absThreshold) → no event", () => {
    const log = buildLog({ link_quality: [95, 93, 96, 94, 95, 92, 95] });
    expect(detectAnomalies(log)).toEqual([]);
  });

  it("NEGATIVE: a drop straight to 0 is owned by failsafe, not double-counted as lqDrop", () => {
    const log = buildLog({ link_quality: [95, 95, 0, 0, 95] });
    expect(detectAnomalies(log).some((e) => e.type === "lqDrop")).toBe(false);
  });

  it("SEAM (positive): a single-sample LQ === 0 dip inside a drop (no failsafe channel) → one critical lqDrop", () => {
    // The bottom touches 0 for ONE sample only — too brief for the failsafe
    // LQ-zero fallback (needs >= lqZeroSamples = 2 consecutive zeros) and there
    // is no failsafe channel, so neither detector would otherwise claim it. The
    // moment must surface as an lqDrop instead of being zero-emitted.
    const log = buildLog({ link_quality: [95, 95, 30, 0, 30, 30, 95] });
    const events = detectAnomalies(log);

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe("lqDrop");
    expect(e.severity).toBe("critical"); // bottom 0 <= criticalTo
    expect(e.messageKey).toBe("anomaly.message.lqDrop");
    expect(e.index).toBe(3); // the zero-touch bottom
    expect(e.detail).toEqual({ from: 95, to: 0 });
    // Not double-counted as a failsafe event.
    expect(events.some((ev) => ev.type === "failsafe")).toBe(false);
  });

  it("SEAM (negative): a >=2-sample LQ === 0 run inside a drop stays failsafe's — one failsafe event, no lqDrop", () => {
    // Two consecutive zeros reach lqZeroSamples, so the failsafe LQ-zero
    // fallback owns the moment and lqDrop cedes — exactly one event, no
    // double-count, confirming the seam hands off at the lqZeroSamples boundary.
    const log = buildLog({ link_quality: [95, 95, 30, 0, 0, 30, 95] });
    const events = detectAnomalies(log);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("failsafe");
    expect(events.some((ev) => ev.type === "lqDrop")).toBe(false);
  });

  it("DEBOUNCE: one drop that stays low for many samples → exactly ONE event (no re-emit until recovery)", () => {
    // Falls 95 → 30 at idx 2 and stays at 30 (below absThreshold 50, above
    // criticalTo 20) without ever recovering above the threshold.
    const log = buildLog({ link_quality: [95, 95, 30, 30, 30, 30, 30, 30] });
    const events = detectAnomalies(log).filter((e) => e.type === "lqDrop");

    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("warning");
    expect(events[0].index).toBe(2); // bottom = first low sample
    expect(events[0].detail).toEqual({ from: 95, to: 30 });
  });

  it("TWO RUNS: drop → recover above threshold → drop again → two events (debounce re-arms on recovery)", () => {
    // First drop bottom @2, recovers @4,5, second drop bottom @6.
    const log = buildLog({ link_quality: [95, 95, 30, 30, 95, 95, 30, 30, 95] });
    const events = detectAnomalies(log).filter((e) => e.type === "lqDrop");

    expect(events).toHaveLength(2);
    expect(events[0].index).toBe(2);
    expect(events[1].index).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Detector 4 — txPowerChange
// ---------------------------------------------------------------------------

describe("detectAnomalies — txPowerChange", () => {
  it("POSITIVE: tx_power 25→100 → one info event anchored at the change", () => {
    const log = buildLog({ tx_power: [25, 25, 100, 100] });
    const events = detectAnomalies(log);

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe("txPowerChange");
    expect(e.severity).toBe("info");
    expect(e.messageKey).toBe("anomaly.message.txPowerChange");
    expect(e.index).toBe(2);
    expect(e.startIndex).toBe(2);
    expect(e.endIndex).toBe(2);
    expect(e.detail).toEqual({ from: 25, to: 100 });
  });

  it("NEGATIVE: constant tx_power → no event", () => {
    const log = buildLog({ tx_power: [50, 50, 50, 50] });
    expect(detectAnomalies(log)).toEqual([]);
  });

  it("BOUNDARY: a delta of exactly 1 mW (== minDeltaMw) fires; a delta of 0 does not", () => {
    // idx1: 50→50 (delta 0, no fire); idx2: 50→51 (delta 1, fires).
    const log = buildLog({ tx_power: [50, 50, 51] });
    const events = detectAnomalies(log).filter((e) => e.type === "txPowerChange");

    expect(events).toHaveLength(1);
    expect(events[0].index).toBe(2);
    expect(events[0].detail).toEqual({ from: 50, to: 51 });
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting properties
// ---------------------------------------------------------------------------

/** A rich log exercising all four detectors at distinct indices. */
function combinedLog(): ParsedLog {
  return buildLog({
    // signalLoss run at 4,5,6; min -110 at 5.
    rssi1: [-50, -50, -50, -50, -105, -110, -108, -50, -50, -50],
    // lqDrop bottom at index 2 (95 → 40, warning).
    link_quality: [95, 95, 40, 40, 95, 95, 95, 95, 95, 95],
    // txPowerChange at index 6 (25 → 100).
    tx_power: [25, 25, 25, 25, 25, 25, 100, 100, 100, 100],
    // failsafe activation at index 8.
    failsafe: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
  });
}

describe("detectAnomalies — cross-cutting", () => {
  it("empty log (sampleCount 0) → []", () => {
    expect(detectAnomalies(buildLog({}))).toEqual([]);
  });

  it("is deterministic: two calls return deeply equal results", () => {
    const log = combinedLog();
    expect(detectAnomalies(log)).toEqual(detectAnomalies(log));
  });

  it("returns all four detectors' events sorted ascending by index", () => {
    const events = detectAnomalies(combinedLog());
    const indices = events.map((e) => e.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    // One event per detector at its expected anchor.
    expect(events.map((e) => [e.type, e.index])).toEqual([
      ["lqDrop", 2],
      ["signalLoss", 5],
      ["txPowerChange", 6],
      ["failsafe", 8],
    ]);
  });

  it("every event has a valid window and t === time[index]", () => {
    const log = combinedLog();
    const max = log.sampleCount - 1;
    for (const e of detectAnomalies(log)) {
      expect(e.startIndex).toBeLessThanOrEqual(e.index);
      expect(e.index).toBeLessThanOrEqual(e.endIndex);
      expect(e.startIndex).toBeGreaterThanOrEqual(0);
      expect(e.endIndex).toBeLessThanOrEqual(max);
      expect(e.t).toBe(log.time[e.index]);
    }
  });

  it("honours a passed config (defaults are exported and used by default)", () => {
    // Sanity: the default config is the one applied when none is passed.
    const log = buildLog({ rssi1: [-50, -105, -110, -50] }); // 2-sample dip
    expect(detectAnomalies(log)).toEqual([]); // default minSamples = 3
    expect(detectAnomalies(log, DEFAULT_ANOMALY_CONFIG)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SAFETY — no GPS coordinate / identifier may ever appear in event.detail
// ---------------------------------------------------------------------------

const COORD_LAT = 47.1234567;
const COORD_LON = -8.7654321;
const UID_VALUE = 8675309;

/** Detail keys the four detectors are ever allowed to emit. */
const ALLOWED_DETAIL_KEYS = new Set(["rssi", "lq", "from", "to"]);

describe("detectAnomalies — no GPS / identifier leak in detail", () => {
  // A log that also carries a GPS-coordinate channel, a uid channel, and a real
  // gps track alongside the telemetry that triggers every detector.
  const leaky = buildLog(
    {
      rssi1: [-50, -50, -50, -50, -105, -110, -108, -50, -50, -50],
      link_quality: [95, 95, 40, 40, 95, 95, 95, 95, 95, 95],
      tx_power: [25, 25, 25, 25, 25, 25, 100, 100, 100, 100],
      failsafe: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
      "GPS_coord[0]": Array.from({ length: 10 }, () => COORD_LAT),
      uid: Array.from({ length: 10 }, () => UID_VALUE),
    },
    {
      labels: { "GPS_coord[0]": "GPS Latitude" },
      gps: Array.from({ length: 10 }, () => ({ lat: COORD_LAT, lon: COORD_LON })),
    }
  );

  const events: AnomalyEvent[] = detectAnomalies(leaky);

  it("still detects the four telemetry anomalies (GPS/uid channels ignored)", () => {
    expect(events.map((e) => e.type)).toEqual(["lqDrop", "signalLoss", "txPowerChange", "failsafe"]);
  });

  it("every detail key is non-sensitive and within the allowed key set", () => {
    for (const e of events) {
      expect(e.detail).toBeDefined();
      for (const key of Object.keys(e.detail ?? {})) {
        expect(ALLOWED_DETAIL_KEYS.has(key)).toBe(true);
        // Cross-check against the shared sensitivity classifier.
        expect(isSensitiveChannel({ key, label: key })).toBe(false);
        // Explicit: never a coordinate-shaped key.
        expect(key).not.toMatch(/lat|lon|lng|gps|coord|geo|uid|mac|email/i);
      }
    }
  });

  it("no numeric detail value equals any planted coordinate or identifier", () => {
    for (const e of events) {
      for (const value of Object.values(e.detail ?? {})) {
        expect(typeof value).toBe("number");
        const n = value as number;
        expect(Number.isFinite(n)).toBe(true);
        expect(n).not.toBe(COORD_LAT);
        expect(n).not.toBe(COORD_LON);
        expect(n).not.toBe(UID_VALUE);
      }
    }
  });
});
