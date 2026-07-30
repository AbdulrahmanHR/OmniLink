import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  XCircle,
  MinusCircle,
  Circle,
  Loader2,
  PlugZap,
  Cable,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePassthroughStore } from "@/stores";
import {
  PASSTHROUGH_STEPS,
  PASSTHROUGH_WIRING_KEYS,
  BRIDGE_RECOVERY_KEYS,
  passthroughStepLabelKey,
  passthroughFailureLabelKey,
  passthroughStepStatus,
} from "@/lib/bridge";
import type { PassthroughStepStatusDto } from "@/lib/tauri";
import { BridgeSafetyWarning } from "./BridgeSafetyWarning";
import { BaudOverride } from "./BaudOverride";
import { PassthroughLog } from "./PassthroughLog";
import { BridgeExport } from "./BridgeExport";

/** Per-status icon + tint for a stepper row. `pending` spins while running. */
function StepIcon({
  status,
  running,
}: {
  status: PassthroughStepStatusDto | "pending";
  running: boolean;
}) {
  const cls = "h-4 w-4 shrink-0";
  switch (status) {
    case "pass":
      return <CheckCircle2 className={cn(cls, "text-status-good")} aria-hidden="true" />;
    case "fail":
      return <XCircle className={cn(cls, "text-status-critical")} aria-hidden="true" />;
    case "skipped":
      return <MinusCircle className={cn(cls, "text-muted-foreground")} aria-hidden="true" />;
    default:
      return running ? (
        <Loader2 className={cn(cls, "animate-spin text-status-warning")} aria-hidden="true" />
      ) : (
        <Circle className={cn(cls, "text-muted-foreground")} aria-hidden="true" />
      );
  }
}

/**
 * The M64 guided passthrough check (FR-FLASH-09). A stepper-style sequence —
 * controller handshake → UART/passthrough → receiver response → CRSF response —
 * showing per-step pass/fail and, on failure, the SPECIFIC failure-category copy
 * + recovery guidance (never a generic flash error). Includes the manual baud
 * override and the diagnostic event log.
 *
 * Hardware safety: the RX-energizing {@link BridgeSafetyWarning} renders BEFORE
 * the run-check action. Generic wiring guidance (D29) is surfaced above the run
 * control. Accessible: each step is labeled and the stepper is an `aria-live`
 * region so progress is announced.
 *
 * READ-ONLY: the check sends only the read-only MSP GET + `MSP_SET_PASSTHROUGH`.
 */
export function PassthroughCheck({ port }: { port: string }) {
  const { t } = useTranslation();
  const { status, report, error, runCheck } = usePassthroughStore();
  const [baudOverride, setBaudOverride] = useState<number | undefined>(undefined);

  const isRunning = status === "running";
  const isError = status === "error";

  return (
    <div data-testid="passthrough-check" className="flex flex-col gap-3">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <PlugZap className="h-4 w-4" aria-hidden="true" />
          {t("bridge.passthrough.title")}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("bridge.passthrough.intro")}
        </p>
      </div>

      {/* Hardware-safety warning — ALWAYS before the RX-energizing run action. */}
      <BridgeSafetyWarning messageKey="bridge.passthrough.safety" />

      {/* Generic wiring guidance (D29) — original, no board-specific diagrams. */}
      <section
        data-testid="passthrough-wiring"
        aria-label={t("bridge.passthrough.wiring.title")}
        className="rounded-md border border-border bg-card/40 p-2.5"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Cable className="h-3.5 w-3.5" aria-hidden="true" />
          {t("bridge.passthrough.wiring.title")}
        </span>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-muted-foreground">
          {PASSTHROUGH_WIRING_KEYS.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
      </section>

      {/* Controls: manual baud override + run action. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <BaudOverride
          value={baudOverride}
          onChange={setBaudOverride}
          disabled={isRunning}
        />
        <Button
          size="sm"
          data-testid="passthrough-run"
          onClick={() => void runCheck(port, baudOverride)}
          disabled={isRunning}
          aria-label={t("bridge.passthrough.run")}
        >
          {isRunning ? (
            <>
              <Loader2 className="animate-spin" />
              {t("bridge.passthrough.running")}
            </>
          ) : (
            <>
              <PlugZap />
              {t("bridge.passthrough.run")}
            </>
          )}
        </Button>
      </div>

      {/* Stepper — an aria-live region so progress is announced. */}
      <ol
        data-testid="passthrough-steps"
        aria-live="polite"
        className="space-y-1.5"
      >
        {PASSTHROUGH_STEPS.map((step) => {
          const stepStatus = passthroughStepStatus(report, step);
          const stepLabel = t(passthroughStepLabelKey(step));
          const statusLabel = t(`bridge.passthrough.status.${stepStatus}`);
          return (
            <li
              key={step}
              data-testid={`passthrough-step-${step}`}
              data-status={stepStatus}
              className="flex items-center gap-2 text-xs"
              aria-label={`${stepLabel}: ${statusLabel}`}
            >
              <StepIcon status={stepStatus} running={isRunning} />
              <span
                className={cn(
                  "text-foreground",
                  stepStatus === "fail" && "font-medium text-status-critical",
                  stepStatus === "skipped" && "text-muted-foreground"
                )}
              >
                {stepLabel}
              </span>
            </li>
          );
        })}
      </ol>

      {/* Specific failure category — the actionable reason, NOT a generic error. */}
      {report?.failure ? (
        <div
          role="alert"
          data-testid="passthrough-failure"
          className="rounded-md border border-status-warning/40 bg-status-warning/10 p-2.5 text-xs text-status-warning"
        >
          {t(passthroughFailureLabelKey(report.failure))}
        </div>
      ) : null}

      {/* Full success. */}
      {report && report.failure === null ? (
        <p
          data-testid="passthrough-success"
          className="flex items-center gap-1.5 text-xs text-status-good"
        >
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t("bridge.passthrough.success")}
        </p>
      ) : null}

      {/* Open/invoke failure (busy/missing port, off-Tauri) + recovery hints.
          role="alert" so the failure is announced (matches the categorized
          passthrough failure above) — otherwise the stepper stays all-pending. */}
      {isError && error ? (
        <div role="alert" data-testid="passthrough-error">
          <p className="whitespace-pre-line break-words text-xs text-status-critical">
            {error}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
            {BRIDGE_RECOVERY_KEYS.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <PassthroughLog />

      {/* M66: one-click support-report export for a failed/completed check. */}
      <BridgeExport port={port} />
    </div>
  );
}
