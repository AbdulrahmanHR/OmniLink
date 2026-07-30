import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import maplibregl, { type Marker as MapLibreMarker } from "maplibre-gl";
import type { ParsedLog } from "@/lib/blackbox";
import type { AnomalySeverity } from "@/lib/anomaly";
import { useFlightMap } from "@/components/map";
import { useSessionStore } from "@/stores/session";

/**
 * Clickable anomaly markers on the flight-path map (M15, FR-LOG-04).
 *
 * Rendered as a child of {@link import("@/components/map").FlightMap} so it can
 * reach the live MapLibre instance via {@link useFlightMap}. Each detected
 * {@link import("@/lib/anomaly").AnomalyEvent} that has a GPS fix at its sample
 * index (`log.gps[ev.index]`) gets a severity-coloured marker; events without a
 * fix simply don't appear (FlightMap's no-GPS state is unchanged).
 *
 * ## One shared cursor
 * Clicking a marker calls the store's `selectAnomaly(i)` — the very same action
 * the panel and timeline use — which both selects the event and scrubs the
 * single `positionIndex`. There is no second, desyncable cursor; the selected
 * marker's emphasis is keyed off `selectedAnomalyIndex`, so panel ↔ timeline ↔
 * map stay in lockstep.
 *
 * Markers are imperative MapLibre objects (no React DOM tree of its own), so the
 * component returns `null` and manages the full marker lifecycle inside one
 * effect: build on mount/update, `.remove()` every marker on teardown so
 * re-renders never leak or duplicate.
 */

/** Severity → Signal Lab status token (shared across all M15 surfaces). */
const SEVERITY_COLOR: Record<AnomalySeverity, string> = {
  info: "var(--color-status-good)",
  warning: "var(--color-status-warning)",
  critical: "var(--color-status-critical)",
};

interface AnomalyMapMarkersProps {
  log: ParsedLog;
}

export function AnomalyMapMarkers({ log }: AnomalyMapMarkersProps) {
  const { t } = useTranslation();
  const { map, ready } = useFlightMap();
  const anomalies = useSessionStore((s) => s.anomalies);
  const selectedAnomalyIndex = useSessionStore((s) => s.selectedAnomalyIndex);
  const selectAnomaly = useSessionStore((s) => s.selectAnomaly);

  useEffect(() => {
    if (!map || !ready) return;
    const t0 = log.time[0] ?? 0;
    const markers: MapLibreMarker[] = [];

    anomalies.forEach((ev, i) => {
      const fix = log.gps?.[ev.index] ?? null;
      if (!fix) return; // no-GPS events never appear on the map

      const selected = i === selectedAnomalyIndex;
      const color = SEVERITY_COLOR[ev.severity];
      const size = selected ? 18 : 12;

      const el = document.createElement("button");
      el.type = "button";
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.borderRadius = "9999px";
      el.style.background = color;
      el.style.border = "2px solid var(--color-background)";
      el.style.cursor = "pointer";
      el.style.padding = "0";
      el.style.boxSizing = "border-box";
      if (selected) el.style.boxShadow = `0 0 0 3px ${color}`;
      el.setAttribute("role", "button");
      const seconds = ((ev.t - t0) / 1000).toFixed(1);
      const label = t("anomaly.marker.aria", {
        type: t(`anomaly.type.${ev.type}`),
        time: `${seconds}s`,
      });
      el.setAttribute("aria-label", label);
      el.title = label;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        selectAnomaly(i);
      });

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([fix.lon, fix.lat])
        .addTo(map);
      markers.push(marker);
    });

    return () => {
      for (const marker of markers) marker.remove();
    };
  }, [map, ready, anomalies, selectedAnomalyIndex, log, selectAnomaly, t]);

  return null;
}
