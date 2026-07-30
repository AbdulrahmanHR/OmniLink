import { describe, expect, it } from "vitest";
import {
  parseOmniLogCsv,
  parsedLogFromTelemetryRows,
} from "@/lib/omnilog";
import type { LogChannel } from "@/lib/blackbox";
import {
  telemetrySessionToCsv,
  type TelemetrySessionCsvRow,
} from "@/lib/telemetry-session-csv";

function gpsRow(ts: number): TelemetrySessionCsvRow {
  return {
    ts,
    rssi1: -70,
    rssi2: -80,
    linkQuality: 100,
    snr: 8,
    txPower: 100,
    packetRate: 250,
    lat: 37.7749,
    lon: -122.4194,
    alt: 100,
    sats: 9,
    groundSpeed: 15,
    heading: 180,
  };
}

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

function channel(channels: readonly LogChannel[], key: string): LogChannel {
  const found = channels.find((c) => c.key === key);
  if (!found) throw new Error(`missing channel ${key}`);
  return found;
}

const ROWS: TelemetrySessionCsvRow[] = [
  gpsRow(1000),
  noGpsRow(1040),
  gpsRow(1080),
];

describe("parseOmniLogCsv (M11 canonical CSV round-trip)", () => {
  it("maps each M11 column to the right channel with the right values", () => {
    const log = parseOmniLogCsv(telemetrySessionToCsv(ROWS));

    expect(log.source).toBe("omnilog");
    expect(log.sampleCount).toBe(ROWS.length);
    expect(log.channels.map((c) => c.key)).toEqual([
      "rssi1",
      "rssi2",
      "link_quality",
      "snr",
      "tx_power",
      "packet_rate",
      "alt",
      "sats",
      "ground_speed",
      "heading",
    ]);

    expect(channel(log.channels, "rssi1").values).toEqual([-70, -65, -70]);
    expect(channel(log.channels, "rssi2").values).toEqual([-80, -90, -80]);
    expect(channel(log.channels, "link_quality").values).toEqual([100, 88, 100]);
    expect(channel(log.channels, "snr").values).toEqual([8, -3, 8]);
    expect(channel(log.channels, "tx_power").values).toEqual([100, 25, 100]);
    expect(channel(log.channels, "packet_rate").values).toEqual([250, 500, 250]);

    // GPS-derived (non-coordinate) channels: null cells become NaN gaps.
    expect(channel(log.channels, "alt").values).toEqual([100, NaN, 100]);
    expect(channel(log.channels, "sats").values).toEqual([9, NaN, 9]);
    expect(channel(log.channels, "ground_speed").values).toEqual([15, NaN, 15]);
    expect(channel(log.channels, "heading").values).toEqual([180, NaN, 180]);
  });

  it("derives the time axis from the ts column", () => {
    const log = parseOmniLogCsv(telemetrySessionToCsv(ROWS));
    expect(log.time).toEqual([1000, 1040, 1080]);
    expect(log.durationMs).toBe(80);
  });

  it("populates gps where lat/lon are present and null where the M11 row was null", () => {
    const log = parseOmniLogCsv(telemetrySessionToCsv(ROWS));
    expect(log.gps).toEqual([
      { lat: 37.7749, lon: -122.4194 },
      null,
      { lat: 37.7749, lon: -122.4194 },
    ]);
  });

  it("never exposes lat/lon as a chart channel", () => {
    const log = parseOmniLogCsv(telemetrySessionToCsv(ROWS));
    for (const c of log.channels) {
      expect(c.key).not.toMatch(/lat|lon|coord/i);
    }
  });
});

describe("parsedLogFromTelemetryRows", () => {
  it("produces an identical ParsedLog to parsing the equivalent CSV", () => {
    const fromRows = parsedLogFromTelemetryRows(ROWS);
    const fromCsv = parseOmniLogCsv(telemetrySessionToCsv(ROWS));
    expect(fromRows).toEqual(fromCsv);
  });

  it("reports source omnilog and sampleCount === rows.length", () => {
    const log = parsedLogFromTelemetryRows(ROWS);
    expect(log.source).toBe("omnilog");
    expect(log.sampleCount).toBe(ROWS.length);
  });
});
