import { describe, expect, it } from "vitest";
import type { GpsTelemetry, LinkStats } from "@/lib/tauri";
import {
  GPS_ALT_OFFSET_M,
  GPS_COORD_SCALE,
  gpsFromTelemetry,
  gpsHasFix,
  linkStatsToFrame,
} from "@/lib/telemetry-crsf";

/**
 * Raw CRSF GPS sub-object matching the bytes decoded by the Rust parser test
 * (`src-tauri/src/crsf/mod.rs::parses_gps`):
 *   lat 377749000 (37.7749°), lon -1224194000 (-122.4194°),
 *   ground_speed 150 (15.0 km/h), heading 18000 (180.00°),
 *   altitude 1100 (100 m, +1000 m offset), 9 satellites.
 */
function sampleGps(overrides: Partial<GpsTelemetry> = {}): GpsTelemetry {
  return {
    latitude: 377_749_000,
    longitude: -1_224_194_000,
    groundSpeed: 150,
    heading: 18_000,
    altitude: 1_100,
    satellites: 9,
    ...overrides,
  };
}

function sampleStats(overrides: Partial<LinkStats> = {}): LinkStats {
  return {
    uplinkRssi1: 70,
    uplinkRssi2: 80,
    uplinkLinkQuality: 100,
    uplinkSnr: 8,
    activeAntenna: 0,
    rfMode: 6,
    uplinkTxPower: 3,
    downlinkRssi: 60,
    downlinkLinkQuality: 99,
    downlinkSnr: -5,
    ...overrides,
  };
}

describe("gpsFromTelemetry", () => {
  it("scales the raw CRSF wire integers into human units", () => {
    const reading = gpsFromTelemetry(sampleGps());
    expect(reading).toEqual({
      latitude: 37.7749,
      longitude: -122.4194,
      altitude: 100,
      satellites: 9,
      groundSpeed: 15,
      heading: 180,
    });
  });

  it("uses the documented scale and offset constants", () => {
    expect(GPS_COORD_SCALE).toBe(1e7);
    expect(GPS_ALT_OFFSET_M).toBe(1000);
    const reading = gpsFromTelemetry(sampleGps({ latitude: 5_000_000, altitude: 1_500 }));
    expect(reading?.latitude).toBe(0.5);
    expect(reading?.altitude).toBe(500);
  });

  it("returns null when no GPS data is present (non-GPS device)", () => {
    expect(gpsFromTelemetry(null)).toBeNull();
    expect(gpsFromTelemetry(undefined)).toBeNull();
  });

  it("preserves a powered-but-unlocked module reporting 0,0", () => {
    const reading = gpsFromTelemetry(
      sampleGps({ latitude: 0, longitude: 0, satellites: 0, altitude: 1_000 })
    );
    expect(reading).not.toBeNull();
    expect(reading?.latitude).toBe(0);
    expect(reading?.altitude).toBe(0);
  });
});

describe("gpsHasFix", () => {
  it("is true only when a real position is reported", () => {
    expect(gpsHasFix(gpsFromTelemetry(sampleGps()))).toBe(true);
  });

  it("is false for null and for a 0,0 no-lock reading", () => {
    expect(gpsHasFix(null)).toBe(false);
    expect(
      gpsHasFix(gpsFromTelemetry(sampleGps({ latitude: 0, longitude: 0 })))
    ).toBe(false);
  });
});

// M29 hardening: the GPS-readout decode (M11/M13) must hold at the extremes of
// the coordinate/altitude domains a real module can legitimately report — full
// ±lat/±lon range and an altitude BELOW the +1000 m wire bias.
describe("gpsFromTelemetry extremes (M29 hardening)", () => {
  it("decodes the full ±lon / high-±lat coordinate range without clamping", () => {
    // +85° lat (850000000) and −180° lon (−1800000000) are both well within i32
    // wire range; the scale must pass them through exactly, not saturate.
    const north = gpsFromTelemetry(
      sampleGps({ latitude: 850_000_000, longitude: -1_800_000_000 })
    );
    expect(north?.latitude).toBe(85);
    expect(north?.longitude).toBe(-180);
    expect(gpsHasFix(north)).toBe(true);

    // The mirror extreme: −85° lat, +180° lon.
    const south = gpsFromTelemetry(
      sampleGps({ latitude: -850_000_000, longitude: 1_800_000_000 })
    );
    expect(south?.latitude).toBe(-85);
    expect(south?.longitude).toBe(180);
  });

  it("maps a wire altitude of 0 to −1000 m (below the +1000 m bias)", () => {
    // The CRSF altitude wire value is metres + 1000, so a wire 0 is a real
    // −1000 m, not 0. A naive (missing-offset) decode would read 0 here.
    const reading = gpsFromTelemetry(sampleGps({ altitude: 0 }));
    expect(reading?.altitude).toBe(-1000);
    // And a sub-sea reading (wire 500) decodes to −500 m.
    expect(gpsFromTelemetry(sampleGps({ altitude: 500 }))?.altitude).toBe(-500);
  });
});

describe("linkStatsToFrame GPS integration", () => {
  it("attaches a decoded GPS reading when link stats carry one", () => {
    const frame = linkStatsToFrame(sampleStats({ gps: sampleGps() }), 1234);
    expect(frame.gps).toEqual({
      latitude: 37.7749,
      longitude: -122.4194,
      altitude: 100,
      satellites: 9,
      groundSpeed: 15,
      heading: 180,
    });
  });

  it("leaves gps null when the device reports no GPS", () => {
    const frame = linkStatsToFrame(sampleStats(), 0);
    expect(frame.gps).toBeNull();
  });
});
