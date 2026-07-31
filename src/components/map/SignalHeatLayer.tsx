import * as React from "react";
import type {
  GeoJSONSource,
  LineLayerSpecification,
} from "maplibre-gl";
import { isMapAlive } from "./map-style";
import { signalColor, type SignalMetric } from "./signal-color";
import { useFlightMap, type FlightPathPoint } from "./flight-map-context";

const SOURCE_ID = "signal-heat";
const LAYER_ID = "signal-heat-line";

interface SignalHeatLayerProps {
  track: readonly FlightPathPoint[];
  metric: SignalMetric;
}

/** The metric value for a sample. */
function metricValue(p: FlightPathPoint, metric: SignalMetric): number {
  return metric === "rssi" ? p.rssi : p.lq;
}

/**
 * Build a FeatureCollection of per-segment LineStrings, each carrying a `color`
 * property derived from the average signal of its two endpoints. Colouring
 * per-segment (rather than one gradient line) keeps the mapping exact and works
 * without `line-gradient`/`line-progress` plumbing.
 */
function toSegments(
  track: readonly FlightPathPoint[],
  metric: SignalMetric,
  ramp: readonly string[]
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    const value = (metricValue(a, metric) + metricValue(b, metric)) / 2;
    features.push({
      type: "Feature",
      properties: { color: signalColor(value, metric, ramp) },
      geometry: {
        type: "LineString",
        coordinates: [
          [a.lon, a.lat],
          [b.lon, b.lat],
        ],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Signal heatmap overlay (M12, FR-TELEM-07): colours each flight-path segment by
 * its RSSI or link-quality so a pilot can *see where* the link degraded. Colours
 * come from the theme-resolved ramp in the {@link FlightMap} context
 * (`--status-critical` → `--status-good`), so it tracks dark/light/carbon.
 *
 * Drawn above {@link PathLayer}. The source/layer are added exactly once (init
 * effect); the per-segment colours (baked into the GeoJSON `color` property) are
 * re-pushed in place via {@link GeoJSONSource.setData} (update effect) whenever
 * the track, metric, or theme ramp changes. The layer paint reads `['get',
 * 'color']`, so the layer spec itself is ramp-independent — only the data is.
 * Live growth therefore never tears down the source/layer or thrashes GL.
 */
export function SignalHeatLayer({ track, metric }: SignalHeatLayerProps) {
  const { map, ready, ramp } = useFlightMap();

  // INIT: add source (empty) + layer exactly once; cleanup (unmount / map
  // change) removes them. No track/metric/ramp deps, so it never re-runs on
  // growth or recolour.
  React.useEffect(() => {
    if (!map || !ready) return;

    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: toSegments([], metric, ramp),
      });
    }
    if (!map.getLayer(LAYER_ID)) {
      const layer: LineLayerSpecification = {
        id: LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 4,
          "line-opacity": 0.9,
        },
      };
      map.addLayer(layer);
    }

    return () => {
      // See PathLayer: `FlightMap` removes the map before clearing the context,
      // so this cleanup is routinely handed an already-torn-down instance.
      if (!isMapAlive(map)) return;
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
    // metric/ramp here only seed the initial (empty) data; recolours happen in
    // the update effect, so they are intentionally not in this dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ready]);

  // UPDATE: re-push per-segment geometry+colours in place. No teardown — on live
  // growth or a ramp/metric change the existing source is reused.
  React.useEffect(() => {
    if (!map || !ready) return;
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return; // init effect hasn't run yet
    source.setData(toSegments(track, metric, ramp));
  }, [map, ready, track, metric, ramp]);

  return null;
}
