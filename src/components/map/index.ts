/**
 * Reusable offline flight-path map (M12, FR-TELEM-07/08).
 *
 * `FlightMap` is the single entry point consumers use; the layer components and
 * signal-colour helpers are exported for advanced composition + tests.
 */
export { FlightMap } from "./FlightMap";
export { useFlightMap, type FlightPathPoint } from "./flight-map-context";
export { PathLayer } from "./PathLayer";
export { SignalHeatLayer } from "./SignalHeatLayer";
export {
  signalColor,
  signalQualityFraction,
  rampColor,
  interpolateHex,
  DEFAULT_SIGNAL_RAMP,
  RSSI_DOMAIN_DBM,
  LQ_DOMAIN_PCT,
  type SignalMetric,
} from "./signal-color";
export {
  buildOfflineStyle,
  resolveSignalRamp,
  resolveThemeColor,
  prefersReducedMotion,
  installOfflineTileFallback,
  isTauriRuntime,
  OMNITILES_URL_TEMPLATE,
} from "./map-style";
