/**
 * OmniLink telemetry-session → {@link ParsedLog} parsing (M14, FR-LOG-02/03/05).
 *
 * The OmniLink side of flight-log import: it reuses the canonical M11 telemetry
 * session CSV reader ({@link parseTelemetrySessionCsv}) and reshapes those rows
 * into the **same** {@link ParsedLog} model that `blackbox.ts` produces, so the
 * synchronized charts, the flight map, and the AI range summariser are entirely
 * source-agnostic.
 *
 * The link metrics (rssi1/rssi2/link_quality/snr/tx_power/packet_rate) plus the
 * non-coordinate GPS-derived metrics (alt/sats/ground_speed/heading) become
 * {@link LogChannel}s; the time axis is the already-ms `ts` column; and the
 * `lat`/`lon` pair becomes the separate `gps` track (`null` where there was no
 * fix). Coordinates are never emitted as a channel.
 */

import type { LogChannel, LogGpsFix, ParsedLog } from "@/lib/blackbox";
import {
  parseTelemetrySessionCsv,
  type TelemetrySessionCsvRow,
} from "@/lib/telemetry-session-csv";

/** Stable channel keys produced from an OmniLink telemetry session. */
export const OMNILOG_CHANNEL_KEYS = {
  rssi1: "rssi1",
  rssi2: "rssi2",
  linkQuality: "link_quality",
  snr: "snr",
  txPower: "tx_power",
  packetRate: "packet_rate",
  altitude: "alt",
  sats: "sats",
  groundSpeed: "ground_speed",
  heading: "heading",
} as const;

/** Descriptor for one channel sourced from a {@link TelemetrySessionCsvRow}. */
interface ChannelSpec {
  key: string;
  label: string;
  unit?: string;
  /** Reads this channel's sample from a row; `null` becomes `NaN` (a gap). */
  read: (row: TelemetrySessionCsvRow) => number | null;
}

/**
 * Channel layout, in chart order. The first six are always present (required
 * columns); the last four are GPS-derived but are **not** coordinates, so they
 * are safe to chart and to summarise for the AI.
 */
const CHANNEL_SPECS: readonly ChannelSpec[] = [
  { key: OMNILOG_CHANNEL_KEYS.rssi1, label: "RSSI 1", unit: "dBm", read: (r) => r.rssi1 },
  { key: OMNILOG_CHANNEL_KEYS.rssi2, label: "RSSI 2", unit: "dBm", read: (r) => r.rssi2 },
  { key: OMNILOG_CHANNEL_KEYS.linkQuality, label: "Link Quality", unit: "%", read: (r) => r.linkQuality },
  { key: OMNILOG_CHANNEL_KEYS.snr, label: "SNR", unit: "dB", read: (r) => r.snr },
  { key: OMNILOG_CHANNEL_KEYS.txPower, label: "TX Power", unit: "mW", read: (r) => r.txPower },
  { key: OMNILOG_CHANNEL_KEYS.packetRate, label: "Packet Rate", unit: "Hz", read: (r) => r.packetRate },
  { key: OMNILOG_CHANNEL_KEYS.altitude, label: "Altitude", unit: "m", read: (r) => r.alt },
  { key: OMNILOG_CHANNEL_KEYS.sats, label: "Satellites", read: (r) => r.sats },
  { key: OMNILOG_CHANNEL_KEYS.groundSpeed, label: "Ground Speed", unit: "km/h", read: (r) => r.groundSpeed },
  { key: OMNILOG_CHANNEL_KEYS.heading, label: "Heading", unit: "deg", read: (r) => r.heading },
];

/**
 * Build a {@link ParsedLog} from already-parsed telemetry-session rows. Exposed
 * for callers that hold {@link TelemetrySessionCsvRow}s directly (e.g. a live
 * recording) without round-tripping through CSV text.
 */
export function parsedLogFromTelemetryRows(
  rows: readonly TelemetrySessionCsvRow[]
): ParsedLog {
  const n = rows.length;
  const time = new Array<number>(n);
  const gps = new Array<LogGpsFix | null>(n);
  const channels: LogChannel[] = CHANNEL_SPECS.map((spec) => ({
    key: spec.key,
    label: spec.label,
    unit: spec.unit,
    values: new Array<number>(n),
  }));

  for (let i = 0; i < n; i++) {
    const row = rows[i];
    time[i] = row.ts;
    for (let c = 0; c < CHANNEL_SPECS.length; c++) {
      const v = CHANNEL_SPECS[c].read(row);
      channels[c].values[i] = v === null ? NaN : v;
    }
    gps[i] = row.lat !== null && row.lon !== null ? { lat: row.lat, lon: row.lon } : null;
  }

  const durationMs = n >= 2 ? time[n - 1] - time[0] : 0;

  return {
    source: "omnilog",
    time,
    channels,
    sampleCount: n,
    gps,
    durationMs,
  };
}

/**
 * Parse an OmniLink telemetry-session CSV (M11 format) into a {@link ParsedLog}.
 * Thin wrapper over {@link parseTelemetrySessionCsv} +
 * {@link parsedLogFromTelemetryRows}.
 */
export function parseOmniLogCsv(csv: string): ParsedLog {
  return parsedLogFromTelemetryRows(parseTelemetrySessionCsv(csv));
}
