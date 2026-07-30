import { useTranslation } from "react-i18next";
import { FlaskConical } from "lucide-react";

/**
 * Persistent high-contrast overlay shown while replay simulation is active
 * (FR-SIM-02). Intentionally distinct from the live "● live" indicator so
 * simulated data can never be mistaken for a real device feed. Rendered inside
 * the relative dashboard container as a top-right overlay.
 *
 * Contrast: the `--status-warning` amber is out of sRGB gamut, so browsers
 * gamut-map it to a mid-dark amber where solid-on-amber text falls below 4.5:1
 * AA (and worse mid-pulse). Instead this uses an amber-TINTED chip
 * (`bg-status-warning/20` + `border-status-warning/60`) with `text-foreground`,
 * a guaranteed AA pair against the card across the dark / light / carbon
 * themes. The pulse lives only on the decorative leading icon — never on the
 * label text — so axe can never sample faded body text. Honors
 * prefers-reduced-motion via `motion-safe:`.
 */
export function SimulatedBadge() {
  const { t } = useTranslation();

  return (
    <div
      role="status"
      data-testid="simulated-badge"
      title={t("simulator.badgeTitle")}
      aria-label={t("simulator.badgeTitle")}
      className="absolute right-2 top-2 z-20 flex items-center gap-1.5 rounded-full border border-status-warning/60 bg-status-warning/20 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-foreground shadow-sm"
    >
      <FlaskConical
        className="h-3.5 w-3.5 text-status-warning motion-safe:animate-pulse"
        aria-hidden="true"
      />
      {t("simulator.badge")}
    </div>
  );
}
