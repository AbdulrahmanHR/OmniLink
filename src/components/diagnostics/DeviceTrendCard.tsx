import { useTranslation } from "react-i18next";
import type { DeviceTrend } from "@/lib/diagnostics";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Sparkline } from "@/components/telemetry/Sparkline";
import { camel } from "./util";

interface DeviceTrendCardProps {
  trend: DeviceTrend;
}

/** Health band → sparkline color (mirrors SignalHealthPanel's `bandColor`). */
function bandColor(score: number): string {
  if (score < 40) return "var(--color-status-critical)";
  if (score < 75) return "var(--color-status-warning)";
  return "var(--color-status-good)";
}

/**
 * One device's cross-session trend card (M40).
 *
 * Renders the health-over-time sparkline (oldest→newest), the average health, the
 * rule/pattern events that recurred across this device's sessions, and any weak RF
 * modes. Reads a pure {@link DeviceTrend} the trend engine already computed — no
 * detection here. Reuses the existing rule/pattern i18n labels so nothing is
 * duplicated. An imported-CSV device (no metadata) renders under a localized
 * "unknown device" label.
 */
export function DeviceTrendCard({ trend }: DeviceTrendCardProps) {
  const { t } = useTranslation();
  const label = trend.deviceLabel ?? t("diagnostics.trends.unknownDevice");

  const eventLabel = (kind: "rule" | "pattern", id: string): string =>
    kind === "rule"
      ? t(`diagnostics.rule.${camel(id)}`)
      : t(`diagnostics.pattern.${camel(id)}`);

  return (
    <Card data-testid="diagnostics-trend-device">
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>
          {t("diagnostics.trends.sessionCount", { count: trend.sessionCount })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Health over time — oldest→newest. */}
        <div className="flex items-center gap-4">
          {trend.healthSeries.length > 1 && (
            <div
              role="img"
              aria-label={t("diagnostics.trends.healthTrendAria", {
                device: label,
              })}
              className="h-10 w-40 shrink-0"
            >
              <Sparkline
                data={trend.healthSeries}
                color={bandColor(trend.avgHealth)}
                domain={[0, 100]}
                className="h-full w-full"
              />
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {t("diagnostics.trends.avgHealth", {
              score: Math.round(trend.avgHealth),
            })}
          </p>
        </div>

        {/* Repeated event types across this device's sessions. */}
        {trend.repeatedEvents.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("diagnostics.trends.repeatedEvents")}
            </p>
            <ul className="flex flex-col gap-1">
              {trend.repeatedEvents.map((ev) => (
                <li
                  key={`${ev.kind}:${ev.id}`}
                  className="flex items-center justify-between gap-2 text-sm text-foreground/90"
                >
                  <span>{eventLabel(ev.kind, ev.id)}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("diagnostics.trends.eventSessions", {
                      count: ev.sessions,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Repeated weak RF modes / packet rates. */}
        {trend.weakRfModes.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("diagnostics.trends.weakRfModes")}
            </p>
            <ul className="flex flex-col gap-1">
              {trend.weakRfModes.map((mode) => (
                <li
                  key={mode.packetRate}
                  className="text-sm text-foreground/90"
                >
                  {t("diagnostics.trends.weakRfMode", {
                    packetRate: mode.packetRate,
                    avgHealth: Math.round(mode.avgHealth),
                    sessions: mode.sessions,
                  })}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
