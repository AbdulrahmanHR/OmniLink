/**
 * Betaflight Blackbox CSV parsing + the shared {@link ParsedLog} model (M14,
 * FR-LOG-01/03/05).
 *
 * This module is the **keystone** of flight-log import: it defines the
 * source-agnostic {@link ParsedLog} / {@link LogChannel} types that every other
 * log consumer (the OmniLink-session parser in `omnilog.ts`, the on-device AI
 * range summariser in `log-range-summary.ts`, the synchronized charts, and the
 * flight map) is built on. Keep these types stable.
 *
 * ## Design
 * A {@link ParsedLog} is a normalized time-series: a shared `time` axis (ms) and
 * a set of numeric {@link LogChannel}s all aligned to it (one value per time
 * sample). GPS is deliberately kept **out** of `channels` and in its own `gps`
 * array so it can feed the map without ever being flattened into a chart series
 * that the AI summariser might pick up — see `log-range-summary.ts`.
 *
 * `parseBlackboxCsv` consumes the CSV produced by `blackbox_decode` (the same
 * text a bundled CLI would emit from a `.bbl`). Column names vary by firmware,
 * so parsing is tolerant: it maps every numeric column to a channel, derives the
 * time axis from a `time (us)` column when present (else a synthetic index), and
 * lifts `GPS_coord[0..1]` into `gps` (scaled from Betaflight's ×1e7 ints).
 */

import type { FlightPathPoint } from "@/components/map";
import { decimatePath, LIVE_PATH_MAX_POINTS } from "@/lib/flight-path";

// ---------------------------------------------------------------------------
// Shared log model (consumed by omnilog.ts, log-range-summary.ts, charts, map)
// ---------------------------------------------------------------------------

/** Where a {@link ParsedLog} came from. */
export type LogSource = "blackbox" | "omnilog";

/** A single GPS fix in decimal degrees. */
export interface LogGpsFix {
  lat: number;
  lon: number;
}

/**
 * One numeric series aligned to a {@link ParsedLog}'s shared `time` axis.
 * `values.length` always equals `time.length` (== `sampleCount`). Individual
 * samples may be `NaN` where the source had no value for that row.
 */
export interface LogChannel {
  /** Stable machine key, unique within a log (e.g. `"rssi1"`, `"gyroADC[0]"`). */
  key: string;
  /** Human-readable name derived from the CSV header (data, not UI chrome). */
  label: string;
  /** Unit derived from the header where derivable (e.g. `"dBm"`, `"V"`). */
  unit?: string;
  /** Sample values, one per `time` entry; `NaN` marks a gap. */
  values: number[];
}

/**
 * A normalized, source-agnostic flight log: a shared time axis plus numeric
 * channels and (optionally) an aligned GPS track.
 *
 * Invariants:
 * - `time.length === sampleCount`
 * - every `channels[i].values.length === sampleCount`
 * - when present, `gps.length === sampleCount` (entries are `null` at no-fix rows)
 */
export interface ParsedLog {
  source: LogSource;
  /** Time axis in milliseconds, ascending. */
  time: number[];
  /** Numeric channels, all aligned to `time`. Never contains GPS coordinates. */
  channels: LogChannel[];
  /** Number of time samples (`=== time.length`). */
  sampleCount: number;
  /**
   * Optional GPS track aligned to `time`; `null` at rows without a fix. Kept
   * separate from `channels` so coordinates never leak into a chart series or
   * the AI summariser. Absent entirely when the source carried no GPS.
   */
  gps?: Array<LogGpsFix | null>;
  /** Span of the time axis in ms (`time[last] - time[0]`, or `0` for <2 rows). */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Well-known Betaflight channel keys (best-effort; firmware-dependent)
// ---------------------------------------------------------------------------

/** Common Betaflight blackbox column keys, for callers that want to look up by name. */
export const BLACKBOX_CHANNEL_KEYS = {
  rssi: "rssi",
  vbat: "vbatLatest",
  amperage: "amperageLatest",
  gpsAltitude: "GPS_altitude",
  gpsNumSat: "GPS_numSat",
} as const;

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/**
 * Split one CSV line into fields, honouring double-quoted fields (which may
 * contain commas and `""`-escaped quotes) and trimming surrounding whitespace
 * from unquoted fields.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

/** Split a header cell like `"vbatLatest (V)"` into `{ label, unit }`. */
function splitHeader(header: string): { label: string; unit?: string } {
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(header);
  if (match && match[1].trim() !== "") {
    const unit = match[2].trim();
    return { label: match[1].trim(), unit: unit === "" ? undefined : unit };
  }
  return { label: header };
}

/** Normalised lowercase tokens of a header, for column-role detection. */
function headerTokens(header: string): string[] {
  return header.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== "");
}

