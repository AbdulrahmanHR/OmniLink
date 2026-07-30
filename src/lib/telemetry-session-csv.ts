/**
 * Canonical telemetry-session CSV format (M11).
 *
 * One CSV file == one recorded `telemetry_session`. This is the interchange
 * format the M16 Telemetry Replay Simulator replays through the live dashboard
 * pipeline, and that flight-log import (M14) and the map (M12/M13) consume, so
 * the column order below is **load-bearing** and must stay stable.
 *
 * ## Column order (header row, comma-separated, in this exact order)
 *
 *   1. `ts`            — capture timestamp, integer ms since epoch
 *   2. `rssi1`         — antenna-1 RSSI, dBm (negative)
 *   3. `rssi2`         — antenna-2 RSSI, dBm (negative)
 *   4. `link_quality`  — uplink link quality, 0–100 %
 *   5. `snr`           — signal-to-noise ratio, dB
 *   6. `tx_power`      — TX power, mW
 *   7. `packet_rate`   — packet/RF rate, Hz
 *   8. `lat`           — latitude, decimal degrees (empty = no GPS / no fix)
 *   9. `lon`           — longitude, decimal degrees (empty = no GPS / no fix)
 *  10. `alt`           — altitude, metres (empty = no GPS)
 *  11. `sats`          — satellite count (empty = no GPS)
 *  12. `ground_speed`  — ground speed, km/h (empty = no GPS)
 *  13. `heading`       — heading, degrees (empty = no GPS)
 *
 * GPS columns are nullable: an empty field round-trips to `null`. Values are
 * already in human units (degrees / metres / km/h / degrees) — i.e. the units
 * stored in the `telemetry` table after the migration-v3 GPS columns, not the
 * raw CRSF wire integers.
 *
 * Serialisation contract: numeric values are written with `String(n)` and read
 * back with `Number(s)`, which is exact for IEEE-754 doubles, so
 * `parseTelemetrySessionCsv(telemetrySessionToCsv(rows))` is identical to
 * `rows`. The unit test asserts this round-trip.
 */

/** Canonical column order. Exported so consumers/tests can assert it. */
export const TELEMETRY_CSV_COLUMNS = [
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
] as const;

/** A single row of a telemetry-session CSV. GPS fields are nullable. */
export interface TelemetrySessionCsvRow {
  ts: number;
  rssi1: number;
  rssi2: number;
  linkQuality: number;
  snr: number;
  txPower: number;
  packetRate: number;
  /** Latitude in decimal degrees, or `null` when no GPS fix was recorded. */
  lat: number | null;
  /** Longitude in decimal degrees, or `null`. */
  lon: number | null;
  /** Altitude in metres, or `null`. */
  alt: number | null;
  /** Satellite count, or `null`. */
  sats: number | null;
  /** Ground speed in km/h, or `null`. */
  groundSpeed: number | null;
  /** Heading in degrees, or `null`. */
  heading: number | null;
}

/** Non-GPS columns, in canonical order, paired with their row accessor. */
const REQUIRED_FIELDS: ReadonlyArray<keyof TelemetrySessionCsvRow> = [
  "ts",
  "rssi1",
  "rssi2",
  "linkQuality",
  "snr",
  "txPower",
  "packetRate",
];

/** GPS (nullable) columns, in canonical order, paired with their row accessor. */
const GPS_FIELDS: ReadonlyArray<keyof TelemetrySessionCsvRow> = [
  "lat",
  "lon",
  "alt",
  "sats",
  "groundSpeed",
  "heading",
];

/** Field order matching {@link TELEMETRY_CSV_COLUMNS}. */
const FIELD_ORDER: ReadonlyArray<keyof TelemetrySessionCsvRow> = [
  ...REQUIRED_FIELDS,
  ...GPS_FIELDS,
];

/** Render one cell: numbers via `String`, `null` as an empty field. */
function cell(value: number | null): string {
  return value === null ? "" : String(value);
}

/**
 * Export telemetry-session rows to a canonical CSV string (header + one line
 * per row). See the module header for the exact column order.
 */
export function telemetrySessionToCsv(
  rows: readonly TelemetrySessionCsvRow[]
): string {
  const lines = [TELEMETRY_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(FIELD_ORDER.map((f) => cell(row[f])).join(","));
  }
  return lines.join("\n");
}

/**
 * Parse a required (non-nullable) numeric cell. Throws on a missing/non-numeric
 * value so a malformed required column fails loudly rather than silently
 * producing `NaN`.
 */
function parseRequired(value: string, column: string, line: number): number {
  const n = Number(value);
  if (value.trim() === "" || Number.isNaN(n)) {
    throw new Error(
      `telemetry CSV: invalid value "${value}" for required column "${column}" on row ${line}`
    );
  }
  return n;
}

/** Parse a nullable GPS cell: empty → `null`, otherwise a finite number. */
function parseNullable(value: string, column: string, line: number): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  if (Number.isNaN(n)) {
    throw new Error(
      `telemetry CSV: invalid value "${value}" for column "${column}" on row ${line}`
    );
  }
  return n;
}

/**
 * Parse a canonical telemetry-session CSV string back into rows. Inverse of
 * {@link telemetrySessionToCsv}. The header row is validated against
 * {@link TELEMETRY_CSV_COLUMNS}; blank trailing lines are ignored.
 */
export function parseTelemetrySessionCsv(
  csv: string
): TelemetrySessionCsvRow[] {
  const lines = csv.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];

  const header = lines[0].split(",");
  const expected = TELEMETRY_CSV_COLUMNS;
  if (
    header.length !== expected.length ||
    header.some((h, i) => h.trim() !== expected[i])
  ) {
    throw new Error(
      `telemetry CSV: unexpected header "${lines[0]}"; expected "${expected.join(",")}"`
    );
  }

  const rows: TelemetrySessionCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length !== expected.length) {
      throw new Error(
        `telemetry CSV: row ${i} has ${cells.length} columns, expected ${expected.length}`
      );
    }
    rows.push({
      ts: parseRequired(cells[0], "ts", i),
      rssi1: parseRequired(cells[1], "rssi1", i),
      rssi2: parseRequired(cells[2], "rssi2", i),
      linkQuality: parseRequired(cells[3], "link_quality", i),
      snr: parseRequired(cells[4], "snr", i),
      txPower: parseRequired(cells[5], "tx_power", i),
      packetRate: parseRequired(cells[6], "packet_rate", i),
      lat: parseNullable(cells[7], "lat", i),
      lon: parseNullable(cells[8], "lon", i),
      alt: parseNullable(cells[9], "alt", i),
      sats: parseNullable(cells[10], "sats", i),
      groundSpeed: parseNullable(cells[11], "ground_speed", i),
      heading: parseNullable(cells[12], "heading", i),
    });
  }
  return rows;
}
