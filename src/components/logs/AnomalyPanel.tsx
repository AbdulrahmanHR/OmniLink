import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import type { ParsedLog } from "@/lib/blackbox";
import type { AnomalySeverity, AnomalyType } from "@/lib/anomaly";
import { useSessionStore } from "@/stores/session";
import { useAssistantStore } from "@/stores/assistant";
import { summarizeLogRangeToPromptString } from "@/lib/log-range-summary";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** All anomaly types, for the type filter dropdown (mirrors `AnomalyType`). */
const ANOMALY_TYPES: readonly AnomalyType[] = [
  "signalLoss",
  "failsafe",
  "lqDrop",
  "txPowerChange",
];

/** All severities, for the severity filter dropdown (mirrors `AnomalySeverity`). */
const SEVERITIES: readonly AnomalySeverity[] = ["info", "warning", "critical"];

/** Severity → Signal Lab status token (info→good, warning→warning, critical→critical). */
const SEVERITY_COLOR: Record<AnomalySeverity, string> = {
  info: "var(--color-status-good)",
  warning: "var(--color-status-warning)",
  critical: "var(--color-status-critical)",
};

/** Shared classes for the lightweight native <select> filter controls. */
const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-background px-2 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface AnomalyPanelProps {
  log: ParsedLog;
}

/**
 * Detected-anomaly list + filters (M15, FR-ANOM-01..04).
 *
 * Renders the panel body (the page wraps it in a Card). Lists every anomaly the
 * store computed for the loaded log, filterable by type and severity. The
 * selected row, the timeline marker, and the map marker all key off the store's
 * single `selectedAnomalyIndex`, so clicking a row scrubs the one shared cursor
 * and lights up the same event everywhere. Each row can forward only its
 * GPS-free range summary string to the AI assistant.
 */
export function AnomalyPanel({ log }: AnomalyPanelProps) {
  const { t } = useTranslation();
  const anomalies = useSessionStore((s) => s.anomalies);
  const selectedAnomalyIndex = useSessionStore((s) => s.selectedAnomalyIndex);
  const selectAnomaly = useSessionStore((s) => s.selectAnomaly);

  const [typeFilter, setTypeFilter] = useState<"all" | AnomalyType>("all");
  const [severityFilter, setSeverityFilter] = useState<"all" | AnomalySeverity>(
    "all"
  );

  const t0 = log.time[0] ?? 0;

  // Keep each event's original index into `anomalies` so a click on a *filtered*
  // row still selects the right entry in the full store array.
  const rows = useMemo(
    () =>
      anomalies
        .map((ev, index) => ({ ev, index }))
        .filter(
          ({ ev }) =>
            (typeFilter === "all" || ev.type === typeFilter) &&
            (severityFilter === "all" || ev.severity === severityFilter)
        ),
    [anomalies, typeFilter, severityFilter]
  );

  const handleSendToAi = async (startIndex: number, endIndex: number) => {
    // Reuse the shared, GPS-free summariser — only the resulting string is sent.
    const summary = summarizeLogRangeToPromptString(log, startIndex, endIndex);
    await useAssistantStore.getState().sendMessage(summary);
    useAssistantStore.getState().open();
  };

  if (anomalies.length === 0) {
    return (
      <p
        data-testid="logs-anomaly-panel"
        className="py-6 text-center text-sm text-muted-foreground"
      >
        {t("anomaly.panel.empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="logs-anomaly-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {t("anomaly.panel.count", { count: anomalies.length })}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={SELECT_CLASS}
            value={typeFilter}
            onChange={(e) =>
              setTypeFilter(e.target.value as "all" | AnomalyType)
            }
            aria-label={t("anomaly.filter.type")}
          >
            <option value="all">{t("anomaly.filter.allTypes")}</option>
            {ANOMALY_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`anomaly.type.${type}`)}
              </option>
            ))}
          </select>
          <select
            className={SELECT_CLASS}
            value={severityFilter}
            onChange={(e) =>
              setSeverityFilter(e.target.value as "all" | AnomalySeverity)
            }
            aria-label={t("anomaly.filter.severity")}
          >
            <option value="all">{t("anomaly.filter.allSeverities")}</option>
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {t(`anomaly.severity.${severity}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <ul className="flex flex-col gap-1.5">
        {rows.map(({ ev, index }) => {
          const selected = index === selectedAnomalyIndex;
          const seconds = `${((ev.t - t0) / 1000).toFixed(1)}s`;
          const typeLabel = t(`anomaly.type.${ev.type}`);
          return (
            <li key={index}>
              <div
                className={cn(
                  "flex items-start gap-2 rounded-md border p-2 text-left transition-colors",
                  selected
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-accent"
                )}
              >
                <button
                  type="button"
                  onClick={() => selectAnomaly(index)}
                  aria-pressed={selected}
                  aria-label={t("anomaly.jumpAria", {
                    type: typeLabel,
                    time: seconds,
                  })}
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span
                    aria-hidden
                    className="mt-1 size-2 shrink-0 rounded-full"
                    style={{ background: SEVERITY_COLOR[ev.severity] }}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                      <span>{typeLabel}</span>
                      <span className="font-mono text-muted-foreground">
                        {seconds}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(ev.messageKey, ev.detail)}
                    </span>
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleSendToAi(ev.startIndex, ev.endIndex)}
                  aria-label={t("anomaly.sendToAiAria")}
                  className="shrink-0"
                >
                  <Sparkles aria-hidden />
                  {t("anomaly.sendToAi")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
