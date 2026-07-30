import { useTranslation } from "react-i18next";
import { Trash2, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePassthroughStore } from "@/stores";
import { passthroughFailureLabelKey } from "@/lib/bridge";
import type { PassthroughAttempt } from "@/stores/passthrough";

/**
 * The M64 diagnostic event log: every passthrough attempt, newest-first, with a
 * frontend-stamped timestamp, the port/baud, and a categorised outcome
 * (success / specific failure category / open error). Bounded by the store
 * ({@link import("@/stores/passthrough").PASSTHROUGH_LOG_CAP}). M66 exports this.
 *
 * Accessible list semantics (`role="list"`) with one labeled row per attempt.
 */
export function PassthroughLog() {
  const { t } = useTranslation();
  const log = usePassthroughStore((s) => s.log);
  const clearLog = usePassthroughStore((s) => s.clearLog);

  return (
    <section
      data-testid="passthrough-log"
      aria-label={t("bridge.passthrough.log.title")}
      className="mt-3"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">
          {t("bridge.passthrough.log.title")}
        </span>
        {log.length > 0 && (
          <button
            type="button"
            data-testid="passthrough-log-clear"
            onClick={() => clearLog()}
            aria-label={t("bridge.passthrough.log.clear")}
            className="flex items-center gap-1 rounded p-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t("bridge.passthrough.log.clear")}
          </button>
        )}
      </div>

      {log.length === 0 ? (
        <p
          data-testid="passthrough-log-empty"
          className="text-[11px] text-muted-foreground"
        >
          {t("bridge.passthrough.log.empty")}
        </p>
      ) : (
        <ul role="list" className="space-y-1">
          {log.map((attempt) => (
            <PassthroughLogRow key={attempt.id} attempt={attempt} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One log row: timestamp + port/baud + a categorised outcome chip. */
function PassthroughLogRow({ attempt }: { attempt: PassthroughAttempt }) {
  const { t } = useTranslation();
  const time = new Date(attempt.timestamp).toLocaleTimeString();
  const baud = attempt.report?.baud ?? attempt.baudOverride;

  // Outcome: an open/invoke error, a specific failure category, or success.
  let icon = <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-status-good" aria-hidden="true" />;
  let outcome = t("bridge.passthrough.log.success");
  let tone = "text-status-good";
  if (attempt.error) {
    icon = <AlertCircle className="h-3.5 w-3.5 shrink-0 text-status-critical" aria-hidden="true" />;
    outcome = t("bridge.passthrough.log.errored");
    tone = "text-status-critical";
  } else if (attempt.report?.failure) {
    icon = <XCircle className="h-3.5 w-3.5 shrink-0 text-status-warning" aria-hidden="true" />;
    outcome = t(passthroughFailureLabelKey(attempt.report.failure));
    tone = "text-status-warning";
  }

  return (
    <li
      data-testid="passthrough-log-row"
      className="flex items-start gap-2 rounded border border-border bg-card/40 px-2 py-1 text-[11px]"
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <time dateTime={new Date(attempt.timestamp).toISOString()}>{time}</time>
          <span className="truncate font-mono text-foreground">{attempt.port}</span>
          {baud ? (
            <span className="whitespace-nowrap">
              {t("bridge.passthrough.log.atBaud", { baud })}
            </span>
          ) : null}
        </div>
        <span className={cn("break-words", tone)}>{outcome}</span>
      </div>
    </li>
  );
}
