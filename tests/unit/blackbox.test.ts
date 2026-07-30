import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deriveLogFlightPath,
  parseBlackboxCsv,
  type ParsedLog,
} from "@/lib/blackbox";

/**
 * A small hand-written Betaflight blackbox CSV. Time is in microseconds, the GPS
 * coordinates are the ×1e7 fixed-point ints Betaflight stores, and one row
 * (index 1) has no fix (0,0 + zero satellites). Channel column names are chosen
 * so none of them contain the substrings gps/coord/lat/lon — proving the GPS
 * lat/lon never leaks into `channels`.
 */
const BLACKBOX_CSV = [
  "time (us),rssi,vbat (V),numSat,GPS_coord[0],GPS_coord[1]",
  "0,200,16.2,8,471230000,85000000",
  "10000,180,16,0,0,0",
  "20000,160,15.8,9,471240000,85010000",
].join("\n");

describe("parseBlackboxCsv", () => {
  it("parses channels with the right keys/labels and aligned values", () => {
    const log = parseBlackboxCsv(BLACKBOX_CSV);

    expect(log.source).toBe("blackbox");
    expect(log.sampleCount).toBe(3);
    expect(log.channels.map((c) => c.key)).toEqual(["rssi", "vbat", "numSat"]);

    const vbat = log.channels.find((c) => c.key === "vbat");
    expect(vbat?.label).toBe("vbat");
    expect(vbat?.unit).toBe("V");
    expect(vbat?.values).toEqual([16.2, 16, 15.8]);

    const rssi = log.channels.find((c) => c.key === "rssi");
    expect(rssi?.values).toEqual([200, 180, 160]);

    // Every channel is aligned to the shared time axis.
    expect(log.time.length).toBe(log.sampleCount);
    for (const channel of log.channels) {
      expect(channel.values.length).toBe(log.sampleCount);
    }
  });

  it("converts the microsecond time axis to milliseconds", () => {
    const log = parseBlackboxCsv(BLACKBOX_CSV);
    expect(log.time).toEqual([0, 10, 20]);
  });

  it("computes durationMs as time[last] - time[0]", () => {
    const log = parseBlackboxCsv(BLACKBOX_CSV);
    expect(log.durationMs).toBe(20);
  });

  it("scales GPS_coord ×1e7 ints into log.gps with no-fix rows null", () => {
    const log = parseBlackboxCsv(BLACKBOX_CSV);
    expect(log.gps).toEqual([
      { lat: 47.123, lon: 8.5 },
      null,
      { lat: 47.124, lon: 8.501 },
    ]);
    // GPS track is aligned to the time axis.
    expect(log.gps?.length).toBe(log.sampleCount);
  });

  it("never exposes GPS coordinates as a chart channel", () => {
    const log = parseBlackboxCsv(BLACKBOX_CSV);
    for (const channel of log.channels) {
      expect(channel.key).not.toMatch(/gps|coord|lat|lon/i);
      expect(channel.label).not.toMatch(/gps|coord|lat|lon/i);
    }
  });

  it("returns an empty zero-sample log for header-only input (no throw)", () => {
    const empty = parseBlackboxCsv("time (us),rssi,vbat (V)");
    expect(empty).toEqual<ParsedLog>({
      source: "blackbox",
      time: [],
      channels: [],
      sampleCount: 0,
      durationMs: 0,
    });
    expect(empty.gps).toBeUndefined();
  });

  it("returns an empty log for blank input (no throw)", () => {
    expect(parseBlackboxCsv("").sampleCount).toBe(0);
    expect(parseBlackboxCsv("   \n  ").sampleCount).toBe(0);
  });
});

