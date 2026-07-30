import { describe, expect, it } from "vitest";
import type { LogChannel, ParsedLog } from "@/lib/blackbox";
import {
  isSensitiveChannel,
  logRangeSummaryToPromptString,
  stripSensitiveChannels,
  summarizeLogRange,
  summarizeLogRangeToPromptString,
} from "@/lib/log-range-summary";

/** A small, safe log: a 5-sample window of two ordinary channels. */
const SAFE_LOG: ParsedLog = {
  source: "omnilog",
  time: [0, 100, 200, 300, 400],
  sampleCount: 5,
  durationMs: 400,
  channels: [
    { key: "rssi1", label: "RSSI 1", unit: "dBm", values: [-70, -72, -74, -76, -78] },
    { key: "snr", label: "SNR", unit: "dB", values: [10, 8, 6, 4, 2] },
  ],
};

describe("summarizeLogRange", () => {
  it("computes min/max/mean/last/delta/samples over an inclusive window", () => {
    const summary = summarizeLogRange(SAFE_LOG, 1, 3);

    expect(summary.startIndex).toBe(1);
    expect(summary.endIndex).toBe(3);
    expect(summary.sampleCount).toBe(3); // inclusive: 1,2,3
    expect(summary.durationMs).toBe(200); // time[3] - time[1]
    expect(summary.source).toBe("omnilog");

    const rssi = summary.channels.find((c) => c.key === "rssi1");
    expect(rssi).toMatchObject({
      min: -76,
      max: -72,
      mean: -74,
      last: -76,
      delta: -4, // last(-76) - first(-72)
      samples: 3,
    });

    const snr = summary.channels.find((c) => c.key === "snr");
    expect(snr).toMatchObject({
      min: 4,
      max: 8,
      mean: 6,
      last: 4,
      delta: -4,
      samples: 3,
    });
  });

  it("clamps out-of-range indices to the log bounds", () => {
    const summary = summarizeLogRange(SAFE_LOG, -5, 100);
    expect(summary.startIndex).toBe(0);
    expect(summary.endIndex).toBe(4);
    expect(summary.sampleCount).toBe(5);
  });

  it("orders a reversed window", () => {
    const summary = summarizeLogRange(SAFE_LOG, 3, 1);
    expect(summary.startIndex).toBe(1);
    expect(summary.endIndex).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Security-critical: no sensitive data may reach the AI prompt string.
// ---------------------------------------------------------------------------

const COORD_LAT = 47.1234567;
const COORD_LON = -8.7654321;
const UID_VALUE = 8675309;
const BINDING_VALUE = 90019002;

/** A log that ALSO carries sensitive channels and a populated gps track. */
const LEAKY_LOG: ParsedLog = {
  source: "omnilog",
  time: [0, 100, 200],
  sampleCount: 3,
  durationMs: 200,
  gps: [
    { lat: COORD_LAT, lon: COORD_LON },
    { lat: COORD_LAT, lon: COORD_LON },
    { lat: COORD_LAT, lon: COORD_LON },
  ],
  channels: [
    { key: "rssi1", label: "RSSI 1", unit: "dBm", values: [-70, -71, -72] },
    { key: "snr", label: "SNR", unit: "dB", values: [5, 6, 7] },
    { key: "gps_lat", label: "GPS Latitude", values: [COORD_LAT, COORD_LAT, COORD_LAT] },
    { key: "GPS_coord[0]", label: "GPS_coord[0]", values: [COORD_LAT, COORD_LAT, COORD_LAT] },
    { key: "uid", label: "Device UID", values: [UID_VALUE, UID_VALUE, UID_VALUE] },
    { key: "mac", label: "MAC address", values: [1, 2, 3] },
    { key: "binding_phrase", label: "Binding Phrase", values: [BINDING_VALUE, BINDING_VALUE, BINDING_VALUE] },
  ],
};

describe("AI prompt string never leaks sensitive data", () => {
  const direct = logRangeSummaryToPromptString(summarizeLogRange(LEAKY_LOG, 0, 2));
  const convenience = summarizeLogRangeToPromptString(LEAKY_LOG, 0, 2);
  const lower = direct.toLowerCase();

  it("two entry points produce the same string", () => {
    expect(convenience).toBe(direct);
  });

  it("contains no GPS coordinate value from log.gps", () => {
    expect(direct).not.toContain(String(COORD_LAT)); // "47.1234567"
    expect(direct).not.toContain(String(COORD_LON)); // "-8.7654321"
    expect(direct).not.toContain("8.7654321");
    expect(direct).not.toContain("47.1234567");
  });

  it("contains no binding/uid/mac channel data", () => {
    expect(lower).not.toContain("binding");
    expect(lower).not.toContain("uid");
    expect(lower).not.toContain("mac");
    expect(direct).not.toContain(String(UID_VALUE));
    expect(direct).not.toContain(String(BINDING_VALUE));
  });

  it("contains no email or IPv4 address", () => {
    expect(direct).not.toContain("@");
    expect(direct).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it("is deterministic (identical on repeated calls)", () => {
    expect(summarizeLogRangeToPromptString(LEAKY_LOG, 0, 2)).toBe(
      summarizeLogRangeToPromptString(LEAKY_LOG, 0, 2)
    );
  });

  it("excludes sensitive channels from the structured summary", () => {
    const summary = summarizeLogRange(LEAKY_LOG, 0, 2);
    expect(summary.channels.map((c) => c.key)).toEqual(["rssi1", "snr"]);
  });
});

describe("stripSensitiveChannels", () => {
  it("drops coordinate/identifier channels and keeps ordinary ones", () => {
    const result = stripSensitiveChannels(LEAKY_LOG.channels);
    expect(result.map((c) => c.key)).toEqual(["rssi1", "snr"]);
  });

  it("returns the channels unchanged when none are sensitive", () => {
    const safe: LogChannel[] = [
      { key: "rssi1", label: "RSSI 1", values: [1] },
      { key: "snr", label: "SNR", values: [2] },
    ];
    expect(stripSensitiveChannels(safe).map((c) => c.key)).toEqual(["rssi1", "snr"]);
  });
});

describe("isSensitiveChannel", () => {
  it("flags coordinate and identifier channels", () => {
    for (const key of [
      "gps",
      "gps_lat",
      "GPS_coord[0]",
      "lat",
      "latitude",
      "lon",
      "longitude",
      "uid",
      "mac",
      "ip",
      "email",
      "binding_phrase",
      "phrase",
      // Aliases hardened after the M14 review (defense-in-depth backstop):
      "lng",
      "coordinate",
      "coordinates",
      "geo",
      "mail",
    ]) {
      expect(isSensitiveChannel({ key, label: key })).toBe(true);
    }
  });

  it("does not flag ordinary telemetry channels", () => {
    for (const key of ["rssi1", "rssi2", "snr", "vbat", "vbatLatest", "link_quality", "tx_power"]) {
      expect(isSensitiveChannel({ key, label: key })).toBe(false);
    }
  });
});
