import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircuitBoard, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { isBridgeOperationInFlight, useBridgeStore } from "@/stores";
import {
  BRIDGE_RECOVERY_KEYS,
  isBridgeCandidate,
  isLabeledBridge,
  isStaleBridgeResult,
} from "@/lib/bridge";
import { BridgeContext } from "./BridgeContext";
import { BridgeLabel } from "./BridgeLabel";
import { BridgeSafetyWarning } from "./BridgeSafetyWarning";
import { PassthroughCheck } from "./PassthroughCheck";

/**
 * The controller-bridge probe affordance (M63), surfaced in the DeviceBar for
 * the selected serial port. Kept visually SEPARATE from the ELRS TX/RX, WiFi and
 * Backpack chips: a dedicated `CircuitBoard` toggle opens a popover that — before
 * any energizing probe — shows the hardware-safety warning, then a "Probe"
 * action, then the {@link BridgeLabel} for a recognized bridge or recovery
 * guidance for a non-controller / failure.
 *
 * READ-ONLY: the probe sends only MSP GET queries; the FC is a passthrough
 * bridge endpoint, never a managed device.
 */
export function BridgeProbeControl({ port }: { port: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const {
    status: probeStatus,
    classification: probeClassification,
    error: probeError,
    port: probedPort,
    probe,
    reset,
  } = useBridgeStore();

  // A classification belongs to the port it was taken on. This control is
  // re-rendered with a NEW `port` whenever the picker selection or the hotplug
  // watcher moves it, while the store still holds the PREVIOUS port's result —
  // so the popover would label the newly selected device with another device's
  // classification (and offer it a passthrough check). Drop the stale result:
  // for this render, and from the store, so nothing downstream reads it either.
  const stale = isStaleBridgeResult(probedPort, port);
  const status = stale ? "idle" : probeStatus;
  const classification = stale ? null : probeClassification;
  const error = stale ? null : probeError;
  // A probe still running on the OTHER port holds the serial seam (the backend
  // refuses a second claimer), so this port has nothing to offer yet either.
  const otherProbeRunning = stale && probeStatus === "probing";

  useEffect(() => {
    // Never clear an operation that is still in flight — see
    // `isBridgeOperationInFlight`.
    const s = useBridgeStore.getState();
    if (isBridgeOperationInFlight(s.status, s.contextStatus)) return;
    if (isStaleBridgeResult(s.port, port)) reset();
  }, [port, reset]);

  const isProbing = status === "probing";
  const isError = status === "error";
  const isNotController =
    status === "classified" && classification?.kind === "notAController";
  // Single source of truth for the bridge predicates (see `@/lib/bridge`).
  const isLabeled = status === "classified" && isLabeledBridge(classification);
  // Recovery guidance is relevant on a failed probe or a non-controller result.
  const showRecovery = isError || isNotController;

  const close = () => {
    setOpen(false);
    // The same in-flight guard the port-change effect takes, for the same
    // reason: dismissing the popover is not a cancel. Clearing here dropped
    // `status: "probing"` while the BACKEND still held the port — Connect and
    // Start Flash went live over it — and nulled `bridge.port`, so the probe's
    // result landed unattributed and was then rendered for whichever port the
    // picker moved to next. The result stays owned by the port it was taken on;
    // reopening on another port simply reads it as stale.
    const s = useBridgeStore.getState();
    if (isBridgeOperationInFlight(s.status, s.contextStatus)) return;
    reset();
  };

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="bridge-probe-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t("bridge.probeAction", { port })}
        className={cn(
          "flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          open
            ? "border-violet-500 bg-violet-500/15"
            : "border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/20"
        )}
      >
        <CircuitBoard
          className="h-3 w-3 shrink-0 text-violet-600 dark:text-violet-400"
          aria-hidden="true"
        />
        <span className="font-medium text-foreground">{t("bridge.label")}</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[24rem] max-w-[90vw] rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <CircuitBoard className="h-3.5 w-3.5" aria-hidden="true" />
              {t("bridge.title")}
            </span>
            <button
              type="button"
              onClick={close}
              aria-label={t("common.close")}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Hardware-safety warning — ALWAYS before the energizing probe action. */}
          <BridgeSafetyWarning className="mb-2" />

          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {port}
            </span>
            <Button
              size="sm"
              onClick={() => void probe(port)}
              disabled={isProbing || otherProbeRunning}
              aria-label={t("bridge.probeAction", { port })}
            >
              {isProbing ? (
                <>
                  <Loader2 className="animate-spin" />
                  {t("bridge.probing")}
                </>
              ) : (
                <>
                  <CircuitBoard />
                  {t("bridge.probe")}
                </>
              )}
            </Button>
          </div>

          {/* Result — a recognized/unsupported bridge gets the distinct label. */}
          {isLabeled && classification ? (
            <div className="mt-2" data-testid="bridge-result">
              <BridgeLabel classification={classification} />
            </div>
          ) : null}

          {/* M64: once a SUPPORTED bridge is identified, offer the guided
              passthrough check for this port (its own RX-energizing safety
              warning gates the run action). */}
          {isBridgeCandidate(classification) ? (
            <div className="mt-3 border-t border-border pt-3">
              <PassthroughCheck port={port} />
            </div>
          ) : null}

          {/* M65: read-only controller context for ELRS troubleshooting —
              display-only (no editing). Surfaced for a recognized bridge so the
              FC family/version + coarse serial ports help diagnose passthrough. */}
          {isBridgeCandidate(classification) ? (
            <div className="mt-3 border-t border-border pt-3">
              <BridgeContext port={port} />
            </div>
          ) : null}

          {/* Non-controller — the zero-false-positive outcome: no bridge label. */}
          {isNotController ? (
            <p
              data-testid="bridge-not-controller"
              className="mt-2 text-xs text-muted-foreground"
            >
              {t("bridge.notController")}
            </p>
          ) : null}

          {/* Failure detail. role="alert" so an open/invoke failure (busy/missing
              port, off-Tauri) is announced rather than leaving the probe silent. */}
          {isError && error ? (
            <p
              role="alert"
              className="mt-2 whitespace-pre-line break-words text-xs text-status-critical"
            >
              {error}
            </p>
          ) : null}

          {/* Recovery guidance: wrong port / busy port / wrong baud / no MSP. */}
          {showRecovery ? (
            <ul
              data-testid="bridge-recovery"
              className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground"
            >
              {BRIDGE_RECOVERY_KEYS.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
