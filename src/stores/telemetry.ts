import { create } from "zustand";

/**
 * Maximum number of frames retained in each rolling history buffer.
 * At 25Hz this is ~7.2s of telemetry — enough for smooth sparklines and
 * the link chart window without unbounded memory growth.
 */
export const TELEMETRY_HISTORY_CAP = 180;

// The TX-power / packet-rate ladders now live in a pure, store-free module so
// the on-device diagnostic engine can read them without importing this impure
// layer. Re-exported here for back-compat (existing `@/stores/telemetry`
// importers are unchanged).
export { PACKET_RATES, TX_POWER_STEPS } from "@/lib/telemetry-constants";

/** Health classification for a telemetry value, used for color coding. */
export type TelemetryHealth = "good" | "warning" | "critical";

/** A single per-antenna reading for the polar plot. */
export interface AntennaReading {
  /** Stable antenna id (1-based). */
  id: number;
  /** Raw RSSI for this antenna in dBm (negative, higher is better). */
  rssi: number;
  /** Whether this antenna is the currently active (selected) diversity path. */
  active: boolean;
}

/**
 * A decoded GPS fix in human units (M11), derived from the raw CRSF GPS frame.
 * Attached to a {@link TelemetryFrame} when the device reports GPS; absent
 * otherwise so the dashboard never renders a bogus `0,0`.
 */
export interface GpsReading {
  /** Latitude in decimal degrees. */
  latitude: number;
  /** Longitude in decimal degrees. */
  longitude: number;
  /** Altitude in metres (CRSF +1000 m bias already removed). */
  altitude: number;
  /** Number of satellites in the fix. */
  satellites: number;
  /** Ground speed in km/h. */
  groundSpeed: number;
  /** Heading in degrees. */
  heading: number;
}

/** A single telemetry frame, modelled on an ExpressLRS link statistics packet. */
export interface TelemetryFrame {
  /** Capture timestamp (ms since epoch). */
  t: number;
  /** Antenna 1 RSSI in dBm (negative; higher/less-negative is better). */
  rssi1: number;
  /** Antenna 2 RSSI in dBm. */
  rssi2: number;
  /** Link quality, 0-100 %. */
  linkQuality: number;
  /** Signal-to-noise ratio in dB. */
  snr: number;
  /** Current TX power in mW (one of TX_POWER_STEPS). */
  txPower: number;
  /** Packet/RF rate in Hz (one of PACKET_RATES). */
  packetRate: number;
  /** Per-antenna readings driving the polar plot. */
  antennas: AntennaReading[];
  /** Latest GPS fix in human units (M11); `null` when the device has no GPS. */
  gps?: GpsReading | null;
}

interface TelemetryState {
  latest: TelemetryFrame | null;
  history: TelemetryFrame[];
  /** Append a frame, trimming the rolling buffer to TELEMETRY_HISTORY_CAP. */
  push: (frame: TelemetryFrame) => void;
  /**
   * Replace the entire rolling buffer in a single set (one notification), used
   * by session-window rebuilds instead of clear()+N push(). `frames` is trimmed
   * to the last TELEMETRY_HISTORY_CAP entries; `latest` becomes the final frame.
   */
  setHistory: (frames: TelemetryFrame[]) => void;
  /** Reset all telemetry (called on disconnect). */
  clear: () => void;
}

export const useTelemetryStore = create<TelemetryState>()((set) => ({
  latest: null,
  history: [],
  push: (frame) =>
    set((state) => {
      const history =
        state.history.length >= TELEMETRY_HISTORY_CAP
          ? [...state.history.slice(state.history.length - TELEMETRY_HISTORY_CAP + 1), frame]
          : [...state.history, frame];
      return { latest: frame, history };
    }),
  setHistory: (frames) => {
    const history =
      frames.length > TELEMETRY_HISTORY_CAP
        ? frames.slice(frames.length - TELEMETRY_HISTORY_CAP)
        : frames;
    set({
      history,
      latest: history.length ? history[history.length - 1] : null,
    });
  },
  clear: () => set({ latest: null, history: [] }),
}));

/** RSSI (dBm) health thresholds — less negative is better. */
export function rssiHealth(rssi: number): TelemetryHealth {
  if (rssi >= -85) return "good";
  if (rssi >= -100) return "warning";
  return "critical";
}

/** Link quality (%) health thresholds. */
export function linkQualityHealth(lq: number): TelemetryHealth {
  if (lq >= 80) return "good";
  if (lq >= 50) return "warning";
  return "critical";
}

/** SNR (dB) health thresholds. */
export function snrHealth(snr: number): TelemetryHealth {
  if (snr >= 8) return "good";
  if (snr >= 3) return "warning";
  return "critical";
}
