import { describe, expect, it } from "vitest";
import {
  csvRowToTelemetryFrame,
  indexAtSessionElapsed,
  sessionDurationMs,
  toRelativeTimes,
} from "@/lib/replay";
import {
  TELEMETRY_CSV_COLUMNS,
  parseTelemetrySessionCsv,
  telemetrySessionToCsv,
} from "@/lib/telemetry-session-csv";
import type { TelemetrySessionCsvRow } from "@/lib/telemetry-session-csv";

/** A fully-populated row (GPS present). `overrides` tweak individual fields. */
function fullRow(
  overrides: Partial<TelemetrySessionCsvRow> = {}
): TelemetrySessionCsvRow {
  return {
    ts: 1_700_000_000_000,
    rssi1: -70,
    rssi2: -82,
    linkQuality: 96,
    snr: 7,
    txPower: 100,
    packetRate: 250,
    lat: 37.7749,
    lon: -122.4194,
    alt: 120,
    sats: 11,
    groundSpeed: 14.5,
    heading: 271,
    ...overrides,
  };
}

/** A row with no GPS fix at all (lat/lon null). */
function noGpsRow(ts: number): TelemetrySessionCsvRow {
  return {
    ts,
    rssi1: -65,
    rssi2: -90,
    linkQuality: 88,
    snr: -3,
    txPower: 25,
    packetRate: 500,
    lat: null,
    lon: null,
    alt: null,
    sats: null,
    groundSpeed: null,
    heading: null,
  };
}

describe("csvRowToTelemetryFrame — scalar field mapping", () => {
  it("copies the timestamp and every scalar link field through verbatim", () => {
    const row = fullRow();
    const frame = csvRowToTelemetryFrame(row);
    expect(frame.t).toBe(row.ts);
    expect(frame.rssi1).toBe(row.rssi1);
    expect(frame.rssi2).toBe(row.rssi2);
    expect(frame.linkQuality).toBe(row.linkQuality);
    expect(frame.snr).toBe(row.snr);
    expect(frame.txPower).toBe(row.txPower);
    expect(frame.packetRate).toBe(row.packetRate);
  });
});

describe("csvRowToTelemetryFrame — antenna synthesis", () => {
  it("produces exactly two antennas with ids 1 and 2 carrying their RSSI", () => {
    const frame = csvRowToTelemetryFrame(fullRow({ rssi1: -70, rssi2: -82 }));
    expect(frame.antennas).toHaveLength(2);
    expect(frame.antennas[0]).toMatchObject({ id: 1, rssi: -70 });
    expect(frame.antennas[1]).toMatchObject({ id: 2, rssi: -82 });
  });

  it("lights antenna 1 when rssi1 > rssi2 (exactly one active)", () => {
    const frame = csvRowToTelemetryFrame(fullRow({ rssi1: -60, rssi2: -90 }));
    expect(frame.antennas[0].active).toBe(true);
    expect(frame.antennas[1].active).toBe(false);
  });

  it("lights antenna 2 when rssi2 > rssi1 (exactly one active)", () => {
    const frame = csvRowToTelemetryFrame(fullRow({ rssi1: -90, rssi2: -60 }));
    expect(frame.antennas[0].active).toBe(false);
    expect(frame.antennas[1].active).toBe(true);
  });

  it("resolves a tie (rssi1 === rssi2) to antenna 1", () => {
    const frame = csvRowToTelemetryFrame(fullRow({ rssi1: -75, rssi2: -75 }));
    expect(frame.antennas[0].active).toBe(true);
    expect(frame.antennas[1].active).toBe(false);
    // Exactly one active in the tie case too.
    expect(frame.antennas.filter((a) => a.active)).toHaveLength(1);
  });
});

describe("csvRowToTelemetryFrame — GPS mapping", () => {
  it("maps a present GPS fix field-for-field", () => {
    const row = fullRow();
    const frame = csvRowToTelemetryFrame(row);
    expect(frame.gps).toEqual({
      latitude: row.lat,
      longitude: row.lon,
      altitude: row.alt,
      satellites: row.sats,
      groundSpeed: row.groundSpeed,
      heading: row.heading,
    });
  });

  it("yields gps === null when latitude is null", () => {
    const frame = csvRowToTelemetryFrame(fullRow({ lat: null }));
    expect(frame.gps).toBeNull();
  });

  it("yields gps === null when longitude is null", () => {
    const frame = csvRowToTelemetryFrame(fullRow({ lon: null }));
    expect(frame.gps).toBeNull();
  });

  it("yields gps === null for a fully-null-GPS row", () => {
    const frame = csvRowToTelemetryFrame(noGpsRow(1000));
    expect(frame.gps).toBeNull();
  });

  it("defaults partial-null GPS fields to 0 when lat/lon are present", () => {
    const frame = csvRowToTelemetryFrame(
      fullRow({
        lat: 10,
        lon: 20,
        alt: null,
        sats: null,
        groundSpeed: null,
        heading: null,
      })
    );
    expect(frame.gps).toEqual({
      latitude: 10,
      longitude: 20,
      altitude: 0,
      satellites: 0,
      groundSpeed: 0,
      heading: 0,
    });
  });
});

