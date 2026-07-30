import { useTranslation } from "react-i18next";
import { CheckCircle2, RotateCcw, TriangleAlert, Zap } from "lucide-react";
import {
  FLASH_METHOD_BY_ID,
  REGULATORY_DOMAIN_BY_ID,
  domainToElrsIndex,
  findBrand,
  findModel,
  resolveConnectedTarget,
} from "@/lib/elrsTargets";
import { wifiDeviceBackpackKind } from "@/lib/backpack";
import type { FlashRequestPayload } from "@/lib/tauri";
import { useDeviceStore, useWifiStore, useWizardStore } from "@/stores";
import { useDerivedUid, useSerialPortBusyReasonKey } from "@/hooks";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { FlashProgress } from "./FlashProgress";
import { FlashError } from "./FlashError";

function SummaryRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={
          mono
            ? "truncate font-mono text-sm font-medium text-foreground"
            : "truncate text-sm font-medium text-foreground"
        }
      >
        {value}
      </span>
    </div>
  );
}

/** Copy shown when a device-identity guard has already refused this flash. */
const IDENTITY_BLOCKED = "wizard.review.identityBlocked";

/** Step 5 — configuration summary, fake flash run, and success state. */
export function StepReview() {
  const { t } = useTranslation();

  const brandId = useWizardStore((s) => s.brandId);
  const modelId = useWizardStore((s) => s.modelId);
  const domain = useWizardStore((s) => s.domain);
  const firmwareVersion = useWizardStore((s) => s.firmwareVersion);
  const localFirmwarePath = useWizardStore((s) => s.localFirmwarePath);
  const localFirmwareName = useWizardStore((s) => s.localFirmwareName);
  const flashMethod = useWizardStore((s) => s.flashMethod);
  const useTraditional = useWizardStore((s) => s.useTraditionalBinding);
  const bindingPhrase = useWizardStore((s) => s.bindingPhrase);
  const deviceIp = useWizardStore((s) => s.deviceIp);
  const flash = useWizardStore((s) => s.flash);
  const startFlash = useWizardStore((s) => s.startFlash);
  const cancelFlash = useWizardStore((s) => s.cancelFlash);
  const resetFlash = useWizardStore((s) => s.resetFlash);
  const reset = useWizardStore((s) => s.reset);
  const identityRefusal = useWizardStore((s) => s.identityRefusal);
  const connectedDevice = useDeviceStore((s) => s.device);
  // The last device that handshook, kept per port after the link drops — the
  // flash guards' evidence once a serial flash has disconnected the device it is
  // about to write to (see `lastIdentity` in `stores/device.ts`).
  const lastIdentity = useDeviceStore((s) => s.lastIdentity);
  // The port the flash writes to. NOT taken from the connected device alone: the
  // wizard releases the CRSF connection before a serial flash (CONN-1), and a
  // device sitting in the bootloader never handshakes in the first place — the
  // picker's selection is what survives both.
  const selectedPort = useDeviceStore((s) => s.selectedPort);
  // M18/M19: the WiFi-OTA destination the user picked in StepFrequency. Its
  // Backpack role has to travel with the request — a Backpack is a different
  // firmware family, and over WiFi nothing handshakes, so the TX/RX guard
  // abstains and this is the only signal the backend's cross-family guard has.
  const wifiDevices = useWifiStore((s) => s.discovered);
  const wifiSelectedId = useWifiStore((s) => s.selectedId);

  // Real ELRS UID (MD5 of the phrase) for the summary — matches what is flashed.
  const uid = useDerivedUid(bindingPhrase, !useTraditional);

  // A controller-bridge probe / context fetch / passthrough check holds the
  // serial port while it runs, and this step had NO port-ownership gate at all:
  // a UART flash started mid-check took its point of no return before esptool
  // ever tried the port, then reported the busy port as a WIRING fault — telling
  // the user to re-cable and bootloader a device nothing had touched.
  const bridgeBusyKey = useSerialPortBusyReasonKey();
  // CONN-11: a CRSF handshake in flight is the other way the port is taken —
  // and the one the store now refuses outright, because a flash started on top
  // of it left the device bar spinning on "connecting" forever afterwards.
  const deviceStatus = useDeviceStore((s) => s.status);
  const portBusyKey =
    bridgeBusyKey ??
    (deviceStatus === "connecting" ? "device.portBusy.connecting" : null);
  const portBusy = portBusyKey !== null;

  const brand = findBrand(brandId);
  const model = findModel(brandId, modelId);
  // M25: the firmware source is either a GitHub release version or a local file.
  if (
    !brand ||
    !model ||
    !domain ||
    !flashMethod ||
    (!firmwareVersion && !localFirmwarePath)
  ) {
    return null;
  }

  const domainMeta = REGULATORY_DOMAIN_BY_ID[domain];
  const methodMeta = FLASH_METHOD_BY_ID[flashMethod];
  // Human label for the chosen firmware: release tag, or the local file name.
  // The guard above guarantees one of them is set, so this is never empty.
  const firmwareLabel = firmwareVersion ?? localFirmwareName ?? "";
  const isDone = flash.status === "done";
  const isRunning = flash.status === "running";
  const isError = flash.status === "error";

  // The serial port this flash writes to; a WiFi OTA addresses an IP instead and
  // has none.
  const flashPort =
    flashMethod === "wifi"
      ? null
      : (connectedDevice?.port ?? selectedPort ?? null);
  // The device identity the FR-FLASH-10 guards compare the selection against.
  //
  // A serial flash hands the port over BEFORE the engine evaluates those guards
  // (CONN-1), so by the time a refusal is on screen `connectedDevice` is already
  // null — and the retry the refusal invites used to carry no identity at all,
  // abstaining both guards and writing the very image the first click refused.
  // The store retains the last handshake per port for exactly this, and it still
  // describes the destination as long as the flash is aimed at that same port.
  //
  // A WiFi OTA writes to a device on the NETWORK, so only a LIVE serial link is
  // evidence about anything: a retained identity would false-block an OTA to a
  // completely different device.
  const guardIdentity =
    connectedDevice ??
    (flashPort !== null && lastIdentity?.port === flashPort
      ? lastIdentity
      : null);
  // FR-FLASH-10: an identity refusal is sticky for the pair that earned it, so
  // the second click is answered here instead of becoming another flash. Lifted
  // by a live handshake (better evidence than a remembered refusal — including
  // when the user really did swap the hardware) or by aiming somewhere else.
  const identityBlocked =
    connectedDevice === null &&
    identityRefusal !== null &&
    identityRefusal.target === model.target &&
    identityRefusal.port === flashPort;
  const startBlockedKey =
    portBusyKey ?? (identityBlocked ? IDENTITY_BLOCKED : null);

  // Translate the wizard selections into the Rust flash request (FR-FLASH-03).
  const handleStartFlash = () => {
    // The button is disabled for both, but a refusal must never depend on a
    // control's disabled attribute.
    if (portBusy || identityBlocked) return;
    // Only a WiFi flash actually writes to the picked discovery row; on serial
    // the selection is stale context, so it must not describe the destination.
    const wifiDestination =
      flashMethod === "wifi"
        ? (wifiDevices.find((d) => d.id === wifiSelectedId) ?? null)
        : null;
    const request: FlashRequestPayload = {
      target: model.target,
      deviceType: model.deviceType,
      // The MCU family decides esptool's `--chip` and the write offset in the
      // Rust engine (ESP32 app images go at 0x10000, ESP8285 at 0x0), so the
      // catalogue value has to travel with the request.
      mcu: model.mcu,
      // For a local file the version is informational only (the engine flashes
      // the file verbatim and never downloads), so fall back to its name.
      version: firmwareLabel,
      method: flashMethod,
      // M25: when set, the Rust engine reads + safety-validates this local `.bin`
      // before any erase/write, instead of downloading a release.
      localFilePath: localFirmwarePath,
      // Serial transports flash over the connected device's port, falling back
      // to the picker selection when nothing is connected.
      port: flashPort,
      // WiFi OTA needs the device's IP/host; ignored by the serial transports.
      deviceIp: flashMethod === "wifi" ? deviceIp.trim() : null,
      // The TX/RX guard compares against the device on the destination port —
      // live, or the identity retained across the disconnect the flash itself
      // performs (`guardIdentity`). `null` here means "no device, or a device
      // whose class the handshake could not resolve" (CONN-5) — the guard
      // abstains on it, so it must never be replaced with a guessed "TX"/"RX".
      connectedDeviceType: guardIdentity?.deviceType ?? null,
      // The device's OWN identity, RESOLVED to a catalogue build target first:
      // TX-vs-RX can't tell a Ranger from a BetaFPV Nano TX, but the raw CRSF
      // string is a display name, so sending it unresolved would false-block
      // correct flashes. `null` (no device, no name, or a name the catalogue
      // can't map) is "no evidence" and the Rust guard abstains on it.
      connectedTargetName: resolveConnectedTarget(guardIdentity?.targetName),
      // The OTA destination's Backpack role, when the picked WiFi device is a
      // Backpack. The wizard catalogue has no Backpack targets, so `backpackKind`
      // stays absent and the backend blocks the cross-FAMILY combination.
      connectedBackpackKind: wifiDestination
        ? wifiDeviceBackpackKind(wifiDestination.kind)
        : null,
      options: {
        useTraditionalBinding: useTraditional,
        bindingPhrase: useTraditional ? undefined : bindingPhrase.trim(),
        domain: domainToElrsIndex(domain),
      },
      // Snapshot the current device config before flashing (FR-FLASH-05).
      backupTarget: connectedDevice
        ? {
            targetName: connectedDevice.targetName,
            // Both of these are `null` when the handshake could not establish
            // them, and both travel as `null` on purpose: the snapshot records
            // what was actually read from the device, so a defaulted "0.0.0" /
            // "TX" here would write a fabricated identity into a recovery file
            // the user is meant to trust.
            firmwareVersion: connectedDevice.firmwareVersion,
            deviceType: connectedDevice.deviceType,
            // Part of the identity the snapshot records, so a user looking at
            // `<app_data_dir>/backups` can tell which device it came from.
            port: connectedDevice.port,
          }
        : null,
    };
    // M25: for a local-file flash, name the best-effort recovery backup here
    // (localized) so the store/seam stay string-free.
    const recoveryProfileName =
      localFirmwarePath && connectedDevice
        ? t("wizard.localFile.backupName", {
            target: connectedDevice.targetName,
          })
        : undefined;
    void startFlash(request, recoveryProfileName);
  };

  // Success screen.
  if (isDone) {
    return (
      <div className="flex flex-col items-center gap-5 py-8 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-status-good/15 text-status-good shadow-[0_0_30px_-6px_var(--color-signal-glow)]">
          <CheckCircle2 className="h-8 w-8" />
        </span>
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            {t("wizard.flash.success.title")}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("wizard.flash.success.description", {
              model: model.name,
              version: firmwareLabel,
            })}
          </p>
        </div>
        <Button variant="outline" onClick={reset}>
          <RotateCcw />
          {t("wizard.nav.flashAnother")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Summary */}
      <div className="rounded-lg border border-border bg-card/60 p-4">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("wizard.review.summaryTitle")}
        </h3>
        <div className="divide-y divide-border">
          <SummaryRow label={t("wizard.review.fields.brand")} value={brand.name} />
          <SummaryRow label={t("wizard.review.fields.model")} value={model.name} />
          <SummaryRow
            label={t("wizard.review.fields.deviceType")}
            value={t(`wizard.deviceType.${model.deviceType}`)}
          />
          <SummaryRow
            label={t("wizard.review.fields.target")}
            value={model.target}
            mono
          />
          <SummaryRow
            label={t("wizard.review.fields.band")}
            value={`${t(domainMeta.labelKey)} (${domainMeta.frequency})`}
          />
          <SummaryRow
            label={t("wizard.review.fields.firmware")}
            value={firmwareLabel}
            mono
          />
          {localFirmwarePath && (
            <div className="flex items-center justify-between gap-3 py-1.5">
              <span className="text-xs text-muted-foreground">
                {t("wizard.review.fields.source")}
              </span>
              <span
                data-testid="review-local-file-badge"
                className="rounded border border-primary/50 bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground"
              >
                {t("wizard.localFile.badge")}
              </span>
            </div>
          )}
          <SummaryRow
            label={t("wizard.review.fields.method")}
            value={t(methodMeta.nameKey)}
          />
          <SummaryRow
            label={t("wizard.review.fields.binding")}
            value={
              useTraditional
                ? t("wizard.review.traditionalBinding")
                : bindingPhrase.trim()
            }
            mono={!useTraditional}
          />
          {!useTraditional && (
            <SummaryRow
              label={t("wizard.review.fields.uid")}
              value={uid ?? "—"}
              mono
            />
          )}
          {flashMethod === "wifi" && (
            <SummaryRow
              label={t("wizard.review.fields.deviceIp")}
              value={deviceIp.trim()}
              mono
            />
          )}
        </div>
      </div>

      {/* M25: best-effort pre-flash backup couldn't be taken — non-blocking. */}
      {flash.backupWarning && (
        <div
          role="alert"
          data-testid="local-file-backup-warning"
          className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-xs text-status-warning"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("wizard.localFile.backupWarning")}</span>
        </div>
      )}

      {/* Flash action / progress / error */}
      {isRunning ? (
        <FlashProgress
          status={flash.status}
          percent={flash.percent}
          stage={flash.stage}
          etaSeconds={flash.etaSeconds}
          log={flash.log}
          // FLASH-11: the only way out of a hung flash — the wizard locks
          // navigation while one runs. Gated by stage inside FlashProgress.
          onCancel={() => void cancelFlash()}
        />
      ) : isError && flash.error ? (
        <FlashError error={flash.error} log={flash.log} onRetry={resetFlash} />
      ) : (
        <>
          <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-xs text-status-warning">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t("wizard.review.warning")}</span>
          </div>
          {portBusy && (
            <div
              role="status"
              data-testid="review-port-busy"
              className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
            >
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t(portBusyKey)}</span>
            </div>
          )}
          {identityBlocked && (
            <div
              role="status"
              data-testid="review-identity-blocked"
              className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-xs text-status-warning"
            >
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t(IDENTITY_BLOCKED)}</span>
            </div>
          )}
          <Separator />
          <Button
            size="lg"
            className="self-end"
            onClick={handleStartFlash}
            disabled={portBusy || identityBlocked}
            title={startBlockedKey ? t(startBlockedKey) : undefined}
          >
            <Zap />
            {t("wizard.flash.start")}
          </Button>
        </>
      )}
    </div>
  );
}
