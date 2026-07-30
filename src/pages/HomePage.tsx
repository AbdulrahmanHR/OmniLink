import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";
import { ChevronRight, Cpu, FolderOpen, Usb } from "lucide-react";
import { useDevice } from "@/hooks";
import { useProfilesStore } from "@/stores";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { profileName } from "@/lib/profileLabels";

function DeviceStatusCard() {
  const { t } = useTranslation();
  const { device, isConnected } = useDevice();

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-1.5">
          <Cpu className="h-4 w-4 text-primary" />
          {t("home.deviceStatus.title")}
        </CardTitle>
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span className="relative flex h-2 w-2">
            {isConnected && (
              <span className="absolute inline-flex h-full w-full rounded-full bg-status-good opacity-75 motion-safe:animate-ping" />
            )}
            <span
              className={
                isConnected
                  ? "relative inline-flex h-2 w-2 rounded-full bg-status-good"
                  : "relative inline-flex h-2 w-2 rounded-full bg-muted-foreground"
              }
            />
          </span>
          {t(`device.status.${isConnected ? "connected" : "disconnected"}`)}
        </span>
      </CardHeader>
      <CardContent>
        {isConnected && device ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold text-foreground">
                {device.targetName}
              </span>
              {/* Display only — see the note in DeviceBar: an unclassifiable
                  CRSF origin stays `null` in the store (CONN-5). */}
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                {device.deviceType ?? t("device.typeUnknown")}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div className="flex flex-col">
                <dt className="text-xs text-muted-foreground">
                  {t("home.deviceStatus.firmware")}
                </dt>
                {/* Display only — see the note in DeviceBar: a device that
                    reported no firmware word stays `null` in the store. */}
                <dd className="font-medium text-foreground">
                  {device.firmwareVersion
                    ? `v${device.firmwareVersion}`
                    : t("device.firmwareUnknown")}
                </dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs text-muted-foreground">
                  {t("home.deviceStatus.port")}
                </dt>
                <dd className="truncate font-medium text-foreground">
                  {device.port}
                </dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs text-muted-foreground">
                  {t("home.deviceStatus.baud")}
                </dt>
                <dd className="font-medium text-foreground">{device.baud}</dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs text-muted-foreground">
                  {t("home.deviceStatus.params")}
                </dt>
                <dd className="font-medium text-foreground">
                  {device.paramCount}
                </dd>
              </div>
            </dl>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
              <Usb className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">
                {t("home.deviceStatus.disconnectedTitle")}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("home.deviceStatus.disconnectedDescription")}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActiveProfileGlance() {
  const { t } = useTranslation();
  const profiles = useProfilesStore((s) => s.profiles);
  const appliedId = useProfilesStore((s) => s.appliedId);

  const applied = useMemo(
    () => profiles.find((p) => p.id === appliedId) ?? null,
    [profiles, appliedId]
  );

  return (
    <NavLink
      to="/profiles"
      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm transition-colors hover:bg-accent/50"
    >
      <span className="flex min-w-0 items-center gap-2">
        <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("home.activeProfile.label")}
        </span>
        <span className="truncate font-medium text-foreground">
          {applied ? profileName(applied, t) : t("home.activeProfile.none")}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
        {t("home.activeProfile.view")}
        <ChevronRight className="h-3.5 w-3.5" />
      </span>
    </NavLink>
  );
}

export function HomePage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
      {/* Hero — the OmniLink waveform, breathing on the signal glow. */}
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 motion-safe:animate-signal-glow-pulse">
          <svg
            viewBox="0 0 100 100"
            className="h-8 w-8 text-primary"
            aria-hidden="true"
          >
            <path
              d="M 15 50 Q 32.5 20, 50 50 T 85 50"
              fill="none"
              stroke="currentColor"
              strokeWidth="5"
              strokeLinecap="round"
            />
            <circle cx="15" cy="50" r="3.5" fill="currentColor" />
            <circle cx="50" cy="50" r="3.5" fill="currentColor" />
            <circle cx="85" cy="50" r="3.5" fill="currentColor" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t("app.name")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("app.tagline")}</p>
        </div>
      </div>

      <DeviceStatusCard />

      <ActiveProfileGlance />
    </div>
  );
}
