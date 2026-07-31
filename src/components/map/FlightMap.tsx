import * as React from "react";
import { useTranslation } from "react-i18next";
import { MapPinOff } from "lucide-react";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
// NOTE: `maplibre-gl/dist/maplibre-gl.css` is deliberately NOT imported here.
// A JS-imported stylesheet is unlayered, and unlayered CSS outranks every
// Tailwind v4 utility — `.maplibregl-map { position: relative }` then beat the
// `absolute inset-0` on the host below and collapsed the map to height 0. It is
// imported from `src/index.css` into `layer(base)` instead; see the comment
// there. Do not re-add it here.
import { cn } from "@/lib/utils";
import {
  buildOfflineStyle,
  installOfflineTileFallback,
  isExpectedTileError,
  prefersReducedMotion,
  resolveSignalRamp,
} from "./map-style";
import type { SignalMetric } from "./signal-color";
import {
  FlightMapContext,
  type FlightPathPoint,
} from "./flight-map-context";
import { PathLayer } from "./PathLayer";
import { SignalHeatLayer } from "./SignalHeatLayer";

interface FlightMapProps {
  /** Ordered path samples. Points without a real GPS fix must be filtered out. */
  track: readonly FlightPathPoint[];
  /** Which metric colours the heatmap. Defaults to RSSI. */
  metric?: SignalMetric;
  /** Deepest zoom any locally-stored tile pack provides (style `maxzoom`). */
  maxLocalZoom?: number;
  className?: string;
  /**
   * Optional overlay children rendered inside the map's
   * {@link FlightMapContext} provider, so they can reach the live map instance
   * via {@link useFlightMap} (e.g. M15 anomaly markers). Only mounted once a
   * track exists — the no-GPS branch returns before the provider, so overlays
   * correctly don't appear in the no-GPS state.
   */
  children?: React.ReactNode;
}

/**
 * The map host element, carrying the live MapLibre instance so out-of-app
 * observers (E2E, the browser console) can interrogate the map's real state.
 * See where it is assigned in the init effect for why this exists.
 */
type MapHost = HTMLDivElement & { _omniMap?: MapLibreMap };

/** Whether a single sample carries a usable GPS fix (finite, not null island). */
function hasFix(p: FlightPathPoint): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    (p.lat !== 0 || p.lon !== 0)
  );
}

/** Whether any point in the track carries a usable position. */
function hasTrack(track: readonly FlightPathPoint[]): boolean {
  return track.some(hasFix);
}

/**
 * Bounding box [west, south, east, north] of the track. Only points with a
 * usable fix are considered, so interspersed `(0,0)`/non-finite placeholders
 * (which {@link hasTrack} deliberately tolerates) don't stretch the fit toward
 * null island.
 */
function trackBounds(
  track: readonly FlightPathPoint[]
): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of track) {
    if (!hasFix(p)) continue;
    if (p.lon < w) w = p.lon;
    if (p.lon > e) e = p.lon;
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
  }
  return [w, s, e, n];
}

/**
 * Reusable offline flight-path map (M12, FR-TELEM-07/08).
 *
 * Renders a recorded or live GPS track as a polyline ({@link PathLayer}) with an
 * RSSI/LQ-coloured heatmap overlay ({@link SignalHeatLayer}), fitting the view
 * to the track's bounds. Tiles come exclusively from the local `omnitiles://`
 * store, so the map works with the network disabled.
 *
 * **No-GPS state (FR-TELEM-08) is baked in:** when the track has no usable
 * coordinates the map is hidden and a translated hint is shown instead, so M13
 * (live panel) and M14 (log path) consumers don't reimplement it.
 *
 * Honors `prefers-reduced-motion` (fit-bounds jumps instantly) and all three
 * Signal Lab themes (background + heat ramp resolved from CSS tokens).
 */
