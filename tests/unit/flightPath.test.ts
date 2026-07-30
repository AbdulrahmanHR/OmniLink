import { describe, expect, it } from "vitest";
import {
  LIVE_PATH_MAX_POINTS,
  decimatePath,
  deriveFlightPath,
} from "@/lib/flight-path";
import type { FlightPathPoint } from "@/components/map";
import type { GpsReading, TelemetryFrame } from "@/stores/telemetry";

/**
 * Minimal valid {@link TelemetryFrame}. Only the fields the derivation reads
 * (gps, rssi1, linkQuality) are interesting; the rest are filled with sane
 * placeholders so the fixture type-checks.
 */
function makeFrame(overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    t: 0,
    rssi1: -70,
    rssi2: -80,
    linkQuality: 100,
    snr: 8,
    txPower: 100,
    packetRate: 250,
    antennas: [],
    ...overrides,
  };
}

/** A GPS reading with a real fix unless overridden to 0,0. */
function makeGps(overrides: Partial<GpsReading> = {}): GpsReading {
  return {
    latitude: 37.7749,
    longitude: -122.4194,
    altitude: 100,
    satellites: 9,
    groundSpeed: 15,
    heading: 180,
    ...overrides,
  };
}

describe("deriveFlightPath", () => {
  it("maps a fixed frame to {lat,lon,rssi:rssi1,lq:linkQuality} (no field swap)", () => {
    const frame = makeFrame({
      gps: makeGps({ latitude: 12.5, longitude: -45.25 }),
      rssi1: -73,
      rssi2: -91,
      linkQuality: 88,
    });
    const path = deriveFlightPath([frame]);
    expect(path).toEqual<FlightPathPoint[]>([
      { lat: 12.5, lon: -45.25, rssi: -73, lq: 88 },
    ]);
    // Guard against rssi/lq being swapped.
    expect(path[0].rssi).toBe(-73);
    expect(path[0].lq).toBe(88);
  });

  it("excludes frames with gps null or undefined", () => {
    const path = deriveFlightPath([
      makeFrame({ gps: null }),
      makeFrame({ gps: undefined }),
    ]);
    expect(path).toEqual([]);
  });

  it("excludes a powered-but-unlocked (0,0) reading (no fix)", () => {
    const path = deriveFlightPath([
      makeFrame({ gps: makeGps({ latitude: 0, longitude: 0, satellites: 0 }) }),
    ]);
    expect(path).toEqual([]);
  });

  it("keeps only fix frames, in order, for a mixed sequence", () => {
    const frames = [
      makeFrame({ gps: makeGps({ latitude: 1, longitude: 1 }), rssi1: -60, linkQuality: 99 }),
      makeFrame({ gps: null }),
      makeFrame({ gps: makeGps({ latitude: 0, longitude: 0 }) }),
      makeFrame({ gps: makeGps({ latitude: 2, longitude: 2 }), rssi1: -65, linkQuality: 95 }),
      makeFrame({ gps: undefined }),
      makeFrame({ gps: makeGps({ latitude: 3, longitude: 3 }), rssi1: -70, linkQuality: 90 }),
    ];
    const path = deriveFlightPath(frames);
    expect(path).toEqual<FlightPathPoint[]>([
      { lat: 1, lon: 1, rssi: -60, lq: 99 },
      { lat: 2, lon: 2, rssi: -65, lq: 95 },
      { lat: 3, lon: 3, rssi: -70, lq: 90 },
    ]);
  });

  it("returns [] for empty history", () => {
    expect(deriveFlightPath([])).toEqual([]);
  });
});

function pt(i: number): FlightPathPoint {
  return { lat: i, lon: i, rssi: -50 - i, lq: i % 101 };
}

describe("decimatePath", () => {
  it("returns all points (as a copy) when length <= max", () => {
    const points = [pt(0), pt(1), pt(2)];
    const out = decimatePath(points, 10);
    expect(out).toEqual(points);
    // Module returns a shallow copy ([...points]).
    expect(out).not.toBe(points);
  });

  it("anchors endpoints and preserves ascending order when length > max", () => {
    const points = Array.from({ length: 50 }, (_, i) => pt(i));
    const out = decimatePath(points, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out[0]).toBe(points[0]);
    expect(out[out.length - 1]).toBe(points[points.length - 1]);
    // Selected source lat values are strictly ascending (indices monotonic).
    for (let i = 1; i < out.length; i++) {
      expect(out[i].lat).toBeGreaterThan(out[i - 1].lat);
    }
  });

  it("does not cap when max <= 0 (returns a full copy)", () => {
    const points = Array.from({ length: 5 }, (_, i) => pt(i));
    const zero = decimatePath(points, 0);
    expect(zero).toEqual(points);
    expect(zero).not.toBe(points);
    const neg = decimatePath(points, -3);
    expect(neg).toEqual(points);
  });

  it("keeps the first point (no div-by-zero) when max === 1", () => {
    const points = Array.from({ length: 5 }, (_, i) => pt(i));
    const out = decimatePath(points, 1);
    expect(out).toEqual([points[0]]);
  });

  it("decimates 1000 points to <= 500 with endpoints preserved", () => {
    const points = Array.from({ length: 1000 }, (_, i) => pt(i));
    const out = decimatePath(points, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out[0]).toBe(points[0]);
    expect(out[out.length - 1]).toBe(points[999]);
  });
});

describe("LIVE_PATH_MAX_POINTS", () => {
  it("is a positive number", () => {
    expect(typeof LIVE_PATH_MAX_POINTS).toBe("number");
    expect(LIVE_PATH_MAX_POINTS).toBeGreaterThan(0);
  });
});
