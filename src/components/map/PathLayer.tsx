import * as React from "react";
import type {
  GeoJSONSource,
  LineLayerSpecification,
} from "maplibre-gl";
import { resolveThemeColor } from "./map-style";
import { useFlightMap, type FlightPathPoint } from "./flight-map-context";

const SOURCE_ID = "flight-path";
const LAYER_ID = "flight-path-line";

interface PathLayerProps {
  track: readonly FlightPathPoint[];
}

/** Build a single LineString GeoJSON of the whole track. */
function toLineString(track: readonly FlightPathPoint[]): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: track.map((p) => [p.lon, p.lat]),
    },
  };
}

/**
 * The flight path baseline (M12): a thin continuous polyline drawn *under* the
 * {@link SignalHeatLayer} so the route stays legible even where adjacent signal
 * colours are similar. Colour comes from the Signal Lab `--muted-foreground`
 * token so it reads in every theme.
 *
 * Imperatively manages its MapLibre source/layer keyed off the parent
 * {@link FlightMap} context. The source/layer are added exactly once (init
 * effect) and the line data is updated in place via {@link GeoJSONSource.setData}
 * as the track grows (update effect) — so live growth never tears down the
 * source/layer and never thrashes the GL context.
 */
export function PathLayer({ track }: PathLayerProps) {
  const { map, ready } = useFlightMap();

  // INIT: add source (empty) + layer exactly once; cleanup (unmount / map
  // change) removes them. No `track` dep, so this never re-runs on growth.
  React.useEffect(() => {
    if (!map || !ready) return;

    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: toLineString([]) as GeoJSON.GeoJSON,
      });
    }
    if (!map.getLayer(LAYER_ID)) {
      const layer: LineLayerSpecification = {
        id: LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": resolveThemeColor("--muted-foreground", "#7a8699"),
          "line-width": 1.5,
          "line-opacity": 0.7,
        },
      };
      map.addLayer(layer);
    }

    return () => {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
  }, [map, ready]);

  // UPDATE: push new track geometry in place. No teardown here — on live growth
  // the existing source is reused and only its data changes.
  React.useEffect(() => {
    if (!map || !ready) return;
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return; // init effect hasn't run yet
    source.setData(toLineString(track) as GeoJSON.GeoJSON);
  }, [map, ready, track]);

  return null;
}
