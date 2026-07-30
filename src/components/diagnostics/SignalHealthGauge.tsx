import { useId } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** Score band thresholds: <40 critical, <75 warning, else good. */
type Band = "good" | "warning" | "critical";

/** Classify a 0–100 score into a status band (higher is healthier). */
function scoreBand(score: number): Band {
  if (score < 40) return "critical";
  if (score < 75) return "warning";
  return "good";
}

/** Band → SVG/Recharts color token (used for the arc stroke + glow). */
const BAND_VAR: Record<Band, string> = {
  good: "var(--color-status-good)",
  warning: "var(--color-status-warning)",
  critical: "var(--color-status-critical)",
};

/** Band → Tailwind text token (used for the centered numeric readout). */
const BAND_TEXT: Record<Band, string> = {
  // M41: `-strong` is the per-theme contrast-safe good (base green is only ~2.67:1
  // on the light card); darkened on light, aliases the base on dark/carbon. Keeps
  // the readout consistent with the factor list + severity badges.
  good: "text-status-good-strong",
  warning: "text-status-warning",
  // M41: `-strong` is the per-theme contrast-safe critical (base was only ~4.4:1
  // as a direct label on the card); keeps the readout consistent with the finding/
  // pattern severity badges.
  critical: "text-status-critical-strong",
};

interface SignalHealthGaugeProps {
  /** Health score, 0–100 (clamped). */
  score: number;
  /** Square pixel size of the SVG. */
  size?: number;
  /** Compact tuning: thinner ring + smaller type for inline/dashboard use. */
  compact?: boolean;
  /** Optional short caption rendered under the score (e.g. a mode label). */
  label?: string;
}

/**
 * Radial signal-health gauge (M37). A single self-contained SVG instrument —
 * there is no shared arc primitive in this codebase, so this builds one from a
 * full-ring `stroke-dasharray` sweep (the circle's `pathLength` is normalised to
 * 100 so the dash maps straight to the percentage). The arc is band-coloured by
 * the score (critical → warning → good as the score rises) using the bridged
 * status tokens, so it reads correctly in dark / light / carbon themes.
 *
 * The sweep animates with a `motion-safe:` transition and is instant under
 * `prefers-reduced-motion`. Exposed to assistive tech as a single labelled image
 * (`role="img"` + `aria-label` + `<title>`).
 */
export function SignalHealthGauge({
  score,
  size = 160,
  compact = false,
  label,
}: SignalHealthGaugeProps) {
  const { t } = useTranslation();
  // Unique gradient id so multiple gauges never collide on their <defs>.
  const gradId = `gauge-grad-${useId().replace(/:/g, "")}`;

  const safe = Number.isFinite(score) ? score : 0;
  const clamped = Math.max(0, Math.min(100, safe));
  const rounded = Math.round(clamped);
  const band = scoreBand(clamped);
  const color = BAND_VAR[band];

  const stroke = compact ? Math.max(6, size * 0.085) : size * 0.075;
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - stroke) / 2 - 1;

  // Descriptive accessible name: the health-label context + the "N / 100" score,
  // e.g. "Signal health score: 85 / 100" (not a bare number).
  const ariaLabel = `${t("diagnostics.panel.healthLabel")}: ${t("diagnostics.gauge.scoreOf", { score: rounded })}`;
  const scoreFont = compact ? size * 0.3 : size * 0.27;
  const capFont = compact ? size * 0.12 : size * 0.1;
  const labelFont = compact ? size * 0.1 : size * 0.085;

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label={ariaLabel}
      >
        <title>{ariaLabel}</title>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.7} />
            <stop offset="100%" stopColor={color} stopOpacity={1} />
          </linearGradient>
        </defs>

        {/* Track ring */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--color-signal-grid)"
          strokeWidth={stroke}
        />

        {/* Value arc: full ring, swept clockwise from 12 o'clock. pathLength=100
            maps the dash length straight to the percentage. */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${clamped} 100`}
          transform={`rotate(-90 ${cx} ${cy})`}
          className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-700 motion-safe:ease-out motion-reduce:transition-none"
        />
      </svg>

      {/* Centered readout: kept as HTML (not SVG <text>) so it inherits the mono
          tabular numerals and the status text token cleanly across themes. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span
          data-testid="diagnostics-health-score"
          className={cn(
            "font-mono font-semibold leading-none tabular-nums",
            BAND_TEXT[band]
          )}
          style={{ fontSize: scoreFont }}
        >
          {rounded}
        </span>
        <span
          className="font-mono leading-none text-muted-foreground"
          style={{ fontSize: capFont, marginTop: size * 0.04 }}
        >
          {t("diagnostics.gauge.outOf")}
        </span>
        {label && (
          <span
            className="mt-1 max-w-[80%] truncate text-center font-medium text-muted-foreground"
            style={{ fontSize: labelFont }}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  );
}
