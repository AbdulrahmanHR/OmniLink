import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Plug,
  Loader2,
  Wifi,
  WifiOff,
  Cpu,
  RefreshCw,
  AlertTriangle,
  Copy,
  X,
  Backpack as BackpackIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDevice, useSerialPortBusyReasonKey } from "@/hooks";
import { canClaimPort, type ConnectionStatus } from "@/stores/device";
import { useWifiStore } from "@/stores";
import { wifiSourceLabelKey } from "@/lib/wifiDiscovery";
import { backpackKindLabelKey } from "@/lib/backpack";
import { BackpackConfigForm } from "@/components/config/BackpackConfigForm";
import { BridgeProbeControl } from "@/components/bridge/BridgeProbeControl";
import { NotificationBell } from "@/components/notifications";
import {
  DEFAULT_BACKPACK_SETTINGS,
  type BackpackSettings,
} from "@/lib/backpackConfig";

const statusConfig: Record<
  ConnectionStatus,
  { dot: string; glow: string; pulse: boolean }
> = {
  disconnected: { dot: "bg-muted-foreground", glow: "", pulse: false },
  connecting: {
    dot: "bg-status-warning",
    glow: "shadow-[0_0_8px_2px] shadow-status-warning/50",
    pulse: true,
  },
  connected: {
    dot: "bg-status-good",
    glow: "shadow-[0_0_8px_2px] shadow-status-good/60",
    pulse: false,
  },
  bootloader: { dot: "bg-status-warning", glow: "", pulse: false },
  flashing: { dot: "bg-status-warning", glow: "", pulse: true },
  error: {
    dot: "bg-status-critical",
    glow: "shadow-[0_0_8px_2px] shadow-status-critical/50",
    pulse: false,
  },
};

