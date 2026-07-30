/**
 * M40 conservative setup-suggestion rules — PURE.
 *
 * Feeds hand-built {@link TrendReport}s into {@link deriveSuggestions} and holds it
 * to: each of the five suggestions fires on its trend signal and stays silent
 * otherwise; the measured/likely/worthChecking confidence buckets land at their
 * thresholds; nothing is emitted below the 2-session recurrence minimum; and the
 * output is deduped + deterministically ordered. No engine, no fixtures.
 */

import { describe, expect, it } from "vitest";
import {
  deriveSuggestions,
  type DeviceTrend,
  type RepeatedEvent,
  type SuggestionId,
  type TrendReport,
} from "@/lib/diagnostics";

function device(over: Partial<DeviceTrend> = {}): DeviceTrend {
  return {
    deviceKey: "dev-a|fw",
    deviceLabel: "dev-a",
    sessionCount: 3,
    healthSeries: [80, 70, 60],
    avgHealth: 70,
    repeatedEvents: [],
    weakRfModes: [],
    ...over,
  };
}

function report(devices: DeviceTrend[]): TrendReport {
  return {
    hasEnoughHistory: true,
    sessionCount: devices.reduce((n, d) => n + d.sessionCount, 0),
    devices,
  };
}

const rule = (id: string, sessions: number): RepeatedEvent => ({
  kind: "rule",
  id,
  sessions,
});
const pattern = (id: string, sessions: number): RepeatedEvent => ({
  kind: "pattern",
  id,
  sessions,
});

function ids(devices: DeviceTrend[]): SuggestionId[] {
  return deriveSuggestions(report(devices)).map((s) => s.id);
}

describe("deriveSuggestions — each rule fires on its signal", () => {
  it("recurring rssi-floor → antenna-check", () => {
    expect(ids([device({ repeatedEvents: [rule("rssi-floor", 2)] })])).toContain(
      "antenna-check"
    );
  });

  it("recurring heading-degradation pattern → antenna-check", () => {
    expect(
      ids([device({ repeatedEvents: [pattern("heading-degradation", 2)] })])
    ).toContain("antenna-check");
  });

  it("recurring packet-instability → telemetry-interval-review + packet-rate-reconsideration", () => {
    const got = ids([device({ repeatedEvents: [rule("packet-instability", 2)] })]);
    expect(got).toContain("telemetry-interval-review");
    expect(got).toContain("packet-rate-reconsideration");
  });

  it("a weak RF mode → packet-rate-reconsideration", () => {
    expect(
      ids([
        device({ weakRfModes: [{ packetRate: 500, sessions: 2, avgHealth: 55 }] }),
      ])
    ).toContain("packet-rate-reconsideration");
  });

  it("recurring tx-power-saturation → power-setting-review", () => {
    expect(
      ids([device({ repeatedEvents: [rule("tx-power-saturation", 2)] })])
    ).toContain("power-setting-review");
  });

  it("co-recurring rssi-floor + lq-collapse → wiring-power-suspicion (and antenna-check)", () => {
    const got = ids([
      device({ repeatedEvents: [rule("rssi-floor", 2), rule("lq-collapse", 2)] }),
    ]);
    expect(got).toContain("wiring-power-suspicion");
    expect(got).toContain("antenna-check");
  });
});

describe("deriveSuggestions — silence when there is no signal", () => {
  it("emits nothing for a device with no repeated events or weak modes", () => {
    expect(deriveSuggestions(report([device()]))).toEqual([]);
  });

  it("emits nothing for an empty trend report", () => {
    expect(
      deriveSuggestions({ hasEnoughHistory: false, sessionCount: 0, devices: [] })
    ).toEqual([]);
  });

  it("lq-collapse alone (no rssi-floor) does not raise wiring-power-suspicion", () => {
    expect(
      ids([device({ repeatedEvents: [rule("lq-collapse", 2)] })])
    ).not.toContain("wiring-power-suspicion");
  });

  it("gps-area-degradation is environmental → triggers NO setup suggestion", () => {
    // Its M38 guidance is 'note the location and avoid it', not a wiring/power fix,
    // so it must not generate a contradicting suggestion (it still shows in the card).
    expect(
      deriveSuggestions(
        report([device({ repeatedEvents: [pattern("gps-area-degradation", 3)] })])
      )
    ).toEqual([]);
  });

  it("repeated-lq-drops alone (range/obstruction) triggers NO setup suggestion", () => {
    // Its guidance is range/obstruction, not wiring — it must not imply wiring here.
    expect(
      deriveSuggestions(
        report([device({ repeatedEvents: [pattern("repeated-lq-drops", 3)] })])
      )
    ).toEqual([]);
  });

  it("does not fire on a sub-minimum (1-session) recurrence", () => {
    // A defensively-constructed event below the 2-session minimum is ignored.
    expect(ids([device({ repeatedEvents: [rule("rssi-floor", 1)] })])).toEqual([]);
  });
});

