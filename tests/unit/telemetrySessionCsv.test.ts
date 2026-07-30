import { describe, expect, it } from "vitest";
import {
  TELEMETRY_CSV_COLUMNS,
  parseTelemetrySessionCsv,
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

describe("telemetrySessionToCsv", () => {
  it("emits the canonical header in the documented column order", () => {
    const csv = telemetrySessionToCsv([]);
    expect(csv).toBe(TELEMETRY_CSV_COLUMNS.join(","));
    expect(TELEMETRY_CSV_COLUMNS).toEqual([
      "ts",
      "rssi1",
      "rssi2",
      "link_quality",
      "snr",
      "tx_power",
      "packet_rate",
      "lat",
      "lon",
      "alt",
      "sats",
      "ground_speed",
      "heading",
    ]);
  });

  it("renders null GPS fields as empty cells", () => {
    const csv = telemetrySessionToCsv([noGpsRow(1000)]);
    const dataLine = csv.split("\n")[1];
    expect(dataLine).toBe("1000,-65,-90,88,-3,25,500,,,,,,");
  });
});

describe("CSV round-trip", () => {
  it("export -> parse yields identical rows (GPS + no-GPS mixed)", () => {
    const rows: TelemetrySessionCsvRow[] = [
      gpsRow(1000),
      noGpsRow(1040),
      gpsRow(1080),
    ];
    const parsed = parseTelemetrySessionCsv(telemetrySessionToCsv(rows));
    expect(parsed).toEqual(rows);
  });

  it("round-trips an empty session to no rows", () => {
    expect(parseTelemetrySessionCsv(telemetrySessionToCsv([]))).toEqual([]);
  });

  it("ignores a trailing newline", () => {
    const csv = telemetrySessionToCsv([gpsRow(5)]) + "\n";
    expect(parseTelemetrySessionCsv(csv)).toEqual([gpsRow(5)]);
  });
});

describe("parseTelemetrySessionCsv validation", () => {
  it("rejects an unexpected header", () => {
    expect(() => parseTelemetrySessionCsv("ts,rssi1\n1,2")).toThrow();
  });

  it("rejects a row with the wrong column count", () => {
    const bad = TELEMETRY_CSV_COLUMNS.join(",") + "\n1,2,3";
    expect(() => parseTelemetrySessionCsv(bad)).toThrow();
  });

  it("rejects a non-numeric required column", () => {
    const bad = TELEMETRY_CSV_COLUMNS.join(",") + "\nx,-70,-80,100,8,100,250,,,,,,";
    expect(() => parseTelemetrySessionCsv(bad)).toThrow();
  });
});

// M29 hardening for the record → browse → CSV export round-trip (M11): pin the
// three coercion/precision edges a real recorded session can hit.
describe("CSV GPS 0,0 vs empty-cell vs null (M29 hardening)", () => {
  // A powered-but-unlocked GPS module reports a real (0,0) "acquiring" fix — a
  // VALUE, distinct from a non-GPS device's null. The serializer must write "0"
  // (not an empty cell), and the parser must read it back as 0 (not null), or
  // the map would lose the difference between "at 0,0" and "no GPS at all".
  const zeroFixRow: TelemetrySessionCsvRow = {
    ts: 1000,
    rssi1: -70,
    rssi2: -80,
    linkQuality: 100,
    snr: 8,
    txPower: 100,
    packetRate: 250,
    lat: 0,
    lon: 0,
    alt: 0,
    sats: 0,
    groundSpeed: 0,
    heading: 0,
  };

  it("renders a 0,0 fix as literal '0' cells, never empty", () => {
    const dataLine = telemetrySessionToCsv([zeroFixRow]).split("\n")[1];
    expect(dataLine).toBe("1000,-70,-80,100,8,100,250,0,0,0,0,0,0");
  });

  it("round-trips a 0,0 fix as 0 (a value) — distinct from a null no-GPS row", () => {
    const [back] = parseTelemetrySessionCsv(telemetrySessionToCsv([zeroFixRow]));
    expect(back.lat).toBe(0);
    expect(back.lat).not.toBeNull();
    expect(back).toEqual(zeroFixRow);
    // The null sibling: empty cells coerce back to null, never 0.
    const [nullBack] = parseTelemetrySessionCsv(telemetrySessionToCsv([noGpsRow(1000)]));
    expect(nullBack.lat).toBeNull();
  });
});

describe("CSV line-ending + numeric precision (M29 hardening)", () => {
  it("parses CRLF input identically to LF (tolerant of externally-edited files)", () => {
    const lf = telemetrySessionToCsv([gpsRow(1000), noGpsRow(1040)]);
    const crlf = lf.replace(/\n/g, "\r\n");
    const fromCrlf = parseTelemetrySessionCsv(crlf);
    expect(fromCrlf).toEqual(parseTelemetrySessionCsv(lf));
    expect(fromCrlf).toEqual([gpsRow(1000), noGpsRow(1040)]);
  });

  it("preserves 13-digit ms timestamps and fractional values exactly", () => {
    const precise: TelemetrySessionCsvRow = {
      ...gpsRow(1_700_000_000_123),
      snr: -3.5,
      alt: 120.5,
      groundSpeed: 42.37,
    };
    const [back] = parseTelemetrySessionCsv(telemetrySessionToCsv([precise]));
    expect(back.ts).toBe(1_700_000_000_123);
    expect(back.snr).toBe(-3.5);
    expect(back.alt).toBe(120.5);
    expect(back.groundSpeed).toBe(42.37);
    expect(back).toEqual(precise);
  });
});
