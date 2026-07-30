import { useTranslation } from "react-i18next";
import { Radio } from "lucide-react";
import { useDevice, useTelemetryStream } from "@/hooks";
import { TelemetryDashboard } from "@/components/telemetry";
import {
  DiagnosticSettings,
  SignalHealthPanel,
} from "@/components/diagnostics";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useSessionStore } from "@/stores/session";

export function TelemetryPage() {
  const { t } = useTranslation();
  const { isConnected } = useDevice();
  const isSimulating = useSessionStore((s) => s.isSimulating);

  // Subscribes to real CRSF Link Statistics (`device://link-stats`) while
  // connected, feeding decoded frames into the telemetry store and the batching
  // SQLite writer; self-gates and clears the store on disconnect.
  useTelemetryStream();

  // Show the live dashboard for a real connected device OR while a replay
  // simulation is feeding the same store; otherwise an honest empty state.
  const showDashboard = isConnected || isSimulating;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">
          {t("telemetry.title")}
        </h1>
        {/* Suppress the live indicator while simulating so "● live" and the
            SIMULATED badge are never shown together (the badge is the sole
            status while a sim is active). */}
        {isConnected && !isSimulating && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-status-good">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-status-good opacity-75 motion-safe:animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-status-good" />
            </span>
            {t("telemetry.live")}
          </span>
        )}
      </div>

      {showDashboard ? (
        <div className="flex flex-col gap-4">
          <TelemetryDashboard />

          {/* M37 live signal-health: the rolling health score + transparent
              factor breakdown from the live link, plus a settings trigger. The
              live evaluator runs here; notifications stay on the M26 path. */}
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle>{t("diagnostics.panel.title")}</CardTitle>
              <DiagnosticSettings />
            </CardHeader>
            <CardContent>
              <SignalHealthPanel mode="live" />
            </CardContent>
          </Card>
        </div>
      ) : (
        <EmptyState
          icon={Radio}
          title={t("telemetry.empty.title")}
          description={t("telemetry.empty.description")}
        />
      )}
    </div>
  );
}