function isTimeHeader(header: string): boolean {
  const h = header.toLowerCase();
  return h === "time" || h.startsWith("time ") || h.startsWith("time(");
}

function isLatHeader(header: string): boolean {
  const h = header.toLowerCase().replace(/\s+/g, "");
  if (h === "gps_coord[0]" || h === "gpscoord[0]") return true;
  return h === "lat" || h === "latitude";
}

function isLonHeader(header: string): boolean {
  const h = header.toLowerCase().replace(/\s+/g, "");
  if (h === "gps_coord[1]" || h === "gpscoord[1]") return true;
  return h === "lon" || h === "lng" || h === "long" || h === "longitude";
}

function isNumSatHeader(header: string): boolean {
  const tokens = headerTokens(header);
  return tokens.includes("numsat") || tokens.includes("sats") || tokens.includes("sat");
}

/**
 * Scale a raw Betaflight GPS coordinate to decimal degrees.
 *
 * Betaflight stores `GPS_coord` as a fixed-point integer × 1e7 (e.g.
 * `471230000` for `47.123°`). Some `blackbox_decode` builds already emit
 * degrees. A real latitude/longitude is bounded by ±180, so any magnitude above
 * `360` can only be the ×1e7 integer form and is divided down; values already in
 * range are passed through unchanged.
 */
function scaleGpsCoord(raw: number): number {
  if (!Number.isFinite(raw)) return NaN;
  return Math.abs(raw) > 360 ? raw / 1e7 : raw;
}

// ---------------------------------------------------------------------------
// Blackbox CSV → ParsedLog
// ---------------------------------------------------------------------------

/**
 * Parse a `blackbox_decode` CSV export into a {@link ParsedLog}.
 *
 * Robust to firmware-varying column sets and quoted/whitespace-padded fields:
 * - The time axis comes from a `time (us|ms|s)` column (converted to ms); if no
 *   time column exists, a synthetic 0..n-1 index axis is used.
 * - Every other column that is numeric in at least one row becomes a
 *   {@link LogChannel} (`NaN` for individual non-numeric cells).
 * - `GPS_coord[0]`/`[1]` (or `lat`/`lon`) populate `gps` — scaled to degrees and
 *   **never** added as channels. A row is `null` in `gps` when it has no fix
 *   (zero satellites, or a `0,0` coordinate).
 *
 * Returns an empty log (no channels, no samples) for blank/header-only input.
 */
