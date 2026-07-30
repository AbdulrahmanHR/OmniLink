import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Eye, EyeOff, Gauge, Signal, Waves, Zap } from "lucide-react";
import {
  linkQualityHealth,
  rssiHealth,
  snrHealth,
  useTelemetryStore,
} from "@/stores/telemetry";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GpsReadout, LinkChart, MetricCard, PolarPlot } from "@/components/telemetry";
import { FlightMap } from "@/components/map";
import {
  decimatePath,
  deriveFlightPath,
  LIVE_PATH_MAX_POINTS,
} from "@/lib/flight-path";
import { useDashboardPanelsStore } from "@/stores/dashboardPanels";
import { useSessionStore } from "@/stores/session";
import { SimulatedBadge } from "@/components/simulator/SimulatedBadge";

interface TelemetryDashboardProps {
  /**
   * Whether to render the dashboard's own rolling-window flight-map card.
   * Defaults to `true` (the live TelemetryPage). The unified Session Analysis
   * page passes `false` because it provides a richer full-track map with anomaly
   * markers alongside, so the dashboard's map would be a redundant second
   * MapLibre instance.
   */
  showFlightPath?: boolean;
}

/**
 * Shared presentational telemetry dashboard. Reads the telemetry store directly
 * and renders the live widgets; it is data-source agnostic (live device stream
 * or session replay both feed the same store). When a session is active it
 * overlays a persistent SIMULATED badge (FR-SIM-02). This component must NOT
 * own any device subscription — that stays in TelemetryPage.
 */
export function TelemetryDashboard({
  showFlightPath = true,
}: TelemetryDashboardProps = {}) {
  const { t } = useTranslation();
  // Select each field separately rather than returning a combined object: a
  // `{ latest, history }` selector allocates a new object every render, which
  // useSyncExternalStore reads as a changed snapshot and loops infinitely.
  const latest = useTelemetryStore((s) => s.latest);
  const history = useTelemetryStore((s) => s.history);
  const isSimulating = useSessionStore((s) => s.isSimulating);

  const series = useMemo(
    () => ({
      rssi1: history.map((f) => f.rssi1),
      linkQuality: history.map((f) => f.linkQuality),
      snr: history.map((f) => f.snr),
    }),
    [history]
  );

  // Live flight path: derive from the same rolling history every other widget
  // reads, then cap the vertex count so MapLibre never bloats (see flight-path).
  const track = useMemo(
    () => decimatePath(deriveFlightPath(history), LIVE_PATH_MAX_POINTS),
    [history]
  );
  const showFlightMap = useDashboardPanelsStore((s) => s.showFlightMap);
  const setShowFlightMap = useDashboardPanelsStore((s) => s.setShowFlightMap);

  // Before the first frame `latest` is null. Show a neutral "--" placeholder
  // rather than 0, otherwise metrics like RSSI would paint a healthy green
  // "0 dBm" while others paint critical red — a misleading initial paint.
  const hasData = latest != null;
  const rssi = latest?.rssi1 ?? 0;
  const lq = latest?.linkQuality ?? 0;
  const snr = latest?.snr ?? 0;
  const placeholder = "--";

  return (
    <div className="relative flex flex-col gap-4">
      {isSimulating && <SimulatedBadge />}

      {/* Metric cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <MetricCard
          label={t("telemetry.metrics.rssi")}
          value={hasData ? rssi : placeholder}
          unit="dBm"
          health={hasData ? rssiHealth(rssi) : "neutral"}
          icon={Signal}
          sparklineData={series.rssi1}
          sparklineDomain={[-110, -30]}
        />
        <MetricCard
          label={t("telemetry.metrics.linkQuality")}
          value={hasData ? lq : placeholder}
          unit="%"
          health={hasData ? linkQualityHealth(lq) : "neutral"}
          icon={Activity}
          sparklineData={series.linkQuality}
          sparklineDomain={[0, 100]}
        />
        <MetricCard
          label={t("telemetry.metrics.snr")}
          value={hasData ? snr : placeholder}
          unit="dB"
          health={hasData ? snrHealth(snr) : "neutral"}
          icon={Waves}
          sparklineData={series.snr}
        />
        <MetricCard
          label={t("telemetry.metrics.txPower")}
          value={hasData ? latest.txPower : placeholder}
          unit="mW"
          health={hasData ? "good" : "neutral"}
          icon={Zap}
        />
        <MetricCard
          label={t("telemetry.metrics.packetRate")}
          value={hasData ? latest.packetRate : placeholder}
          unit="Hz"
          health={hasData ? "good" : "neutral"}
          icon={Gauge}
        />
      </div>

      {/* GPS readout (M11) — degrades gracefully when no GPS module present. */}
      <GpsReadout
        gps={latest?.gps ?? null}
        labels={{
          title: t("telemetry.gps.title"),
          latitude: t("telemetry.gps.latitude"),
          longitude: t("telemetry.gps.longitude"),
          satellites: t("telemetry.gps.satellites"),
          altitude: t("telemetry.gps.altitude"),
          groundSpeed: t("telemetry.gps.groundSpeed"),
          heading: t("telemetry.gps.heading"),
          noModule: t("telemetry.gps.noModule"),
          noFix: t("telemetry.gps.noFix"),
        }}
      />

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("telemetry.link.title")}</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <LinkChart
              labels={{
                rssi1: t("telemetry.link.rssi1"),
                rssi2: t("telemetry.link.rssi2"),
                linkQuality: t("telemetry.link.linkQuality"),
                seconds: "s",
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("telemetry.polar.title")}</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <PolarPlot
              labels={{
                antenna1: t("telemetry.polar.antenna1"),
                antenna2: t("telemetry.polar.antenna2"),
                noSignal: t("telemetry.polar.noSignal"),
                ariaLabel: t("telemetry.polar.ariaLabel"),
              }}
            />
          </CardContent>
        </Card>
      </div>

      {/* Flight path map (M13, FR-TELEM-04) — toggleable optional panel whose
          visibility is persisted. FlightMap owns the no-GPS hint (FR-TELEM-08)
          when the track has no usable fix, so we just pass the track through.
          Suppressed on the Session Analysis page (showFlightPath=false), which
          renders its own richer full-track map. */}
      {showFlightPath && (
      <Card data-testid="flight-map-panel">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>{t("telemetry.map.title")}</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("telemetry.map.toggleLabel")}
            aria-pressed={showFlightMap}
            onClick={() => setShowFlightMap(!showFlightMap)}
          >
            {showFlightMap ? <EyeOff /> : <Eye />}
          </Button>
        </CardHeader>
        {showFlightMap && (
          <CardContent>
            <FlightMap track={track} metric="rssi" className="h-80" />
          </CardContent>
        )}
      </Card>
      )}
    </div>
  );
}