export function DeviceBar() {
  const { t } = useTranslation();
  const {
    status,
    device,
    error,
    ports,
    selectedPort,
    portPinned,
    isConnected,
    isConnecting,
    setSelectedPort,
    refreshPorts,
    connect,
    disconnect,
  } = useDevice();
  const config = statusConfig[status];
  const hasPorts = ports.length > 0;
  // CONN-10: a pinned selection SURVIVES its path disappearing (a just-flashed
  // board re-enumerates for a second or two) instead of being silently
  // re-pointed at another device, so the picker has to be able to render a path
  // that is not in the enumeration — and Connect has to stay inert until it
  // comes back.
  const selectedPresent = ports.some((p) => p.path === selectedPort);
  // CONN-2: may this bar touch the serial port at all? `!isConnected` is NOT the
  // question — it is TRUE while a flash is running, which would leave the port
  // picker, the Connect button and the MSP bridge probe live during a firmware
  // write. Only "disconnected"/"error" leave the port free.
  const canAct = canClaimPort(status);
  const [showError, setShowError] = useState(false);

  // M19: the Backpack config form (FR-FLASH-11c) is mounted under a discovered
  // Backpack device — click its badge to expand the data-driven settings form.
  // Settings are kept locally (controlled read+write); real device sync is HW-
  // pending. One open device at a time, keyed by the discovered device id.
  const [openBackpackId, setOpenBackpackId] = useState<string | null>(null);
  const [backpackSettings, setBackpackSettings] = useState<BackpackSettings>(
    DEFAULT_BACKPACK_SETTINGS
  );

  // M18: WiFi-discovered devices (mDNS / self-AP), shown alongside serial.
  const discoveredWifi = useWifiStore((s) => s.discovered);

  // The controller-bridge commands hold the serial port for as long as they run
  // (up to ~14s for a passthrough check) and the backend now refuses a second
  // claimer outright. Surfacing that here is what keeps the user from clicking
  // Connect into a refusal: `canClaimPort` cannot see these operations — they
  // live in their own stores and never touch the device status.
  const portBusyKey = useSerialPortBusyReasonKey();
  const portBusy = portBusyKey !== null;

  // Why Connect is inert, as a tooltip. `!selectedPresent` had none at all: the
  // only cue that a pinned path is gone was the "(not connected)" suffix inside
  // the closed picker, and "nothing selected" had no cue whatsoever.
  const connectBlockedTitle = portBusyKey
    ? t(portBusyKey)
    : selectedPresent
      ? undefined
      : selectedPort
        ? t("device.connectPortAbsent", { port: selectedPort })
        : t("device.connectNoPort");

  const hasError = status === "error" && !!error;
  // First line of the (possibly multi-line) backend message — shown inline as a
  // concise summary; the full text lives in the expandable panel + tooltip.
  const errorSummary = error?.split("\n")[0] ?? "";

  const portLabel = (path: string, productName?: string | null) =>
    productName ? `${productName} (${path})` : path;

  return (
    <header className="relative flex h-14 items-center justify-between border-b border-border bg-card px-4">
      {/* Connection status */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          {/* Indicator dot with optional ping ring while connecting */}
          <span className="relative flex h-2.5 w-2.5 items-center justify-center">
            {config.pulse && (
              <span
                className={cn(
                  "absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping",
                  config.dot
                )}
              />
            )}
            <span
              className={cn(
                "relative inline-flex h-2.5 w-2.5 rounded-full transition-colors duration-500",
                config.dot,
                config.glow,
                // Connected: a slow signal-glow breath, so a live link reads as
                // live at a glance. `config.pulse` still drives the ping ring
                // for the transient connecting state.
                status === "connected" && "motion-safe:animate-signal-glow-pulse"
              )}
            />
          </span>
          <span
            className={cn(
              "text-xs font-medium transition-colors duration-300",
              hasError ? "text-status-critical" : "text-muted-foreground"
            )}
          >
            {t(`device.status.${status}`)}
          </span>
        </div>

        {/* Error detail — the actual backend failure reason. Without this the
            user only sees the word "Error" with no cause. Click to expand the
            full message (permission hints, busy-port guidance, etc.). */}
        {hasError && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowError((v) => !v)}
              title={error ?? undefined}
              aria-expanded={showError}
              aria-label={t("device.error.show")}
              className="flex max-w-[22rem] items-center gap-1.5 rounded-md border border-status-critical/40 bg-status-critical/10 px-2 py-1 text-xs text-status-critical transition-colors hover:bg-status-critical/20"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{errorSummary}</span>
            </button>

            {showError && (
              <div className="absolute left-0 top-full z-50 mt-2 w-[28rem] max-w-[90vw] rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-status-critical">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {t("device.error.title")}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        void navigator.clipboard?.writeText(error ?? "")
                      }
                      title={t("device.error.copy")}
                      aria-label={t("device.error.copy")}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowError(false)}
                      aria-label={t("common.close")}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <p className="whitespace-pre-line break-words text-xs leading-relaxed text-foreground">
                  {error}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Device info — fades/slides in on connect */}
        <div
          className={cn(
            "flex items-center gap-2 overflow-hidden text-xs text-foreground transition-all duration-500 ease-out",
            isConnected && device
              ? "max-w-xs translate-x-0 opacity-100"
              : "max-w-0 -translate-x-1 opacity-0"
          )}
        >
          <Cpu className="h-3.5 w-3.5 shrink-0 text-status-good" />
          <span className="whitespace-nowrap font-medium">
            {device?.targetName}
          </span>
          {/*
            Display only, same discipline as `deviceType` below: a device that
            reported no firmware word at all (a Betaflight FC answering our ping
            on the shared CRSF UART sends an all-zero triple) arrives as `null`,
            and is LABELLED unknown here rather than being defaulted to a
            concrete-looking "v0.0.0" the user would read as fact.
          */}
          <span className="whitespace-nowrap text-muted-foreground">
            {device?.firmwareVersion
              ? `v${device.firmwareVersion}`
              : t("device.firmwareUnknown")}
          </span>
          {/*
            Display only. A device whose CRSF origin the backend could not
            classify reports `deviceType: null` (CONN-5); we label that "unknown"
            HERE rather than defaulting it in the store — the flash guard needs
            the honest `null` to abstain, and a cosmetic default would follow the
            value into the flash request.
          */}
          <span className="whitespace-nowrap rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
            {device?.deviceType ?? t("device.typeUnknown")}
          </span>
          {device?.baud ? (
            <span
              className="whitespace-nowrap text-muted-foreground"
              title={t("device.baudTitle", { baud: device.baud })}
            >
              @{(device.baud / 1000).toFixed(0)}k
            </span>
          ) : null}
        </div>

        {!isConnected && !isConnecting && (
          <WifiOff
            className="h-3.5 w-3.5 text-muted-foreground"
            aria-hidden="true"
          />
        )}

        {/* M18: WiFi-discovered devices (mDNS / self-AP). Shown alongside the
            serial connection — never replacing it. Each badge carries an
            UNMISTAKABLE AP-mode vs on-network (mDNS) label so the user always
            knows which discovery channel found the device. */}
        {discoveredWifi.length > 0 && (
          <div className="flex items-center gap-1.5 motion-safe:transition-all motion-safe:duration-500">
            <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
              {t("wifi.discoveredTitle")}
            </span>
            <div
              data-testid="wifi-discovered-list"
              className="flex items-center gap-1"
            >
              {discoveredWifi.map((d) => {
                // Plain ELRS TX/RX rows keep their existing M18 rendering. The
                // direct check on d.kind narrows it to a BackpackKind below.
                if (d.kind !== "tx-backpack" && d.kind !== "vrx-backpack") {
                  return (
                    <span
                      key={d.id}
                      data-testid="wifi-device-item"
                      title={t("wifi.deviceTitle", {
                        name: d.name,
                        address: d.address,
                      })}
                      className="flex items-center gap-1 whitespace-nowrap rounded border border-border bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground"
                    >
                      <span className="font-medium text-foreground">
                        {d.name}
                      </span>
                      <span
                        data-testid="wifi-device-source"
                        className={cn(
                          "rounded border px-1 py-0 text-[9px] font-semibold uppercase tracking-wide text-foreground",
                          d.source === "ap"
                            ? "border-status-warning/50 bg-status-warning/20"
                            : "border-status-good/50 bg-status-good/20"
                        )}
                      >
                        {t(wifiSourceLabelKey(d.source))}
                      </span>
                    </span>
                  );
                }

                // M19: a Backpack device is rendered UNMISTAKABLY as a Backpack
                // (distinct icon + primary-tinted badge), never as plain TX/RX.
                // Clicking toggles the data-driven settings form below.
                const open = openBackpackId === d.id;
                return (
                  <div key={d.id} className="relative">
                    <button
                      type="button"
                      data-testid="wifi-device-item"
                      onClick={() =>
                        setOpenBackpackId((cur) => (cur === d.id ? null : d.id))
                      }
                      title={t("wifi.deviceTitle", {
                        name: d.name,
                        address: d.address,
                      })}
                      aria-expanded={open}
                      className={cn(
                        "flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] transition-colors",
                        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        open
                          ? "border-primary bg-primary/15"
                          : "border-primary/40 bg-primary/10 hover:bg-primary/20"
                      )}
                    >
                      <BackpackIcon
                        className="h-3 w-3 shrink-0 text-primary"
                        aria-hidden="true"
                      />
                      <span className="font-medium text-foreground">
                        {d.name}
                      </span>
                      <span
                        data-testid="backpack-device-label"
                        className="rounded border border-primary/50 bg-primary/20 px-1 py-0 text-[9px] font-semibold uppercase tracking-wide text-foreground"
                      >
                        {t(backpackKindLabelKey(d.kind))}
                      </span>
                    </button>

                    {open && (
                      <div className="absolute left-0 top-full z-50 mt-2 w-[22rem] max-w-[90vw]">
                        <BackpackConfigForm
                          value={backpackSettings}
                          onChange={setBackpackSettings}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* M63: Controller Bridge probe — a Betaflight/iNav FC used as the path
            to an ELRS RX. The probe WRITES MSP frames to the selected port, so
            it is mounted only while that port is free: never while we hold it as
            an ELRS device, and never while a flash owns it (CONN-2). Kept
            CLEARLY SEPARATE from the ELRS / WiFi / Backpack chips: a distinct
            CircuitBoard affordance whose popover gates the probe behind the
            hardware-safety warning. The FC is a bridge endpoint, never managed.

            `|| portBusy` keeps it mounted through its OWN operation: a status
            flip to "connecting" used to unmount it mid-probe, silently
            discarding the in-flight result while the backend kept the port. */}
        {(canAct || portBusy) && selectedPort && (
          <BridgeProbeControl port={selectedPort} />
        )}

        {/* Why the connection controls are inert right now. Without it the
            Connect button just looks broken: nothing in the device status
            explains that a bridge operation is holding the port. */}
        {portBusy && (
          <span
            data-testid="device-port-busy"
            className="whitespace-nowrap text-[10px] text-muted-foreground"
          >
            {t(portBusyKey)}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {isConnected ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void disconnect()}
            aria-label={t("device.disconnect")}
          >
            <Wifi className="text-status-good" />
            {t("device.disconnect")}
          </Button>
        ) : (
          // Not connected — but that does NOT mean the port is ours to take:
          // every control below is gated on `canAct`, so while a flash owns the
          // port the cluster stays visible but completely inert (CONN-2).
          <>
            {/* Port picker — enumerated from the Rust backend */}
            <div className="flex items-center gap-1">
              <select
                className="h-8 max-w-[12rem] rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                value={selectedPort ?? ""}
                onChange={(e) => setSelectedPort(e.target.value || null)}
                disabled={!canAct || !hasPorts}
                aria-label={t("device.port")}
              >
                {!hasPorts && !selectedPort ? (
                  <option value="">{t("device.noPorts")}</option>
                ) : (
                  <>
                    {!selectedPort && (
                      <option value="">{t("device.selectPort")}</option>
                    )}
                    {/* CONN-10: the way BACK to auto-follow. A pin is released
                        only by an explicit `null`, and the placeholder above is
                        the sole control that emitted one — while rendering only
                        when nothing is selected, i.e. never once something is.
                        The first pick (or the first Connect) therefore froze the
                        picker out of hotplug auto-follow for the whole session. */}
                    {portPinned && (
                      <option value="">{t("device.autoSelectPort")}</option>
                    )}
                    {/* The pinned selection while its path is gone — labelled as
                        absent rather than quietly swapped for another device. */}
                    {selectedPort && !selectedPresent && (
                      <option value={selectedPort}>
                        {t("device.portMissing", { port: selectedPort })}
                      </option>
                    )}
                    {ports.map((p) => (
                      <option key={p.path} value={p.path}>
                        {portLabel(p.path, p.product)}
                      </option>
                    ))}
                  </>
                )}
              </select>
              <button
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                onClick={() => void refreshPorts()}
                // Re-enumerating mid-flash can also move `selectedPort` off the
                // port being written (a rebooting device drops off the bus),
                // losing the pre-selection for the post-flash reconnect.
                disabled={!canAct}
                aria-label={t("device.refreshPorts")}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>

            <Button
              size="sm"
              onClick={() => void connect()}
              // `portBusy`: a controller-bridge operation is holding the port,
              // and the backend would refuse this connect anyway. The reason is
              // rendered next to the bridge chip (and repeated as the tooltip).
              // `!selectedPresent` covers "no ports", "nothing selected" and a
              // pinned path that is currently absent — there is nothing to open.
              disabled={!canAct || !selectedPresent || portBusy}
              title={connectBlockedTitle}
              aria-label={t("device.connect")}
            >
              {isConnecting ? (
                <>
                  <Loader2 className="animate-spin" />
                  {t("device.connecting")}
                </>
              ) : (
                <>
                  <Plug />
                  {t("device.connect")}
                </>
              )}
            </Button>

            {/* CONN-7: a full baud sweep is ~4.5s (5 candidate bauds × a 900ms
                probe window). Until now every control above was disabled for its
                duration and Disconnect renders only when `isConnected`, so a
                wrong-port attempt could only be waited out — even though the
                backend has always supported aborting it (the probe loop checks
                the stop flag, and the silent-stop path suppresses the resulting
                error event). This is that Disconnect, worded as a cancel. */}
            {isConnecting && (
              <Button
                variant="outline"
                size="sm"
                data-testid="device-cancel-connect"
                onClick={() => void disconnect()}
                aria-label={t("device.cancelConnect")}
              >
                <X />
                {t("common.cancel")}
              </Button>
            )}
          </>
        )}

        <NotificationBell />
      </div>
    </header>
  );
}
