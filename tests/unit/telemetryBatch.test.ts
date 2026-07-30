import { describe, expect, it, vi } from "vitest";
import {
  BATCH_SIZE,
  TelemetryBatchBuffer,
  buildTelemetryInsert,
  type TelemetryRow,
} from "@/lib/telemetry-db";
import type { TelemetryFrame } from "@/stores/telemetry";

function frame(t: number): TelemetryFrame {
  return {
    t,
    rssi1: -70,
    rssi2: -80,
    linkQuality: 100,
    snr: 8,
    txPower: 100,
    packetRate: 250,
    antennas: [
      { id: 1, rssi: -70, active: true },
      { id: 2, rssi: -80, active: false },
    ],
  };
}

function row(t: number, sessionId = "s1"): TelemetryRow {
  return { sessionId, frame: frame(t) };
}

describe("buildTelemetryInsert", () => {
  it("returns null for an empty batch", () => {
    expect(buildTelemetryInsert([])).toBeNull();
  });

  it("builds one placeholder group and 14 params per row (GPS columns NULL when absent)", () => {
    const stmt = buildTelemetryInsert([row(1000)]);
    expect(stmt).not.toBeNull();
    expect(stmt!.sql).toContain(
      "(session_id, ts, rssi1, rssi2, link_quality, snr, tx_power, packet_rate, " +
        "lat, lon, alt, sats, ground_speed, heading)"
    );
    expect(stmt!.sql).toContain(
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)"
    );
    expect(stmt!.params).toEqual([
      "s1",
      1000,
      -70,
      -80,
      100,
      8,
      100,
      250,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("writes GPS columns when the frame carries a fix", () => {
    const gpsFrame: TelemetryRow = {
      sessionId: "s1",
      frame: {
        ...frame(1000),
        gps: {
          latitude: 37.7749,
          longitude: -122.4194,
          altitude: 100,
          satellites: 9,
          groundSpeed: 15,
          heading: 180,
        },
      },
    };
    const stmt = buildTelemetryInsert([gpsFrame]);
    expect(stmt!.params.slice(8)).toEqual([37.7749, -122.4194, 100, 9, 15, 180]);
  });

  it("persists NULL GPS for a powered-but-unlocked (0,0) no-fix frame", () => {
    // A GPS module that is powered but hasn't locked reports (0,0); the live
    // readout keeps it (to show "acquiring"), but the stored/exported contract
    // is NULL before a fix — persisting 0,0 would emit bogus null-island coords
    // in an exported session CSV. All GPS columns must be NULL here.
    const noFix: TelemetryRow = {
      sessionId: "s1",
      frame: {
        ...frame(1000),
        gps: {
          latitude: 0,
          longitude: 0,
          altitude: 0,
          satellites: 3,
          groundSpeed: 0,
          heading: 0,
        },
      },
    };
    const stmt = buildTelemetryInsert([noFix]);
    expect(stmt!.params.slice(8)).toEqual([null, null, null, null, null, null]);
  });

  it("flattens multiple rows with sequential placeholders", () => {
    const stmt = buildTelemetryInsert([row(1), row(2)]);
    expect(stmt!.sql).toContain(
      "($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)"
    );
    expect(stmt!.sql).toContain(
      "($15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)"
    );
    expect(stmt!.params).toHaveLength(28);
    expect(stmt!.params[1]).toBe(1);
    expect(stmt!.params[15]).toBe(2);
  });
});

describe("TelemetryBatchBuffer", () => {
  it("does not flush before the batch size is reached", () => {
    const sink = vi.fn();
    const buf = new TelemetryBatchBuffer(sink, 3);
    buf.add(row(1));
    buf.add(row(2));
    expect(sink).not.toHaveBeenCalled();
    expect(buf.pending).toBe(2);
  });

  it("auto-flushes exactly when the batch size is reached and drains", () => {
    const sink = vi.fn();
    const buf = new TelemetryBatchBuffer(sink, 3);
    buf.add(row(1));
    buf.add(row(2));
    buf.add(row(3));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toHaveLength(3);
    expect(buf.pending).toBe(0);
  });

  it("flush() drains a partial buffer and is a no-op when empty", () => {
    const sink = vi.fn();
    const buf = new TelemetryBatchBuffer(sink, 50);
    buf.add(row(1));
    buf.flush();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(buf.pending).toBe(0);
    buf.flush(); // empty -> no extra call
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("never hands the sink frames added after it was invoked", () => {
    const seen: TelemetryRow[][] = [];
    const buf = new TelemetryBatchBuffer((rows) => {
      seen.push(rows);
    }, 2);
    buf.add(row(1));
    buf.add(row(2)); // triggers flush of [1, 2]
    buf.add(row(3));
    buf.flush(); // flushes [3]
    expect(seen).toHaveLength(2);
    expect(seen[0].map((r) => r.frame.t)).toEqual([1, 2]);
    expect(seen[1].map((r) => r.frame.t)).toEqual([3]);
  });

  it("defaults to the exported BATCH_SIZE", () => {
    const sink = vi.fn();
    const buf = new TelemetryBatchBuffer(sink);
    for (let i = 0; i < BATCH_SIZE - 1; i++) buf.add(row(i));
    expect(sink).not.toHaveBeenCalled();
    buf.add(row(BATCH_SIZE));
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
