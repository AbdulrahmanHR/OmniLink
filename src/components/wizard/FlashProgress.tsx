import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CheckCircle2, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
// Direct module import (mirroring `canClaimPort` in DeviceBar): the gate and
// the stage/status types come from the wizard store itself.
import {
  canCancelFlash,
  type FlashStage,
  type FlashStatus,
} from "@/stores/wizard";
import { FlashLogPanel } from "./FlashLogPanel";

interface FlashProgressProps {
  status: FlashStatus;
  percent: number;
  stage: FlashStage;
  /** Estimated seconds remaining (FR-FLASH-07); null until estimable. */
  etaSeconds?: number | null;
  /** Streamed build/upload log lines (FR-FLASH-06). */
  log?: string[];
  /**
   * Abort the run (FLASH-11). Rendered only while the flash can still be
   * stopped safely — see {@link canCancelFlash}; from the write stage on, the
   * backend refuses a cancel and the control is replaced by a "do not
   * disconnect" notice.
   */
  onCancel?: () => void;
}

/**
 * Format a seconds count as a compact, localized "~1m 20s" / "~45s" ETA string.
 * Units come from i18n (`wizard.flash.etaUnits.*`) rather than hardcoded m/s.
 */
function formatEta(seconds: number, t: TFunction): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    const mins = t("wizard.flash.etaUnits.minutes", { count: m });
    return s > 0
      ? `~${mins} ${t("wizard.flash.etaUnits.seconds", { count: s })}`
      : `~${mins}`;
  }
  return `~${t("wizard.flash.etaUnits.seconds", { count: seconds })}`;
}

/**
 * Animated progress bar + stage label + ETA + live log for the flash run, plus
 * the cancel control (FLASH-11).
 *
 * Without a cancel affordance a hung flash — an unreachable OTA host, a flight
 * controller that never answers the handshake — left the user with no way out
 * but killing the app, because the wizard locks navigation while a flash runs.
 */
export function FlashProgress({
  status,
  percent,
  stage,
  etaSeconds,
  log,
  onCancel,
}: FlashProgressProps) {
  const { t } = useTranslation();
  const done = status === "done";
  // The gate is the STAGE, not a timer: it flips exactly where the backend's
  // point of no return is (`FlashCancel::enter_write`).
  const cancellable = canCancelFlash(status, stage);
  const writing = status === "running" && !cancellable;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {done ? (
            <CheckCircle2 className="h-4 w-4 text-status-good" />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" />
          )}
          {t(`wizard.flash.stages.${stage}`)}
        </span>
        <span className="flex items-center gap-2 font-mono text-sm tabular-nums text-muted-foreground">
          {!done && etaSeconds != null && etaSeconds > 0 && (
            <span>{t("wizard.flash.eta", { eta: formatEta(etaSeconds, t) })}</span>
          )}
          <span>{Math.round(percent)}%</span>
        </span>
      </div>
      <Progress
        value={percent}
        indicatorClassName={done ? "bg-status-good" : undefined}
      />
      {log && log.length > 0 && <FlashLogPanel log={log} defaultOpen={false} />}
      {onCancel && cancellable && (
        <Button
          variant="outline"
          size="sm"
          className="self-end"
          data-testid="flash-cancel"
          onClick={onCancel}
        >
          <XCircle />
          {t("wizard.flash.cancel")}
        </Button>
      )}
      {onCancel && writing && (
        <p
          // Announced when it replaces the cancel button, so a screen-reader
          // user learns the flash can no longer be stopped.
          role="status"
          data-testid="flash-cancel-unavailable"
          className="flex items-start gap-2 self-end text-right text-xs text-status-warning"
        >
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("wizard.flash.cancelUnavailable")}
        </p>
      )}
    </div>
  );
}