describe("deriveSuggestions — confidence bucketing", () => {
  it("worthChecking at the bare 2-session minimum", () => {
    const [s] = deriveSuggestions(
      report([device({ sessionCount: 4, repeatedEvents: [rule("rssi-floor", 2)] })])
    );
    expect(s.confidence).toBe("worthChecking");
    expect(s.detail).toEqual({ sessions: 2, ofSessions: 4 });
  });

  it("measured when the signal recurs in ≥⅔ of sessions", () => {
    const [s] = deriveSuggestions(
      report([device({ sessionCount: 3, repeatedEvents: [rule("rssi-floor", 3)] })])
    );
    expect(s.confidence).toBe("measured");
  });

  it("likely when the signal recurs in ≥½ but <⅔ of sessions", () => {
    const [s] = deriveSuggestions(
      report([device({ sessionCount: 6, repeatedEvents: [rule("rssi-floor", 3)] })])
    );
    expect(s.confidence).toBe("likely");
  });

  it("measured at exactly ⅔", () => {
    const [s] = deriveSuggestions(
      report([device({ sessionCount: 6, repeatedEvents: [rule("rssi-floor", 4)] })])
    );
    expect(s.confidence).toBe("measured");
  });
});

describe("deriveSuggestions — dedupe + ordering + keys", () => {
  it("dedupes packet-rate-reconsideration, keeping the direct signal over the weak-RF correlation", () => {
    // packet-instability (a direct signal) + a weak RF mode (a correlation) both feed
    // packet-rate-reconsideration; it appears once, and the direct signal wins even
    // though the correlation has more sessions (the correlation is capped).
    const suggestions = deriveSuggestions(
      report([
        device({
          sessionCount: 5,
          repeatedEvents: [rule("packet-instability", 3)],
          weakRfModes: [{ packetRate: 500, sessions: 5, avgHealth: 50 }],
        }),
      ])
    );
    const prr = suggestions.filter((s) => s.id === "packet-rate-reconsideration");
    expect(prr).toHaveLength(1);
    expect(prr[0].confidence).toBe("likely"); // 3/5 direct, not capped
    expect(prr[0].detail.sessions).toBe(3);
    expect(prr[0].bodyKey).toBe(
      "diagnostics.suggestion.packetRateReconsideration.body"
    );
  });

  it("sorts measured→likely→worthChecking then id, and carries i18n keys", () => {
    const suggestions = deriveSuggestions(
      report([
        device({
          sessionCount: 6,
          repeatedEvents: [
            rule("tx-power-saturation", 2), // → power-setting-review: worthChecking
            rule("rssi-floor", 6), // → antenna-check: measured
            rule("packet-instability", 3), // → telemetry + packet-rate: likely (3/6)
          ],
        }),
      ])
    );
    const order = suggestions.map((s) => s.confidence);
    // Confidence ranks are non-decreasing (measured first).
    const rank = { measured: 0, likely: 1, worthChecking: 2 } as const;
    for (let i = 1; i < order.length; i++) {
      expect(rank[order[i]]).toBeGreaterThanOrEqual(rank[order[i - 1]]);
    }
    // Keys follow the camelCased id convention.
    const antenna = suggestions.find((s) => s.id === "antenna-check")!;
    expect(antenna.titleKey).toBe("diagnostics.suggestion.antennaCheck.title");
    expect(antenna.bodyKey).toBe("diagnostics.suggestion.antennaCheck.body");
  });

  it("is deterministic across device input order", () => {
    const a = device({ deviceKey: "a|1", repeatedEvents: [rule("rssi-floor", 2)] });
    const b = device({ deviceKey: "b|1", repeatedEvents: [rule("tx-power-saturation", 2)] });
    const forward = deriveSuggestions(report([a, b]));
    const reversed = deriveSuggestions(report([b, a]));
    expect(reversed).toEqual(forward);
  });
});

describe("deriveSuggestions — weak-RF correlation is capped", () => {
  it("weak-RF-derived packet-rate-reconsideration never exceeds worthChecking, even at full recurrence", () => {
    // Low COMPOSITE health at a packet rate is a correlation, not a measurement of
    // the rate — so even a rate weak in every session stays worthChecking.
    const [s] = deriveSuggestions(
      report([
        device({
          sessionCount: 6,
          repeatedEvents: [],
          weakRfModes: [{ packetRate: 500, sessions: 6, avgHealth: 45 }],
        }),
      ])
    );
    expect(s.id).toBe("packet-rate-reconsideration");
    expect(s.confidence).toBe("worthChecking");
    expect(s.bodyKey).toBe(
      "diagnostics.suggestion.packetRateReconsideration.bodyWeakRf"
    );
  });

  it("packet-instability-derived packet-rate-reconsideration CAN reach measured", () => {
    const [s] = deriveSuggestions(
      report([
        device({
          sessionCount: 6,
          repeatedEvents: [rule("packet-instability", 6)],
          weakRfModes: [],
        }),
      ])
    ).filter((x) => x.id === "packet-rate-reconsideration");
    expect(s.confidence).toBe("measured");
    expect(s.bodyKey).toBe("diagnostics.suggestion.packetRateReconsideration.body");
  });
});