describe("toRelativeTimes", () => {
  it("subtracts the first timestamp so relTimes[0] === 0", () => {
    const rows = [noGpsRow(1000), noGpsRow(1100), noGpsRow(1350)];
    const rel = toRelativeTimes(rows);
    expect(rel).toEqual([0, 100, 350]);
    expect(rel[0]).toBe(0);
  });

  it("returns [] for empty input", () => {
    expect(toRelativeTimes([])).toEqual([]);
  });
});

describe("indexAtSessionElapsed — the replay clock", () => {
  // 8 frames at a fixed 100 ms spacing.
  const relTimes = [0, 100, 200, 300, 400, 500, 600, 700];

  it("returns the exact index on a sample boundary", () => {
    expect(indexAtSessionElapsed(relTimes, 0)).toBe(0);
    expect(indexAtSessionElapsed(relTimes, 100)).toBe(1);
    expect(indexAtSessionElapsed(relTimes, 700)).toBe(7);
  });

  it("holds the previous frame between samples", () => {
    expect(indexAtSessionElapsed(relTimes, 150)).toBe(1);
    expect(indexAtSessionElapsed(relTimes, 699)).toBe(6);
  });

  it("clamps past the end, below zero, and on empty input", () => {
    expect(indexAtSessionElapsed(relTimes, 999999)).toBe(7); // clamp high
    expect(indexAtSessionElapsed(relTimes, -50)).toBe(0); // clamp low
    expect(indexAtSessionElapsed([], 123)).toBe(0); // empty
  });

  // The store computes sessionElapsedMs = wallElapsedMs * speed, so we drive the
  // clock by passing wall*speed and assert the index each speed reaches.
  describe("speed multipliers (sessionElapsed = wall * speed)", () => {
    it("0.5×: at wall=400ms, 400*0.5=200 → index 2", () => {
      expect(indexAtSessionElapsed(relTimes, 400 * 0.5)).toBe(2);
    });

    it("1×: at wall=400ms, 400*1=400 → index 4", () => {
      expect(indexAtSessionElapsed(relTimes, 400 * 1)).toBe(4);
    });

    it("2×: at wall=400ms, 400*2=800 → index 7 (clamped, 800>700)", () => {
      expect(indexAtSessionElapsed(relTimes, 400 * 2)).toBe(7);
    });

    it("2× reaches frame 4 in half the wall time: wall=200ms, 200*2=400 → index 4", () => {
      // 1× needs wall=400ms to reach frame 4; 2× reaches it at wall=200ms.
      expect(indexAtSessionElapsed(relTimes, 200 * 2)).toBe(4);
      expect(indexAtSessionElapsed(relTimes, 200 * 1)).toBe(2); // 1× only at frame 2 by then
    });

    it("4× reaches frame 4 in a quarter the wall time: wall=100ms, 100*4=400 → index 4", () => {
      // 1× needs wall=400ms to reach frame 4; 4× reaches it at wall=100ms.
      expect(indexAtSessionElapsed(relTimes, 100 * 4)).toBe(4);
      expect(indexAtSessionElapsed(relTimes, 100 * 1)).toBe(1); // 1× only at frame 1 by then
    });

    it("at the SAME wall time, higher speed → higher-or-equal index", () => {
      const wall = 400;
      const i05 = indexAtSessionElapsed(relTimes, wall * 0.5); // 2
      const i1 = indexAtSessionElapsed(relTimes, wall * 1); // 4
      const i2 = indexAtSessionElapsed(relTimes, wall * 2); // 7 (clamped)
      expect(i05).toBeLessThan(i1);
      expect(i1).toBeLessThanOrEqual(i2);
      expect([i05, i1, i2]).toEqual([2, 4, 7]);
    });
  });
});

describe("sessionDurationMs", () => {
  it("returns last - first relative time", () => {
    expect(sessionDurationMs([0, 100, 350])).toBe(350);
  });

  it("returns 0 for a single sample", () => {
    expect(sessionDurationMs([0])).toBe(0);
  });

  it("returns 0 for an empty table", () => {
    expect(sessionDurationMs([])).toBe(0);
  });
});

describe("export round-trip (FR-SIM-03 schema)", () => {
  const rows: TelemetrySessionCsvRow[] = [
    fullRow({ ts: 1000 }),
    noGpsRow(1100),
    fullRow({ ts: 1350, lat: 51.5, lon: -0.12 }),
  ];

  it("parse(toCsv(rows)) deep-equals rows (round-trip identity)", () => {
    expect(parseTelemetrySessionCsv(telemetrySessionToCsv(rows))).toEqual(rows);
  });

  it("emits the canonical header as the first line", () => {
    const header = telemetrySessionToCsv(rows).split("\n")[0];
    expect(header).toBe(TELEMETRY_CSV_COLUMNS.join(","));
  });
});
