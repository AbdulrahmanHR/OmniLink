import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import type { TelemetryHealth } from "@/stores/telemetry";
import { Sparkline } from "./Sparkline";

/**
 * `"neutral"` is a placeholder state for when no telemetry has arrived yet
 * (e.g. before the first frame on connect). It paints muted with no glow so a
 * missing reading never reads as a healthy value.
 */
type MetricHealth = TelemetryHealth | "neutral";

/** Maps a health level to its foreground text token. */
const healthText: Record<MetricHealth, string> = {
  good: "text-status-good",
  warning: "text-status-warning",
  critical: "text-status-critical",
  neutral: "text-muted-foreground",
};

/** Maps a health level to a CSS color var for the sparkline. */
const healthVar: Record<MetricHealth, string> = {
  good: "var(--color-status-good)",
  warning: "var(--color-status-warning)",
  critical: "var(--color-status-critical)",
  neutral: "var(--color-muted-foreground)",
};

/** Subtle glow applied to the value when the signal is healthy. */
const healthGlow: Record<MetricHealth, string> = {
  good: "drop-shadow-[0_0_8px_var(--color-signal-glow)]",
  warning: "",
  critical: "",
  neutral: "",
};

interface MetricCardProps {
  label: string;
  /** Big numeric/string readout. */
  value: string | number;
  /** Unit shown next to the value (e.g. "dBm", "%"). */
  unit?: string;
  /** Health classification driving the color coding. */
  health?: MetricHealth;
  /** Optional inline sparkline series (oldest first). */
  sparklineData?: number[];
  /** Optional fixed sparkline domain. */
  sparklineDomain?: [number, number];
  icon?: LucideIcon;
  className?: string;
}

export function MetricCard({
  label,
  value,
  unit,
  health = "good",
  sparklineData,
  sparklineDomain,
  icon: Icon,
  className,
}: MetricCardProps) {
  return (
    <Card
      className={cn(
        "relative flex flex-col gap-2 overflow-hidden p-4 transition-all duration-300",
        // A healthy signal lights its own card edge. `neutral` (no telemetry
        // yet) deliberately stays dark, so an absent reading never glows.
        health === "good" &&
          "border-status-good/30 shadow-[0_0_16px_-4px_var(--color-signal-glow)]",
        className
      )}
    >
      {/* Oscilloscope grid — decorative, behind the readout. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(var(--color-signal-grid) 1px, transparent 1px), linear-gradient(90deg, var(--color-signal-grid) 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
        aria-hidden="true"
      />

      {/* The readout is `relative` so it paints ABOVE the absolutely-positioned
          grid, which would otherwise overlay the text (positioned siblings paint
          over static ones regardless of DOM order). */}
      <div className="relative flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {Icon && (
          <Icon className={cn("h-4 w-4 shrink-0", healthText[health])} />
        )}
      </div>

      <div className="relative flex items-baseline gap-1.5">
        <span
          className={cn(
            "font-mono text-3xl font-semibold tabular-nums leading-none transition-colors duration-300",
            healthText[health],
            healthGlow[health]
          )}
        >
          {value}
        </span>
        {unit && (
          <span className="font-mono text-sm text-muted-foreground">
            {unit}
          </span>
        )}
      </div>

      {sparklineData && sparklineData.length > 1 && (
        <Sparkline
          data={sparklineData}
          color={healthVar[health]}
          domain={sparklineDomain}
          className="relative mt-1 h-10 w-full"
        />
      )}
    </Card>
  );
}
