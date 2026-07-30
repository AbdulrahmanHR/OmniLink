import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { deriveLogFlightPath, type ParsedLog } from "@/lib/blackbox";
import { FlightMap } from "@/components/map";
import { useSessionStore } from "@/stores/session";
import { AnomalyMapMarkers } from "./AnomalyMapMarkers";

interface LogPathPanelProps {
  log: ParsedLog;
}

/**
 * Flight-path map panel for a loaded log (M14, FR-LOG-05; M15 anomaly markers).
 *
 * Reuses {@link FlightMap} directly with the log's derived track, so the offline
 * tiles, signal heat overlay, theming, reduced-motion handling, and the baked-in
 * **no-GPS state** (FR-TELEM-08) all come for free — none of it is reimplemented.
 * M15 anomaly markers ({@link AnomalyMapMarkers}) are mounted as a FlightMap
 * child so they reach the live map instance via `useFlightMap()`.
 *
 * ## Cursor ↔ map wiring
 * The shared position index (`useSessionStore().positionIndex` — the very same
 * field the dashboard, charts and transport use) is reflected on this panel as a
 * live position readout
 * re-derived from `log.gps[cursorIndex]`. Clicking an anomaly marker scrubs that
 * same cursor (via `selectAnomaly`); one cursor index drives the chart reference
 * line, this readout, and the markers — there is no second, desyncable cursor.
 */
export function LogPathPanel({ log }: LogPathPanelProps) {
  const { t } = useTranslation();
  const cursorIndex = useSessionStore((s) => s.positionIndex);

  const track = useMemo(() => deriveLogFlightPath(log), [log]);
  const cursorFix = log.gps?.[cursorIndex] ?? null;

  return (
    <div className="flex flex-col gap-2">
      <FlightMap track={track} metric="rssi" className="h-80">
        <AnomalyMapMarkers log={log} />
      </FlightMap>
      <p className="font-mono text-xs text-muted-foreground">
        {cursorFix
          ? t("logs.path.cursorFix", {
              lat: cursorFix.lat.toFixed(5),
              lon: cursorFix.lon.toFixed(5),
            })
          : t("logs.path.cursorNoFix")}
      </p>
    </div>
  );
}
