import { useTranslation } from "react-i18next";
import { History } from "lucide-react";

/**
 * Unmistakable badge shown in the import preview when an `.elrsp` document was
 * authored in an older schema version and auto-upgraded (FR-CFG-06). Uses a
 * filled status-accent pill with fixed-contrast text so it stays legible across
 * the dark / light / carbon Signal Lab themes (mirrors the M16 SimulatedBadge
 * token approach). Honors prefers-reduced-motion via `motion-safe:`.
 */
export function MigratedBadge() {
  const { t } = useTranslation();

  return (
    <span
      role="status"
      title={t("profiles.migrated.title")}
      aria-label={t("profiles.migrated.title")}
      className="inline-flex items-center gap-1.5 rounded-full border border-status-warning bg-status-warning px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-[oklch(0.18_0_0)] shadow-sm"
    >
      <History className="h-3.5 w-3.5 motion-safe:animate-pulse" aria-hidden="true" />
      {t("profiles.migrated.badge")}
    </span>
  );
}
