import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Antenna,
  Backpack,
  Cable,
  Clock,
  CloudOff,
  FileUp,
  FlaskConical,
  GitBranch,
  History,
  Loader2,
  Package,
  RadioTower,
  Search,
  Square,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  FLASH_METHODS,
  REGULATORY_DOMAIN_BY_ID,
  findModel,
  type FlashMethod,
} from "@/lib/elrsTargets";
import { pickLocalFirmwareFile } from "@/lib/tauri";
import { liveReleaseList, releaseChoices } from "@/lib/firmwareReleases";
import {
  isValidDeviceIp,
  useFirmwareReleasesStore,
  useWifiStore,
  useWizardStore,
} from "@/stores";
import { wifiSourceLabelKey } from "@/lib/wifiDiscovery";
import { backpackKindLabelKey, wifiDeviceBackpackKind } from "@/lib/backpack";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectableTile } from "./SelectableTile";

const METHOD_ICONS: Record<FlashMethod, LucideIcon> = {
  wifi: Wifi,
  uart: Cable,
  betaflight: Zap,
};

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

/** Step 3 — RF band + firmware version + flash method (+ WiFi device IP). */
export function StepFrequency() {
  const { t, i18n } = useTranslation();
  const deviceIpId = useId();
  const brandId = useWizardStore((s) => s.brandId);
  const modelId = useWizardStore((s) => s.modelId);
  const domain = useWizardStore((s) => s.domain);
  const firmwareVersion = useWizardStore((s) => s.firmwareVersion);
  const flashMethod = useWizardStore((s) => s.flashMethod);
  const deviceIp = useWizardStore((s) => s.deviceIp);
  const localFirmwarePath = useWizardStore((s) => s.localFirmwarePath);
  const localFirmwareName = useWizardStore((s) => s.localFirmwareName);
  const selectDomain = useWizardStore((s) => s.selectDomain);
  const selectFirmware = useWizardStore((s) => s.selectFirmware);
  const selectLocalFirmware = useWizardStore((s) => s.selectLocalFirmware);
  const selectFlashMethod = useWizardStore((s) => s.selectFlashMethod);
  const setDeviceIp = useWizardStore((s) => s.setDeviceIp);

  // M25: a local-file pick can fail outside the native runtime (no dialog
  // plugin) or if the user's OS dialog errors; surfaced as a small inline notice.
  const [localPickError, setLocalPickError] = useState(false);

  const handlePickLocalFile = async () => {
    setLocalPickError(false);
    try {
      const path = await pickLocalFirmwareFile({
        title: t("wizard.localFile.dialogTitle"),
        filterName: t("wizard.localFile.filterName"),
      });
      if (path) selectLocalFirmware(path);
    } catch {
      setLocalPickError(true);
    }
  };

  // M18: pick a WiFi-discovered device instead of typing its IP. The serial
  // seam is untouched — picking just populates the wizard's `deviceIp`, so the
  // existing WiFi-OTA path runs USB-free. Manual entry stays as a fallback.
  const wifiDevices = useWifiStore((s) => s.discovered);
  const wifiScanning = useWifiStore((s) => s.scanning);
  const wifiSelectedId = useWifiStore((s) => s.selectedId);
  const startWifiScan = useWifiStore((s) => s.startScan);
  const stopWifiScan = useWifiStore((s) => s.stopScan);
  const selectWifiDevice = useWifiStore((s) => s.select);
  // M20: a genuine discovery failure (e.g. mDNS init) surfaces as a localized,
  // categorized line. Graceful no-adapter/no-device paths leave this null.
  const wifiError = useWifiStore((s) => s.error);

  // FR-FLASH-01 / FWCHK-2: the live ExpressLRS release list and the pre-release
  // opt-in both live in the store, NOT here. The version chosen here flows into
  // the flash request, and the reconcile that keeps the stored tag inside the
  // rendered list has to survive this step unmounting — see
  // `stores/firmwareReleases.ts`. The bundled catalogue is the offline fallback.
  const releaseState = useFirmwareReleasesStore((s) => s.state);
  const showPrereleases = useFirmwareReleasesStore((s) => s.showPrereleases);
  const setShowPrereleases = useFirmwareReleasesStore(
    (s) => s.setShowPrereleases
  );
  const loadReleases = useFirmwareReleasesStore((s) => s.load);

  useEffect(() => {
    // Idempotent in the store: a list that already landed is not re-fetched.
    void loadReleases();
  }, [loadReleases]);

  const model = findModel(brandId, modelId);

  // Prefer the live release list; fall back to the bundled catalogue offline.
  const liveList = liveReleaseList(releaseState);
  const liveReleases = liveList?.releases ?? null;
  const usingFallback = releaseState.kind !== "loading" && !liveList;
  // GitHub's unauthenticated quota is 60 requests/hour/IP; the bundled list is
  // the same fallback either way, but the chip must name the real cause.
  const rateLimited =
    releaseState.kind === "error" && releaseState.reason === "rateLimited";

  // What the grid shows and which single tag wears "Latest" (FWCHK-2) — the
  // rules live in `releaseChoices` so they are unit-tested, not re-derived here.
  // Plain render-time derivation: the manual memo existed only to give the
  // reconcile effect a stable dependency, and that reconcile now lives in the
  // store (which re-derives the same choices from the same pure helper).
  const { versions, latest: latestVersion, hasPrereleases } = releaseChoices(
    liveReleases,
    model?.firmwareVersions ?? [],
    showPrereleases
  );

  const selectedRelease = liveReleases?.find((r) => r.tag === firmwareVersion);

  // FWCHK-7: a list served out of the cache after GitHub was unreachable must
  // say so — the old UI badged it "Live from ExpressLRS GitHub" regardless.
  const cachedAtText =
    liveList?.stale && liveList.fetchedAt
      ? new Intl.DateTimeFormat(i18n.language, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(liveList.fetchedAt))
      : null;

  if (!model) return null;

  const methods = FLASH_METHODS.filter((m) =>
    model.flashMethods.includes(m.id)
  );
  const ipValid = isValidDeviceIp(deviceIp);

  return (
    <div className="flex flex-col gap-6">
      {/* Frequency band */}
      <section>
        <SectionHeading>{t("wizard.frequency.bandTitle")}</SectionHeading>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {model.domains.map((id) => {
            const meta = REGULATORY_DOMAIN_BY_ID[id];
            return (
              <SelectableTile
                key={id}
                icon={Antenna}
                title={t(meta.labelKey)}
                description={meta.frequency}
                selected={domain === id}
                onSelect={() => selectDomain(id)}
              />
            );
          })}
        </div>
      </section>

      {/* Firmware version */}
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <SectionHeading>{t("wizard.frequency.firmwareTitle")}</SectionHeading>
          {releaseState.kind === "loading" && (
            <span
              data-testid="firmware-source"
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <Loader2
                className="h-3 w-3 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {t("wizard.frequency.releasesLoading")}
            </span>
          )}
          {liveList && !liveList.stale && (
            <span
              data-testid="firmware-source"
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <GitBranch className="h-3 w-3" aria-hidden="true" />
              {t("wizard.frequency.releasesLive")}
            </span>
          )}
          {liveList && liveList.stale && (
            <span
              data-testid="firmware-source"
              className="flex items-center gap-1.5 text-[11px] text-status-warning"
            >
              <History className="h-3 w-3" aria-hidden="true" />
              {cachedAtText
                ? t("wizard.frequency.releasesCached", { updated: cachedAtText })
                : t("wizard.frequency.releasesCachedUnknown")}
            </span>
          )}
          {usingFallback && (
            <span
              data-testid="firmware-source"
              className="flex items-center gap-1.5 text-[11px] text-status-warning"
            >
              {rateLimited ? (
                <Clock className="h-3 w-3" aria-hidden="true" />
              ) : (
                <CloudOff className="h-3 w-3" aria-hidden="true" />
              )}
              {rateLimited
                ? t("wizard.frequency.releasesRateLimited")
                : t("wizard.frequency.releasesOffline")}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {versions.map(({ tag, prerelease }) => {
            const selected = firmwareVersion === tag;
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={selected}
                onClick={() => selectFirmware(tag)}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-md border p-3 outline-none transition-all duration-200 motion-reduce:transition-none",
                  "hover:border-primary/50 hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring",
                  selected
                    ? "border-primary bg-primary/5 shadow-[0_0_0_1px_var(--color-primary),0_0_18px_-6px_var(--color-signal-glow)]"
                    : "border-border"
                )}
              >
                <span className="flex items-center gap-1.5 font-mono text-sm font-semibold text-foreground">
                  <Package className="h-3.5 w-3.5 text-muted-foreground" />
                  {tag}
                </span>
                {/* A pre-release is marked UNMISTAKABLY and can never also be
                    "Latest" — the two badges are mutually exclusive by
                    construction (`latestVersion` is the top stable tag). */}
                {prerelease ? (
                  <span
                    data-testid="firmware-prerelease-badge"
                    className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-status-warning"
                  >
                    <FlaskConical className="h-3 w-3" aria-hidden="true" />
                    {t("wizard.frequency.prerelease")}
                  </span>
                ) : (
                  tag === latestVersion && (
                    <span className="text-[10px] font-medium uppercase tracking-wide text-status-good">
                      {t("wizard.frequency.latest")}
                    </span>
                  )
                )}
              </button>
            );
          })}
        </div>

        {/* FWCHK-2: opt-in to beta/RC builds. Only offered when the live list
            actually contains some, so the stable-only case stays uncluttered. */}
        {hasPrereleases && (
          <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              data-testid="show-prereleases-toggle"
              checked={showPrereleases}
              onChange={(e) => setShowPrereleases(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--color-primary)]"
            />
            {t("wizard.frequency.showPrereleases")}
          </label>
        )}

        {/* M25: flash a local firmware .bin instead of a release. A safety
            validation in the Rust engine blocks a mismatched/corrupt file. */}
        <div className="mt-3 flex flex-col gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t("wizard.localFile.sectionLabel")}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              data-testid="local-firmware-button"
              variant="outline"
              size="sm"
              onClick={() => void handlePickLocalFile()}
            >
              <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
              {t("wizard.localFile.select")}
            </Button>
            {localFirmwarePath && (
              <span
                data-testid="local-firmware-badge"
                className="rounded border border-primary/50 bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground"
              >
                {t("wizard.localFile.badge")}
              </span>
            )}
          </div>

          {localFirmwarePath ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 p-2.5">
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {localFirmwareName}
                </span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {localFirmwarePath}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => selectLocalFirmware(null)}
                aria-label={t("wizard.localFile.clear")}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                {t("wizard.localFile.clear")}
              </Button>
            </div>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {t("wizard.localFile.hint")}
            </span>
          )}

          {localPickError && (
            <p
              data-testid="local-firmware-error"
              role="alert"
              className="flex items-start gap-1.5 rounded-md border border-status-critical/40 bg-status-critical/10 px-2 py-1 text-[11px] text-status-critical"
            >
              <AlertTriangle
                className="mt-0.5 h-3 w-3 shrink-0"
                aria-hidden="true"
              />
              <span>{t("wizard.localFile.pickFailed")}</span>
            </p>
          )}
        </div>

        {/* Changelog for the selected live release (FR-FLASH-01). */}
        {selectedRelease && selectedRelease.changelog && (
          <div className="mt-3 rounded-md border border-border bg-card/60 p-3">
            <span className="text-xs font-medium text-muted-foreground">
              {t("wizard.frequency.changelogTitle", {
                version: selectedRelease.name,
              })}
            </span>
            <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
              {selectedRelease.changelog}
            </p>
          </div>
        )}
      </section>

      {/* Flash method */}
      <section>
        <SectionHeading>{t("wizard.frequency.methodTitle")}</SectionHeading>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {methods.map((m) => (
            <SelectableTile
              key={m.id}
              icon={METHOD_ICONS[m.id]}
              title={t(m.nameKey)}
              description={t(m.descriptionKey)}
              selected={flashMethod === m.id}
              onSelect={() => selectFlashMethod(m.id)}
            />
          ))}
        </div>

        {/* WiFi OTA device address (FR-FLASH-09) — only relevant for WiFi. */}
        {flashMethod === "wifi" && (
          <div className="mt-3 flex flex-col gap-4">
            {/* M18: pick a discovered device (mDNS / self-AP). Selecting one
                populates `deviceIp` below, so the OTA flash runs USB-free. */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <SectionHeading>
                  {t("wizard.frequency.wifiDevicesTitle")}
                </SectionHeading>
                <Button
                  type="button"
                  data-testid="wifi-scan-button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void (wifiScanning ? stopWifiScan() : startWifiScan())
                  }
                  aria-label={
                    wifiScanning
                      ? t("wizard.frequency.stopScan")
                      : t("wizard.frequency.scan")
                  }
                >
                  {wifiScanning ? (
                    <>
                      <Square className="h-3.5 w-3.5" aria-hidden="true" />
                      {t("wizard.frequency.stopScan")}
                    </>
                  ) : (
                    <>
                      <Search className="h-3.5 w-3.5" aria-hidden="true" />
                      {t("wizard.frequency.scan")}
                    </>
                  )}
                </Button>
              </div>

              {wifiDevices.length > 0 ? (
                <ul
                  data-testid="wifi-discovered-list"
                  className="flex flex-col gap-2"
                >
                  {wifiDevices.map((d) => {
                    const picked = wifiSelectedId === d.id;
                    // M19: Backpack devices are surfaced UNMISTAKABLY as
                    // Backpacks (distinct icon + primary-tinted badge), never
                    // as plain TX/RX. Plain ELRS rows are unchanged.
                    const backpackKind = wifiDeviceBackpackKind(d.kind);
                    const isBackpack = backpackKind !== null;
                    // A Backpack runs a SEPARATE firmware family and the wizard
                    // catalogue holds main-ELRS targets only, so a Backpack can
                    // never be the destination for the model chosen here — the
                    // backend refuses the combination (`backpackCrossFamily`).
                    // Disable the row with a stated reason rather than letting
                    // the user pick a destination that can only fail.
                    const blocked = isBackpack;
                    return (
                      <li key={d.id}>
                        <button
                          type="button"
                          data-testid="wifi-device-item"
                          aria-pressed={picked}
                          disabled={blocked}
                          onClick={() => {
                            selectWifiDevice(d.id);
                            setDeviceIp(d.address);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md border p-2.5 text-left outline-none transition-all duration-200 motion-reduce:transition-none",
                            "hover:border-primary/50 hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring",
                            picked
                              ? "border-primary bg-primary/5 shadow-[0_0_0_1px_var(--color-primary),0_0_18px_-6px_var(--color-signal-glow)]"
                              : "border-border",
                            blocked &&
                              "cursor-not-allowed opacity-60 hover:border-border hover:bg-transparent"
                          )}
                        >
                          {isBackpack ? (
                            <Backpack
                              className="h-4 w-4 shrink-0 text-primary"
                              aria-hidden="true"
                            />
                          ) : (
                            <RadioTower
                              className="h-4 w-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          )}
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-sm font-medium text-foreground">
                              {d.name}
                            </span>
                            <span className="truncate font-mono text-[11px] text-muted-foreground">
                              {d.address}
                            </span>
                          </span>
                          {isBackpack && (
                            <span
                              data-testid="backpack-device-label"
                              className="ml-auto shrink-0 rounded border border-primary/50 bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground"
                            >
                              {t(
                                backpackKindLabelKey(
                                  d.kind === "vrx-backpack"
                                    ? "vrx-backpack"
                                    : "tx-backpack"
                                )
                              )}
                            </span>
                          )}
                          <span
                            data-testid="wifi-device-source"
                            className={cn(
                              "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground",
                              isBackpack ? "" : "ml-auto",
                              d.source === "ap"
                                ? "border-status-warning/50 bg-status-warning/20"
                                : "border-status-good/50 bg-status-good/20"
                            )}
                          >
                            {t(wifiSourceLabelKey(d.source))}
                          </span>
                        </button>
                        {blocked && (
                          <p
                            data-testid="wifi-device-blocked-reason"
                            className="mt-1 pl-2.5 text-[11px] text-muted-foreground"
                          >
                            {t("wizard.frequency.backpackNotFlashable")}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p
                  data-testid="wifi-empty"
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                >
                  {wifiScanning && (
                    <Loader2
                      className="h-3 w-3 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  )}
                  {wifiScanning
                    ? t("wizard.frequency.scanning")
                    : t("wizard.frequency.noDevicesFound")}
                </p>
              )}
              {wifiError && (
                <p
                  data-testid="wifi-error"
                  role="alert"
                  className="flex items-start gap-1.5 rounded-md border border-status-critical/40 bg-status-critical/10 px-2 py-1 text-[11px] text-status-critical"
                >
                  <AlertTriangle
                    className="mt-0.5 h-3 w-3 shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    {t(`wifi.errors.${wifiError.summaryKey}`, {
                      defaultValue: t(
                        `wifi.errors.categories.${wifiError.category}`,
                        { defaultValue: wifiError.detail }
                      ),
                    })}
                  </span>
                </p>
              )}
              <span className="text-[11px] text-muted-foreground">
                {t("wizard.frequency.pickDeviceHint")}
              </span>
            </div>

            {/* Manual entry kept as a fallback (the device IP can always be
                typed even when discovery finds nothing). */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={deviceIpId}>
                {t("wizard.frequency.manualEntry")}
              </Label>
              <Input
                id={deviceIpId}
                value={deviceIp}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!ipValid}
                placeholder={t("wizard.frequency.deviceIpPlaceholder")}
                onChange={(e) => setDeviceIp(e.target.value)}
              />
              <span
                className={cn(
                  "text-[11px]",
                  ipValid ? "text-muted-foreground" : "text-status-critical"
                )}
              >
                {ipValid
                  ? t("wizard.frequency.deviceIpHint")
                  : t("wizard.frequency.deviceIpInvalid")}
              </span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