/**
 * Golden round-trip closing the Rust-decode → TS-parse loop that no single test
 * spans on its own. `data/fixtures/logs/error-recovery.decoded.csv` is the CSV
 * the in-process Rust decoder (`src-tauri/src/commands/logs.rs`) emits for the
 * REAL vendored `.bbl` fixture (`error-recovery.bbl`, from the `blackbox-log`
 * crate's MIT/Apache corpus; see that dir's `ATTRIBUTION.md`). Regenerate it
 * with `BLACKBOX_WRITE_GOLDEN=1 cargo test decodes_real_bbl_fixture` if the
 * decoder's CSV formatting ever changes. Feeding it back through
 * `parseBlackboxCsv` proves the decoder's columns/units line up with what the
 * importer expects — a mismatch would surface here as an empty ParsedLog.
 */
describe("decoded-bbl golden round-trip", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const goldenPath = path.resolve(
    here,
    "../../data/fixtures/logs/error-recovery.decoded.csv"
  );
  const goldenCsv = readFileSync(goldenPath, "utf8");

  it("parses the real decoded fixture CSV into a non-empty ParsedLog", () => {
    const log = parseBlackboxCsv(goldenCsv);

    expect(log.source).toBe("blackbox");
    expect(log.sampleCount).toBeGreaterThanOrEqual(1);
    expect(log.time.length).toBe(log.sampleCount);
    expect(log.channels.length).toBeGreaterThan(0);
    for (const channel of log.channels) {
      expect(channel.values.length).toBe(log.sampleCount);
    }
  });

  it("recovers the expected channels with correct keys/units", () => {
    const log = parseBlackboxCsv(goldenCsv);
    const byKey = (key: string) => log.channels.find((c) => c.key === key);

    // Signal channel (the flight map / summariser key on this).
    const rssi = byKey("rssi");
    expect(rssi).toBeDefined();
    expect(rssi?.values.every((v) => Number.isFinite(v))).toBe(true);

    // Unit-tagged headers → unit-carrying channels.
    expect(byKey("vbatLatest")?.unit).toBe("V");
    expect(byKey("amperageLatest")?.unit).toBe("A");
    expect(byKey("gyroADC[0]")?.unit).toBe("deg/s");

    // `time (us)` was consumed as the axis (µs → ms), not exposed as a channel.
    expect(byKey("time")).toBeUndefined();
    expect(Number.isFinite(log.time[0])).toBe(true);
    expect(log.durationMs).toBeGreaterThan(0);

    // This fixture carries no GPS frame, so no coordinate track is fabricated.
    expect(log.gps).toBeUndefined();
  });
});

describe("deriveLogFlightPath", () => {
  it("yields a point only for GPS-fix rows, reading rssi from its channel", () => {
    const log = parseBlackboxCsv(BLACKBOX_CSV);
    const path = deriveLogFlightPath(log);
    // Row 1 has no fix, so it is excluded.
    expect(path).toEqual([
      { lat: 47.123, lon: 8.5, rssi: 200, lq: 0 },
      { lat: 47.124, lon: 8.501, rssi: 160, lq: 0 },
    ]);
  });

  it("returns [] when the log carries no GPS track", () => {
    const log = parseBlackboxCsv("time (us),rssi\n0,200\n10000,180");
    expect(log.gps).toBeUndefined();
    expect(deriveLogFlightPath(log)).toEqual([]);
  });

  it("decimates the track to at most maxPoints, anchoring the endpoints", () => {
    const lines = ["time (us),rssi,numSat,GPS_coord[0],GPS_coord[1]"];
    for (let i = 0; i < 20; i++) {
      lines.push(`${i * 1000},${-50 - i},9,${471230000 + i * 1000},${85000000 + i * 1000}`);
    }
    const log = parseBlackboxCsv(lines.join("\n"));

    const path = deriveLogFlightPath(log, { maxPoints: 5 });
    expect(path.length).toBeGreaterThan(0);
    expect(path.length).toBeLessThanOrEqual(5);
    // First and last fix rows survive decimation.
    expect(path[0]).toEqual({ lat: 47.123, lon: 8.5, rssi: -50, lq: 0 });
    expect(path[path.length - 1].lat).toBeCloseTo((471230000 + 19 * 1000) / 1e7, 7);
  });
});