export function parseBlackboxCsv(csv: string): ParsedLog {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    return { source: "blackbox", time: [], channels: [], sampleCount: 0, durationMs: 0 };
  }

  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  const rowCount = rows.length;

  // Identify special columns.
  let timeCol = -1;
  let timeScaleToMs = 1;
  let latCol = -1;
  let lonCol = -1;
  let numSatCol = -1;
  for (let c = 0; c < headers.length; c++) {
    const header = headers[c];
    if (timeCol === -1 && isTimeHeader(header)) {
      timeCol = c;
      const h = header.toLowerCase();
      if (h.includes("(us)") || h.includes("(µs)")) timeScaleToMs = 1 / 1000;
      else if (h.includes("(ms)")) timeScaleToMs = 1;
      else if (h.includes("(s)")) timeScaleToMs = 1000;
      else timeScaleToMs = 1 / 1000; // blackbox default is microseconds
    } else if (latCol === -1 && isLatHeader(header)) {
      latCol = c;
    } else if (lonCol === -1 && isLonHeader(header)) {
      lonCol = c;
    } else if (numSatCol === -1 && isNumSatHeader(header)) {
      numSatCol = c;
    }
  }

  // Time axis.
  const time: number[] = new Array<number>(rowCount);
  if (timeCol === -1) {
    for (let r = 0; r < rowCount; r++) time[r] = r;
  } else {
    for (let r = 0; r < rowCount; r++) {
      const n = Number(rows[r][timeCol]);
      time[r] = Number.isFinite(n) ? n * timeScaleToMs : NaN;
    }
  }

  // Channels: every column except time / GPS lat-lon, that is numeric somewhere.
  const channels: LogChannel[] = [];
  const usedKeys = new Set<string>();
  for (let c = 0; c < headers.length; c++) {
    if (c === timeCol || c === latCol || c === lonCol) continue;
    const values = new Array<number>(rowCount);
    let anyFinite = false;
    for (let r = 0; r < rowCount; r++) {
      const cell = rows[r][c];
      const n = cell === undefined || cell === "" ? NaN : Number(cell);
      values[r] = n;
      if (Number.isFinite(n)) anyFinite = true;
    }
    if (!anyFinite) continue; // skip text-only columns

    const header = headers[c];
    const { label, unit } = splitHeader(header);
    // Prefer the unit-stripped label as a key; fall back to the raw header to
    // keep keys unique when two columns share a label.
    let key = label;
    if (key === "" || usedKeys.has(key)) key = header;
    if (usedKeys.has(key)) key = `${header}#${c}`;
    usedKeys.add(key);
    channels.push({ key, label: label === "" ? header : label, unit, values });
  }

  // GPS track (kept out of channels).
  let gps: Array<LogGpsFix | null> | undefined;
  if (latCol !== -1 && lonCol !== -1) {
    gps = new Array<LogGpsFix | null>(rowCount);
    for (let r = 0; r < rowCount; r++) {
      const lat = scaleGpsCoord(Number(rows[r][latCol]));
      const lon = scaleGpsCoord(Number(rows[r][lonCol]));
      const sats = numSatCol === -1 ? NaN : Number(rows[r][numSatCol]);
      const noFix =
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        (lat === 0 && lon === 0) ||
        (Number.isFinite(sats) && sats <= 0);
      gps[r] = noFix ? null : { lat, lon };
    }
  }

  const durationMs =
    rowCount >= 2 && Number.isFinite(time[0]) && Number.isFinite(time[rowCount - 1])
      ? time[rowCount - 1] - time[0]
      : 0;

  const log: ParsedLog = {
    source: "blackbox",
    time,
    channels,
    sampleCount: rowCount,
    durationMs,
  };
  if (gps) log.gps = gps;
  return log;
}

// ---------------------------------------------------------------------------
// ParsedLog → flight-map track
// ---------------------------------------------------------------------------

/** Options for {@link deriveLogFlightPath}. */
export interface LogFlightPathOptions {
  /** Channel key to read RSSI from. Defaults to the first rssi-like channel. */
  rssiKey?: string;
  /** Channel key to read link quality from. Defaults to the first lq-like channel. */
  lqKey?: string;
  /** Max vertices after decimation. Defaults to {@link LIVE_PATH_MAX_POINTS}. */
  maxPoints?: number;
}

/** Pick the first channel whose key matches one of `candidates` (case-insensitive). */
function findChannel(log: ParsedLog, explicit: string | undefined, candidates: string[]): LogChannel | undefined {
  if (explicit !== undefined) return log.channels.find((c) => c.key === explicit);
  const want = candidates.map((c) => c.toLowerCase());
  return log.channels.find((c) => want.includes(c.key.toLowerCase()));
}

/**
 * Derive a decimated {@link FlightPathPoint} track from a {@link ParsedLog} for
 * the flight map. Only rows with a GPS fix contribute a point; each point's
 * `rssi`/`lq` are read from the resolved signal channels (0 where unavailable).
 *
 * The `FlightPathPoint` import is type-only and `decimatePath` is a pure helper,
 * so this introduces no runtime cycle with the map components.
 */
export function deriveLogFlightPath(
  log: ParsedLog,
  options: LogFlightPathOptions = {}
): FlightPathPoint[] {
  if (!log.gps) return [];
  const rssiCh = findChannel(log, options.rssiKey, ["rssi", "rssi1", "RSSI"]);
  const lqCh = findChannel(log, options.lqKey, ["lq", "link_quality", "linkQuality"]);
  const finite = (n: number | undefined): number => (n !== undefined && Number.isFinite(n) ? n : 0);

  const points: FlightPathPoint[] = [];
  for (let i = 0; i < log.gps.length; i++) {
    const fix = log.gps[i];
    if (!fix) continue;
    points.push({
      lat: fix.lat,
      lon: fix.lon,
      rssi: finite(rssiCh?.values[i]),
      lq: finite(lqCh?.values[i]),
    });
  }
  return decimatePath(points, options.maxPoints ?? LIVE_PATH_MAX_POINTS);
}
