/**
 * CRSF Link Statistics -> TelemetryFrame mapping (M7-API).
 *
 * This module is the single, documented home for every CRSF index -> value
 * lookup the telemetry UI depends on. The Rust CRSF parser
 * (`src-tauri/src/crsf/mod.rs`) decodes a Link Statistics (0x14) frame into the
 * raw wire representation and emits it on `device://link-stats` as a
 * {@link LinkStats} payload; here we turn that into the {@link TelemetryFrame}
 * shape the existing dashboard components consume.
 *
 * Wire conventions (per `docs/CRSF_PROTOCOL.md`):
 * - RSSI fields are a positive magnitude; the dBm value is the negation, so a
 *   wire value of `70` means `-70 dBm`. A wire value of `0` means "no reading"
 *   (e.g. an unused diversity antenna), which we floor to {@link RSSI_FLOOR_DBM}
 *   rather than letting it read as a perfect `0 dBm`.
 * - `uplinkTxPower` and `rfMode` are enum *indices*, decoded below.
 */

import {
  PACKET_RATES,
  TX_POWER_STEPS,
  type AntennaReading,
  type GpsReading,
  type TelemetryFrame,
} from "@/stores/telemetry";
import type { GpsTelemetry, LinkStats } from "@/lib/tauri";

/**
 * dBm value substituted when a CRSF RSSI magnitude is reported as `0`
 * (no reading). Matches the polar plot's lower domain bound so a missing
 * antenna renders as "no signal" rather than a full-strength lobe.
 */
export const RSSI_FLOOR_DBM = -110;

/**
 * CRSF telemetry TX-power index -> milliwatts.
 *
 * This is the standard CRSF `CRSF_FRAMETYPE_LINK_STATISTICS` power enum shared
 * by TBS Crossfire and ExpressLRS. The ExpressLRS UI power steps live in the
 * telemetry store as {@link TX_POWER_STEPS} (a subset of these values); this
 * table is the authoritative decode of the raw index on the wire.
 */
export const CRSF_TX_POWER_MW = [
  0, // 0
  10, // 1
  25, // 2
  100, // 3
  500, // 4
  1000, // 5
  2000, // 6
  250, // 7
  50, // 8
] as const;

/**
 * CRSF `rfMode` index -> packet rate (Hz).
 *
 * ⚠️ UNVERIFIED / firmware-dependent. Unlike {@link CRSF_TX_POWER_MW}, the CRSF
 * `rf_mode` field has NO single canonical Hz ladder: ELRS 2.4 GHz, ELRS 900 MHz
 * and TBS Crossfire each enumerate rates differently, and the mapping shifts
 * between firmware versions. The table below is a best-effort common ladder and
 * WILL mislabel `packetRate` on some real devices. It degrades gracefully
 * (unknown index -> `0`, rendered "0 Hz", never throws), but the value is not
 * trustworthy until validated against the connected target's OTA-rate table.
 *
 * TODO(M7/hardware): confirm against real ELRS firmware (read the device's
 * reported rate table during the CRSF handshake rather than guessing by index).
 */
export const CRSF_RF_RATE_HZ = [
  4, // 0
  25, // 1
  50, // 2
  100, // 3
  150, // 4
  200, // 5
  250, // 6
  333, // 7
  500, // 8
  1000, // 9
] as const;

/**
 * Scale factor for CRSF GPS latitude/longitude: the wire value is degrees × 1e7
 * (`docs/CRSF_PROTOCOL.md` §5.3).
 */
export const GPS_COORD_SCALE = 1e7;

/**
 * Altitude bias (metres) baked into the CRSF GPS frame: the wire value is
 * `metres + 1000`, so real altitude = `altitude - GPS_ALT_OFFSET_M`.
 */
export const GPS_ALT_OFFSET_M = 1000;

/**
 * Convert a raw CRSF GPS sub-object (degrees×1e7, km/h×10, deg×100, m+1000) into
 * a {@link GpsReading} in human units. Returns `null` when no GPS data is
 * present at all (non-GPS device) so callers degrade gracefully instead of
 * rendering a bogus `0,0`. A `(0,0)` "no-fix yet" reading is preserved with its
 * satellite count so the readout can show "acquiring"; {@link gpsHasFix}
 * distinguishes the two.
 */
export function gpsFromTelemetry(
  gps: GpsTelemetry | null | undefined
): GpsReading | null {
  if (!gps) return null;
  return {
    latitude: gps.latitude / GPS_COORD_SCALE,
    longitude: gps.longitude / GPS_COORD_SCALE,
    altitude: gps.altitude - GPS_ALT_OFFSET_M,
    satellites: gps.satellites,
    groundSpeed: gps.groundSpeed / 10,
    heading: gps.heading / 100,
  };
}

/**
 * Whether a {@link GpsReading} represents an actual position fix (vs. a GPS
 * module that is powered but hasn't locked yet, which reports `0,0`). Used by
 * the dashboard to show coordinates only when they are real.
 */
export function gpsHasFix(gps: GpsReading | null | undefined): boolean {
  return !!gps && (gps.latitude !== 0 || gps.longitude !== 0);
}

/** Decode a CRSF RSSI magnitude (positive) into dBm, flooring `0` readings. */
export function crsfRssiToDbm(magnitude: number): number {
  return magnitude === 0 ? RSSI_FLOOR_DBM : -magnitude;
}

/** Map a CRSF TX-power index to milliwatts (0 for unknown indices). */
export function crsfTxPowerToMw(index: number): number {
  return CRSF_TX_POWER_MW[index] ?? 0;
}

/** Map a CRSF RF-mode index to a packet rate in Hz (0 for unknown indices). */
export function crsfRfModeToHz(index: number): number {
  return CRSF_RF_RATE_HZ[index] ?? 0;
}

/**
 * Convert a decoded CRSF Link Statistics payload into a {@link TelemetryFrame}.
 *
 * Only the *uplink* fields drive the dashboard (RSSI ant1/ant2, link quality,
 * SNR, TX power, RF rate) — they describe the radio->craft link the operator
 * cares about. `now` is injectable for deterministic tests.
 */
export function linkStatsToFrame(
  stats: LinkStats,
  now: number = Date.now()
): TelemetryFrame {
  const rssi1 = crsfRssiToDbm(stats.uplinkRssi1);
  const rssi2 = crsfRssiToDbm(stats.uplinkRssi2);

  const antennas: AntennaReading[] = [
    {
      id: 1,
      rssi: rssi1,
      active: stats.activeAntenna === 0 && stats.uplinkRssi1 !== 0,
    },
    {
      id: 2,
      rssi: rssi2,
      active: stats.activeAntenna === 1 && stats.uplinkRssi2 !== 0,
    },
  ];

  return {
    t: now,
    rssi1,
    rssi2,
    linkQuality: stats.uplinkLinkQuality,
    snr: stats.uplinkSnr,
    txPower: crsfTxPowerToMw(stats.uplinkTxPower),
    packetRate: crsfRfModeToHz(stats.rfMode),
    antennas,
    gps: gpsFromTelemetry(stats.gps),
  };
}

// Re-exported so consumers/tests can assert UI steps stay a subset of the CRSF
// decode tables without importing the store directly.
export { PACKET_RATES, TX_POWER_STEPS };
