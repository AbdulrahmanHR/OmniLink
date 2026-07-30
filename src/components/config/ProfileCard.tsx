import { useTranslation } from "react-i18next";
import { CheckCircle2, Gauge, Lock, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ConfigProfile } from "@/lib/mockProfiles";
import { profileDescription, profileName } from "@/lib/profileLabels";

interface ProfileCardProps {
  profile: ConfigProfile;
  /** Whether this card is the selected (previewed) profile. */
  selected: boolean;
  /** Whether this profile's settings match the device's active config. */
  active: boolean;
  onSelect: (id: string) => void;
}

/** Single selectable profile summary with key-spec badges. */
export function ProfileCard({
  profile,
  selected,
  active,
  onSelect,
}: ProfileCardProps) {
  const { t } = useTranslation();
  const name = profileName(profile, t);
  const description = profileDescription(profile, t);

  return (
    <Card
      // An `option` inside the ProfileList `listbox` (axe `aria-required-children`
      // requires option children); `aria-selected` reflects the previewed row.
      role="option"
      tabIndex={0}
      aria-selected={selected}
      onClick={() => onSelect(profile.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(profile.id);
        }
      }}
      className={cn(
        "cursor-pointer p-3 transition-all duration-200 outline-none",
        "hover:border-primary/50 hover:bg-accent/40",
        "focus-visible:ring-1 focus-visible:ring-ring",
        selected
          ? "border-primary bg-primary/5 shadow-[0_0_0_1px_var(--color-primary),0_0_18px_-6px_var(--color-signal-glow)]"
          : "border-border"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">
              {name}
            </span>
            {profile.builtin && (
              <Lock
                className="h-3 w-3 shrink-0 text-muted-foreground"
                aria-label={t("profiles.builtin")}
              />
            )}
          </div>
          {description && (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {active && (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-status-good">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t("profiles.active")}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Badge variant="outline">
          <Gauge className="h-3 w-3" />
          <span className="font-mono">{profile.settings.packetRate}</span>
          Hz
        </Badge>
        <Badge variant="outline">
          <Zap className="h-3 w-3" />
          <span className="font-mono">{profile.settings.txPower}</span>
          mW
        </Badge>
        <Badge variant="outline">
          <span className="font-mono">{profile.settings.telemetryRatio}</span>
        </Badge>
      </div>
    </Card>
  );
}