export function FlightMap({
  track,
  metric = "rssi",
  maxLocalZoom = 12,
  className,
  children,
}: FlightMapProps) {
  const { t } = useTranslation();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<MapLibreMap | null>(null);
  // Mirror the map instance into state so the context value (read during render
  // by the layer children) updates without touching a ref during render.
  const [map, setMap] = React.useState<MapLibreMap | null>(null);
  const [ready, setReady] = React.useState(false);
  const [ramp, setRamp] = React.useState<string[]>(resolveSignalRamp);
  // Remembers the last bounding box we fitted to so live track growth doesn't
  // retrigger the camera every frame (see the re-fit effect below).
  const lastFitRef = React.useRef<string>("");

  const visible = hasTrack(track);

  // Re-resolve the heat ramp when the active Signal Lab theme changes
  // mid-session. The theme store toggles a class on <html>; WebGL can't read CSS
  // classes, so observe that class attribute and re-resolve the ramp from the
  // now-updated computed tokens. The layer children keep `ramp` in their update
  // deps, so the heatmap repaints in place without a GL rebuild.
  React.useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setRamp(resolveSignalRamp()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // Initialise the map exactly once while a track is present. Re-running on
  // every `track` change would tear down/rebuild the GL context needlessly; the
  // layer children handle data updates in place.
  React.useEffect(() => {
    if (!visible || !containerRef.current || mapRef.current) return;

    // Outside Tauri the `omnitiles://` scheme is unreachable; register a
    // transparent-tile fallback so MapLibre never errors and the themed
    // background renders as an empty-coverage backdrop (no broken-tile state).
    installOfflineTileFallback();

    const reduceMotion = prefersReducedMotion();
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildOfflineStyle(maxLocalZoom),
      // Centred provisionally; fitBounds below frames the real track.
      center: [0, 0],
      zoom: 1,
      attributionControl: false,
      // Reduced motion → kill inertial/animated camera moves.
      dragRotate: false,
      ...(reduceMotion ? { fadeDuration: 0 } : {}),
    });
    mapRef.current = map;
    setMap(map);
    // Read-only handle for E2E/console observers. MapLibre keeps no global
    // registry of its instances, so without this there is no way to ask the live
    // map whether its style actually loaded — and "the style silently failed to
    // load" is precisely the defect that shipped a blank map in 3.0.2
    // (tests/e2e/map.spec.ts asserts on it). Nothing in the app reads this.
    const mapHost: MapHost = containerRef.current;
    mapHost._omniMap = map;

    // Graceful degradation, *selectively*: MapLibre fires `error` (never throws)
    // for failed tile/source loads — expected with no network, already handled
    // by the offline fallback above plus the themed empty-coverage backdrop, so
    // those stay quiet.
    //
    // It fires on the SAME channel for style-validation and configuration
    // errors, though, and blanket-ignoring the channel is exactly how 3.0.3
    // shipped a permanently blank map: the style spec rejected an `oklch()`
    // paint colour, the style never loaded, `load` never fired, no layer was
    // ever added — and not one character of it reached the console. Never make
    // this handler unconditional again.
    map.on("error", (event) => {
      if (isExpectedTileError(event)) return;
      const err = (event as { error?: unknown })?.error;
      console.error(
        "[FlightMap] MapLibre style/configuration error — the map may not " +
          "render at all:",
        err instanceof Error ? err.message : err,
        event
      );
    });

    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right"
    );
    // MapLibre's icon-only zoom buttons ship hardcoded English labels and no app
    // focus ring — relabel via i18n and apply the app focus-visible convention
    // so they're accessible and keyboard-discoverable.
    const host = containerRef.current;
    const labelControl = (selector: string, label: string) => {
      const btn = host?.querySelector<HTMLButtonElement>(selector);
      if (!btn) return;
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
      btn.classList.add(
        "focus-visible:outline-none",
        "focus-visible:ring-1",
        "focus-visible:ring-ring"
      );
    };
    labelControl(".maplibregl-ctrl-zoom-in", t("map.zoomIn"));
    labelControl(".maplibregl-ctrl-zoom-out", t("map.zoomOut"));

    map.on("load", () => {
      setReady(true);
      const [w, s, e, n] = trackBounds(track);
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 40, maxZoom: maxLocalZoom, animate: !reduceMotion }
      );
      // Seed the re-fit guard with this fit's bounds key so the re-fit effect
      // (which re-runs once `ready` flips true) doesn't fire a redundant second
      // fitBounds on mount. It still re-fits later if the track box actually
      // grows past this view (keys differ). Must match the effect's key format.
      lastFitRef.current = `${w},${s},${e},${n},${maxLocalZoom}`;
      // Resolve the ramp once the GL context (and thus theme) is live.
      setRamp(resolveSignalRamp());
    });

    return () => {
      map.remove();
      delete mapHost._omniMap;
      mapRef.current = null;
      setMap(null);
      setReady(false);
    };
    // `track`/`maxLocalZoom` intentionally excluded: init is one-shot, and the
    // initial fit uses the track at mount. Subsequent track growth is handled by
    // the layer children + the fit effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Re-fit when the track's bounding box changes (e.g. a new session loaded, or
  // live growth that pushes the path past the current view). Most live frames
  // append points *inside* the existing bounds — re-fitting on every frame would
  // retrigger a camera ease that fights the user's pan/zoom, so we only fit when
  // the box (or maxZoom) actually changes.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !visible) return;
    const [w, s, e, n] = trackBounds(track);
    const key = `${w},${s},${e},${n},${maxLocalZoom}`;
    if (key === lastFitRef.current) return;
    lastFitRef.current = key;
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 40, maxZoom: maxLocalZoom, animate: !prefersReducedMotion() }
    );
  }, [track, ready, visible, maxLocalZoom]);

  if (!visible) {
    // FR-TELEM-08: hide the map panel and show the GPS hint.
    return (
      <div
        data-testid="flight-map"
        className={cn(
          "flex min-h-[18rem] flex-col items-center justify-center gap-3 rounded-md border border-border bg-card/50 p-6 text-center",
          className
        )}
        role="status"
      >
        <MapPinOff className="h-8 w-8 text-muted-foreground" aria-hidden />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            {t("map.noGps.title")}
          </p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {t("map.noGps.hint")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="flight-map"
      /*
        Mirrors the MapLibre `load` event: `true` only once the style parsed and
        loaded, which is the precondition for any layer, any camera fit and any
        pixel being painted. Exposed in the DOM because "the style failed to
        load" was invisible from the outside in 3.0.3 — the container was
        correctly sized and visible while the map was completely blank, so every
        visibility/box assertion passed. tests/e2e/map.spec.ts asserts on it.
      */
      data-map-ready={ready ? "true" : "false"}
      className={cn(
        "relative min-h-[18rem] overflow-hidden rounded-md border border-border",
        className
      )}
    >
      {/*
        The map host doubles as the themed empty-coverage backdrop: `bg-muted`
        guarantees a themed background at the DOM level even before WebGL paints
        or when tiles can't resolve (offline / non-Tauri), so it degrades to an
        empty state rather than a broken-tile error. Keyboard-focusable with the
        app focus-visible ring; labelled for assistive tech.
      */}
      <div
        ref={containerRef}
        data-testid="flight-map-empty"
        className="absolute inset-0 bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        tabIndex={0}
        aria-label={t("map.ariaLabel")}
        role="application"
      />
      <FlightMapContext.Provider value={{ map, ready, ramp }}>
        <PathLayer track={track} />
        <SignalHeatLayer track={track} metric={metric} />
        {children}
      </FlightMapContext.Provider>
    </div>
  );
}
