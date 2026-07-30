import * as React from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * Shared types + context for the flight map (M12). Kept in its own module (no
 * component exports) so `FlightMap.tsx` only exports the component — which keeps
 * React Fast Refresh working and satisfies `react-refresh/only-export-components`.
 */

/**
 * One sample along a recorded/live flight path. The map only needs position +
 * the two signal metrics; callers derive this from an M11 telemetry-session CSV
 * row, a {@link GpsReading}-bearing {@link TelemetryFrame}, or a parsed log.
 */
export interface FlightPathPoint {
  lat: number;
  lon: number;
  /** Uplink RSSI in dBm (negative). */
  rssi: number;
  /** Uplink link quality, 0–100 %. */
  lq: number;
}

/**
 * Context exposing the MapLibre instance + resolved theme ramp to the layer
 * children, plus a `ready` flag so layers only touch the map after `load`.
 */
export interface FlightMapContextValue {
  map: MapLibreMap | null;
  ready: boolean;
  ramp: string[];
}

export const FlightMapContext =
  React.createContext<FlightMapContextValue | null>(null);

/** Access the parent `FlightMap`'s map instance + theme ramp. */
export function useFlightMap(): FlightMapContextValue {
  const ctx = React.useContext(FlightMapContext);
  if (!ctx) {
    throw new Error(
      "FlightMap layer components must be rendered inside <FlightMap>"
    );
  }
  return ctx;
}
