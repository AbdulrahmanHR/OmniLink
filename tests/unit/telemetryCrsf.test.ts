import { describe, expect, it } from "vitest";
import type { LinkStats } from "@/lib/tauri";
import {
  CRSF_RF_RATE_HZ,
  CRSF_TX_POWER_MW,
  RSSI_FLOOR_DBM,
  crsfRfModeToHz,
  crsfRssiToDbm,
  crsfTxPowerToMw,
  linkStatsToFrame,
} from "@/lib/telemetry-crsf";

/** A representative decoded Link Statistics payload (matches the Rust DTO). */
function sampleStats(overrides: Partial<LinkStats> = {}): LinkStats {
  return {
    uplinkRssi1: 70, // -70 dBm
    uplinkRssi2: 80, // -80 dBm
    uplinkLinkQuality: 100,
    uplinkSnr: 8,
    activeAntenna: 0,
    rfMode: 6, // 250 Hz
    uplinkTxPower: 3, // 100 mW
    downlinkRssi: 60,
    downlinkLinkQuality: 99,
    downlinkSnr: -5,
    ...overrides,
  };
}

describe("crsfRssiToDbm", () => {
  it("negates a positive magnitude into dBm", () => {
    expect(crsfRssiToDbm(70)).toBe(-70);
    expect(crsfRssiToDbm(110)).toBe(-110);
  });

  it("floors a zero (no-reading) magnitude instead of reading 0 dBm", () => {
    expect(crsfRssiToDbm(0)).toBe(RSSI_FLOOR_DBM);
  });
});

describe("crsfTxPowerToMw", () => {
  it("maps the standard CRSF power enum indices", () => {
    expect(crsfTxPowerToMw(0)).toBe(0);
    expect(crsfTxPowerToMw(1)).toBe(10);
    expect(crsfTxPowerToMw(3)).toBe(100);
    expect(crsfTxPowerToMw(6)).toBe(2000);
    expect(crsfTxPowerToMw(7)).toBe(250);
    expect(crsfTxPowerToMw(8)).toBe(50);
  });

  it("returns 0 for an out-of-range index", () => {
    expect(crsfTxPowerToMw(99)).toBe(0);
    expect(crsfTxPowerToMw(CRSF_TX_POWER_MW.length)).toBe(0);
  });
});

describe("crsfRfModeToHz", () => {
  it("maps RF-mode indices to packet rates", () => {
    expect(crsfRfModeToHz(2)).toBe(50);
    expect(crsfRfModeToHz(4)).toBe(150);
    expect(crsfRfModeToHz(6)).toBe(250);
    expect(crsfRfModeToHz(8)).toBe(500);
  });

  it("returns 0 for an unknown index", () => {
    expect(crsfRfModeToHz(99)).toBe(0);
    expect(crsfRfModeToHz(CRSF_RF_RATE_HZ.length)).toBe(0);
  });
});

describe("linkStatsToFrame", () => {
  it("maps every uplink field onto the TelemetryFrame shape", () => {
    const frame = linkStatsToFrame(sampleStats(), 1234);
    expect(frame).toEqual({
      t: 1234,
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
      gps: null,
    });
  });

  it("marks antenna 2 active when the diversity path selects it", () => {
    const frame = linkStatsToFrame(sampleStats({ activeAntenna: 1 }), 0);
    expect(frame.antennas[0].active).toBe(false);
    expect(frame.antennas[1].active).toBe(true);
  });

  it("treats a zero-RSSI antenna as inactive and floored (single-antenna RX)", () => {
    const frame = linkStatsToFrame(
      sampleStats({ uplinkRssi2: 0, activeAntenna: 1 }),
      0
    );
    expect(frame.rssi2).toBe(RSSI_FLOOR_DBM);
    // Active antenna index is 1 but it has no reading -> not lit.
    expect(frame.antennas[1].active).toBe(false);
  });

  it("defaults the timestamp to now when omitted", () => {
    const before = Date.now();
    const frame = linkStatsToFrame(sampleStats());
    expect(frame.t).toBeGreaterThanOrEqual(before);
  });
});
